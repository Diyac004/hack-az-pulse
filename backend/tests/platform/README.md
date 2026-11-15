# MockGateway tests

Tests for [`app/gateway/mock.py`](../../app/gateway/mock.py), the fake tractor fleet the world service drives until AgOpenWeb is live. All 24 tests are in [`test_mock_gateway.py`](test_mock_gateway.py).

## How to run

PowerShell (VS Code default on Windows):
```powershell
$env:PYTHONPATH = "backend"
.\.venv\Scripts\python.exe -m unittest discover -s backend/tests/platform -v
```

Git Bash / macOS / Linux:
```bash
PYTHONPATH=backend .venv/bin/python -m unittest discover -s backend/tests/platform -v   # .venv/Scripts/python on Windows
```

First time on a new machine: `python -m venv .venv` then install Pydantic v2 into it (`pip install "pydantic>=2"`).

To see a plan play out instead of just pass/fail: `python backend/scripts/watch_mock.py` (same `PYTHONPATH`).

## Test data

The tests reuse the shared contract fixtures, so they check the same numbers the brain uses:

- [`brain_snapshot.json`](../../../contract/examples/brain_snapshot.json): the farm map (roads, blocked cell `(7,6)`) and the moment `t = 141.5` when T1 breaks down.
- [`brain_result.json`](../../../contract/examples/brain_result.json): the re-plan. T3 finishes mowing J4, drives 10 cells to Block E, and sprays the rest of J1. T2 drives 2 cells and hauls bins (J9).

Expected timeline from that plan:

| Tractor | Event | Sim time |
|---|---|---|
| T2 | Arrives at Block A (2 cells at 0.6/min) | 144.833 |
| T2 | Finishes J9 (45 min) | 189.833 |
| T3 | Finishes J4 (18.5 min left) | 160 |
| T3 | Arrives at Block E (10 cells at 0.5/min) | 180 |
| T3 | Finishes J1 (60 min left) | 240 |

## Test cases

### `FixturePlan`: the brain's plan plays out on schedule
Assigns the fixture plan to T2 and T3, runs to t = 260, and checks the results.

| Test | What it checks | Why it matters |
|---|---|---|
| `test_t3_timeline` | T3 finishes J4 at 160, arrives at `(10,8)` at 180, finishes J1 at 240 | The gateway executes Diya's plan with exactly the times she planned |
| `test_t2_timeline` | T2 arrives at 144.833 and finishes at 189.833 | Same, for a fractional travel time |
| `test_work_minutes_exact` | `Worked` reports add up to exactly 18.5 / 60 / 45 minutes | The state store fills work units from these, so they can't over- or under-count |
| `test_idle_once_at_end` | T3 reports `Idle` exactly once, at 240 | The world service uses `Idle` to know a tractor needs new work; duplicates would cause double dispatch |
| `test_travel_fuel_inputs` | `Moved` reports add up to 10 cells and 20 minutes | The state store computes travel fuel from these numbers |

### `Movement`: driving rules
T3 drives the 10-cell route `(15,3) → (15,6) → (10,6) → (10,8)` on its own.

| Test | What it checks | Why it matters |
|---|---|---|
| `test_no_teleport` | Each 0.2-min tick moves at most `speed × dt`, and cells are reached in route order | Tractors never jump. This was a requirement from Diya's review |
| `test_headings` | Heading is 180° going south, 270° going west, 180° going south again | The dashboard draws tractor direction from this (0 = north, 90 = east) |
| `test_anchor_is_next_whole_cell` | 1.5 cells in: `cell = (15,4)`, `anchor = (15,5)`, `anchor_t = 164`, `y = 4.5` | The brain's router only accepts whole road cells, so a mid-move tractor is planned from its next cell and the time it gets there |

### `Breakdowns`: `stop()` and `resume()`

| Test | What it checks | Why it matters |
|---|---|---|
| `test_stop_while_working_keeps_partial_minutes` | Stopped at 195, T3 has done exactly 15 min of J1. Afterwards: one `Stopped` report, no more `Worked` or `Moved`, status `broken` | Progress is never lost, and a broken tractor does nothing |
| `test_stop_mid_route_freezes_between_cells` | Stopped at 167 (3.5 cells in), T3 stays at `(14.5, 6)` and its anchor is `(14,6)`. Assigning orders to a broken tractor is refused | A breakdown on the road freezes the tractor where it is, not at the nearest cell |
| `test_resume_finishes_segment_then_takes_orders` | After `resume()`, T3 first finishes the half cell into `(14,6)`, then follows its new route, arriving at 173 | A repaired tractor continues smoothly without teleporting |

### `BadOrders`: refuse instead of doing something wrong
T1 at `(5,6)`. Each test sends an invalid order and expects a `GatewayError`.

| Test | Invalid order | Why it matters |
|---|---|---|
| `test_route_with_gap` | `(5,6) → (5,8)` skips a cell | A broken route would otherwise mean teleporting |
| `test_route_through_blocked_cell` | Passes through blocked `(7,6)` | A plan must never use a closed road |
| `test_route_from_wrong_start` | Route starts at `(10,6)` but the tractor is at `(5,6)` | Catches plans built from out-of-date state |
| `test_route_off_road` | Goes to `(6,7)`, which is orchard, not road | Tractors stay on the road grid |
| `test_chained_routes_must_connect` | The second route doesn't start where the first one ended | Multi-step plans must join up |
| `test_failed_assign_changes_nothing` | A bad `assign` after a good one leaves the good orders running | A rejected order can't wipe out the current plan |
| `test_unknown_and_duplicate_tractors` | Unknown ID, duplicate ID, starting off-road | Fleet changes are validated |
| `test_road_blocked_after_assign_halts` | `(5,3)` is blocked while T1 is on its way. T1 stops at `(5,4)` with `Halted(reason="road_blocked")` | A `block_route` event mid-drive halts the tractor safely so the world service can re-plan |

### `Robustness`: things the real system relies on

| Test | What it checks | Why it matters |
|---|---|---|
| `test_tick_size_does_not_matter` | Tick sizes of 0.1, 0.2, 1, 5 and 7.3 min give an identical event timeline and work total | Demo speed can change (sped-up clock, pause, 10×) without changing results |
| `test_deterministic` | Two runs of the same plan produce identical report lists | Our run and the FCFS baseline must be fairly comparable (ARCHITECTURE.md §8, rule 7) |
| `test_fifty_tractors` | 50 tractors each do a 10-min job, and all 50 report `WorkDone` | No fleet-size cap. Diya's scale test runs 50 tractors on MockGateway |
| `test_add_and_remove_live` | T4 added mid-run moves, and T2 removed mid-run stops reporting | Plug-and-play tractors (PROJECT.md Change 4) |
| `test_replan_mid_move_finishes_segment_first` | A re-plan while T3 is between cells must start from its anchor `(15,5)`. A route from `(15,4)` is refused | Re-planning never reverses a tractor mid-cell or teleports it |

## Adding a test

- Use `fixture_gateway()` for the standard T2 and T3 plan, or build a `MockGateway(FARM, t0=...)` directly.
- `run(gw, until, dt)` advances to `until` and returns every report.
- `of(reports, Kind, tractor)` filters reports by type, and `worked(reports, tractor, job)` sums work minutes.
- Times use `assertAlmostEqual(..., places=6)` because tick steps are floats.

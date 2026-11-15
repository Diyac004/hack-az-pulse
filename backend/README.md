# Harvest Fleet AI: platform (MockGateway integration)

A runnable backend that plans a farm day with Diya's brain (`app/brain`), executes it on simulated tractors (MockGateway), and recovers from breakdowns. Divi's dashboard connects to it over REST and `/ws`.

API shapes follow [ARCHITECTURE.md](../ARCHITECTURE.md) sections 4–8, with the **section 13** amendment (202 Operations, `operation` WS messages, `Idempotency-Key`, `unassigned_reason`, `solver_status`, nullable metrics). Anything not built yet is listed under [What's mocked or unfinished](#whats-mocked-or-unfinished).

## Setup (once)

Python 3.11+ (tested on 3.14). From the repository root:

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r backend/requirements.txt     # Windows
# .venv/bin/python -m pip install -r backend/requirements.txt       # macOS / Linux
```

The commands below use the Windows path `.venv/Scripts/python`. On macOS/Linux use `.venv/bin/python`.

Verified: a brand-new virtual environment with only `pip install -r backend/requirements.txt` runs all three test suites, the server, and `scripts/demo_client.py` (`websockets` comes with `uvicorn[standard]`). Only Windows + Python 3.14 has been tried. The one warning (`httpx` with Starlette's TestClient is deprecated) is harmless.

## Start the server

```bash
cd backend
../.venv/Scripts/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

- REST: `http://localhost:8000/api/...`, WebSocket: `ws://localhost:8000/ws`, OpenAPI: `http://localhost:8000/docs`
- The server loads [`data/scenario.json`](../data/scenario.json) **paused**, with plan version 0. Nothing moves until `POST /api/run`.
- Event logs are written to `logs/event_log_<mode>.jsonl` (git-ignored).
- Optional environment variables: `HFA_SCENARIO` (another scenario file), `HFA_LOG_DIR`.

## Acceptance check: run, breakdown, see the update

With the server running, in a second terminal from the repository root:

```bash
.venv/Scripts/python backend/scripts/demo_client.py
```

It connects to `/ws`, calls `POST /api/run`, speeds the clock up, breaks down T2 by hand, and prints every WebSocket message (operation lifecycle, `plan`, `explanation`, `jobs`, `fleet`, `log`), then the final state and explanation. The scenario also has a **scripted T1 breakdown at t = 50**, so at speed 30 you'll usually see both.

The same check by hand (PowerShell):

```powershell
Invoke-RestMethod -Method Post http://localhost:8000/api/run    -ContentType application/json -Body '{"mode":"ours"}'
Invoke-RestMethod -Method Post http://localhost:8000/api/clock  -ContentType application/json -Body '{"speed":30}'
Invoke-RestMethod -Method Post http://localhost:8000/api/events -ContentType application/json -Body '{"type":"breakdown","tractor":"T2","issue":"flat tyre"}'
Invoke-RestMethod http://localhost:8000/api/operations/O2        # use the id the previous call returned
(Invoke-RestMethod http://localhost:8000/api/state).explanations[0]
```

bash:

```bash
curl -s -XPOST localhost:8000/api/run    -H 'Content-Type: application/json' -d '{"mode":"ours"}'
curl -s -XPOST localhost:8000/api/clock  -H 'Content-Type: application/json' -d '{"speed":30}'
curl -s -XPOST localhost:8000/api/events -H 'Content-Type: application/json' -d '{"type":"breakdown","tractor":"T2"}'
curl -s localhost:8000/api/state
```

Submit a job: `POST /api/jobs` with `{"jobs":[{"type":"mow","implement":"mower","block":"E","duration_min":40,"priority":3,"deadline_t":600}]}`.

## Run the tests

From the repository root (the brain, platform and integration suites run separately):

```bash
PYTHONPATH=backend .venv/Scripts/python -m unittest discover -s backend/tests/brain -v
PYTHONPATH=backend .venv/Scripts/python -m unittest discover -s backend/tests/platform -v
PYTHONPATH=backend .venv/Scripts/python -m unittest discover -s backend/tests/integration -v
```

In PowerShell, run `$env:PYTHONPATH = "backend"` first, then the same commands without the `PYTHONPATH=backend` prefix.

| Suite | What it proves |
|---|---|
| `tests/platform` (26) | MockGateway executes routes and work on sim time, stops failed tractors, never teleports. See [its README](tests/platform/README.md). |
| `tests/integration/test_world.py` (20) | **Execution:** all 12 jobs done on time, every work row done exactly once, tractors follow the plan, deterministic. **Progress preservation:** the T1 breakdown keeps J1's progress (≈59%) and it never goes back. **Valid reassignment:** J1 goes to T3 (the only other sprayer), the broken tractor gets no work, no lost or duplicated minutes. **Adapter gates:** stale results refused, invalid results refused and logged as `safety_reject`, a gateway refusal applies nothing, snapshots always pass `BrainSnapshot` validation, re-planning a driving tractor keeps its arrival time. Also blocked roads, new jobs mid-day, repairs. |
| `tests/integration/test_api.py` (12) | The running server: 202 Operations and their lifecycle, `Idempotency-Key` replay and 409, contract error shape, fleet add/remove, manual and scripted breakdowns over HTTP, and on `/ws`: snapshot first, gap-free `seq`, ping/pong, and section 13.3 order (`operation` running, `plan`, `explanation`, `jobs`, …, `operation` succeeded). The full plan `diff` (`moved`, `retimed`, `dropped`, `added`) and `solver`/`solver_status` are identical in REST state and the WS `plan` message. An unmeetable constraint fails the operation with `SAFETY_REJECTED` / `no_feasible_plan`. |
| `tests/integration/test_review_fixes.py` (13) | Diya's review items. **Idle time:** identical full-day metrics at dt = 0.2, 1 and 5 for both policies, and idle stops at a job's exact finish time inside a long tick. **Plan diff:** every diff field and the solver name/status forwarded; invalid values (`solver: "magic"`, `no_feasible_plan`, malformed `moved`) rejected with nothing dispatched. **Mid-drive commitment:** public position stays actual; the remaining drive is in the public plan and matches execution; work starts at arrival; four re-plans during one trip leave arrival, travel minutes and fuel unchanged; breakdown and blockage during travel; an unmeetable deadline is rejected explicitly. |

## Headless comparison (next milestone starter)

Runs a full day for both policies through the same simulator, with the same scenario and the same scripted events. Only the dispatch policy differs (`plan(..., policy="multi")` vs `policy="fcfs"`):

```bash
PYTHONPATH=backend .venv/Scripts/python -m app.core.runner --mode both
```

Output on the current demo scenario (one scenario, deterministic; not a benchmark):

```
metric                    ours    baseline
jobs_total                  12          12
completed                   12          12
on_time                     12          12
weighted_on_time            21          21
travel_min                76.0       148.0
idle_min                  80.0       272.0
productive_min           700.0       700.0
violations                   0           0
```

These numbers are the same at any tick size (`--dt` is fixed at 1 in the runner; the tests check 0.2, 1, 5 and 7.3). Every plan search completed (`search_complete: true` in both logs). Both policies finish every job on time here, so on this scenario the measured difference is efficiency only: half the travel and about 30% of the idle time. One scenario is not a general claim.

It writes `logs/event_log_ours.jsonl` and `logs/event_log_baseline.jsonl`. Metric definitions are those in PROJECT.md section 7, applied identically to both policies:
- **Idle time** is measured over exact intervals, not per tick. MockGateway reports each interval in which an operational tractor is neither driving nor working (out of orders, or waiting for an order's start time, such as a planner `wait` while another tractor uses the field). An interval counts only while a compatible job (right implement, pin allows it) is unfinished; a job finished mid-tick stops counting at its exact finish time. Refuelling isn't modeled, so it never applies.
- **No tick-size effect on the simulation either.** A step stops at the exact moment a tractor needs a decision (out of orders while compatible work waits, or a blocked road ahead), as it already did for scheduled events. Before this, a tractor could sit up to one tick before its re-plan, which is why idle varied with dt (79.8 / 79 / 77).
- **Planner budget.** Diya's improvement search stops when it converges or its wall-clock budget runs out. A budget that runs out makes plans depend on machine load, so the platform passes `budget_ms=10000`; it converges in about 0.4 s here. Each `plan`/`replan` log line records `search_complete`.

## How it fits together

```
 Divi's dashboard ──REST /api──▶ main.py ──▶ Engine (core/engine.py)
        ▲                                      │  tick loop every 0.2 s: World.step(real_s × speed)
        └──────────── /ws ◀── Hub (ws/hub.py) ◀┤  planning worker: one Operation at a time
                                               ▼
                       World (core/state.py)  ◀── reports ── MockGateway (gateway/mock.py)
                       single source of truth  ── orders ──▶
                               │  to_brain_snapshot()      ▲ apply_result(): stale + validation gate, all-or-nothing
                               ▼                           │
                       Diya's brain: plan() in a worker thread → PlanningResult
```

- **Time:** sim minutes = real seconds × clock speed (speed 1 → a 720-minute day takes 12 real minutes). `POST /api/clock {"speed": 30}` to go faster. Sim time is held while a plan is being computed.
- **Breakdown flow:** `POST /api/events` (or a scripted event) → `World.breakdown` stops the tractor immediately, keeps progress and releases its jobs → `fleet`/`jobs`/`log` go out → a `replan` Operation runs `plan()` off the event loop → if the result is still current and passed Diya's validator, it is applied atomically → `plan`, `explanation`, `jobs`, `fleet`, `metrics` → `operation` succeeded.
- **Stale results:** every state change bumps an internal `state_version`. A result built from an older version is recomputed (up to 3 times) or marked `superseded`. A reset (`/run`) supersedes everything in flight.
- **Atomic apply:** every tractor's new orders are dry-run checked against the gateway before any are given.
- **Progress** is kept per work unit (20-minute rows). Public `progress` and `remaining_min` are derived from the rows.

## What's mocked or unfinished

**AgOpenWeb is not connected.** All execution runs on MockGateway.

**Mocked**
- **Tractors are MockGateway,** not AgOpenWeb. Movement is cell by cell on the road grid; a tractor works a block while parked at its entrance. `agopenweb` is `null` on every tractor.
- **Weather** (`GET /api/weather`, `weather` in the snapshot) is a static calm placeholder, and `constraints.weather` is off.
- **Capacity / hosts** report a single `mock` host with `max` = current fleet size. There's no real compute pool.
- **Scenario numbers** (speeds, fuel burn, row sizes, deadlines) are demo defaults, not machine data. `basemap.image_url` is `null` (no aerial image yet).

**Not implemented (return HTTP 501, code `INTERNAL`, `details.not_implemented: true`)**
- `/api/tractors/{id}/controls`, `/control`, `/preview`, `/manual`, `/api/why/{job}`, `/api/mechanics`, `/api/mechanics/book`, `/api/approve`, `/api/scale-test`.
- Events `weather_change`, `heat_alert` and `ripening_change` return 400 (`INVALID_INPUT`): weather and agronomy aren't modeled.
- `POST /api/run` with `mode: "both"` returns 400. Use the headless runner for the side-by-side comparison. The live server runs one mode at a time and shows the other mode's last finished run in `metrics`.
- Refuelling (`constraints.refuel` is off; Diya's v1 returns "unsupported" if it's on). Implement swaps, `pending` approvals, coverage, and `rejected_candidates` (always `null`; the brain doesn't expose it yet).

**Integration decisions to review with Diya**
- **Driving tractors are committed to their current trip (no mid-drive rerouting).** Brain v1 can't plan ongoing travel, so:
  - **Planner input only:** the snapshot puts the driving tractor at its destination entrance, its job frozen from the exact arrival time, and the rest of the drive's fuel already deducted. Public positions (`fleet`, `poses`) are always the real ones.
  - **Public plan:** the platform adds a `travel` entry for the rest of the trip (start = now, end = arrival, route = remaining cells from the next whole cell), using the existing `PlanEntry` shape. Execution orders are built from the same entries, so the timeline and execution agree. Work starts at arrival, never before.
  - **Counted once:** travel minutes and fuel are charged only as the tractor actually moves; the planner sees the remaining fuel deducted once and gets no second travel entry for it.
  - **Refusals:** a plan that doesn't keep the committed job from its arrival, or schedules that tractor earlier, is rejected (`safety_reject`, `committed_trip`). If the committed job can no longer meet its constraints (e.g. its deadline was moved earlier than its finish), every plan fails validation and the operation fails with `SAFETY_REJECTED`. The tractor keeps executing the last valid plan, and re-planning stays blocked until that job finishes. This is a known limitation.
  - **Breakdown mid-drive:** the tractor stops where it is (between cells if need be) and its job is released. **Road blocked ahead:** it drives to the last open cell before the block, its job is released, and the next re-plan routes around.
  - Tested by re-planning midway through a trip, four times during one trip, and with a breakdown or blockage during travel.
- **Plan diff and solver.** `plan.diff` forwards the brain's `moved`, `retimed`, `dropped` and `added`, with `moved[].progress_kept` filled from the brain's facts. `solver` and `solver_status` come from the brain's result. Values outside the public enums, or `no_feasible_plan` as an applied plan, are rejected before anything changes.
- **Idle tractors re-plan.** When a tractor runs out of orders while a compatible job is pending or paused, a re-plan runs. This picks up work that was infeasible earlier.
- **Unassigned reasons.** `unassigned_reason` turns the brain's "unavailable or incompatible" into "No operational tractor has the right implement for this job." Other reasons pass through.
- **Breakdown status.** The broken tractor's jobs show `paused` (some progress) or `pending` until the re-plan finishes. After that, unassigned jobs are `pending` with a reason (13.1).

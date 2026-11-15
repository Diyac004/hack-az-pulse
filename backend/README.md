# Harvest Fleet AI: platform (MockGateway integration)

A runnable backend that plans a farm day with Diya's brain (`app/brain`), executes it on simulated tractors (MockGateway), and recovers from breakdowns. Divi's dashboard connects to it over REST and `/ws`.

## Which backend to demo

**The validated coordinator path is this server: FastAPI + Diya's brain + MockGateway.** It is the only one that runs our scheduler, our breakdown recovery, and a measured comparison against FCFS.

| Backend | Port | Runs our scheduler? | Tractors | Use it for |
|---|---|---|---|---|
| **This server** (`backend/`) | 8000 | **Yes** (Diya's brain) | MockGateway (simulated) | Planning, re-planning, explanations, scorecard |
| Divi's `agopenweb-bridge/` | 8040 | No (one job per tractor, no optimizer) | Real headless AgOpenWeb | Showing AgOpenWeb steering only |
| Divi's `mock-backend/` | 8000 | No (in-browser simulation's own planner) | Simulated | Rehearsal without Python |

- **AgOpenWeb is not connected to this server.** Divi's bridge is a separate program and does not execute our scheduler.
- **Don't mix numbers.** The bridge's metrics are placeholders (counts only, static fuel), and the mock backend's come from a different planner. Only this server's `metrics` (and `python -m app.core.runner`) are measured results of our scheduler vs FCFS. Present them separately, and say which backend is on screen.

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
- **Cold start:** the server loads [`data/scenario.json`](../data/scenario.json), plans the day straight away (operation `O1`, kind `run`) and stays **paused** at farm minute 0. Play (`POST /api/clock {"playing": true}`) starts it; no `/run` call is needed. `POST /api/run {"mode":"ours"}` resets and re-plans the day at any time.
- Event logs are written to `logs/event_log_ours.jsonl` (git-ignored).
- Optional environment variables: `HFA_SCENARIO` (another scenario file), `HFA_LOG_DIR`, `HFA_AUTORUN=0` (start with plan version 0 and wait for `POST /api/run`).

## Connect Divi's dashboard

With this server running on port 8000 (Divi's dashboard is in `dashboard/` on `main`; see `CLAUDE.md` and `DEMO.md`):

```bash
cd dashboard
npx vite --port 5173            # rehearsal; for the demo: npx vite build && npx vite preview --port 5173
```

Open `http://localhost:5173/?source=live&api=http://localhost:8000`. The plan badge shows plan v1 before Play, because the server planned the day at startup. Press **Play**. From another machine, replace `localhost` in `api=` with this laptop's IP (`ipconfig`); CORS allows any origin.

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
| `tests/integration/test_api.py` (18) | The running server: 202 Operations and their lifecycle, `Idempotency-Key` replay and 409, contract error shape, fleet add/remove, manual and scripted breakdowns over HTTP, and on `/ws`: snapshot first, gap-free `seq`, ping/pong, and section 13.3 order (`operation` running, `plan`, `explanation`, `jobs`, …, `operation` succeeded). The full plan `diff` (`moved`, `retimed`, `dropped`, `added`) and `solver`/`solver_status` are identical in REST state and the WS `plan` message. An unmeetable deadline edit fails with `SAFETY_REJECTED` / `no_feasible_plan`, leaves `deadline_t` unchanged, and a later valid edit applies. **Cold start:** planned and paused at startup, Play works without `/run`. **Baseline:** shown only when it matches; after an operator action it is `null` until recomputed; at day end it equals the headless FCFS run. |
| `tests/integration/test_review_fixes.py` (19) | **Staged edits:** a failed edit leaves deadline, priority, pin and plan version intact, is logged `edit_rejected`, isn't broadcast or replayed; later valid edits and re-plans work; a rollback never overwrites a newer value; scripted priority changes are staged too. **Baseline twin:** with no operator actions it equals headless FCFS; operator actions replay at the same farm minute. Diya's earlier review items: **Idle time:** identical full-day metrics at dt = 0.2, 1 and 5 for both policies, and idle stops at a job's exact finish time inside a long tick. **Plan diff:** every diff field and the solver name/status forwarded; invalid values (`solver: "magic"`, `no_feasible_plan`, malformed `moved`) rejected with nothing dispatched. **Mid-drive commitment:** public position stays actual; the remaining drive is in the public plan and matches execution; work starts at arrival; four re-plans during one trip leave arrival, travel minutes and fuel unchanged; breakdown and blockage during travel; an unmeetable deadline is rejected explicitly. |

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

## Baseline comparison on the dashboard

The scorecard's "Ours vs first come, first served" column is `metrics.baseline`. On this server it is filled automatically; there is no separate baseline run to start.

**What it is.** FCFS (`plan(..., policy="fcfs")`) on the same scenario, through the same simulator, with every operator action from the live run (breakdowns, repairs, road blocks, accepted job edits, new jobs, fleet changes) replayed at the same farm time. It is read at the same farm minute as the live run (the most recent whole minute), so mid-day both columns describe the same moment of the same day. At day end it is the complete matching FCFS day. `baseline_source` is `"simulated"`: a Python twin on the same simulator, not a second live run. The dashboard labels it "first-come-first-served on the same day & events (simulated, not a live run)", which is accurate.

**When it's unavailable.** `metrics.baseline` and `metrics.baseline_source` are both `null` (the dashboard shows "Baseline not run yet.") until the twin for the current set of operator actions is computed. That takes about half a second after startup and after each operator action. A baseline from a different day or an older set of actions is never shown.

**Steps to populate it:**
1. Start the server (`uvicorn` above). The day is planned at startup.
2. Open the dashboard on `?source=live&api=http://localhost:8000`.
3. Wait about a second: the scorecard fills in at minute 0.
4. Press Play. Operator actions blank the column for about half a second while it recomputes.
5. To check from a terminal: `GET /api/baseline` returns `status: "ready"` or `"computing"`, the number of operator actions replayed, and the farm minute compared. This is a platform diagnostic, not part of the dashboard contract.

For the hand-in logs and table, use the headless runner above (`--mode both`); its FCFS column equals the dashboard's end-of-day baseline when no operator actions were taken (tested).

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
- `POST /api/run` accepts only `mode: "ours"`; `"baseline"` and `"both"` return 400 with a pointer to the automatic baseline and the headless runner. The live FCFS column is the twin described above.
- The baseline twin replays operator actions at whole-event granularity. It doesn't model the dashboard's Why/Preview/cockpit actions (not built).
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
- **Operator job edits are staged.** `PATCH /api/jobs/{id}` and `priority_change` events are checked at once (unknown job → 404, finished job → 409 `CONFLICT`, incompatible pin → 422 `SAFETY_REJECTED`), then accepted as a 202 Operation. The new values are given to the planner only. If a valid plan is applied, they're committed: logged as `job_patch`/`priority_change`, broadcast in `jobs`, and replayed in the baseline. Otherwise the previous values are restored, the operation fails (`SAFETY_REJECTED`, `solver_status: no_feasible_plan`), and the log gets `safety_reject` then `edit_rejected`. While the plan is being computed (about 0.4 s), REST reads can show the staged value; nothing is broadcast until the outcome is known.

## Notes for the dashboard (Divi)

No new fields. Everything follows ARCHITECTURE.md section 13. Behaviour to rely on:
- **Cold start:** the day is already planned (plan v1, paused at t = 0) when the dashboard connects. Play = `POST /api/clock {"playing": true}`. `POST /api/run` resets the day: the server sends a `snapshot` (t back to 0), then the run operation's lifecycle. `POST /api/clock {"playing": true}` before any plan exists returns 409 `CONFLICT` (only with `HFA_AUTORUN=0`).
- **Clock speed** = farm minutes per real second (1 = a 12-minute day). The dashboard's "fast" button (`speed: 6`) gives a 2-minute day.
- **Operations:** `POST /api/run`, `POST /api/jobs`, `PATCH /api/jobs/{id}` and `POST /api/events` always return 202 + Operation. Track `queued → running → succeeded | failed | superseded` over WS `operation` messages (or `GET /api/operations/{id}`). `Idempotency-Key` retries return the original operation; reusing a key with a different body returns 409. Fleet add/remove keep their old shapes and start a re-plan Operation with `source: "events"` (§13 has no `fleet` source).
- **`POST /api/jobs`** works (`{"jobs":[{"type","implement","block","duration_min","priority","deadline_t"}]}`; `id` optional). It is accepted as 202 and the new jobs appear in `jobs` messages. The dashboard has no form for it yet.
- **A failed edit** (e.g. a deadline that can't be met) never changes the job: watch for the operation's `failed` status and its `error.message`.
- **HTTP statuses:** `INVALID_INPUT` 400, `NOT_FOUND` 404, `CONFLICT` 409, `SAFETY_REJECTED` 422, unbuilt endpoints 501 (code `INTERNAL`, `details.not_implemented: true`).
- **Not on this server yet** (501 or 400): Why, Preview, cockpit controls, manual mode, mechanics, approvals, scale test, weather/heat events. The demo's mechanic, wind and Why moments need Divi's mock backend for now.

## Frontend integration fixes (Diya's branch)

- `GET /api/capabilities` explicitly reports supported actions using Divi's existing capability shape. Weather, mechanics, cockpit, approval, Why and scale-test remain disabled; no pending mechanic item is expected. They are optional features, not missing core recovery.
- Simulator capacity defaults to **8 tractors**, configurable using `HFA_MAX_TRACTORS` (must fit the initial fleet). This is a configured simulation limit, not measured Docker capacity. `used` reflects current fleet size; add/remove sends `capacity`. Add at the limit returns 409 `AT_CAPACITY` without mutation.
- Mock fleet creation is immediate: POST /fleet returns 202 with an `idle` tractor, plus readiness/fleet/capacity events. There is no fake startup delay. Real gateway provisioning may implement `starting` later.
- `HFA_SCRIPTED=0` disables scenario-scripted events for a manual-only demonstration, for BOTH live execution and its baseline twin. Default remains scripted events enabled. A manual repair does not silently erase a future independent failure. For headless manual-only comparison use `python -m app.core.runner --mode both --no-scripted`.
- Unknown routes and wrong methods return the normal error envelope, with `NOT_FOUND` / `METHOD_NOT_ALLOWED`; HTTP status and Allow headers remain correct.
- Explanations use human job/tractor names, clock times and bounded summaries. Full IDs and plan differences remain available in structured facts. Fleet additions/removals/repairs name the event even when no work moves.
- Startup planning has an Operation; clients that connect later recover it from `snapshot.operations`. While the matching baseline is computing, BOTH baseline and baseline_source are null; source becomes `simulated` when available.

### Scheduling balance is an optimization tradeoff

An idle tractor is not by itself an invalid plan. The current objective prefers weighted on-time completion, on-time job count, travel, then planned waiting. It does not minimize makespan or explicitly maximize fleet utilization. A repaired tractor joins the next search, but ongoing work is committed and queued jobs only move if the heuristic finds a preferred valid schedule. Shorter travel may favor keeping a tractor idle. Do not claim every repair transfers work, or that a local heuristic proves no better plan exists.

Evaluate balance with completion, travel, measured idle and planning speed across scenarios before changing the objective. The UI now explains unchanged repair assignments; no forced reassignment or invented improvement is added.

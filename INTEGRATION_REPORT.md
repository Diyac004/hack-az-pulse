# Integration report: dashboard vs the FastAPI backend (`origin/anay` 945edd1)

For Anay (platform) and Diya (planner). Tested 2026-11-15 against `origin/anay` at 945edd1, which already contains `origin/diya/brain` b3aca18, then re-checked against **7df3d39** (cold-start autorun, staged edits, baseline twin). Python 3.13 venv, `pip install -r backend/requirements.txt`, server on port 8000. Dashboard: `divi` with the capability-detection and Start run changes. This report covers the backend only. Nothing under `backend/` was edited.

## Summary

- **Backend tests:** at 945edd1, brain 23, platform 26 and integration 45 all pass (unittest, as documented in `backend/README.md`). At 7df3d39, brain 23 and platform 26 pass, and integration fails 1 of 57 consistently on this Mac: `test_api.BaselineDisplay.test_baseline_appears_only_when_it_matches` (issue 14).
- **Cold start at 7df3d39:** the server plans at startup (plan v1, paused), so the dashboard shows **Play**. With `HFA_AUTORUN=0` it shows **Start run** (plan v0). `scripts/coldstart-e2e.mjs` passes 39/39 with `HFA_AUTORUN=0`; with autorun on, its two "fresh server is v0 / clock 409" checks fail, as expected.
- **`POST /api/jobs`:** a valid job returns 202, then J13 appears and is assigned. A bad block returns 400 "There is no block Z on this farm."; the dashboard puts that error on the Block field. Pydantic range errors (`details.errors[].loc`) are mapped to the Duration and Priority fields.
- **Works end to end in the browser** (`?source=live&api=http://localhost:8000`):
  - cold start: plan v0, paused, Start run, plan v1, Pause/Play
  - Restart day
  - tractors moving
  - timeline and plan badge
  - breakdown, then re-plan, explanation and the "Mark repaired" chip (`tractor_repaired`)
  - Block a road, with a reroute and barrier
  - priority change from the Why sheet (`PATCH /jobs`)
  - Skip to sunset, then the end-of-day keynote (12/12 done)
  - operation lifecycle and gap-free `seq` on `/ws`
  - Idempotency-Key replay and the 409 CONFLICT
- **Hidden by the dashboard** (capability detection, `dashboard/src/data/capabilities.js`):
  - heat alert and wind gust, which return 400
  - the Why comparison, cockpit controls, mechanics and approvals, which return 501
  - placeholder weather is labelled as such
- **Contract match:** the REST and WS shapes match `contract/examples`. These match at top-level and nested keys: state, scenario, fleet, jobs, metrics, weather, hosts, operations, clock, plan, poses, operation. The differences are listed below.

## Issues

Severity: **blocks demo** / **visible glitch** / **cosmetic**.

| # | Endpoint | Expected (contract) | Actual | Severity | Suggested fix |
|---|---|---|---|---|---|
| 1 | `GET /api/state` `.capacity`, `GET /api/hosts` | "`AT_CAPACITY` only when the compute pool is actually full" (§8.6) | `max` always equals the current fleet size (`state.py capacity_view`), so the fleet always looks full. The dashboard used to disable **Add tractor** because of it. Now it skips the pre-check when every host is `docker: "none"`, and `POST /fleet` itself works. | blocks demo (now worked around in the UI) | Report a configured cap such as `max: 8` (env `HFA_MAX_TRACTORS`) or `max: null` |
| 2 | Explanation `text` (WS `explanation`, `state.explanations`) | §4: "Tractor 1 broke down 60% of the way through spraying Block E…" (plain English for the operator) | Raw IDs and decimals, for example "J1 moves from T1 to T3; 0% of work is already completed. J3 now starts at farm minute 89.40, previously 296.00." The text is long and repeats once per job. For add/remove/patch it is only "Validated plan preserves ongoing work." | visible glitch | `explain()` should use job labels and tractor names, clock times (6:00 AM + t) and rounded minutes, summarise retimes ("4 jobs start later"), and name the trigger ("Tractor 4 joined the fleet; no jobs moved.") |
| 3 | `POST /api/events` `heat_alert`, `weather_change` | §5 EventInput lists both | 400 INVALID_INPUT "not modeled in this build". OpenAPI `EventInput.type` still lists them in its enum, so a client can't tell from the schema. | visible glitch (UI now disables them) | Model them, or drop them from the enum. Better: serve `GET /api/capabilities` (see "Requested" below). |
| 4 | `GET /api/why/{job}`, `GET /api/mechanics`, `POST /api/mechanics/book`, `/api/tractors/{id}/controls`, `/control`, `/preview`, `/manual`, `POST /api/approve`, `POST /api/scale-test` | §5 rows 13-20 and 24 | 501 `INTERNAL` with `details.not_implemented: true` | visible glitch (UI now hides them) | Implement, or at least use a distinct code (`NOT_IMPLEMENTED`) and list them in `/api/capabilities` |
| 5 | Breakdown → `pending` | §4 Pending `kind: "mechanic"`; §6 `pending` message "Added or resolved" | No pending item and no WS `pending` message after a breakdown. The tractor goes `broken` and returns only through `tractor_repaired`. | visible glitch (no mechanic sheet; "Mark repaired" still works) | Emit a `mechanic` pending item once mechanics exist |
| 6 | `POST /api/fleet` | §5 row 10: returns `{tractor}` "with status `starting` (202). Ready arrives later on WS." | 202, but `tractor.status` is already `idle`. There is no `starting` phase and no `tractor_ready` delay. | cosmetic | Fine for MockGateway; document it, or send `starting` and then `idle` |
| 7 | Unknown route (`GET /api/nothing`), wrong method (`GET /api/jobs/NOPE`) | §5: every error is `{error:{code,message,details}}` | `{"detail":"Not Found"}` (404) and `{"detail":"Method Not Allowed"}` (405), the FastAPI defaults | cosmetic | Add a Starlette `HTTPException` handler that wraps these in the contract error shape |
| 8 | `POST /api/clock` right after `POST /api/run` | Not specified | 409 CONFLICT "Start a run first" while the run Operation is still `queued`, even though it was accepted. At 7df3d39 this happens only with `HFA_AUTORUN=0`. | cosmetic (the UI waits for the op) | Accept clock changes once a run is queued, or say "A run is starting" |
| 9 | Explanation `facts` | §4 example keys `travel_delta_min`, `idle_delta_min` | Missing. Diya's notes say this is deliberate until both plans are measured. Extra keys: `newly_assigned`, `retimed`, `unassigned`, `improvement_*`, `search_budget_exhausted`. | cosmetic (the dashboard treats them as optional) | Send them as `null` until measured (§13.4 "null, never invented zeros"), so the key set is stable |
| 10 | `metrics.baseline` | §4 `baseline_source` `live`/`simulated` | `null` in the live server ("Baseline not run yet"); the side-by-side comparison only comes from the headless runner | visible glitch at 945edd1. **Fixed in 7df3d39** (FCFS twin, `baseline_source: "simulated"`, null for about 0.5 s after each operator action) | none |
| 11 | WS `capacity`, `weather` | §6: send on pool / conditions change | Never sent. Capacity changes after add/remove reach the client only through the next snapshot. | cosmetic | Broadcast `capacity` after fleet add/remove |
| 12 | Scripted T1 breakdown at t=50 | n/a | It fires even when the operator already broke down and repaired T1 by hand, so T1 breaks again during the demo | cosmetic (surprising in a demo) | Skip scripted events for a tractor that already had a manual one, or make them opt-in (`HFA_SCRIPTED=0`) |
| 14 | Backend test `test_baseline_appears_only_when_it_matches` (7df3d39) | n/a | Fails consistently on an Apple Silicon Mac: the test reads `/api/baseline` `status: "computing"`, then reads `metrics.baseline` after the twin has already finished, so the value is not null. This is a check-then-read race in the test, not in the server. | cosmetic (test only) | Assert on one consistent read (status and baseline from the same response), or pause the twin worker in the test |
| 13 | Planner balance (Diya) | n/a | The initial plan gives T3 (sprayer + mower) no work while T1 and T2 carry 12 jobs. After a repaired breakdown, the repaired tractor gets no work back (everything stays on T3). | visible glitch | Consider an idle-tractor or rebalance move after `tractor_repaired` and at day start |

Not issues (mock-only smoke checks that the real backend legitimately lacks):
- `X-Mock-Fail` forced errors.
- The `/openapi.json` `routes[]` shape, which belongs to the Node mock. FastAPI uses `paths`.
- CORS on `GET` without an `Origin` header. The real backend sends `access-control-allow-origin: *` whenever the browser sends `Origin`, and the preflight allows `content-type, idempotency-key`.

## Requested: `GET /api/capabilities`

The dashboard already calls it (optional) and lets it override what it infers. Proposed shape, every key optional:

```json
{ "backend": "fastapi",
  "events": { "breakdown": true, "block_route": true, "unblock_route": true, "tractor_repaired": true,
              "priority_change": true, "heat_alert": false, "weather_change": false },
  "why": false, "controls": false, "mechanics": false, "approve": false, "scaleTest": false,
  "submitJobs": true, "patchJob": true, "weatherEnforced": false, "metricsMeasured": true }
```

Until it exists, the dashboard does three things:
- It identifies the FastAPI backend by `/openapi.json` having `paths`.
- It probes `GET /why/{job}`, `GET /tractors/{id}/controls` and `GET /mechanics?tractor=` (501 means the feature is off).
- It uses a fixed profile for the POST-only features in rows 3 and 4.

## How to reproduce

```bash
# backend (from repo root, macOS/Linux)
python3 -m venv .venv && .venv/bin/python -m pip install -r backend/requirements.txt
cd backend && ../.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
# dashboard
cd dashboard && npm install && npx vite --port 5173
# open http://localhost:5173/?source=live&api=http://localhost:8000  -> Start run
```

# Integration report: dashboard vs the FastAPI backend (`origin/anay` 945edd1)

> All of this is now on `main`: the backend is `backend/` (from `origin/diya/brain` 20d266e, which includes Anay's 7df3d39) and the dashboard is `dashboard/` (from `divi` f8e903f). Run the backend with `cd backend` as in `backend/README.md`; branch names below are historical.

For Anay (platform) and Diya (planner). Tested 2026-11-15 against `origin/anay` at 945edd1, which already contains `origin/diya/brain` b3aca18, then re-checked against **7df3d39** (cold-start autorun, staged edits, baseline twin) and **`origin/diya/brain` 20d266e** on top of it (capabilities endpoint, configured capacity, error envelope, explanation wording, `HFA_SCRIPTED`). Python 3.13 venv, `pip install -r backend/requirements.txt`, server on port 8000. Dashboard: `divi` with the capability-detection and Start run changes. This report covers the backend only. Nothing under `backend/` was edited.

## Summary

- **Backend tests:** at 945edd1, brain 23, platform 26 and integration 45 all pass (unittest, as documented in `backend/README.md`). At 7df3d39, brain 23 and platform 26 pass, and integration fails 1 of 57 consistently on this Mac: `test_api.BaselineDisplay.test_baseline_appears_only_when_it_matches` (issue 14).
- **Cold start at 7df3d39 (fixed: pre-plan at startup):** the server plans at startup (plan v1, paused), so the dashboard shows **Play** and Play works without `/run`. With `HFA_AUTORUN=0` it shows **Start run** (plan v0). `scripts/coldstart-e2e.mjs` now accepts both startups (v0 + clock 409, or pre-planned + Play) and passes against a fresh autorun server.
- **At 20d266e:** brain 23 and platform 26 pass; integration fails 1 of 61, the same `test_baseline_appears_only_when_it_matches` race (issue 14). `scripts/coldstart-e2e.mjs --dashboard-capabilities` passes with autorun on and with `HFA_AUTORUN=0`. Issues 1, 3 (via `/api/capabilities`), 2, 6, 7 and 12 are resolved there; 13 is now documented as an optimizer trade-off.
- **Staged job edits at 7df3d39 (fixed):** an incompatible pin is refused up front with **422 `SAFETY_REJECTED`** ("Can't pin Hedge D to Tractor 1: it has no hedger.") and `pinned_to` stays unchanged; an edit no valid plan accepts fails its Operation (`SAFETY_REJECTED`, `no_feasible_plan`) and the job keeps its old values, with no WS `jobs` message carrying the staged value. The dashboard's Why sheet says "Couldn't change priority: no valid plan accepts it — kept High". See issue 15 for one case that is accepted instead.
- **Baseline at 7df3d39 (fixed):** `metrics.baseline` (FCFS twin, `simulated`) is non-null within a few ms of startup, `/run`, `POST /jobs` and a breakdown in the e2e run; the dashboard holds the last values dimmed ("updating…") during the ~0.5 s recompute.
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
| 1 | `GET /api/state` `.capacity`, `GET /api/hosts` | "`AT_CAPACITY` only when the compute pool is actually full" (§8.6) | `max` always equals the current fleet size (`state.py capacity_view`), so the fleet always looks full. The dashboard used to disable **Add tractor** because of it. Now it skips the pre-check when every host is `docker: "none"`, and `POST /fleet` itself works. | blocks demo (now worked around in the UI). **Resolved in 20d266e**: `max` is a configured limit (default 8, `HFA_MAX_TRACTORS`), `used` = fleet size, add/remove emit `capacity`, 409 `AT_CAPACITY` at the limit | none |
| 2 | Explanation `text` (WS `explanation`, `state.explanations`) | §4: "Tractor 1 broke down 60% of the way through spraying Block E…" (plain English for the operator) | Raw IDs and decimals, for example "J1 moves from T1 to T3; 0% of work is already completed. J3 now starts at farm minute 89.40, previously 296.00." The text is long and repeats once per job. For add/remove/patch it is only "Validated plan preserves ongoing work." | visible glitch. **Resolved in 20d266e**: human names, clock times, bounded summaries; add/remove/repair name the event even when no work moves | none |
| 3 | `POST /api/events` `heat_alert`, `weather_change` | §5 EventInput lists both | 400 INVALID_INPUT "not modeled in this build". OpenAPI `EventInput.type` still lists them in its enum, so a client can't tell from the schema. | visible glitch (UI now disables them). **Resolved in 20d266e** via `GET /api/capabilities` (heat/weather/ripening false); the dashboard uses it directly | none |
| 4 | `GET /api/why/{job}`, `GET /api/mechanics`, `POST /api/mechanics/book`, `/api/tractors/{id}/controls`, `/control`, `/preview`, `/manual`, `POST /api/approve`, `POST /api/scale-test` | §5 rows 13-20 and 24 | 501 `INTERNAL` with `details.not_implemented: true` | visible glitch (UI now hides them) | Implement, or at least use a distinct code (`NOT_IMPLEMENTED`) and list them in `/api/capabilities` |
| 5 | Breakdown → `pending` | §4 Pending `kind: "mechanic"`; §6 `pending` message "Added or resolved" | No pending item and no WS `pending` message after a breakdown. The tractor goes `broken` and returns only through `tractor_repaired`. | visible glitch (no mechanic sheet; "Mark repaired" still works) | Emit a `mechanic` pending item once mechanics exist |
| 6 | `POST /api/fleet` | §5 row 10: returns `{tractor}` "with status `starting` (202). Ready arrives later on WS." | 202, but `tractor.status` is already `idle`. There is no `starting` phase and no `tractor_ready` delay. | cosmetic. **Resolved in 20d266e** by ARCHITECTURE.md §14: MockGateway fleet creation is immediate (`idle` + `tractor_ready`/`fleet`/`capacity`); the dashboard toasts "joined the fleet" for it | none |
| 7 | Unknown route (`GET /api/nothing`), wrong method (`GET /api/jobs/NOPE`) | §5: every error is `{error:{code,message,details}}` | `{"detail":"Not Found"}` (404) and `{"detail":"Method Not Allowed"}` (405), the FastAPI defaults | cosmetic. **Resolved in 20d266e**: `NOT_FOUND` / `METHOD_NOT_ALLOWED` in the normal envelope, Allow headers kept | none |
| 8 | `POST /api/clock` right after `POST /api/run` | Not specified | 409 CONFLICT "Start a run first" while the run Operation is still `queued`, even though it was accepted. At 7df3d39 this happens only with `HFA_AUTORUN=0`. | cosmetic (the UI waits for the op) | Accept clock changes once a run is queued, or say "A run is starting" |
| 9 | Explanation `facts` | §4 example keys `travel_delta_min`, `idle_delta_min` | Missing. Diya's notes say this is deliberate until both plans are measured. Extra keys: `newly_assigned`, `retimed`, `unassigned`, `improvement_*`, `search_budget_exhausted`. | cosmetic (the dashboard treats them as optional) | Send them as `null` until measured (§13.4 "null, never invented zeros"), so the key set is stable |
| 10 | `metrics.baseline` | §4 `baseline_source` `live`/`simulated` | `null` in the live server ("Baseline not run yet"); the side-by-side comparison only comes from the headless runner | visible glitch at 945edd1. **Fixed in 7df3d39** (FCFS twin, `baseline_source: "simulated"`, null for about 0.5 s after each operator action) | none |
| 11 | WS `capacity`, `weather` | §6: send on pool / conditions change | Never sent. Capacity changes after add/remove reach the client only through the next snapshot. | cosmetic | Broadcast `capacity` after fleet add/remove |
| 12 | Scripted T1 breakdown at t=50 | n/a | It fires even when the operator already broke down and repaired T1 by hand, so T1 breaks again during the demo | cosmetic (surprising in a demo). **Resolved in 20d266e** as an option: `HFA_SCRIPTED=0` disables scripted events (live run and baseline twin) for a manual-only demo | none |
| 14 | Backend test `test_baseline_appears_only_when_it_matches` (7df3d39) | n/a | Fails consistently on an Apple Silicon Mac: the test reads `/api/baseline` `status: "computing"`, then reads `metrics.baseline` after the twin has already finished, so the value is not null. This is a check-then-read race in the test, not in the server. | cosmetic (test only) | Assert on one consistent read (status and baseline from the same response), or pause the twin worker in the test |
| 15 | `PATCH /api/jobs/{id}` impossible deadline mid-day (7df3d39) | README: "applied only if a valid plan accepts it; otherwise SAFETY_REJECTED" | At t=0 `{"deadline_t":5}` on J1 fails (`SAFETY_REJECTED`, job unchanged), as described. Mid-day (t≈1.4-3), `{"deadline_t":1}` on J2/J3 **succeeds**: plan v+1 is applied with the job in `unassigned_job_ids`, `deadline_t` becomes 1 and the job drops to `pending` ("No valid assignment right now … deadline"). So an impossible deadline can silently unassign a job instead of being rejected. | visible glitch (an operator typo unschedules a job) | Treat "the edited job becomes unassigned because of the edit" as a rejection, or document that this is intended |
| 13 | Planner balance (Diya) | n/a | The initial plan can leave T3 (sprayer + mower) without work, and a repaired tractor may get no work back. Per Diya's README (20d266e) this is an **optimization trade-off, not a bug**: the objective prefers weighted on-time completion, on-time count, travel, then waiting; it does not maximize utilization, and committed work isn't moved. The UI now explains unchanged repair assignments. | open question | Evaluate balance across scenarios before changing the objective; never claim every repair transfers work |

Not issues (mock-only smoke checks that the real backend legitimately lacks):
- `X-Mock-Fail` forced errors.
- The `/openapi.json` `routes[]` shape, which belongs to the Node mock. FastAPI uses `paths`.
- CORS on `GET` without an `Origin` header. The real backend sends `access-control-allow-origin: *` whenever the browser sends `Origin`, and the preflight allows `content-type, idempotency-key`.

## `GET /api/capabilities` (served since 20d266e, ARCHITECTURE.md §14)

The dashboard requests it first and, when served, uses it as is (no probing). The shape served by 20d266e matches this proposal, plus `ripening_change: false`. Proposed shape, every key optional:

```json
{ "backend": "fastapi",
  "events": { "breakdown": true, "block_route": true, "unblock_route": true, "tractor_repaired": true,
              "priority_change": true, "heat_alert": false, "weather_change": false },
  "why": false, "controls": false, "mechanics": false, "approve": false, "scaleTest": false,
  "submitJobs": true, "patchJob": true, "weatherEnforced": false, "metricsMeasured": true }
```

Without it (older backends), the dashboard falls back to three things:
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
# open http://localhost:5173/?source=live&api=http://localhost:8000  -> Play (Start run only with HFA_AUTORUN=0)
```

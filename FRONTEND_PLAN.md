# Frontend Plan (Divi) - revised for ARCHITECTURE.md §13

Fleet strategy: design for ~5 tractors first and make it look best at 5 (lanes, chips, labels, camera framing, scale test = 5); scaling to 50+ is a later, separate milestone (M7).

Stack: Vite + vanilla JS + three@0.128.0 in `dashboard/`, built by improving `reference/ui-mock.html` (keep every visual). Components read only from `dashboard/src/data/` (`sourceInfo`, `start()`, `store.get/subscribe`, `api.*`). `?source=mock|live&api=http://localhost:8000`.

**Process:** one milestone at a time. Each ends with a numbered Visual check. Nothing starts until Divi says yes. **Status: M1 in progress (approved).**

## 1. What changed (§13 supersedes earlier sections)
- `POST /api/run`, `POST /api/jobs`, `PATCH /api/jobs/{id}`, `POST /api/events`, `POST /api/tractors/{id}/manual`, `POST /api/mechanics/book`, `POST /api/approve` always return **202 + Operation**, not the old plan bodies. 202 = accepted, not applied.
- `/control` stays synchronous for non-replanning controls. For `replans: true` controls, branch on status: 409 `CONFLICT` while running, else 202 Operation.
- New WS message `operation` (full Operation, normal envelope). Snapshot gains `operations[]` (active plus last 20 terminal, newest first). `GET /api/operations/{id}` (404 if unknown).
- Emit order: `operation(running)` -> `plan` -> `explanation` -> `jobs` -> other state (`pending`, `fleet`, `metrics`) -> `operation(final)`. A new run sends `snapshot` after reset, then the terminal operation.
- Operation: `kind` run|replan|repair_booking|approval; `status` queued|running|succeeded|failed|superseded; `source` run|jobs|job_patch|events|manual|control|mechanics_book|approve; `result` by kind (plan: `applied_plan_version`, `unassigned_job_ids`; repair: tractor, mechanic, `arrival_t`, `estimated_return_t`; approval: `pending_id`, `decision`, `applied_plan_version`). Failed: `error {code,message,details}` (e.g. `SAFETY_REJECTED` + `no_feasible_plan`); never a bad plan broadcast. Superseded is not success.
- Job: `unassigned_reason`; unassigned = `pending` with null tractor/start/end/eta. `dropped` only for cancel.
- Plan: `solver_status` feasible|optimal|fallback|no_feasible_plan. Never label feasible as optimal. Reset plan is version 0, feasible.
- RunMetrics: 5 nullable keys (`weighted_on_time`, `productive_min`, `original_deadline_on_time`, `replan_ms_last`, `rejected_candidates`). Show only when non-null, never as 0. Show completion next to efficiency.
- Repair: booking does not make a tractor schedulable. Frontend must send `POST /api/events {type:"tractor_repaired", tractor}` (Mark repaired). Breakdown stops tractor immediately, before planning.
- Approval `override` = reject (proposal unapplied). Real edits go through PATCH.
- Preview/Why/scale-test: HTTP 503 `TIMEOUT` is a real outcome (show it, no fake numbers). New error code `TIMEOUT`.
- Retries use `Idempotency-Key` (same key + same body = same Operation; other endpoint/body = 409). Reconnect restores truth from snapshot; a REST timeout is not a failure.

## 2. Milestones

| # | Scope | Backend dependency (mock stands in?) |
|---|---|---|
| **M1** (in progress) | Scaffold; `contract/examples/`; data layer (MockSource + LiveSource); whole mock ported onto it (diorama, sky, tilt-shift/bloom, ribbons, Island, glass dock + springing pills, breakdown slow-mo/smoke, van, barriers, heat glow, Why sheet, scorecard); dynamic fleet (up to ~5 tractors, tuned to look best at 5) + Add tractor sheet; job labels on blocks; priority pills (ordered/colored by priority, thin tractor-color edge); §13 Operation handling in MockSource (202, emit order, ops in snapshot) | None. Mock emits exact contract shapes. |
| **M2** Live handshake (by 1:45) | `?source=live`: snapshot, `poses` from real tractors, WS reconnect/resnapshot, error toast on bad `api=` | Anay `/api/state`, `/ws`. Mock can't prove it; needs real server. |
| **M3** Operation UX (by 3:00) | Per-operation spinner in Island/dock; failed (plain-language error); superseded ("replaced"); one op finishing never clears another's spinner; ops restored on reconnect; Idempotency-Key retries | Operation endpoints/WS. Mock injects fail/superseded via a debug flag. |
| **M4** Plan truth (by 3:00) | Unassigned tray (reason on card + detail, clears on reassign); solver badge (feasible/optimal/fallback); PATCH priority from pill; extra metrics when non-null | §13.1/13.4 fields. Mock yes. |
| **M5** Breakdown loop (by 3:00) | Breakdown -> explanation -> mechanic sheet -> book (use op result) -> Mark repaired -> work returns; approval approve/reject (override = reject); 4xx/409 handling | `/events`, `/mechanics/book`, `/approve`. Mock yes; live confirm. |
| **M6** Live end-to-end gate (3:00) | Full scripted run on live: plan, work, breakdown, replan, explanation, scorecard vs baseline, violations counter; fix contract drift | All must-haves live. |
| **M7** Scale to 50+ (after must-haves) | Virtualized lanes + fit all, instanced tractors, dynamic colors, filterable fleet list, capacity banner (`AT_CAPACITY`), Starting state, scale-test view handling the backend's 50/200 result (or 503 TIMEOUT) | `/fleet`, `capacity`, `/scale-test`. Mock can emit 50 tractors. |
| **M8** Live feed view | Simulated\|Live toggle, aerial basemap, heading + implement bar, trails, AB lines, coverage painting, readouts, follow, camera switch | `poses.tool`, `coverage`. Mock needs synthetic coverage. |
| **M9** Weather UI, then control panel | Wind particles + compass, spray windows, hatched bands, sensitive areas; schema-rendered tabbed control sheet, Manual badge, preview confirm | `weather`, `/controls`, `/control`, `/preview`. Mock yes. |
| **M10** Polish, freeze 4:00, demo | Effects toggle, spring pills, Island morphs, keynote scorecard; freeze; backup video during final live run; rehearse x2 | Anay's final runs. |

### Visual checks
**M1** (open `cd dashboard && npm run dev`, `?source=mock`)
1. Page loads with diorama, sky cycle, Island "6:00 AM", glass timeline dock; no console errors.
2. Play: tractors drive, ribbons glow, pills fill.
3. Block labels show job names (e.g. "Spray E").
4. Dock pills ordered by priority: red high, orange medium, grey low, each with a thin tractor-color edge.
5. Click Add tractor, fill the sheet: a new tractor, lane and card appear; add 3 more (5 total), lanes, chips, labels and camera framing still look right.
6. Trigger breakdown: slow-mo, smoke, Island morphs, explanation, mechanic van after booking.
7. Change a pill's priority: pill recolors and reorders after a short "running" state (PATCH, 202).
8. Open Why sheet from a pill; end of day shows scorecard.
9. Console/Network: mock operations appear as queued -> running -> succeeded in the store.
10. `?source=live` with no server shows a clear "backend unreachable" state, not a blank page.

**M2** 1. Start backend, open `?source=live&api=http://localhost:8000`. 2. Island shows connected; fleet cards match `curl /api/state`. 3. Tractors move live. 4. Kill backend: banner appears; restart: it recovers with fresh snapshot.

**M3** 1. Click Run: spinner on Run while running, then clears. 2. Fire breakdown plus a PATCH at once: two independent spinners; finishing one keeps the other. 3. Force failure (debug flag): plain-language error, plan unchanged. 4. Force superseded: "replaced" chip, not a success tick. 5. Reload mid-operation: spinner returns. 6. Double-click an action: one operation.

**M4** 1. Remove the only sprayer: spray job goes to the Unassigned tray with its reason. 2. Add a sprayer: job leaves the tray, reason gone. 3. Badge reads feasible (optimal/fallback only when sent). 4. Metrics null: extra rows hidden; present: shown beside completion.

**M5** 1. Breakdown: tractor stops immediately, explanation card appears. 2. Book mechanic: confirmation shows arrival and return time from the op result. 3. Tractor stays out of service until Mark repaired. 4. Click Mark repaired: it gets work with an explanation. 5. Pending approval: Approve applies; Reject (override) leaves the plan unchanged. 6. Bad input shows 4xx message.

**M6** Scripted live run start to scorecard with no console errors; violations 0; ours vs baseline visible.

**M7** 1. Mock with 50 tractors: lanes virtualized, Fit all works, filter finds a tractor. 2. Instanced tractors hold 60 fps. 3. Capacity banner shows on forced `AT_CAPACITY`. 4. Scale test shows the 50/200 result or a TIMEOUT message. 5. Back at 5 tractors the layout still looks as in M1.

**M8** 1. Toggle Live feed: camera tilts overhead, cross-fades to aerial. 2. Heading arrows, implement bars, trails. 3. Breakdown: backup paints from where the broken one stopped. 4. Tap tractor: follow mode and readout.

**M9** 1. Wind change: particles/compass, hatched bands, spray pill "Waiting for wind". 2. Control sheet renders tabs from schema; manual badge; preview confirm; replans control shows 202 vs 409 handling.

**M10** Effects toggle works; full demo rehearsal twice; backup video saved.

## 3. Contract-gap questions (Anay/Diya)
1. `coverage` cells `[x, y, rgb_int]`: x/y axes (east/north metres from `origin`, or cell indices x `cell_m`)? rgb packing (0xRRGGBB?), alpha?
2. `map_pick` control: value shape (lat/lon? grid cell? block id?) and how the UI sends it.
3. Live-feed readouts: where do cross-track error, heartbeat age, autosteer/sections, container port live? `poses` lists only `tool`, `agopenweb`; confirm fields.
4. Operation `source: control` and `manual`: which `kind` for `/manual` (replan?) and for replanning controls? Does `/manual` always replan?
5. Fixture `plan_feasible.json` is empty at `version: 8`; §13.1 says only version 0 is a valid empty plan. Fix fixture or confirm.
6. Metrics fixture has `baseline_source: null` with a populated baseline object: should baseline be null when unmeasured? How to label source?
7. Is `priority_change` event still valid vs PATCH? Both fire replan ops: any conflict rule?
8. `tractor_repaired` event: is a `tractor_repaired` WS/log echo guaranteed, and does it get its own Operation?
9. 409 on `/control` while running: is the running op id in `error.details`?
10. Snapshot `operations` dedupe vs live `operation` messages (by `id`, latest `updated_t` wins)?

## 4. Cut order and never-cut
Cut from top: (1) optional LLM wording, (2) control panel Advanced/Vehicle tabs, (3) mechanic van animation (keep sheet and booking), (4) live coverage painting (keep tractors and trails), (5) OR-Tools. Frontend adds: weather UI before control panel polish; keynote scorecard polish before Live feed only if Live feed is blocked.

**Never cut:** live tractors with no fleet-size cap (50+ via M7) and Add tractor; compatible assignment shown; Safety/0 violations counter; breakdown recovery with progress kept; explanations; scorecard vs baseline; event logs; operation spinners/failure states; unassigned tray; Mark repaired.

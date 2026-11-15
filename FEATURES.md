# Harvest Fleet AI: Feature List (step by step, by person)

> Companion to PROJECT.md (base doc + Changes 1 to 11) and ARCHITECTURE.md (the API contract).
> Work top to bottom. A step is done only when its "Done when" check passes.
> Deadline **5:00 PM**. It's 12:20 now, so the schedule below is re-timed (PROJECT.md Change 11).

## Who owns what

| Person | Role | Owns |
|---|---|---|
| **Divi** | Frontend | The whole dashboard (3D diorama, Live feed, glass panels, all sheets), the in-browser MockSource, `contract/examples/`, demo script and backup video |
| **Anay** | Platform | AgOpenWeb containers, compute pool / Fleet Manager, AgOpenWeb gateway, FastAPI app (routes, WebSocket hub, state store), world service (clock, progress, fuel, events, event log), Live feed data, tractor control mapping to AgOpenWeb |
| **Diya** | Brain | Scenario data, MockGateway, all agents (Navigation, Fleet planner greedy + OR-Tools, Safety, Weather, Agronomy, Mechanic), re-planning, explanations, "Why?", preview, baseline, metrics, scale test, README |

Swap Anay and Diya if their strengths fit the other role better. Ownership stays per column, not per person.

## Checkpoints
| Time | Checkpoint |
|---|---|
| **1:00 PM** | One AgOpenWeb container steered from Python. Dashboard shell on mock. Greedy plan prints. |
| **1:45 PM** | Live handshake: dashboard on `?source=live` shows `/api/state` and live `poses` from 3 AgOpenWeb tractors. |
| **3:00 PM** | All must-haves work end to end, live. |
| **4:00 PM** | Feature freeze. |
| **4:40 PM** | Submitted (20 min buffer). |

---

## Phase 0: Foundations (12:20 to 1:00)

### 1. Repo and contract (Divi, with everyone, 10 min)
- Repo: `backend/` (FastAPI), `dashboard/`, `infra/` (Docker), `data/`, `contract/`.
- Everyone reads ARCHITECTURE.md Sections 2 to 6. `contract/examples/`: one JSON file per response and WebSocket message, copied from ARCHITECTURE.md.
- **Done when:** repo exists, everyone can run their part locally, examples committed.

### 2. AgOpenWeb in a container (Anay)
- Docker image of AgOpenWeb (.NET 10, `--headless`), one container on port 5174, simulator on.
- Python adapter: `control.acquire`, heartbeat every 0.4 s, decode the Tick frame (position, heading, speed, tool pose, autosteer/section/U-turn flags).
- **Done when (1:00):** Python creates an AB line, engages autosteer, and the tractor follows it while its pose prints.

### 3. FastAPI skeleton (Anay)
- `app/models.py` and `app/main.py` from ARCHITECTURE.md Sections 9 and 10. State store in `core/`. `GET /api/state` and `/ws` sending `snapshot`, then `poses` from MockGateway.
- **Done when:** a browser WebSocket client receives `snapshot` then `poses`.

### 4. Scenario and MockGateway (Diya)
- `data/scenario.json`: 8 blocks, depot, roads, about 12 jobs, 3 starting tractors, events, weather timeline, sensitive areas, basemap bounds, geo origin. Sized for a 10 to 12 minute live demo day.
- MockGateway implementing the `TractorGateway` interface (instant movement in Python).
- **Done when:** three mock tractors move along routes and report poses in the ARCHITECTURE.md `Tractor.pose` shape.

### 5. Navigation + greedy Fleet Agent (Diya)
- A* on the road grid (blocked cells impassable), travel time matrix.
- Greedy planner: jobs by priority then deadline, cheapest compatible tractor (travel + idle + lateness), fuel check with refuel stops, candidates saved for "Why?".
- **Done when (1:00):** a full plan prints with every job on a compatible tractor.

### 6. Dashboard shell + MockSource (Divi)
- Data layer with MockSource and LiveSource behind one interface, `?source=mock|live`.
- MockSource replays the ARCHITECTURE.md shapes (start from the UI mock's simulation code).
- 3D diorama (island, roads, blocks, instanced trees, depot), glass layout, Dynamic Island.
- **Done when (1:00):** the diorama shows tractors moving from MockSource `poses`.

---

## Phase 1: Must-haves (1:00 to 3:00)

### 7. Three live AgOpenWeb tractors (Anay)
- docker-compose: three containers, ports 5174 to 5176, CPU-limited, same 8 fields mounted in each, field origins lookup table.
- AgOpenWebGateway: E/N to grid and lat/lon, transit by stepping `sim.setCoords` along routes, field work (field open, AB line, sections, U-turns, autosteer), job completion detection.
- **Done when (1:45):** three containers run three jobs at once, and their poses stream to `/ws`.

### 8. World service (Anay)
- Clock (compressed farm time), job progress from poses, fuel model, event engine (breakdown, block_route, priority_change, weather_change), event log writer (`event_log_ours.jsonl`), throttled `poses`/`jobs`/`metrics`/`clock` broadcasts.
- **Done when:** a full run writes the event log and broadcasts every message type in ARCHITECTURE.md Section 6 that exists so far.

### 9. Safety Agent (Diya)
- Plan checks: implement match, operational, fuel reserve 10%, no job twice, no two tractors in one block at once, no blocked roads, completed jobs never reassigned, weather rules once step 16 lands.
- Live invariant checker every tick, violation counter.
- **Done when:** a deliberately bad plan is rejected with the rule named, and the demo run has 0 violations.

### 10. Breakdown recovery + explanations (Diya, with Anay for the gateway stop)
- Anay: `/api/events` breakdown stops that container's tractor (`sim.stop`, autosteer off).
- Diya: re-plan (freeze done and in-progress-on-healthy-tractors, keep progress, reassign the rest), Safety check, apply, explanation from the plan diff (numbers from facts only).
- Messages in order: `plan`, `explanation`, `jobs`.
- **Done when:** a mid-job breakdown never loses or duplicates work, and the explanation numbers match the plan.

### 11. Baseline + metrics (Diya)
- FCFS dispatcher, same scenario, events, weather rules (it just waits), same fleet changes. Metrics exactly as defined in PROJECT.md Section 7.
- **Done when:** ours vs baseline table prints (completed, on time, travel, idle, violations).

### 12. Dashboard core on live data (Divi)
- Tractors on the diorama from `poses`, route ribbons from `plan`, status rings.
- Fleet cards (fuel ring, status, job, AgOpenWeb chip), timeline dock (lanes, pills, now line), explanation card, activity feed (`log`), scorecard + violation counter, event buttons (`POST /api/events`).
- **Done when (3:00):** on `?source=live`: plan, work, breakdown, re-plan, explanation, scorecard all play from the real backend.

---

## Phase 2: Wow and stretch (3:00 to 4:00, top to bottom)

### 13. Unlimited plug-and-play tractors (Anay + Diya + Divi) (non-negotiable)
- Anay: `fleet.json` entries, Fleet Manager add/remove/health, compute pool (`hosts.json`, remote Docker over SSH on teammate laptops, measured capacity, warm pool, `AT_CAPACITY`), `POST/DELETE /api/fleet`, `/api/hosts`, `capacity` messages.
- Diya: re-plan on `tractor_added` / `tractor_removed` with explanation, baseline gets the same changes, no fleet-size assumption in any agent, scale test (`POST /api/scale-test`, 50 tractors / 200 jobs on MockGateway).
- Divi: dynamic colors and lanes, instanced tractors, filterable fleet list, virtualized lanes with "fit all", Add tractor sheet, Starting state, capacity banner, scale-test view.
- **Done when:** tractors keep being added live across at least two laptops until capacity runs out, each takes jobs with an explanation, and the scale test shows 50 tractors with 0 violations.

### 14. Optimizer upgrade: OR-Tools (Diya)
- Vehicle routing with time windows behind the greedy interface: allowed vehicles by implement, travel matrix, soft deadlines, drop penalties, weather forbidden times, fuel dimension, 1 to 5 s limit by fleet size, greedy fallback, rolling re-plan.
- **Done when:** beats greedy on travel and idle for the demo scenario, 0 violations.

### 15. Live feed view (Anay + Divi)
- Anay: decode tool pose and coverage frames (types 3 and 4), throttled `coverage` messages, basemap served at `/static/naip.png`.
- Divi: Simulated | Live feed toggle, aerial basemap, tractors with heading and implement bar, trails, AB lines, live coverage, tap readouts, follow mode, animated camera switch.
- **Done when:** after a breakdown, Live feed shows the backup tractor painting coverage from exactly where the broken one stopped.

### 16. Weather Agent (Diya + Divi, Anay for the live guard)
- Diya: `weather_rules.json` (spray only at 3 to 10 mph and not toward sensitive areas, no spray under 3 mph, rain/temp limits, mowing/hauling limits), spray windows per job into the planner, `weather` messages, `/api/weather`.
- Anay: live guard sends sections off and holds the tractor when wind leaves range mid-spray.
- Divi: wind particles + compass, weather card with spray windows, hatched no-spray bands, sensitive areas glowing when downwind, "Waiting for wind" pills.
- **Done when:** a wind-change event pauses a spray job, the sprayer switches to other work, and the explanation cites the limit.

### 17. "Why?" (Diya + Divi)
- Diya: counterfactual re-solves per tractor, `GET /api/why/{job}`.
- Divi: tap a pill to open the Why sheet.
- **Done when:** every tractor shows a real number or a reason.

### 18. Tractor Control Panel (Anay + Diya + Divi)
- Anay: control schema, `/controls`, `/control`, `/manual`, mapping to AgOpenWeb commands and `config.set` keys, true state from Tick flags, `operator_action` log lines.
- Diya: manual mode in the planner, `/preview` (re-plan without applying), Safety refusals with reasons.
- Divi: tabbed sheet rendered from the schema, Manual badge, preview confirm dialog.
- Build order inside: Drive + manual, Fleet settings + preview, Guidance, Implement/sections, Vehicle, Advanced.
- **Done when:** steer a tractor manually, change its implement, preview and apply the re-plan, hand it back to the AI.

### 19. Mechanic Agent (Diya + Divi)
- Diya: top 4 ranked from preloaded real listings (farm equipment / mobile diesel), `pending` mechanic item, `/api/mechanics`, `/api/mechanics/book` (mock booking only), return time, re-plan on repair.
- Divi: mechanic sheet, van animation.
- **Done when:** approving a mechanic schedules the return and the repaired tractor gets work back with an explanation.

### 20. Agronomy events (Diya)
- Heat alert and early ripening re-prioritize jobs on their own.
- **Done when:** the heat alert reorders spray jobs with an explanation.

### 21. Wow polish (Divi)
- Day cycle, tilt-shift and bloom with an Effects toggle, breakdown camera move and slow-motion beat, spring pill animations, Dynamic Island morphs, end-of-day keynote scorecard.

### 22. Optional LLM wording (Diya, only if everything else is done)
- Smoother wording of explanation facts, operator chat to structured events. Never changes a plan.

---

## Phase 3: Freeze, runs, hand-in (4:00 to 5:00)

### 23. Final live runs (Anay runs, Diya checks)
- Ours on the AgOpenWeb containers, then baseline on the same scenario and events. Save both logs. Comparison table.
- **Done when:** `event_log_ours.jsonl`, `event_log_baseline.jsonl`, and the table are in the repo.

### 24. README and submission (Diya leads)
- How to run, all tractors on headless AgOpenWeb, architecture, agents, results table, known limitations, plus `scenario.json`, `fleet.json`, `hosts.json`, `weather_rules.json`, Dockerfile/compose, field data, both logs.
- **Done when:** submitted by 4:40 PM.

### 25. Demo prep (Divi leads)
- Backup video of a clean full run (record during step 23).
- Rehearse twice: plan, breakdown + explanation, Live feed proof, add a tractor, wind change, Why?, manual control, end-of-day scorecard.

---

## Cut order if behind (cut from the top)
1. Optional LLM wording (22)
2. Advanced and Vehicle tabs in the control panel (part of 18)
3. Mechanic van animation (keep sheet and booking)
4. Live coverage painting (keep tractors and trails on Live feed)
5. OR-Tools (keep greedy, it still beats FCFS)

**Never cut:** live AgOpenWeb tractors with no fleet-size cap (add until compute runs out, across machines), compatible assignment, Safety Agent with 0 violations, breakdown recovery with progress kept, explanations, scorecard vs baseline, event logs.

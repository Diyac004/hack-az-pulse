# DEMO.md: 2-minute demo, click by click (presenter: Divi)

Rubric rows: **Constraint** (4), **Completed work** (4), **Efficiency** (4), **Adaptation** (3), **Explanations** (5, biggest), **Tiebreaker** (operator trust, 1-5).

## 1. Pre-flight checklist

Pick the data source in this order. Say honestly which one you are on. Three backends exist and they are separate: only the first is the scored coordinator demo.

**Mode switch (top-right of the 3D view): `Mock | Live` plus `⋯`.** One tab can show every piece:
1. **Mock** = "Simulation — full feature showcase": the in-browser simulation with every feature on (weather and wind gust, heat alert, Why, cockpit controls, mechanic booking, approvals). Use it to show *everything* the product does. Nothing in it is real; say so.
2. Click **Live** to prove the real planner: it reloads on the remembered Live address (default `http://localhost:8000`, Anay's FastAPI planner) and the caption reads "Live — planner backend". Features that backend lacks are disabled with "Not supported by this backend". The scorecard numbers here are the real scheduler vs FCFS.
3. `⋯` → **AgOpenWeb bridge** (`:8040`) → **Connect** for real AgOpenWeb tractors; the caption reads "Live — AgOpenWeb bridge" and the scorecard is replaced by "Scorecard comes from the planner backend (FastAPI). Bridge mode shows real AgOpenWeb tractors only." (only a "Jobs done (bridge)" count).
- `⋯` presets: **Planner backend (FastAPI)** `:8000`, **AgOpenWeb bridge** `:8040`, **Simulated backend (mock-backend)** `:8001` (start it with `PORT=8001 npm start` so it can run beside the planner). Any address can be typed; the last one is remembered in this browser.
- Switching rewrites `?source=` / `?api=` and reloads. Typed URLs (`?source=live&api=...`, `?source=mock`) still work exactly as before.
- If Live can't reach the backend, the switch turns red ("no backend") and shows **Switch to Mock**: one click and the demo continues in Mock.

Two labels are easy to mix up:
- **Connected backend** = which server the dashboard is talking to. The mode switch shows it: **Live** (a backend over REST and `/ws`, caption says which kind) or **Mock** (in-browser, no server). It says nothing about whether any tractor is real.
- **Real AgOpenWeb tractors** = a per-tractor fact. A tractor is real only if its readout card says "AgOpenWeb ws://... · heartbeat" (a container is running for it). "Simulated" means not real. Only the bridge (below) can show real tractors; the FastAPI backend, the mock-backend and `?source=mock` never do.

**Primary: Anay's FastAPI backend (the scored coordinator demo)**: Diya's Python scheduler/validator plans, MockGateway executes on simulated tractors. Deadlines, fuel, implements and safety are checked on every plan; breakdown recovery keeps progress. No Docker.
- [ ] First time only, from the repo root: `python -m venv .venv && .venv/bin/python -m pip install -r backend/requirements.txt` (Windows: `.venv/Scripts/python`). Python 3.11+.
- [ ] Start it (fresh each time; since 7df3d39 it plans the day at startup and stays paused at plan v1): `cd ~/hack-az-pulse/backend && HFA_MAX_TRACTORS=5 ../.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000` (Windows: `../.venv/Scripts/python`). Check `http://localhost:8000/docs` opens. The demo **starts with 3 tractors; Add tractor up to 5** (`HFA_MAX_TRACTORS=5` is the cap, not the starting fleet; backend default is 8). The Add tractor sheet shows "Fleet capacity: 3 of 5 tractors" from the backend's `capacity` and disables Add at 5 (the backend also answers 409 `AT_CAPACITY`). Mock is the same: 3 tractors, up to 5. Optional `HFA_SCRIPTED=0` turns off the scenario's scripted events (e.g. the T1 breakdown at t=50) for a manual-only demo; manual Break down still works. Needs `origin/diya/brain` 20d266e or later.
- [ ] Dashboard **production build** so it never hot-reloads: `cd ~/hack-az-pulse/dashboard && npx vite build && npx vite preview --port 5173` (dev server is for rehearsal only: `npx vite --port 5173`).
- [ ] Open in a fresh tab: `http://localhost:5173/?source=live&api=http://localhost:8000` (or click **Live** in the mode switch; caption "Live — planner backend"). Do not use `?pace=` here: the real backend's clock is driven by `POST /api/clock`, not by the dashboard.
- [ ] Cold-start flow (tested, see "Cold-start test" below): fresh backend, open the dashboard. Since Anay's 7df3d39 the server plans at startup (plan v1, paused), so the first button reads **Play**. With `HFA_AUTORUN=0` the backend starts with no plan and the button reads **Start run** (it calls `POST /api/run`, then becomes **Pause** / **Play**) so the plan appears (plan v1), **Pause** then **Play** (time holds while paused), submit jobs, **Break down...**. Nothing moves until the run is started. To rerun the demo, press **Restart day** and confirm (it calls `POST /api/run`, which resets the day), or restart the backend. **Play works immediately** on a fresh 7df3d39 server: no Start run, no /run.
- [ ] Scorecard Baseline column: filled by the server's FCFS twin within about a second of startup. After each action (breakdown, job, priority change) it is recomputed for about 0.5 s; the dashboard keeps the last numbers dimmed with "updating…" instead of flashing "not measured". **Restart day** clears it until the new day's twin is ready.
- [ ] A priority change the planner can't accept is not applied: the toast says e.g. "Couldn't change priority: no valid plan accepts it — kept High" and the pill keeps its old priority. An incompatible pin is refused up front (422).
- [ ] Not built yet on this backend (501/400): weather events, mechanic booking, "Why", the cockpit endpoints. The dashboard detects this on connect and disables or hides them (tooltip "Not supported by this backend"); the weather card says "Placeholder weather — not used for spraying decisions". Skip those rows in section 2 when on it (see "Which rows work where").

**Backup: mock-backend (offline, simulated)**: the dashboard's in-browser simulation behind REST/WS. Full planner story (weather, breakdown, mechanic, Why) but **not** Diya's Python scheduler, so its numbers are simulated.
- [ ] `cd ~/hack-az-pulse/mock-backend && npm install && PORT=8001 npm start` (port 8001 so it can run beside the FastAPI backend; plain `npm start` uses 8000; `PACE=` sets the pace).
- [ ] Tab: `http://localhost:5173/?source=live&api=http://localhost:8001&pace=6` (or `⋯` → **Simulated backend (mock-backend)**; caption "Live — simulated backend (mock-backend)", tractors **Simulated**). Default pace is 1.2 farm min per real second (10-minute day); `?pace=6` gives about 2 minutes.
- [ ] Reload that tab right before you start: `POST /api/run` resets the day, and the clock starts on the first connection.

**Last resort: in-browser mock.**
- [ ] Tab: `http://localhost:5173/?source=mock`, or click **Mock** in the mode switch (caption "Simulation — full feature showcase"). Nothing is real here. Say so. Optional `?view=map|3d`, `?debug=perf`.

**Real AgOpenWeb tractors (bridge demo, bypasses the Python scheduler; its travel/idle/violation numbers are placeholders, not measured)**. This is a separate beat, not the scored coordinator. The bridge plans one job per tractor with its own simple logic and has no weather, mechanic or "Why". The dashboard no longer shows the bridge's numbers on the scorecard at all (Anay's request): in bridge mode the scorecard says "Scorecard comes from the planner backend (FastAPI)" and only counts jobs done (bridge). One container per tractor, about 120-140 MB RAM and 7-10% of a core each; 3 tractors is about 0.4 GB.
- [ ] Docker Desktop is running.
- [ ] First time only, build the image and prove one container works: `cd ~/hack-az-pulse/agopenweb-bridge && npm install && ./run-agopenweb.sh && ./run-agopenweb.sh stop`
- [ ] Start the bridge (one line, from the repo root, **by path**; port 8040 so it can run beside the FastAPI backend): `cd ~/hack-az-pulse && MAX_TRACTORS=3 REAL_SLOTS=3 node agopenweb-bridge/server.mjs`
- [ ] Separate tab: `http://localhost:5173/?source=live&api=http://localhost:8040` (or `⋯` → **AgOpenWeb bridge**). Tap a tractor: the readout card must say "AgOpenWeb ws://... · heartbeat". If it says "Simulated", that tractor is not real.
- [ ] Hot-seat fallback if the laptop is struggling: `node agopenweb-bridge/server.mjs` (`REAL_SLOTS=1`); a tractor becomes a real container when you take manual control (0.9-1.6 s).
- [ ] Use it only for the AgOpenWeb moment (section 2). Drop it if Docker misbehaves.

**Room**
- [ ] Fullscreen browser, 1080p or projector, zoom 100%, **Effects: on**. Other apps closed, Do Not Disturb, charger in.
- [ ] Backup video of a clean full run on the desktop, one click to open.
- [ ] Rehearsed twice, including the failure switch in section 5.

## 2. The 2:00 script

| Time | Divi clicks | On screen | SAY | Earns |
|---|---|---|---|---|
| 0:00 | Nothing. Dashboard loaded, paused. | Farm in 3D, Dynamic Island, fleet chips, timeline dock with pills colored red/orange/grey by priority. | "Today a farm operator coordinates autonomous tractors by hand. This is a citrus farm in Mesa, Arizona (East Valley): 3 tractors, 8 orchard blocks (the fleet is capped at 5 for this demo)." | Framing |
| 0:10 | Point at the plan badge and the scorecard. | Plan badge reads "Plan v<N> · Feasible" (N is the current plan version), scorecard "Ours vs first come, first served", violations counter at 0. | "Every job is assigned. Safety checks every plan: constraint violations, zero." | Constraint |
| 0:20 | **Play** | Tractors drive, pills advance, activity feed ticks. | "Now the day runs." (Never say "real AgOpenWeb tractors" on the FastAPI, mock-backend or mock tab: they are simulated. See the AgOpenWeb moment.) | Completed work |
| 0:30 | **Break down...** then pick Tractor 1 | Tractor 1 stops, timeline reshuffles, explanation card appears, mechanic sheet pops up. | Read the explanation aloud. "Progress is kept. Nothing lost, nothing duplicated." | Adaptation + Explanations |
| 0:45 | **Approve and book** in the mechanic sheet | Van drives out. Booking does not return the tractor; its work comes back only after **Mark repaired** on the chip. The Unassigned tray shows only if no compatible working tractor exists (e.g. both sprayers down). | "The operator approves one thing. The AI already re-planned around it." | Tiebreaker |
| 0:55 | **3D / Map** toggle to **Map** | Overhead aerial; Tractor 1 sits still with its coverage ending mid-block, backup tractor paints on from exactly that point. | "Let's check this is real. The backup picks up from exactly where the broken one stopped." Flip back to 3D. | Adaptation |
| 1:10 | **Wind gust** | Wind particles speed up, sprayer pauses mid-block, hatched band on the timeline. | "It knows when not to spray: the explanation cites the 10 mph limit. And it keeps the tractor busy anyway." | Explanations + Constraint |
| 1:20 | **Add tractor** (choose a sprayer) | New tractor chip and lane; pills fly into it; explanation names the jobs it took. | "Plug in a tractor, the fleet adapts in seconds. Fleet is capped at 5 for this demo." | Adaptation |
| 1:30 | Tap a timeline pill | **Why** sheet: counterfactual bars and Low/Med/High priority. | "Why this tractor, why now: real numbers, not a story." | Explanations (5 pts) |
| 1:40 | **Skip to sunset** | Fast-forward to **Day complete** keynote scorecard. | "More jobs done, less travel, less idle than first come, first served. Violations: zero." | Completed work + Efficiency + Constraint |
| 1:55 | Hold on scorecard. | | "The operator didn't coordinate anything. They read a few explanations and approved." | Tiebreaker |

### Which rows work where

- **FastAPI backend (primary):** 0:00 to 0:45 (plan, Play, breakdown with explanation), Skip to sunset scorecard (ours vs first come, first served, both measured by the backend). Weather (wind gust), mechanic booking and **Why** return 501 or are not modeled there: skip 1:10 and 1:30 and the mechanic sheet at 0:45 unless you have confirmed they work; if you need them, switch to the mock-backend and say so.
- **mock-backend (backup):** every row, all simulated.
- **Bridge:** only the AgOpenWeb moment.

### Cold-start test (what was checked, 2:00 script on the FastAPI backend)

Fresh backend from a clean checkout of `origin/anay` (new venv, `pip install -r backend/requirements.txt`), driven with curl only: initial state is paused, t=0, plan v0, 12 jobs pending. `POST /api/run {"mode":"ours"}` returns an Operation (202) and the plan appears (plan v1, 23 entries, jobs move to assigned/traveling). `POST /api/clock {"speed":30}` makes time run (t 0.8 to 86 in 3 s). `{"playing":false}` freezes t exactly; `{"playing":true}` resumes. `POST /api/jobs` (mow E, deadline 600) creates J13 and a re-plan (plan v3). `POST /api/events {"type":"breakdown","tractor":"T2"}` re-plans to plan v4, J12 and J13 move to T3 with J13 keeping 41% progress, violations 0. Note the scenario also scripts a T1 breakdown at t=50, so with T1 and T2 both down only T3 keeps working and some jobs end `pending`. Not tested in a browser.

### The real AgOpenWeb moment (30-40 s, on the bridge tab; drop it if Docker misbehaves)

Run it as its own beat on the **separate bridge tab** (port 8040), after the scored run on the FastAPI backend, not mixed into it. The bridge bypasses our Python scheduler and has no breakdown flow, so do not show its scorecard or quote its travel, idle or violation numbers (placeholders).

| Step | Divi clicks | On screen | SAY |
|---|---|---|---|
| 1 | Tap a tractor to open its readout card. | Card shows "AgOpenWeb ws://... · heartbeat" (on any non-bridge backend it says "Simulated"). | "This is a real AgOpenWeb instance in a container. Our side sends a heartbeat; if we stop, it stops the tractor itself." |
| 2 | Card, **Controls**. In the cockpit, **Take manual control**. | Orange MANUAL badge, hatched lane on the timeline. | "The operator takes over. The AI plans around it." |
| 3 | **Guidance** tab, **New AB line**, tap A then B on the map. | Preview shows jobs moved and deadlines affected; **Apply**. | "Anything that re-plans shows its impact first." |
| 4 | Watch the tractor. | Autosteer follows the line (cross-track error stays under 2 cm on straights); coverage paints. | "That path is AgOpenWeb's autosteer, not our animation." |
| 5 | **Hand back to AI**. | MANUAL badge clears, lane returns to normal. | "Handing back re-plans from where it is now. Progress is kept." |

Map view coverage-continuation beat (0:55 row): on **Map**, a broken tractor's painted coverage ends mid-block and the backup paints on from exactly that point. Optional: if "Satellite | Simple" is in the build by 4 PM, switch to Satellite (real USGS NAIP imagery); otherwise stay on Simple.

Optional if time: **Block a road** (reroute, explanation shows the time cost) and **Heat alert** (priorities change on their own). Drop them first.

Other controls: **3D | Map** toggle, **Wind gust** / **Calm the wind**, Pause/Play, Normal speed, Effects, Reset view, tap a tractor for the glass readout card with **Follow**, **Mark repaired** on the chip after the van arrives.

## 3. Short and extended versions

**30 seconds** (hallway, or if the stage clock is cut):
1. Plan already showing: "3 tractors, 8 blocks, zero violations."
2. Play, then **Break down...** Tractor 1. Read the explanation.
3. **Skip to sunset**: scorecard vs first come, first served, zero violations.

**4 minutes** (adds the real AgOpenWeb moment, Map view, weather, Why, add tractor):
- Run the 2:00 script at default pace or `?pace=3`.
- After the breakdown: dwell on **Map**, tap a tractor, **Follow** it, show the readout card. Show that the backup picks up the coverage where the broken tractor stopped.
- After wind: **Calm the wind**, show the tractor resuming; point at sensitive areas (houses, apiary, canal) glowing when downwind.
- After **Add tractor**: open **Why** on a pill the new tractor took; read the counterfactual bars.
- Real AgOpenWeb moment (30-40 s, section 2): switch to the bridge tab, readout card heartbeat, cockpit, take manual control, draw an AB line, autosteer follows, hand back to AI. Optionally show **Drive to...** (tap the map) and the Vehicle tab (applies on real tractors).
- Show the Plan badge ("Overtime" or "N late" chips, overflow markers past 6 PM), **Heat alert**, **Block a road**.
- Close on the scorecard and say how the baseline is computed (section 4). The mock's baseline numbers are simulated (scaled): say so if you show them.

## 4. Q&A cheat-sheet

| Question | Answer |
|---|---|
| Is it really AI? | The brain is an algorithm, not an LLM: Weather, Agronomy, Fleet (optimizer: greedy, OR-Tools later), Navigation (A* on the road grid), Safety and Mechanic agents, plus explanation generation. Plans are checked against hard constraints, so they are safe and repeatable. An LLM is optional and may only reword explanation facts, never choose or change a plan. |
| Are the tractors real? | Not in the main demo: on the FastAPI backend they are simulated (MockGateway). Only on the separate bridge tab are they real headless AgOpenWeb containers (AgOpenWeb is the .NET rewrite of AgOpenGPS) doing real autosteer, U-turns and section control in its simulator mode; not physical machines. The readout card says "AgOpenWeb ws://... · heartbeat" on real ones and "Simulated" otherwise. A LIVE badge only means a backend is connected, not that tractors are real. |
| Does the AgOpenWeb demo run your scheduler? | No. The bridge bypasses our Python scheduler; its travel, idle and violation numbers are placeholders, not measured results. The scored coordinator numbers come from the FastAPI backend. Wiring AgOpenWeb under the real scheduler is the `AgOpenWebGateway` work, not done. |
| What does AgOpenWeb do vs your AI? | AgOpenWeb drives: pose, steering along the AB line, U-turns, sections. Our agents decide: who does which job, when, around weather and breakdowns, and why. A deadman heartbeat drops autosteer about 1.6 s after our side goes quiet. |
| How many tractors? | 5 in this demo (the cap we set for the hackathon). The design scales by running one container per tractor (about 130 MB RAM each), so the limit is compute, not the plan logic. We did not demo 50. |
| What's the AI? | Algorithmic agents, not an LLM: Fleet planner, Navigation (A*), Safety, Weather, Agronomy, Mechanic, and the Explanations/Why generator. Every plan passes hard-constraint checks. An LLM may only reword explanation text. On the primary demo the plans come from the real Python planner (`backend/app/brain`) behind the FastAPI backend; on the mock-backend and `?source=mock` the planner is our simulated version. |
| How is the baseline computed? | First come, first served on the same scenario and the same events, same tractors, logged in `event_log_baseline.jsonl` next to ours. |
| What happens on breakdown? | Stop immediately, keep finished and partial progress, replan unfinished work, explain, offer a mechanic for approval. Repair return is explicit ("Mark repaired"). |
| Can the operator override? | Yes: approve or decline, change priority, take manual control in the cockpit (tabs Drive / Guidance / Implement / Vehicle / Fleet / Advanced), hand back to the AI. Re-plans show a preview before Apply. |
| Do you model missed deadlines? | Yes. A deadline is a hard constraint in the planner: the validator rejects a plan whose job ends after its deadline ("Deadline missed"). The scorecard also shows "Finished late" on its own row so a late finish is never hidden behind "0 violations"; violations count broken constraints in applied or executed plans (deadlines, implements, fuel, safety). |
| Why does "Feasible" show after sunset? | Plans past 6 PM are valid but overtime. The Plan badge shows Overtime or N late chips and the timeline marks overflow past 6 PM; we are asking for an explicit backend flag (FRONTEND_NEEDS.md). |
| What if the backend dies? | Dashboard keeps the last state and shows reconnecting; we restart the backend or switch to the mock-backend, then `?source=mock` (section 5). |

## 5. Failure plan

| Symptom | Action |
|---|---|
| Bridge or Docker misbehaves | Stop the bridge (Ctrl-C removes its containers) and tell the story without the AgOpenWeb step. The scored demo on the FastAPI backend does not depend on it. Skip the real moment rather than fumble it. |
| FastAPI backend fails to start or crashes | Stop it, start the mock-backend (`:8000`, offline backup) and say it is the simulated backend. If that also fails, `?source=mock`. |
| Backend down or badge not LIVE | Restart the backend; if it does not come back, switch to the `?source=mock` tab. Say: "We're running the in-browser simulation; same dashboard, same logic." Don't claim live. |
| In-browser mock also broken | Play the recorded backup video, narrate over it. |
| WebGL slow, frames dropping | Click **Effects** to turn it off, or use **Map** view (`?view=map`). |
| Demo state is messy | Reload the tab (live resets the day) and restart the script; skip to section 3's 30-second version if time is short. |
| Pace wrong | Reload with `?pace=6`. |
| Stuck on a click | Say the sentence anyway, move to the next row. Never apologize on stage. |

## 6. AI Supervisor (optional beat, 20-30 s)

An LLM reviews the plan, implements and plots and **proposes** fixes; the operator approves; the planner re-plans and Safety checks the result. Contract proposal: `AI_SUPERVISOR_PROPOSAL.md`; details in `ai-supervisor/README.md`.

Run it with agy (Antigravity CLI) against the simulated backend, which supports block exclusion:

```sh
cd ai-supervisor && npm install                       # once (deps: ws)
PORT=8001 node mock-backend/server.mjs                # from repo root: simulated backend (Live preset "mock-backend")
AI_PROVIDER=agy AGY_MODEL=claude-sonnet-5-5-low API=http://localhost:8001 node ai-supervisor/server.mjs   # :8060
# dashboard: http://localhost:5173/?source=live&api=http://localhost:8001&ai=http://localhost:8060
# against the planner instead: API=http://localhost:8000 ... and &api=http://localhost:8000
```

The panel follows the **Mock | Live** switch (the switch keeps `&ai=`):

- **Mock**, no `&ai=`: in-browser **rules** reviewer (no model). Plan and implement findings only (late jobs, overtime, idle tractors, missing implement); approvals go to the in-browser simulation. No plot review: that needs the vision model.
- **Mock** with `&ai=`: the service reviews its own `API=` backend, not the in-browser simulation; the panel says so. For the plot beat, use Live on that backend.
- **Live, mock-backend** (`:8001`): everything approvable, including **Exclude Block A**.
- **Live, planner backend** (FastAPI `:8000`): advice only, except **priority** and **pin job** (its `/api/capabilities` reports no controls and no `block_disabled`). Plot findings show as advice ("Not supported by this backend").

What to show:

1. Switch to **Satellite**. Click **Review now** on the AI Supervisor card (a review with agy takes about 15-60 s).
2. Plots: Blocks **A** and **E** are flagged "houses, not orchard", outlined on the map. Open the card, **Show Block A**, then **Approve** "Exclude Block A". Say: "The AI proposed it, I approved it, the planner re-planned and Safety checked it." Block A's jobs go back to Unassigned with the reason; the Latest explanation card says who decided.
3. On the planner backend: show one plan finding, approve a **priority** change, and say plot findings stay advice there until the backend accepts the proposal.

With a model (agy/openai/anthropic) the Latest explanation card shows the model's rewording of the planner's text, only when it kept every number, job, tractor, time and claim (else the template). The AI card header says "AI: <model> via <provider>" and what it is doing; the "AI" chip next to Mock | Live opens the panel; findings say "Proposed by <model>".

If agy is slow or fails: drop `&ai=` (rules reviewer) or skip the beat. Never claim the rules reviewer is an LLM.

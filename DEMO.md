# DEMO.md: 2-minute demo, click by click (presenter: Divi)

Rubric rows: **Constraint** (4), **Completed work** (4), **Efficiency** (4), **Adaptation** (3), **Explanations** (5, biggest), **Tiebreaker** (operator trust, 1-5).

## 1. Pre-flight checklist

Pick the data source in this order. Say honestly which one you are on.

**Primary: real AgOpenWeb bridge, full mode** (one container per tractor, about 120-140 MB RAM and 7-10% of a core each; 3 tractors is about 0.4 GB).
- [ ] Docker Desktop is running.
- [ ] First time only, build the image and prove one container works: `cd ~/hack-az-pulse/agopenweb-bridge && npm install && ./run-agopenweb.sh && ./run-agopenweb.sh stop`
- [ ] Start the bridge (one line, from the repo root, **by path**): `cd ~/hack-az-pulse && MAX_TRACTORS=3 REAL_SLOTS=3 node agopenweb-bridge/server.mjs`
- [ ] Dashboard **production build** so it never hot-reloads: `cd ~/hack-az-pulse/dashboard && npx vite build && npx vite preview --port 5173` (dev server is for rehearsal only: `npx vite --port 5173`).
- [ ] Open in a fresh tab: `http://localhost:5173/?source=live&api=http://localhost:8040`. Tap a tractor: the readout card must say "AgOpenWeb ws://... · heartbeat". If it says "Simulated", you are not on real tractors.
- [ ] Hot-seat fallback if the laptop is struggling: `node agopenweb-bridge/server.mjs` (`REAL_SLOTS=1`); a tractor becomes a real container when you take manual control (0.9-1.6 s).
- [ ] The bridge plans one job per tractor and has no weather, mechanic or "Why". Use it for the AgOpenWeb moment (section 2, row 0:55), not the full planning story.

**Backup: simulated backend** (full planner, weather, breakdown, mechanic, Why; no real tractors, no cockpit endpoints).
- [ ] `cd ~/hack-az-pulse/mock-backend && npm install && npm start` (port 8000; `PACE=` sets the pace).
- [ ] Tab: `http://localhost:5173/?source=live&api=http://localhost:8000&pace=6` (badge **LIVE**). Default pace is 1.2 farm min per real second (10-minute day); `?pace=6` gives about 2 minutes.
- [ ] Reload that tab right before you start: `POST /api/run` resets the day, and the clock starts on the first connection.

**Last resort: in-browser mock.**
- [ ] Tab: `http://localhost:5173/?source=mock` (badge **MOCK**). Nothing is real here. Say so. Optional `?view=map|3d`, `?debug=perf`.

**Room**
- [ ] Fullscreen browser, 1080p or projector, zoom 100%, **Effects: on**. Other apps closed, Do Not Disturb, charger in.
- [ ] Backup video of a clean full run on the desktop, one click to open.
- [ ] Rehearsed twice, including the failure switch in section 5.

## 2. The 2:00 script

| Time | Divi clicks | On screen | SAY | Earns |
|---|---|---|---|---|
| 0:00 | Nothing. Dashboard loaded, paused. | Farm in 3D, Dynamic Island, fleet chips, timeline dock with pills colored red/orange/grey by priority. | "Today a farm operator coordinates autonomous tractors by hand. This is a citrus farm in Mesa, Arizona (East Valley): 3 tractors, 8 orchard blocks (the fleet is capped at 5 for this demo)." | Framing |
| 0:10 | Point at the plan badge and the scorecard. | Plan badge reads "Plan v<N> · Feasible" (N is the current plan version), scorecard "Ours vs first come, first served", violations counter at 0. | "Every job is assigned. Safety checks every plan: constraint violations, zero." | Constraint |
| 0:20 | **Play** | Tractors drive, pills advance, activity feed ticks. | "Now the day runs." (Only say "real AgOpenWeb" if the card shows the heartbeat line; see 0:55.) | Completed work |
| 0:30 | **Break down...** then pick Tractor 1 | Tractor 1 stops, timeline reshuffles, explanation card appears, mechanic sheet pops up. | Read the explanation aloud. "Progress is kept. Nothing lost, nothing duplicated." | Adaptation + Explanations |
| 0:45 | **Approve and book** in the mechanic sheet | Van drives out. Booking does not return the tractor; its work comes back only after **Mark repaired** on the chip. The Unassigned tray shows only if no compatible working tractor exists (e.g. both sprayers down). | "The operator approves one thing. The AI already re-planned around it." | Tiebreaker |
| 0:55 | **3D / Map** toggle to **Map** | Overhead aerial; Tractor 1 sits still with its coverage ending mid-block, backup tractor paints on from exactly that point. | "Let's check this is real. The backup picks up from exactly where the broken one stopped." Flip back to 3D. | Adaptation |
| 1:10 | **Wind gust** | Wind particles speed up, sprayer pauses mid-block, hatched band on the timeline. | "It knows when not to spray: the explanation cites the 10 mph limit. And it keeps the tractor busy anyway." | Explanations + Constraint |
| 1:20 | **Add tractor** (choose a sprayer) | New tractor chip and lane; pills fly into it; explanation names the jobs it took. | "Plug in a tractor, the fleet adapts in seconds. Fleet is capped at 5 for this demo." | Adaptation |
| 1:30 | Tap a timeline pill | **Why** sheet: counterfactual bars and Low/Med/High priority. | "Why this tractor, why now: real numbers, not a story." | Explanations (5 pts) |
| 1:40 | **Skip to sunset** | Fast-forward to **Day complete** keynote scorecard. | "More jobs done, less travel, less idle than first come, first served. Violations: zero." | Completed work + Efficiency + Constraint |
| 1:55 | Hold on scorecard. | | "The operator didn't coordinate anything. They read a few explanations and approved." | Tiebreaker |

### The real AgOpenWeb moment (30-40 s, on the bridge tab; drop it if Docker misbehaves)

Run it as its own beat, either right after 0:20 or as the 0:55 step when the bridge is the primary source. The bridge has no breakdown flow, so on it skip the 0:30-0:45 rows and use this instead.

| Step | Divi clicks | On screen | SAY |
|---|---|---|---|
| 1 | Tap a tractor to open its readout card. | Card shows "AgOpenWeb ws://... · heartbeat" (on the simulated backend it says "Simulated"). | "This is a real AgOpenWeb instance in a container. Our side sends a heartbeat; if we stop, it stops the tractor itself." |
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
| Are the tractors real? | On the bridge tab, yes: each is a real headless AgOpenWeb container (AgOpenWeb is the .NET rewrite of AgOpenGPS) doing real autosteer, U-turns and section control in its simulator mode. They are not physical machines. The readout card says "AgOpenWeb ws://... · heartbeat" on real ones and "Simulated" otherwise. On the simulated backend or `?source=mock`, nothing is real: say so. |
| What does AgOpenWeb do vs your AI? | AgOpenWeb drives: pose, steering along the AB line, U-turns, sections. Our agents decide: who does which job, when, around weather and breakdowns, and why. A deadman heartbeat drops autosteer about 1.6 s after our side goes quiet. |
| How many tractors? | 5 in this demo (the cap we set for the hackathon). The design scales by running one container per tractor (about 130 MB RAM each), so the limit is compute, not the plan logic. We did not demo 50. |
| What's the AI? | Algorithmic agents, not an LLM: Fleet planner, Navigation (A*), Safety, Weather, Agronomy, Mechanic, and the Explanations/Why generator. Every plan passes hard-constraint checks. An LLM may only reword explanation text. Honest note: the dashboard's planner today is our simulated version; the real planner (`backend/app/brain`) connects when the API is up. |
| How is the baseline computed? | First come, first served on the same scenario and the same events, same tractors, logged in `event_log_baseline.jsonl` next to ours. |
| What happens on breakdown? | Stop immediately, keep finished and partial progress, replan unfinished work, explain, offer a mechanic for approval. Repair return is explicit ("Mark repaired"). |
| Can the operator override? | Yes: approve or decline, change priority, take manual control in the cockpit (tabs Drive / Guidance / Implement / Vehicle / Fleet / Advanced), hand back to the AI. Re-plans show a preview before Apply. |
| Why does "Feasible" show after sunset? | Plans past 6 PM are valid but overtime. The Plan badge shows Overtime or N late chips and the timeline marks overflow past 6 PM; we are asking for an explicit backend flag (FRONTEND_NEEDS.md). |
| What if the backend dies? | Dashboard keeps the last state and shows reconnecting; we switch to `?source=mock` (below). |

## 5. Failure plan

| Symptom | Action |
|---|---|
| Bridge or Docker misbehaves | Stop the bridge (Ctrl-C removes its containers), start the mock-backend tab (`:8000`) and tell the story without the AgOpenWeb step. Skip the real moment rather than fumble it. |
| Backend down or badge not LIVE | Switch to the `?source=mock` tab. Say: "We're running the in-browser simulation; same dashboard, same logic." Don't claim live. |
| Mock also broken | Play the recorded backup video, narrate over it. |
| WebGL slow, frames dropping | Click **Effects** to turn it off, or use **Map** view (`?view=map`). |
| Demo state is messy | Reload the tab (live resets the day) and restart the script; skip to section 3's 30-second version if time is short. |
| Pace wrong | Reload with `?pace=6`. |
| Stuck on a click | Say the sentence anyway, move to the next row. Never apologize on stage. |

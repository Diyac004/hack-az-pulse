# DEMO.md: 2-minute demo, click by click (presenter: Divi)

Rubric rows: **Constraint** (4), **Completed work** (4), **Efficiency** (4), **Adaptation** (3), **Explanations** (5, biggest), **Tiebreaker** (operator trust, 1-5).

## 1. Pre-flight checklist

- [ ] Simulated backend: `cd ~/hack-az-pulse/mock-backend && npm install && npm start` (port 8000; swap for the real backend when it exists). `PACE=` env sets its pace.
- [ ] Dashboard as a **production build** so the page never hot-reloads: `cd ~/hack-az-pulse/dashboard && npx vite build && npx vite preview --port 5173`. (Dev server for rehearsal only: `npx vite --port 5173`.)
- [ ] Live URL open in a fresh tab: `http://localhost:5173/?source=live&api=http://localhost:8000&pace=6` (badge **LIVE**, green). Default pace is 1.2 farm min per real second (10-minute day); `?pace=6` gives about a 2-minute run.
- [ ] Offline backup URL in a second tab: `http://localhost:5173/?source=mock` (badge **MOCK**; say so honestly if used). Optional `?view=map|3d`.
- [ ] Reload the live tab right before you start: `POST /api/run` resets the day, and the clock starts on the first connection.
- [ ] Fullscreen browser, 1080p or projector resolution, zoom 100%, **Effects: on**.
- [ ] Close other apps and tabs, Do Not Disturb on, charger plugged in.
- [ ] Backup video of a clean full run is on the desktop and opens in one click (FEATURES step 25).
- [ ] Rehearsed twice, including the failure switch in section 5.

## 2. The 2:00 script

| Time | Divi clicks | On screen | SAY | Earns |
|---|---|---|---|---|
| 0:00 | Nothing. Dashboard loaded, paused. | Farm in 3D, Dynamic Island, fleet chips, timeline dock with pills colored red/orange/grey by priority. | "Today a farm operator coordinates autonomous tractors by hand. This is a citrus farm in Queen Creek: 3 tractors, 8 orchard blocks." | Framing |
| 0:10 | Point at the plan badge and the scorecard. | Plan badge reads "Plan v<N> · Feasible" (N is the current plan version), scorecard "Ours vs first come, first served", violations counter at 0. | "Every job is assigned. Safety checks every plan: constraint violations, zero." | Constraint |
| 0:20 | **Play** | Tractors drive, pills advance, activity feed ticks. | "These are real AgOpenWeb tractors, not animations." | Completed work |
| 0:30 | **Break down...** then pick Tractor 1 | Tractor 1 stops, timeline reshuffles, explanation card appears, mechanic sheet pops up. | Read the explanation aloud. "Progress is kept. Nothing lost, nothing duplicated." | Adaptation + Explanations |
| 0:45 | **Approve and book** in the mechanic sheet | Van drives out. Booking does not return the tractor; its work comes back only after **Mark repaired** on the chip. The Unassigned tray shows only if no compatible working tractor exists (e.g. both sprayers down). | "The operator approves one thing. The AI already re-planned around it." | Tiebreaker |
| 0:55 | **3D / Map** toggle to **Map** | Overhead aerial; Tractor 1 sits still with its coverage ending mid-block, backup tractor paints on from exactly that point. | "Let's check this is real. The backup picks up from exactly where the broken one stopped." Flip back to 3D. | Adaptation |
| 1:10 | **Wind gust** | Wind particles speed up, sprayer pauses mid-block, hatched band on the timeline. | "It knows when not to spray: the explanation cites the 10 mph limit. And it keeps the tractor busy anyway." | Explanations + Constraint |
| 1:20 | **Add tractor** (choose a sprayer) | New tractor chip and lane; pills fly into it; explanation names the jobs it took. | "Plug in a tractor, the fleet adapts in seconds. No fleet-size cap." | Adaptation |
| 1:30 | Tap a timeline pill | **Why** sheet: counterfactual bars and Low/Med/High priority. | "Why this tractor, why now: real numbers, not a story." | Explanations (5 pts) |
| 1:40 | **Skip to sunset** | Fast-forward to **Day complete** keynote scorecard. | "More jobs done, less travel, less idle than first come, first served. Violations: zero." | Completed work + Efficiency + Constraint |
| 1:55 | Hold on scorecard. | | "The operator didn't coordinate anything. They read a few explanations and approved." | Tiebreaker |

Optional if time: **Block a road** (reroute, explanation shows the time cost) and **Heat alert** (priorities change on their own). Drop them first.

Other controls: Pause/Play, Normal speed, Effects, Reset view, tap a tractor for the glass readout card with **Follow**, **Mark repaired** on the chip after the van arrives.

## 3. Short and extended versions

**30 seconds** (hallway, or if the stage clock is cut):
1. Plan already showing: "3 tractors, 8 blocks, zero violations."
2. Play, then **Break down...** Tractor 1. Read the explanation.
3. **Skip to sunset**: scorecard vs first come, first served, zero violations.

**4 minutes** (adds Map view, weather, Why, add tractor, more detail):
- Run the 2:00 script, but use default pace or `?pace=3`.
- After the breakdown: dwell on **Map**, tap a tractor, **Follow** it, show the readout card.
- After wind: **Calm the wind**, show the tractor resuming.
- After **Add tractor**: open **Why** on a pill the new tractor took; read the counterfactual bars.
- Show the Weather card and compass, **Heat alert** (priority change), **Block a road** (reroute and time cost).
- Close on the scorecard and say how the baseline is computed (section 4).

## 4. Q&A cheat-sheet

| Question | Answer |
|---|---|
| Is it really AI? | The brain is an algorithm, not an LLM: Weather, Agronomy, Fleet (optimizer: greedy, OR-Tools later), Navigation (A* on the road grid), Safety and Mechanic agents, plus explanation generation. Plans are checked against hard constraints, so they are safe and repeatable. An LLM is optional and may only reword explanation facts, never choose or change a plan. |
| Are those real tractors? | Yes. Each is a headless AgOpenWeb instance; our system plans, AgOpenWeb drives. A deadman heartbeat stops the tractor if our orchestrator dies. (Say "simulated backend" honestly if the demo runs on the mock.) |
| Fleet size? | No cap. Add tractors until compute runs out. Planning and the baseline are fleet-size independent. |
| How is the baseline computed? | First come, first served on the same scenario and the same events, same tractors, logged in `event_log_baseline.jsonl` next to ours. |
| What happens on breakdown? | Stop immediately, keep finished and partial progress, replan unfinished work, explain, offer a mechanic for approval. Repair return is explicit ("Mark repaired"). |
| Can the operator override? | Yes: approve or decline, change priority, take manual control, hand back to the AI. |
| Why does "Feasible" show after sunset? | Plans past 6 PM are valid but overtime; we are asking for an explicit flag (see FRONTEND_NEEDS.md). |
| What if the backend dies? | Dashboard keeps the last state and shows reconnecting; we switch to `?source=mock` (below). |

## 5. Failure plan

| Symptom | Action |
|---|---|
| Backend down or badge not LIVE | Switch to the `?source=mock` tab. Say: "We're running the in-browser simulation; same dashboard, same logic." Don't claim live. |
| Mock also broken | Play the recorded backup video, narrate over it. |
| WebGL slow, frames dropping | Click **Effects** to turn it off, or use **Map** view (`?view=map`). |
| Demo state is messy | Reload the tab (live resets the day) and restart the script; skip to section 3's 30-second version if time is short. |
| Pace wrong | Reload with `?pace=6`. |
| Stuck on a click | Say the sentence anyway, move to the next row. Never apologize on stage. |

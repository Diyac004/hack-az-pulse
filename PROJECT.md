# Harvest Fleet AI: Project Base Doc

> AgX Arizona Summit Hackathon. Challenge: **Run the Fleet** (presented by American Tractor Company).
> Team of 3. Hand-in deadline: **5:00 PM**.
> This doc is the source of truth. If something changes, update this file.

---

## 1. What we're building

An AI that runs a citrus farm's fleet of autonomous tractors.

It knows which orchard blocks are ripening, heating up, or falling behind, turns that into prioritized jobs with deadlines, assigns each job to a compatible tractor, and re-plans in seconds when a tractor breaks down, a farm road gets blocked, or the crop situation changes. Every change comes with a plain-English explanation the operator can trust.

**One-line pitch:** The farm operator stops coordinating tractors by hand. Our AI plans the fleet, fixes the plan when things go wrong, and explains every decision.

**Our twist:** most teams will only react to breakdowns. Our Agronomy Agent also changes priorities on its own when the crop changes ("Heat alert Thursday, spraying moved up" / "Block C ripening early, bin hauling moved to Thursday").

**Rule for the team:** judges score the coordinator, not the theme. Must-haves first (Section 3). The harvest flavor only gets time once the must-haves work.

---

## 2. How we get scored (and what earns each point)

| Row | Max | How we win it |
|---|---|---|
| Constraint compliance | 4 | Safety Agent checks every plan. Live "Constraint violations: 0" counter on the dashboard. |
| Completed work | 4 | Beat the first-come-first-served baseline on jobs completed and on-time jobs. |
| Operational efficiency | 4 | Less travel time and idle time than the baseline. Show the table live. |
| Adaptation to events | 3 | Fast replans, partial progress saved, no lost or duplicated jobs. |
| Explanations and demo | 5 | Plain-English explanation on every replan, plus a "Why?" button on any assignment. Biggest row. |
| Tiebreaker | 1 to 5 | "Would a farm operator trust this?" Clear explanations, edge cases handled, operator approval. |

---

## 3. Scope

### Must-haves (minimum to submit, done by the 2:30 checkpoint)
- [ ] Operator submits a job list
- [ ] Assign compatible tractors (capabilities, implements, fuel, deadlines)
- [ ] Dashboard or map showing progress
- [ ] Breakdown recovery: reassign unfinished work, no conflicts, no lost completed work
- [ ] Plain-language explanation of what changed

### Stretch goals (from the brief, in our priority order)
1. Beat the baseline on travel and idle time (side-by-side comparison) *(really a must for points)*
2. Blocked routes
3. Changed priorities (our Agronomy Agent triggers these)
4. Fuel planning with refuel stops
5. "Why?" on any assignment
6. Operator approval on the phone
7. Connect to AgOpenWeb *(skip unless everything else is done)*

### Not building
AgOpenWeb integration (needs .NET 10, judges don't score the simulator), real hardware layers, satellite imagery, 3D tree scans, worker staffing.

---

## 4. User walkthrough

Our user is the farm operator at a citrus farm in Queen Creek.

**1. Morning plan**
The operator opens the dashboard and submits today's jobs (or loads them from the scenario file).
- Agronomy Agent reads ripeness and the heat forecast and sets each job's priority and deadline.
- Fleet Agent assigns each job to a compatible tractor.
- Navigation Agent plans the routes.
- Safety Agent checks the whole plan before it runs.
The operator sees the plan on the map and on a timeline per tractor.

**2. Tractors work**
Tractors drive between blocks on the map. Jobs fill in on the timeline as they progress. Fuel bars drop.

**3. Breakdown**
Operator clicks "Break down Tractor 1."
- The AI saves partial progress, reassigns the remaining work, and explains:
  "Tractor 1 broke down 60% into spraying Block E. Tractor 3 has the only other sprayer and enough fuel, so it finishes the last 40%. Mowing Block F moves to 1:15 PM, still before its 3 PM deadline."

**4. Blocked road**
Operator blocks a farm road.
- Navigation Agent reroutes and the explanation says how many minutes it costs.

**5. Crop changes**
- Agronomy Agent: "Block C ripening faster than forecast. Bin hauling moved from Friday to Thursday, priority raised to high."
- Fleet re-plans and explains.

**6. Ask why**
Operator taps any assignment.
- AI shows the alternatives it considered and why it rejected them ("Tractor 2: no sprayer. Tractor 3: 25 min more travel.").

**7. Scorecard**
Side by side with the baseline: jobs completed, on-time jobs, travel time, idle time, constraint violations.

---

## 5. The 2-minute demo script

1. "Today a farm operator coordinates autonomous tractors by hand. Here's a citrus farm in Queen Creek with 3 tractors and 8 orchard blocks."
2. Show the morning plan: map, timeline, every job assigned. Point at "Constraint violations: 0."
3. Press play. Tractors move.
4. Break down Tractor 1. Timeline reshuffles. Read the explanation out loud.
5. Block a road. Tractor reroutes. Explanation shows the time cost.
6. Agronomy Agent heat alert fires on its own. Priorities change. Explanation.
7. Tap an assignment, show "Why?"
8. End of day: scorecard vs baseline. "More jobs done, less travel, less idle, zero violations."
9. Close: "The operator didn't coordinate anything. They read three explanations and approved."

---

## 6. Architecture

```
Dashboard (Command Center)  <--WebSocket-->  FastAPI server
                                                 |
                                   +-------------+-------------+
                                   |                           |
                              Simulator                 AI Farm Orchestrator
                       (world, ticks, events)    Agronomy -> Fleet -> Navigation -> Safety
                                   |                           |
                                   +------ Event log + Metrics +
                                                 |
                                       Baseline dispatcher (same scenario, same events)
```

- **Language:** Python 3.11+ backend (FastAPI + WebSocket). Frontend of Divi's choice (Next.js or plain Vite + canvas).
- **Determinism:** the simulator must be deterministic so ours and the baseline run the exact same scenario and events.
- **Time:** 1 tick = 1 simulated minute. Workday is 6:00 AM to 6:00 PM (720 ticks). Demo runs at about 10 ticks per second, so a full day plays in about 72 seconds.

### Agents

**Agronomy Agent (our twist)**
- Reads `crop` data in the scenario (ripeness by block, heat forecast).
- Sets job priority and deadline at the start of the day.
- Fires scripted crop events during the day (heat alert, early ripening) that change priorities.

**Fleet Agent (core of the challenge)**
- Greedy insertion, then a quick improvement pass:
  1. Sort unassigned jobs by priority (high first), then deadline (earliest first).
  2. For each job, try every compatible, operational tractor. Compute the job's finish time if appended to that tractor's queue (travel + work + any needed refuel stop).
  3. Cost = travel_minutes + idle_minutes + lateness_penalty (large if past deadline) + priority weight.
  4. Pick the cheapest feasible tractor. If none is feasible, leave the job unassigned and flag it.
  5. Improvement pass: try swapping or moving jobs between tractors if it lowers total cost without breaking constraints.
- Record all candidates and their costs for the "Why?" button.

**Navigation Agent**
- A* on the grid. Blocked cells are impassable.
- Returns path and travel minutes for a tractor's speed.

**Safety Agent**
- Runs on every plan before it's applied. Rejects the plan if any check fails, and logs which one.
- Checks:
  - Tractor has the implement the job needs
  - Tractor is operational
  - Fuel never drops below a 10% reserve along the planned route (refuel stops count)
  - No job is assigned to more than one tractor
  - No two tractors scheduled in the same block at the same time
  - No route passes through a blocked cell
  - Completed jobs are never reassigned
- Also runs as a live invariant checker every tick. Any failure increments the violation counter.

### Replanning rules (no lost or duplicated work)
- Job states: `pending` -> `assigned` -> `in_progress` -> `done` (or `failed_unassignable`).
- `progress` is stored per job (0 to 1). A broken tractor's in-progress job keeps its progress; only the remaining work is reassigned.
- On any event: freeze `done` jobs and jobs currently in progress on healthy tractors, release everything else, re-run Fleet Agent, run Safety Agent, apply.
- Every replan is logged with a diff (old plan vs new plan) and an explanation.

### Explanations
- Built from facts in code, never invented. A diff between old and new plans gives the facts: what event happened, which jobs moved, to which tractor, new start times, deadlines still met or missed, and why that tractor was chosen.
- Template first ("Tractor X broke down N% into JOB. Tractor Y takes over because REASON."). An LLM may rephrase for readability but must not add or change any fact or number.

### Operator approval
- Plans that keep every deadline and drop no job are applied immediately and the operator is notified.
- Plans that miss a deadline or leave a job unassigned pause for operator approval ("Approve / Override").
- Keeps tractors moving and keeps a human in the loop for the hard calls.

---

## 7. Data contracts (everyone codes against these)

### `scenario.json`
```json
{
  "name": "queen_creek_citrus_day1",
  "grid": { "width": 20, "height": 14, "minutes_per_cell": 2 },
  "depot": { "x": 1, "y": 1, "refuel_minutes": 15 },
  "blocks": [
    { "id": "A", "x": 4, "y": 3 },
    { "id": "B", "x": 9, "y": 3 },
    { "id": "C", "x": 14, "y": 3 },
    { "id": "D", "x": 18, "y": 6 },
    { "id": "E", "x": 4, "y": 10 },
    { "id": "F", "x": 9, "y": 10 },
    { "id": "G", "x": 14, "y": 10 },
    { "id": "H", "x": 18, "y": 12 }
  ],
  "blocked_cells": [],
  "tractors": [
    { "id": "T1", "name": "Tractor 1", "implements": ["sprayer"], "fuel": 80, "speed": 1.0,
      "fuel_per_cell": 0.4, "fuel_per_work_min": 0.12, "start": { "x": 1, "y": 1 } },
    { "id": "T2", "name": "Tractor 2", "implements": ["mower", "hedger"], "fuel": 65, "speed": 1.2,
      "fuel_per_cell": 0.4, "fuel_per_work_min": 0.10, "start": { "x": 1, "y": 2 } },
    { "id": "T3", "name": "Tractor 3", "implements": ["sprayer", "bin_trailer"], "fuel": 90, "speed": 0.9,
      "fuel_per_cell": 0.5, "fuel_per_work_min": 0.14, "start": { "x": 2, "y": 1 } }
  ],
  "jobs": [
    { "id": "J1", "type": "spray_kaolin", "implement": "sprayer", "block": "E",
      "duration": 90, "priority": 3, "deadline": 300 },
    { "id": "J2", "type": "mow", "implement": "mower", "block": "C",
      "duration": 60, "priority": 2, "deadline": 420 }
  ],
  "crop": {
    "ripeness": { "A": 0.4, "B": 0.5, "C": 0.72, "D": 0.3, "E": 0.55, "F": 0.6, "G": 0.45, "H": 0.35 },
    "heat_forecast_f": 108
  },
  "events": [
    { "t": 120, "type": "breakdown", "tractor": "T1" },
    { "t": 200, "type": "block_route", "cells": [[9, 6], [9, 7], [9, 8]] },
    { "t": 260, "type": "priority_change", "source": "agronomy", "job": "J2",
      "priority": 3, "deadline": 330, "reason": "Block C ripening faster than forecast" }
  ]
}
```
- Times (`t`, `deadline`) are minutes after 6:00 AM.
- Priority: 3 = high, 2 = medium, 1 = low.
- Fuel and travel numbers are illustrative. Tune so the demo day is tight but solvable (target about 12 jobs).
- Make sure at least one breakdown has a clear backup (T1 and T3 both have sprayers).

### WebSocket state message (server to dashboard, every tick)
```json
{
  "t": 134,
  "mode": "ours",
  "tractors": [
    { "id": "T1", "x": 4.0, "y": 9.0, "status": "broken", "fuel": 52.1, "job": null, "route": [] },
    { "id": "T3", "x": 6.5, "y": 8.0, "status": "traveling", "fuel": 71.4, "job": "J1", "route": [[7,8],[7,9]] }
  ],
  "jobs": [
    { "id": "J1", "status": "in_progress", "progress": 0.6, "tractor": "T3",
      "start": 140, "end": 176, "deadline": 300, "priority": 3 }
  ],
  "plan": [ { "tractor": "T3", "job": "J1", "start": 140, "end": 176 } ],
  "blocked_cells": [[9, 6]],
  "metrics": {
    "ours":     { "completed": 4, "on_time": 4, "travel_min": 88, "idle_min": 12, "violations": 0 },
    "baseline": { "completed": 3, "on_time": 2, "travel_min": 131, "idle_min": 47, "violations": 0 }
  },
  "pending_approval": null
}
```
`status` is one of `idle`, `traveling`, `working`, `refueling`, `broken`.

### Event log (`event_log.jsonl`, one JSON object per line, part of the hand-in)
```json
{"t": 120, "kind": "event", "type": "breakdown", "tractor": "T1"}
{"t": 120, "kind": "replan", "trigger": "breakdown", "replan_ms": 14, "changes": [{"job": "J1", "from": "T1", "to": "T3", "progress_kept": 0.6}], "safety": "pass", "explanation": "Tractor 1 broke down 60% into spraying Block E. ..."}
{"t": 176, "kind": "job_done", "job": "J1", "tractor": "T3", "on_time": true}
```

### API
| Method | Path | What it does |
|---|---|---|
| POST | `/jobs` | Operator submits a job list |
| POST | `/run?mode=ours\|baseline\|both` | Start or reset a run |
| POST | `/event` | Trigger breakdown, block_route, or priority_change |
| POST | `/approve` | Approve or override a pending plan |
| GET | `/why/{job_id}` | Candidates considered, costs, rejection reasons |
| GET | `/log` | Download the event log |
| WS | `/ws` | Live state messages |

### Metric definitions (use these exact definitions in the README)
- **Completed:** jobs reaching 100% progress by end of day.
- **On time:** completed at or before the deadline.
- **Travel time:** total minutes all tractors spend driving (including refuel trips).
- **Idle time:** minutes an operational tractor spends neither traveling, working, nor refueling while at least one compatible job is still unfinished.
- **Violations:** count of failed invariant checks (target: 0).

### Baseline (the "starter dispatcher" we compare against)
Jobs in submission order. Each job goes to the first available compatible tractor. No reordering, no fuel planning beyond refueling when empty. On breakdown, the broken tractor's job goes back to the end of the queue. Same scenario, same events.

---

## 8. Dashboard (Divi)

- **Map:** grid with blocks, depot, roads, blocked cells in red, tractors as colored icons moving along routes, fuel bar on each tractor.
- **Timeline (Gantt):** one row per tractor, job bars colored by priority, deadline markers, current-time line. Bars visibly reshuffle on replans. This is the best visual in the demo.
- **Event buttons:** Break down tractor (pick one), Block route (click cells), Change priority.
- **Explanation card:** latest replan explanation, big and readable.
- **Activity feed:** every event, assignment, replan, job done.
- **Why? popover:** click any job bar to see candidates and reasons from `/why/{job_id}`.
- **Scorecard:** ours vs baseline metrics, live, plus the violation counter.
- **Side-by-side mode (stretch):** two small maps running ours and baseline at the same time.
- **Approval modal (stretch):** appears when `pending_approval` is set. A phone page showing the same card is a bonus.

---

## 9. Who owns what

### Divi: Dashboard
- [ ] App shell, WebSocket connection, render a state message
- [ ] Map with blocks, depot, tractors, routes, blocked cells
- [ ] Gantt timeline per tractor
- [ ] Event buttons wired to `/event`
- [ ] Explanation card and activity feed
- [ ] Scorecard with ours vs baseline and violation counter
- [ ] Why? popover
- [ ] Stretch: side-by-side mode, approval modal, phone approval page

### Person 2: Simulator, baseline, metrics
- [ ] `scenario.json` with 3 tractors, 8 blocks, about 12 jobs, 3 events (tune so the day is tight)
- [ ] Simulator: world state, tick loop, travel, work progress, fuel use, refueling at depot
- [ ] Event engine: breakdown, block_route, priority_change, applied at the right tick
- [ ] Baseline dispatcher
- [ ] Metrics exactly as defined in Section 7
- [ ] Event log writer (`event_log.jsonl`)
- [ ] FastAPI server and WebSocket broadcast (or pair with Person 3)
- [ ] Headless mode: `python run.py --mode both` prints the comparison table

### Person 3: Coordinator (AI Farm Orchestrator)
- [ ] Navigation Agent (A* with blocked cells)
- [ ] Fleet Agent (greedy insertion plus improvement pass, fuel stops)
- [ ] Safety Agent (all checks in Section 6, plus live invariant checker)
- [ ] Replanning with progress preserved
- [ ] Agronomy Agent (priorities and deadlines from crop data, scripted crop events)
- [ ] Explanation generator (diff to facts to text)
- [ ] `/why/{job_id}` data
- [ ] README

### Shared at the end
- [ ] Final demo run, export event log
- [ ] Comparison table vs baseline
- [ ] Backup demo video
- [ ] Rehearse the 2-minute demo twice

---

## 10. Timeline (deadline 5:00 PM)

| Clock | What happens |
|---|---|
| 11:05 to 11:30 | Read this doc. Agree on contracts. Scaffold repo. Person 2 writes `scenario.json`. |
| 11:30 to 1:00 | Simulator and baseline running headless. Coordinator v1 assigns jobs. Dashboard renders a static state. |
| **1:00 checkpoint** | Both dispatchers run the scenario and print metrics. Dashboard shows the map from real data. |
| 1:00 to 2:30 | Breakdown recovery, Safety Agent, explanations, live dashboard over WebSocket. |
| **2:30 checkpoint** | All must-haves work end to end. Breakdown, replan, explanation, metrics on screen. |
| 2:30 to 3:45 | Stretch goals in priority order (Section 3). |
| **3:45 feature freeze** | No new features after this. Bug fixes only. |
| 3:45 to 4:30 | Final demo run, save event log, comparison table, README, backup video. |
| 4:30 to 5:00 | Submit. Buffer. |

### Cut order if we fall behind
1. AgOpenWeb (already cut)
2. Side-by-side mode (keep the scorecard table)
3. Phone approval (keep the modal on the dashboard)
4. Improvement pass in Fleet Agent (greedy alone should still beat FCFS)
5. Agronomy crop events (keep the manual priority change button)

**Never cut:** compatible assignment, breakdown recovery with progress saved, explanation card, scorecard vs baseline, violation counter.

---

## 11. Hand-in checklist (due 5:00 PM)

- [ ] Link to code
- [ ] README: how to run, that we built our own simulator (not AgOpenWeb), architecture summary
- [ ] `scenario.json`
- [ ] `event_log.jsonl` from the demo run
- [ ] Comparison vs baseline: jobs completed, travel time, idle time (plus on-time and violations)

### README outline
1. What it is (2 sentences)
2. How to run (`pip install -r requirements.txt`, `python run.py --mode both`, start server, open dashboard)
3. Simulator: our own, why, and its assumptions
4. Agents and how they work
5. Results table vs baseline
6. Known limitations

---

## 12. Honest notes

- **Greedy is not optimal.** It should clearly beat FCFS, but say "heuristic" if judges ask. The improvement pass helps.
- **Numbers are illustrative.** Fuel rates, speeds, and durations are made up but internally consistent. Say so.
- **Tune the scenario so the difference is visible.** If both dispatchers finish everything easily, the comparison is boring. Make the day tight.
- **Don't fake the comparison.** Both runs use the same scenario and events. Judges may ask to see the log.
- **LLM explanations only rephrase.** Every fact and number comes from code, so explanations are always accurate.
- **Test the breakdown edge cases:** tractor breaks while traveling, while refueling, with no compatible backup (job should be flagged, not lost), and a second breakdown right after the first.

---

## 13. If we finish early

1. Side-by-side live mode (ours vs baseline on two maps)
2. Phone approval page for plans that miss a deadline
3. Implement swaps at the depot (a tractor switches mower to hedger, costs 15 min)
4. Operator chat: ask "why" in plain English, answered from the `/why` data
5. AgOpenWeb connection

---

## Additions / Changes

> New changes go here only. The text above stays as written. Where an addition conflicts with something above, the addition wins.

### Change 1: Mechanic Agent (auto-find and book a mechanic on breakdown)

**What it does**
When a tractor breaks down, a new Mechanic Agent finds the top 4 mobile mechanics near the farm and shows a pop-up in the app: "Tractor 1 broke down. Book a mechanic?" with 4 options. The operator picks one (or accepts the AI's top pick) and taps Approve. The agent books the mechanic, and the coordinator plans the tractor's return to service.

**Walkthrough**
1. Tractor 1 breaks down.
2. Fleet Agent replans the work as before and shows the explanation.
3. Mechanic Agent searches for mechanics and ranks the top 4.
4. Pop-up shows 4 cards: name, source, distance, rating, mobile or shop, ag equipment experience, arrival ETA, estimated cost. Top pick is marked "Recommended" with a one-line reason.
5. Operator taps Approve on one card.
6. Agent books it and logs: "Booked [mechanic], arriving 12:40 PM, est. repair 90 min."
7. Coordinator marks Tractor 1 as `repair_scheduled` with an expected return time. When it's back in service, the Fleet Agent replans again and gives it work, with an explanation ("Tractor 1 repaired at 2:10 PM. Hedging Block H moved back to it, saving Tractor 2 a 30 min trip.").

**Why it helps our score**
It isn't a scored row by itself, but the return-to-service replan strengthens "Adaptation to events," and it removes another manual step for the operator, which helps the "would an operator trust this?" tiebreaker.

**Important: use farm equipment mechanics, not car mechanics**
YourMechanic and Wrench are car-repair services and won't fix tractors. Taskrabbit is general help. Search for **mobile farm equipment / heavy diesel repair** instead. Real examples of the right category in Arizona:
- Mobile heavy diesel repair companies that service farm machinery on site (for example, Transwest Mobile lists farm machinery among its field repairs across AZ)
- Farm equipment repair listings (BBB lists farm equipment repair businesses near Mesa, Buckeye, Tucson, and Yuma)
- Tractor dealerships with service departments
- Thumbtack pros who list tractor or diesel repair

Thumbtack can stay as one source. Keep the source field on each card so judges see where the result came from.

**Booking rule for the demo**
Do not send real booking requests to real businesses during the hackathon. A real mechanic would get a fake job and possibly drive out. For the demo:
- Use **real listings preloaded** into the scenario (searched before the demo), so the cards show real businesses.
- The "Book" action hits a **mock booking page** we build (generic, no copied branding), optionally filled in live by a browser agent so judges see it happen.
- On stage say: "In production, this books through the mechanic's real booking channel."

**Ranking (top 4)**
Score each mechanic and sort high to low:
- Arrival ETA (sooner is better) - weighted most, since downtime is the cost
- Ag or heavy diesel experience (required for top pick)
- Mobile service (comes to the field)
- Rating and review count
- Estimated cost
The top pick's reason is generated from the winning factors, e.g. "Recommended: only mobile ag specialist arriving within 1 hour."

**Data contract additions**

`scenario.json` gets a `mechanics` list (preloaded real listings, fill in before the demo):
```json
"mechanics": [
  { "id": "M1", "name": "Example Mobile Diesel", "source": "Google", "distance_mi": 12.4,
    "rating": 4.8, "reviews": 132, "mobile": true, "ag_equipment": true,
    "eta_min": 55, "est_cost": 420, "repair_min_estimate": 90, "url": "https://..." }
]
```

Breakdown events get an optional repair override:
```json
{ "t": 120, "type": "breakdown", "tractor": "T1", "issue": "hydraulic leak" }
```

New tractor statuses: `awaiting_mechanic`, `repair_scheduled`, `repairing` (all count as not operational).

WebSocket state message adds:
```json
"pending_mechanic": {
  "tractor": "T1",
  "issue": "hydraulic leak",
  "options": [ { "id": "M1", "name": "...", "eta_min": 55, "est_cost": 420, "score": 0.91, "recommended": true, "reason": "..." } ]
}
```

New API endpoints:
| Method | Path | What it does |
|---|---|---|
| GET | `/mechanics?tractor=T1` | Top 4 ranked options for a broken tractor |
| POST | `/mechanics/book` | Body `{ "tractor": "T1", "mechanic": "M1" }`. Books (mock), schedules return to service |

New event log entries:
```json
{"t": 121, "kind": "mechanic_search", "tractor": "T1", "options": ["M1","M3","M2","M4"]}
{"t": 124, "kind": "mechanic_booked", "tractor": "T1", "mechanic": "M1", "arrival_t": 176, "return_t": 266}
{"t": 266, "kind": "tractor_repaired", "tractor": "T1"}
{"t": 266, "kind": "replan", "trigger": "tractor_repaired", "explanation": "..."}
```

**Metrics note**
Booking a mechanic doesn't change how we measure travel or idle time. For fairness, apply the same repair return time to the baseline run too, otherwise the comparison isn't apples to apples. (Baseline uses the same booked mechanic's return time; it just doesn't get the smart replan.)

**Owners**
- Divi: mechanic pop-up (4 cards, Recommended badge, Approve), status badges for repair states.
- Person 2: `mechanics` data in the scenario (search real listings before the demo), repair statuses and return-to-service in the simulator, same return time applied to baseline.
- Person 3: Mechanic Agent ranking and reason text, `/mechanics` endpoints, return-to-service replan and explanation.

**Priority**
Stretch. Start only after the 2:30 checkpoint, after "beat the baseline" and "blocked routes." If short on time, keep only steps 1 to 6 (pop-up and mock booking) and skip the return-to-service replan.

---

### Change 2: AgOpenWeb as the tractor layer + an AI orchestration layer on top

> This replaces "Not building: AgOpenWeb integration" in Section 3. AgOpenWeb is now in scope, in tiers, with a hard fallback.

**The idea in one line**
Our AI orchestrator plans the fleet; AgOpenWeb drives the tractors. Each tractor is a real AgOpenWeb guidance instance running in simulator mode, so when our coordinator assigns a job, judges watch AgOpenWeb actually steer that tractor down AB passes and paint coverage, and when we trigger a breakdown, AgOpenWeb stops it.

This maps directly onto ATC's suggested architecture: our 3D dashboard is the **Command Center**, our agents are the **AI Farm Orchestrator**, and AgOpenWeb stands in for the **edge controller and tractor**.

#### What AgOpenWeb is (from reading the repo)
- A .NET 10 GPS guidance app (rewrite of AgOpenGPS). The backend serves a web UI at `http://localhost:5174`.
- It has a **built-in simulator** (no hardware needed): fake GPS, speed, steering.
- **One instance = one tractor.** It refuses a second copy on the same computer (single-instance lock) and uses fixed port 5174 and UDP ports 9999/8888.
- It is controlled over a **WebSocket at `ws://localhost:5174/ws`**. The browser UI sends plain text commands, `command|argument`. We can send the same commands from Python.
- It sends state back as **binary frames**. Byte 0 is the frame type. Type `2` (Tick) carries the live pose.

#### Commands we need (confirmed in `Shared/AgOpenWeb.RemoteWiring/RemoteServerWiring.cs`)
| Command | What it does |
|---|---|
| `control.acquire\|FleetAI` | Take control. Required before almost any command (everything except observer commands is gated). |
| `control.presence` | Heartbeat. Send every ~0.4 s. If it stops for 1.5 s, AgOpenWeb's deadman disengages autosteer and turns sections off. That's a real safety feature, mention it in the pitch. |
| `sim.toggleEnable` | Turn the built-in simulator on/off (it's a toggle, check the state on screen once). |
| `sim.setCoords\|lat,lon` | Teleport the simulated tractor (we use it to "arrive" at a field after our own transit sim). |
| `sim.speedUp` / `sim.speedDown` / `sim.stop` / `sim.toggle10x` | Sim speed control. |
| `field.openOnly\|<field name>` | Open a field created in advance (one AgOpenWeb field per orchard block). Verify the arg format in `ApplyFieldCommand`. |
| `track.latLonAB\|latA,lonA,latB,lonB` | Create an AB guidance line for the job's passes. |
| `autosteer.toggle` | Engage/disengage autosteer (toggle). |
| `section.master` | Automatic section control on (paints coverage). |
| `youturn.toggle` | Automatic U-turns at the headland. |

#### Tick frame layout (first fields only, little-endian, `WireCodec.EncodeTick`)
```
offset 0   u8   type = 2
offset 1   i64  scene version
offset 9   f64  easting  (m, field-local)
offset 17  f64  northing (m, field-local)
offset 25  f32  heading  (check units on screen: radians or degrees)
offset 29  f32  speed
```

#### Integration tiers (pick the highest one that works by 1:00 PM)
- **Tier A: our own simulator only** (the plan in Sections 6 to 7). Always the fallback. Must keep working no matter what.
- **Tier B (target): one tractor live in AgOpenWeb.** Tractor 1 is driven by AgOpenWeb; Tractors 2 and 3 stay in our sim. Our simulator still owns the farm map, roads, travel between blocks, events, metrics, and the baseline. When T1 arrives at a block, the adapter hands the job to AgOpenWeb (open field, set AB line, engage autosteer, sections on). Progress for T1 comes from AgOpenWeb's pose. Breakdown on T1 sends `sim.stop` and disengages autosteer in AgOpenWeb, visibly.
- **Tier C (stretch): all three tractors live.** Run three AgOpenWeb instances in three Docker containers (the repo's own harness runner notes each container gets its own network, so the single-instance lock and UDP ports don't collide), mapped to host ports 5174, 5175, 5176. `Tools/harness-runner/Dockerfile` is a starting point.

#### Architecture (updated)
```
Command Center (3D dashboard)  <-- WebSocket -->  FastAPI server
                                                     |
                     +-------------------------------+-------------------------------+
                     |                               |                               |
              World simulator              AI Farm Orchestrator                Baseline (FCFS)
      (map, roads, transit, events,   LLM Orchestrator Agent (tools only)     same scenario,
       metrics, event log)            -> Agronomy, Fleet, Navigation,          same events
                     |                   Safety, Mechanic agents
                     |                               |
                     +---------- Fleet Gateway (adapter per tractor) --------+
                                        |                |                |
                                 AgOpenWeb :5174   (sim or :5175)   (sim or :5176)
```

#### The AI orchestration layer (what makes it "AI", without risking violations)
Two levels:
1. **Deterministic core** (Fleet, Navigation, Safety agents as already designed). Produces assignments and guarantees zero constraint violations.
2. **LLM Orchestrator Agent** on top, using tools only:
   - `get_fleet_state()`, `get_jobs()`, `get_events()`
   - `propose_plans(strategy)` asks the core for candidate plans under different goals (minimize lateness, minimize travel, protect high priority)
   - `simulate(plan)` returns predicted jobs done, travel, idle, late jobs
   - `safety_check(plan)` runs the Safety Agent
   - `apply(plan)` only accepts a plan that passed `safety_check`
   - `explain(diff)` and `why(job_id)` return facts the LLM turns into plain English
   - `book_mechanic(...)` (Change 1)
   
   The LLM chooses between validated candidate plans and narrates. It never writes an assignment directly, and every number it says comes from a tool result. That's the trust story: "AI judgment, solver guarantees."
3. **Operator chat** (stretch, high value for the "Explanations" row): the operator types "the road east of Block F is flooded" or "why is Tractor 3 doing Block E?" and the LLM turns it into a `block_route` event or a `why` lookup.

#### Fleet Gateway adapter (starter, Python, needs `pip install websockets`)
Not yet run against a live AgOpenWeb. Verify each command once by watching the AgOpenWeb UI while sending it.

```python
import asyncio
import struct
import websockets


class AgOpenWebTractor:
    """One tractor = one AgOpenWeb instance in simulator mode."""

    def __init__(self, tractor_id, url="ws://localhost:5174/ws", name="FleetAI"):
        self.tractor_id = tractor_id
        self.url = url
        self.name = name
        self.ws = None
        self.pose = None          # {'e','n','heading','speed'} from Tick frames
        self.has_control = False
        self._tasks = []

    async def connect(self):
        self.ws = await websockets.connect(self.url, max_size=None)
        await self.send("control.acquire", self.name)
        self._tasks = [asyncio.create_task(self._heartbeat()),
                       asyncio.create_task(self._receive())]

    async def close(self):
        for t in self._tasks:
            t.cancel()
        if self.ws:
            await self.send("control.release")
            await self.ws.close()

    async def send(self, cmd, arg=None):
        await self.ws.send(cmd if arg is None else f"{cmd}|{arg}")

    async def _heartbeat(self):
        # Deadman is 1.5 s: if this stops, AgOpenWeb disengages autosteer itself.
        while True:
            await self.send("control.presence")
            await asyncio.sleep(0.4)

    async def _receive(self):
        async for msg in self.ws:
            if not isinstance(msg, (bytes, bytearray)) or not msg:
                continue
            kind = msg[0]
            if kind == 2 and len(msg) >= 33:          # Tick
                _, e, n, heading, speed = struct.unpack_from("<qddff", msg, 1)
                self.pose = {"e": e, "n": n, "heading": heading, "speed": speed}
            elif kind == 6:                            # ControlState
                self.has_control = True                # refine by decoding if needed

    # High-level actions the orchestrator calls
    async def start_job(self, field_name, lat, lon, ab, speed_steps=6):
        """ab = (latA, lonA, latB, lonB) for the job's first pass."""
        await self.send("field.openOnly", field_name)
        await self.send("sim.setCoords", f"{lat},{lon}")
        await self.send("track.latLonAB", ",".join(str(v) for v in ab))
        await self.send("section.master")
        await self.send("youturn.toggle")
        await self.send("autosteer.toggle")
        for _ in range(speed_steps):
            await self.send("sim.speedUp")

    async def stop(self):
        """Breakdown or pause: stop the sim tractor and disengage autosteer."""
        await self.send("sim.stop")
        await self.send("autosteer.toggle")


async def demo():
    t1 = AgOpenWebTractor("T1")
    await t1.connect()
    await asyncio.sleep(1)
    print("pose:", t1.pose)
    await t1.close()


if __name__ == "__main__":
    asyncio.run(demo())
```

Watch-outs:
- `sim.toggleEnable`, `autosteer.toggle`, `section.master`, and `youturn.toggle` are toggles. Track their state (from the Tick frame flags, or by eye) so you don't flip them off by accident.
- Pose is in field-local meters. Our dashboard uses grid cells. Pick one field origin per block and convert.
- Progress for an AgOpenWeb job: distance covered along passes divided by planned pass length (simple), or decode the Status frame's field data areas (better, more work).

#### Setup spike (Person 2, starts now, hard stop at 1:00 PM)
1. Install the .NET 10 SDK.
2. `git clone https://github.com/AgOpenGPS-Official/AgOpenWeb.git`
3. `dotnet run --project Platforms/AgOpenWeb.Desktop/AgOpenWeb.Desktop.csproj -- --headless`, open `http://localhost:5174`.
4. In the UI: enable the simulator, create one field per orchard block (or at least one field), confirm the tractor moves.
5. Run the adapter's `demo()` and confirm a pose prints.
6. Send `track.latLonAB` and `autosteer.toggle` from Python and watch the tractor follow the line.

**If step 5 isn't working by 1:00 PM, stay on Tier A.** Don't let AgOpenWeb eat the afternoon. The must-haves are scored, the integration is a stretch goal in the brief.

#### Ownership changes
- **Person 2:** AgOpenWeb setup spike and the Fleet Gateway adapter (above). The simulator and baseline tasks don't change, so keep the spike to the 1:00 PM limit.
- **Person 3:** LLM Orchestrator Agent tools wrapper (after the deterministic core works, not before).
- **Divi:** on the dashboard, mark live tractors with a "Live in AgOpenWeb" badge, and add a picture-in-picture panel showing `http://localhost:5174` (an iframe on the demo laptop) so judges see AgOpenWeb steering in real time next to our 3D farm.

#### Hand-in impact
- README must say which tier we reached ("Connected to AgOpenWeb for Tractor 1; Tractors 2 and 3 use our own simulator").
- The event log should include adapter events: `agopenweb_job_started`, `agopenweb_stopped`, heartbeat lost.

#### Updated demo moment
Split screen: our 3D farm on the left, AgOpenWeb on the right. Assign a job, and AgOpenWeb's tractor lines up and starts painting coverage. Break down Tractor 1, and AgOpenWeb's tractor stops dead while our dashboard replans and explains. Then say: "Our AI plans the fleet. AgOpenWeb drives the tractors. The deadman heartbeat means if our orchestrator ever crashes, the tractor stops itself."

---

### Change 3: Multi-tractor coordination through AgOpenWeb containers is now non-negotiable

> This overrides the tiers in Change 2. Tier C (every tractor is a live AgOpenWeb instance) is the core of the project, not a stretch. Tiers A and B are no longer goals.

#### The redefined idea
**Harvest Fleet AI is a fleet brain for autonomous tractors.** One AI orchestrator coordinates three tractors, and each tractor is a real AgOpenWeb guidance system running in its own container. The orchestrator decides which tractor does which job, sends each one its route and guidance line, watches their live positions, and re-plans when a tractor breaks down, a road is blocked, or the crop changes. Every decision comes with a plain-English explanation.

**Pitch line:** "AgOpenWeb can guide one tractor. We built the brain that coordinates a fleet of them."

#### What changes
- **AgOpenWeb is the physics.** Tractor movement, steering, guidance, and coverage all come from the three AgOpenWeb containers. Our Python code no longer moves tractors.
- **Our Python backend becomes the orchestrator plus a "world service":** clock, events, job progress (computed from AgOpenWeb poses), fuel model (AgOpenWeb has none), blocked roads, metrics, event log.
- **A Fleet Gateway** holds one adapter per container (`:5174`, `:5175`, `:5176`), keeps each heartbeat alive, sends commands, and streams poses to the orchestrator and dashboard.

#### How each part of a job runs on AgOpenWeb
1. **Transit between blocks.** AgOpenWeb has no road routing, so our Navigation Agent plans the road route and the gateway moves the tractor along it.
   - Default (reliable): step the tractor along the route with small `sim.setCoords` moves every ~0.3 s. Looks like driving on the map.
   - Stretch: real steering. A pure-pursuit controller in Python reads the pose and sends `sim.setSteer|deg`, so AgOpenWeb physically drives the route.
2. **Field work.** On arrival: `field.openOnly` for that block, `track.latLonAB` for the passes, `section.master`, `youturn.toggle`, `autosteer.toggle`, speed up. AgOpenWeb steers the passes and paints coverage.
3. **Done.** Gateway detects the job's passes are covered (distance along passes vs plan), disengages autosteer, reports done.
4. **Breakdown.** Orchestrator sends `sim.stop` and disengages autosteer on that container. Optional dramatic version: `docker pause` the container, the heartbeat dies, and AgOpenWeb's deadman stops the tractor by itself. That shows a real safety behavior.

#### Shared farm across all three containers
- All containers must have the same 8 fields (one per orchard block), with the same coordinates.
- Build them once in one AgOpenWeb instance (or write them using the documented format in `Docs/FIELD_FILE_FORMATS.md`), then mount that same data folder into all three containers.
- Poses from the Tick frame are field-local meters. Keep each field's origin (from its `field.geojson`) in a lookup table so the gateway converts every pose to one shared farm frame for the dashboard.

#### Containers
- Start from `Tools/harness-runner/Dockerfile` or a slimmer .NET 10 image; build AgOpenWeb once, run it headless (`-- --headless`).
- Run three containers mapped to host ports 5174, 5175, 5176. Each container has its own network, so the single-instance lock and UDP ports don't collide.
- Limit CPU per container (`--cpus 2` on a laptop). The repo notes a CPU-starved instance can falsely report autosteer dropping.
- Open the AgOpenWeb web UI for only one container at a time (the one shown on screen). Every open browser tab adds load.

#### Time scale (important)
AgOpenWeb's simulator runs in real time (with a 10x toggle). A full 12-hour day won't fit in a demo. So:
- Size the scenario so the whole demo day runs in **about 10 to 12 minutes of real time**: small blocks (a few short passes each), 10x sim speed, short transit.
- Show the clock on the dashboard as compressed farm time.

#### The baseline comparison (still required)
Run the baseline on the same containers too, as a second live run of the same scenario and the same events (another ~10 minutes). Record both event logs. This is honest and judges can check it.
- Backup: also run both dispatchers in the fast Python twin (same rules), and label those numbers "simulated" if the live baseline run doesn't finish in time.

#### De-risking: build against an interface, not the containers
- Define one `TractorGateway` interface: `start_transit(route)`, `start_job(job)`, `stop()`, `pose()`, `status()`.
- Two implementations: `AgOpenWebGateway` (the real one) and `MockGateway` (instant, in Python).
- The coordinator, dashboard, and baseline are built and tested against `MockGateway`, so nobody waits on Docker. Swap to `AgOpenWebGateway` as soon as the containers work. The demo runs on AgOpenWeb.

#### Updated roles
- **Person 2: containers and the gateway.** Docker image, three containers, shared field data, `AgOpenWebGateway` (heartbeats, commands, Tick decoding, pose conversion, transit stepping, job completion detection).
- **Person 3: orchestrator.** Fleet, Navigation, Safety, Agronomy agents, replanning, explanations, LLM orchestrator layer, `MockGateway`, baseline dispatcher, metrics, event log.
- **Divi: dashboard.** 3D farm drawn from the gateway's live poses for all three tractors, "Live in AgOpenWeb" badge per tractor, picture-in-picture of one container's AgOpenWeb UI, everything else as planned.

#### Updated timeline (deadline 5:00 PM)
| Clock | Milestone |
|---|---|
| 11:45 to 12:30 | Person 2: image built, one container running, Python reads its pose. Others build against `MockGateway`. |
| **12:30 checkpoint** | One AgOpenWeb container steers a tractor down an AB line on command from Python. |
| 12:30 to 1:30 | Three containers up, shared fields mounted, transit stepping works, poses on the dashboard. |
| **1:30 checkpoint** | Orchestrator assigns jobs to all three containers and they run them. |
| 1:30 to 2:45 | Breakdown recovery live on containers, explanations, scorecard. |
| **2:45 checkpoint** | Full demo flow on AgOpenWeb end to end. |
| 2:45 to 3:45 | Stretch: blocked roads, heat alert, mechanic, "why?", LLM chat. |
| **3:45 freeze** | |
| 3:45 to 4:30 | Live run of ours and baseline, save both logs, comparison table, README, backup video. |
| 4:30 to 5:00 | Submit. |

#### If containers are fighting us at 12:30
The decision stays "AgOpenWeb for every tractor." The fallback is native, not a different design: run each AgOpenWeb instance on a **separate teammate laptop** on the same Wi-Fi (one tractor per laptop, `http://<laptop-ip>:5174`). The gateway only needs three WebSocket URLs, so nothing else changes.

#### Hand-in impact
- README: "All three tractors run on AgOpenWeb (one instance per tractor in Docker). Our orchestrator coordinates them over AgOpenWeb's WebSocket control interface."
- Include the Dockerfile, the compose file or run commands, and the shared field data in the repo.
- Event logs from both live runs.

---

### Change 4: Plug-and-play tractors (add a tractor in one step, even mid-day)

> Builds on Change 3. Nothing in the system may assume exactly 3 tractors. "3" is now just the starting fleet size.

#### The redefined idea
**Harvest Fleet AI is a plug-and-play fleet brain for autonomous tractors.** Every tractor is a real AgOpenWeb guidance system in its own container. Adding a tractor is one click (or one command): a new AgOpenWeb container starts, registers itself with its implements and fuel, appears on the 3D farm, and the AI orchestrator immediately rebalances the day's jobs to use it, then explains what changed. Losing a tractor works the same way in reverse.

**Pitch line:** "AgOpenWeb guides one tractor. We built the brain that coordinates as many as you plug in."

#### How a tractor is defined (one entry, nothing else to edit)
`fleet.json` (or the `tractors` list in `scenario.json`):
```json
{
  "id": "T4",
  "name": "Tractor 4",
  "implements": ["mower", "hedger"],
  "fuel": 75,
  "speed": 1.0,
  "start": { "x": 3, "y": 6 },
  "endpoint": "auto"
}
```
- `endpoint: "auto"` means the Fleet Manager starts a container and picks the port.
- `endpoint: "ws://192.168.1.23:5174/ws"` means "connect to an AgOpenWeb that's already running" (a teammate's laptop, or a real machine later). Same gateway code either way.
- Color, timeline lane, map icon, and fleet card are generated from the id. No hard-coded tractor anywhere in the UI.

#### New component: Fleet Manager
Lives in the backend, next to the Fleet Gateway.
- **Add tractor:** reads the entry, runs `docker run` for a new AgOpenWeb container on the next free port (5174 + n) with the shared field data mounted and a CPU limit, waits until its WebSocket answers, acquires control, enables the simulator, places the tractor at its start point, and registers it with the orchestrator.
- **Remove tractor:** finishes or hands back its current job first (same replan path as a breakdown, but planned), then stops the container.
- **Health:** watches every heartbeat. A container that stops answering is treated as a breakdown automatically.
- Use the Docker SDK for Python (`pip install docker`) or plain `docker run` via subprocess. A `docker-compose.yml` with the starting fleet is fine for the first 3; extra tractors are added by the Fleet Manager at runtime.

Tractor lifecycle states (shown on the dashboard):
`starting` (container booting, show a spinner) -> `ready` -> `traveling` / `working` / `refueling` / `idle` -> `broken` / `repair_scheduled` / `repairing` -> `removing` -> gone.

#### What the orchestrator does when a tractor joins
1. Fleet Agent re-runs assignment over all unstarted jobs with the new tractor included.
2. Safety Agent checks the new plan.
3. Explanation: "Tractor 4 joined with a mower. It takes Mow F and Mow B from Tractor 2, which cuts Tractor 2's queue by 3 hours and brings Hedge H ahead of its deadline."
4. Event log entry: `{"kind": "tractor_added", "tractor": "T4", "implements": [...], "replan": {...}}`.

#### API additions
| Method | Path | What it does |
|---|---|---|
| GET | `/fleet` | All tractors, their state, endpoint, implements |
| POST | `/fleet` | Add a tractor (body = one fleet entry) |
| DELETE | `/fleet/{id}` | Remove a tractor (planned hand-back, then stop container) |

#### Dashboard changes (Divi)
- Timeline lanes, fleet cards, and map tractors are built from `/fleet`, any count. Cards scroll horizontally past 4; lanes grow the dock height.
- **"Add tractor" button** opens a small sheet: pick implements (sprayer, mower, hedger, bin trailer), starting fuel, then Add. The new tractor appears with a "Starting" spinner, then drives onto the farm when ready.
- Color palette assigned by order: blue, purple, orange, teal, pink, indigo, then repeat.

#### Algorithm checklist (Person 3)
Everything already loops over "all tractors", but confirm nothing assumes 3:
- Fleet Agent, Safety Agent, Mechanic Agent, and the baseline all take the tractor list as input.
- Replans can be triggered by `tractor_added` and `tractor_removed`, not just events.
- Metrics count per tractor and in total.
- The baseline run uses the same fleet changes at the same times, so the comparison stays fair.

#### Limits to be honest about
- Each AgOpenWeb container needs real CPU. On one laptop, about 3 to 5 tractors is realistic. Beyond that, point extra tractors' `endpoint` at teammates' laptops.
- A new container takes some seconds to boot. The dashboard shows it as `starting`, and the orchestrator only assigns work once it's `ready`.

#### New demo moment (add to the script after the breakdown)
"Tractor 1 is down. Let's add a tractor." Click Add tractor, choose a sprayer, and a new AgOpenWeb container boots, Tractor 4 drives onto the farm, the timeline pills fly into its new lane, and the explanation says exactly which jobs it took and why. "Plug in a tractor, the fleet adapts in seconds."

#### Updated roles
- **Person 2:** Fleet Manager (container start/stop, port allocation, health checks) on top of the gateway from Change 3.
- **Person 3:** make every agent and the baseline fleet-size independent, handle `tractor_added` / `tractor_removed` replans and explanations.
- **Divi:** dynamic lanes, cards, and colors, plus the Add tractor sheet and the starting state.

#### Timeline note
Fleet Manager "add tractor" lands after the 1:30 checkpoint (3 tractors running jobs). Until then, start the first 3 with `docker-compose up`. The add-tractor flow is in the 1:30 to 2:45 block, before breakdown polish.

---

### Change 5: Our own UI is the only operator UI; AgOpenWeb runs fully headless

> Overrides the picture-in-picture panel in Changes 2 and 3.

- Every AgOpenWeb container runs with `--headless`. Nobody opens AgOpenWeb's web UI during the demo, which also saves CPU for more tractors.
- Our 3D Command Center (the UI mock: diorama, glass panels, Dynamic Island, timeline dock, explanation card, scorecard) is the single screen judges see. It draws every tractor from the live poses the Fleet Gateway reads out of AgOpenWeb.
- Each tractor card shows a small "AgOpenWeb" chip (endpoint, heartbeat age, autosteer on/off) so judges can see the tractors really are AgOpenWeb instances without seeing AgOpenWeb's screen.
- Debug only: a hidden "Open AgOpenWeb" link per tractor (`http://localhost:<port>`) for the team, in case we need to check a container during the build. It is not part of the demo.
- On stage, say it once: "Each of these tractors is a headless AgOpenWeb guidance system. This is our fleet brain's interface on top of them."

---

### Change 6: Weather-aware planning, and the orchestration brain is an algorithm (not an LLM)

> Overrides the "LLM Orchestrator Agent" in Change 2. The LLM is now optional and only words things. All decisions come from an optimization algorithm.

#### Part A: The orchestration brain is an algorithm
**Decision:** the brain that assigns and schedules jobs is a constraint-based optimizer. The brief allows "agent-based (for example, using a language model) or algorithmic." Algorithmic wins for us because:
- **Constraint compliance (4 pts):** hard constraints are enforced by the solver, so violations are impossible by construction, not "hopefully avoided."
- **Completed work and efficiency (8 pts):** an optimizer minimizes travel and idle time directly; an LLM guesses.
- **Adaptation (3 pts):** re-solving takes about a second, every time, deterministically. Same input, same plan.
- **Trust tiebreaker:** we can prove why a plan was chosen (see "Why?" below).

We still call it the AI orchestration layer: agents (Weather, Agronomy, Fleet, Navigation, Safety, Mechanic) wrapped around an optimization solver. That is AI in the operations-research sense, and it's honest.

**The model: vehicle routing with time windows (OR-Tools)**
`pip install ortools`. Use the Routing solver, which matches our problem almost exactly:
| Our problem | OR-Tools Routing |
|---|---|
| Tractors | Vehicles, each with its own start location and "available from" time |
| Jobs | Nodes with service time = remaining work minutes |
| Implements (sprayer, mower...) | Allowed vehicles per node (`SetAllowedVehiclesForIndex`) |
| Travel between blocks | Transit callback from the Navigation Agent's road-distance matrix (A* times, blocked roads included) |
| Deadlines | Soft upper bound on the time dimension with a priority-weighted penalty (`SetCumulVarSoftUpperBound`) |
| Weather no-spray periods | Forbidden start times on that job's time variable (`CumulVar(i).RemoveInterval(a, b)`) |
| Jobs that can't be done today | Disjunctions with a priority-weighted drop penalty, so the solver drops low-priority work first and reports it |
| Fuel | Fuel dimension with capacity = current fuel minus 10% reserve; if a route doesn't fit, insert a depot refuel stop in post-processing and re-check |

Objective: minimize total travel + idle + weighted lateness + weighted dropped jobs. Time limit 1 to 2 seconds per solve (`GUIDED_LOCAL_SEARCH` metaheuristic).

**Rolling re-planning (on any event)**
1. Freeze completed jobs and the in-progress job on every healthy tractor.
2. Rebuild the model from the live state: each tractor's current position and the time it becomes free; remaining work only (a 60%-done job keeps 40% as its service time).
3. Re-solve, run the Safety Agent on the result, apply, log the diff, explain.

**Fallback:** the greedy insertion from Section 6 stays as a backup. If OR-Tools returns nothing within the time limit, use greedy. Build order: greedy first (working by 1:30), OR-Tools behind the same interface after.

**"Why?" answered by the algorithm (counterfactuals)**
When the operator asks "Why Tractor 3 for Spray E?", re-solve with Spray E forced onto each other compatible tractor, and report the difference:
"If Tractor 1 did it instead: +34 min total travel and Spray G misses its 4 PM deadline. Tractor 2 can't (no sprayer)."
These are real numbers from real re-solves, not narration.

**LLM (optional, last):** only rewrites the explanation facts into smoother English, or turns operator chat into structured events. It never chooses or changes a plan. If short on time, skip it; template explanations are fine.

#### Part B: Weather Agent (wind, temperature, rain)
**Why it matters:** wind is the main constraint on spraying. Extension guidance commonly says drift potential is lowest at 3 to 10 mph blowing away from sensitive areas, not to spray toward sensitive areas at any wind speed, and that winds under 3 mph can signal a temperature inversion (long-distance drift). Vapor drift becomes more likely above about 85°F. Labels are the law and vary by product, so every threshold below lives in config, not code.

**Weather rules (config file `weather_rules.json`, defaults)**
| Job type | Allowed when | Blocked when |
|---|---|---|
| Spraying (kaolin, pesticides) | wind 3 to 10 mph and not blowing toward the block's sensitive side | wind < 3 mph (inversion risk), wind > 10 mph, wind toward a sensitive area, rain expected within 2 h, temp above product limit |
| Mowing, hedging | wind < 25 mph | wind ≥ 25 mph (dust, visibility) |
| Bin hauling | always, unless severe | wind ≥ 35 mph or lightning |

**Sensitive areas:** each block gets a list of sensitive neighbors with a compass direction, for example Block E: canal to the east; Block H: houses to the north; Block B: apiary to the west. A spray job is blocked when the wind blows toward one of them.

**Data**
- Demo: a scripted hourly weather timeline in `scenario.json` (deterministic, so ours and the baseline face the same weather).
- Live (nice to have): pull the real hourly forecast for the farm from the National Weather Service API (free, no key, send a User-Agent header): `https://api.weather.gov/points/{lat},{lon}` returns a `forecastHourly` URL. Show it on the dashboard as "Live conditions, Queen Creek." Don't drive the demo plan from it.

`scenario.json` addition:
```json
"weather": [
  { "t": 0,   "wind_mph": 2,  "wind_from_deg": 90,  "temp_f": 68, "rain_prob": 0 },
  { "t": 60,  "wind_mph": 5,  "wind_from_deg": 120, "temp_f": 74, "rain_prob": 0 },
  { "t": 240, "wind_mph": 8,  "wind_from_deg": 200, "temp_f": 92, "rain_prob": 0 },
  { "t": 420, "wind_mph": 14, "wind_from_deg": 250, "temp_f": 104, "rain_prob": 10 },
  { "t": 540, "wind_mph": 6,  "wind_from_deg": 250, "temp_f": 97, "rain_prob": 0 }
],
"blocks_sensitive": { "E": [{ "what": "canal", "dir_deg": 90 }], "H": [{ "what": "houses", "dir_deg": 0 }] }
```
(Times are minutes after 6 AM. `wind_from_deg` is where the wind comes from, meteorological convention; the wind blows toward `wind_from_deg + 180`.)

**How weather enters the plan**
1. The Weather Agent turns the forecast + rules into **allowed windows per job** (for each spray job: the time ranges where its whole duration fits in allowed weather for its block).
2. The optimizer gets those as forbidden start times. Sprayers do non-spray work (bin hauling) or other blocks during bad windows instead of sitting idle.
3. **Live guard:** during a spray job, if live (scripted) wind leaves the allowed range, the Safety Agent pauses spraying at once (AgOpenWeb `section.master` off, tractor holds), the job keeps its progress, and the optimizer re-plans.

**New event:** `weather_change` (wind picks up, wind shifts toward a sensitive area). Example explanation: "Wind rose to 14 mph at 1:00 PM, above the 10 mph spray limit. Tractor 3 paused spraying Block G at 55% and switched to hauling bins in Block B. Spraying resumes at 3:00 PM when wind drops to 6 mph, still before the 4:00 PM deadline."

**Baseline fairness:** the baseline must obey the same weather rules (otherwise it just racks up violations). It simply waits when a job is blocked. That waiting shows up as idle time, which is exactly where our optimizer wins.

#### Dashboard additions (Divi)
- **Wind on the diorama:** animated wind particles drifting across the farm in the wind direction, speed by wind mph. A compass rose with mph. Spray mist particles behind sprayers when spraying.
- **Weather card:** current wind, temp, and a small hourly strip with spray windows marked green and blocked hours hatched.
- **Timeline:** hatched gray bands on sprayer lanes during no-spray periods, so it's obvious why pills avoid them.
- **Job pills** blocked by weather show a small wind icon and "Waiting for wind."
- **Sensitive areas** drawn on the map (canal, houses, apiary) with a soft red highlight when the wind blows toward them.

#### Updated roles
- **Person 3:** OR-Tools model + rolling re-plan + counterfactual "why" (after greedy works), weather windows into the model.
- **Person 2:** Weather Agent data (scripted timeline, rules config, allowed-window calculation, live NWS fetch if time), live spray guard through the gateway.
- **Divi:** wind particles, weather card, hatched no-spray bands, sensitive areas, "Waiting for wind" pills.

#### Demo script addition
After the heat alert: "Now the wind picks up." Trigger `weather_change`. Wind particles speed up, the sprayer pauses mid-block, the timeline re-solves around the hatched band, and the explanation cites the 10 mph limit. "It knows when not to spray, and it keeps the tractor busy anyway."

---

### Change 7: Two views of the same fleet, "Simulated" (3D diorama) and "Live feed" (real positions, AgOpenWeb-style)

> Adds a second view to the dashboard. Both views read the same live data from the Fleet Gateway. Nothing else changes.

#### What the operator sees
A toggle at the top of the dashboard: **Simulated | Live feed**.
- **Simulated (default, the wow view):** the 3D miniature farm from the UI mock. Stylized, tilt-shift, day cycle, glowing routes. Tractor positions come from AgOpenWeb but are mapped onto the diorama's grid.
- **Live feed (the proof view):** a top-down map of the real farm, like AgOpenWeb's own screen but for the whole fleet. Exact positions in real coordinates, straight from each AgOpenWeb container, updating several times a second.

The glass panels (Dynamic Island, fleet cards, timeline dock, explanation, scorecard, weather) stay on top in both views. Switching views animates: the diorama camera tilts down to straight overhead and cross-fades into the live map (and back).

#### Live feed contents
- **Basemap:** the real aerial image of the demo farm (the NAIP image from the satellite script in the earlier base doc's Appendix A, `naip.png` + `naip_bounds.json`), with block outlines and labels.
- **Each tractor at its exact pose:** position, heading arrow, and the implement drawn as a bar at its real working width (from the Tick frame's tool pose `ToolE`, `ToolN`, `ToolHeading`), colored per tractor.
- **Breadcrumb trail** behind each tractor (last few minutes).
- **Coverage painted live:** what each tractor has actually sprayed or mowed, decoded from AgOpenWeb's own coverage frames (below). This is real coverage, not our estimate.
- **Guidance lines:** the active AB line per tractor (we created it, so we already know its coordinates).
- **Per-tractor readout on hover/tap:** speed, heading, cross-track error, autosteer on/off, sections on, heartbeat age, container port.
- **Follow mode:** tap a tractor to lock the camera on it and rotate with its heading, like AgOpenWeb's in-cab view. Tap again to return to the whole farm.
- **Weather overlays still apply:** wind particles, sensitive areas in red when downwind.

#### Data the gateway must forward (Person 2)
All little-endian, byte 0 = frame type (`WireCodec.cs`):
| Frame | Type | Layout we need |
|---|---|---|
| Tick | 2 | `i64 sceneVersion, f64 E, f64 N, f32 heading, f32 speed, u8 fix, i32 nSections, nSections × u8 state, f32 crossTrackError, u8 guidanceActive, str lineLabel, str activeTrackName, f64 toolE, f64 toolN, f32 toolHeading, ...` (strings use .NET `BinaryWriter` format: 7-bit length prefix then UTF-8) |
| CoverageInit | 3 | `f64 cellSize, f64 originE, f64 originN, i32 width, i32 height, u8 reset` |
| CoverageCells | 4 | `i32 count, then count × i32` as flat triples `[cellX, cellY, packedRGB]` |

- Convert every E/N (field-local meters) to lat/lon using that field's origin, so all tractors share one map frame.
- Forward to the dashboard over our own WebSocket as small JSON messages: `pose` (per tractor, throttled to ~5 Hz) and `coverage` (batched cell deltas per tractor, ~1 Hz). Never forward AgOpenWeb's raw frames to the browser.
- The Simulated view uses the same `pose` messages, just mapped to diorama cells.

#### Dashboard build (Divi)
- Live feed can be a second canvas: an orthographic top-down camera in the same three.js scene with the NAIP image as a ground plane is the easiest way to get the smooth animated switch. Coverage is a `DataTexture` (one pixel per coverage cell) laid over the basemap and updated with each delta.
- If time is short: build Live feed as a plain 2D canvas (basemap image, tractors, trails, coverage). Swap with a cross-fade instead of the camera move.

#### Why this is worth it
- **Trust (tiebreaker):** judges see the same tractors twice: once as a beautiful plan, once as real guidance data. It proves the diorama isn't a fake animation.
- **Explanations (5 pts):** a replan explanation reads stronger when you can flip to Live feed and watch Tractor 3 actually line up on Block E's pass and start painting coverage where Tractor 1 stopped.

#### Demo script addition
Right after the breakdown replan: "Let's check this is real." Flip to Live feed. The camera drops overhead onto the aerial map, Tractor 1 sits still with its coverage ending mid-block, and Tractor 3 pulls in and continues painting from exactly where it stopped. Flip back to Simulated.

#### Updated roles
- **Person 2:** decode Tick tool pose and coverage frames, E/N to lat/lon conversion, throttled `pose` and `coverage` messages.
- **Divi:** view toggle, Live feed view, follow mode, animated switch.
- **Timeline:** Live feed comes after the 1:30 checkpoint (poses already flowing). Coverage painting is the last piece; tractors + trails on the basemap first.

---

### Change 8: Full tractor control from our UI (anything AgOpenWeb can change, plus our own fleet settings)

> Adds a Tractor Control Panel to the dashboard. Every control goes through our backend and the Fleet Gateway (the gateway is the single control holder for each AgOpenWeb container).

#### What the operator gets
Tap any tractor (map, card, or timeline lane) and a glass side sheet opens with tabs. Every change shows instantly on both views.

**1. Drive** (AgOpenWeb simulator commands)
- Take manual control / Hand back to AI (see rules below)
- Speed up, speed down, stop, 10x speed (`sim.speedUp`, `sim.speedDown`, `sim.stop`, `sim.toggle10x`)
- Steering slider in degrees (`sim.setSteer|deg`), reset steering (`sim.steerReset`), reverse direction (`sim.reverseDir`)
- Drive to: tap a spot on the Live feed map, our Navigation Agent routes it over the farm roads and the gateway drives it there
- Place here (debug): teleport (`sim.setCoords|lat,lon`)

**2. Guidance**
- Autosteer on/off (`autosteer.toggle`)
- Create an AB line by tapping two points on the Live feed map (`track.latLonAB`), or pick an existing line (`track.select`, `track.activate`), swap A/B (`track.swapAB`)
- Nudge left/right, fine nudge, snap to pass (`track.nudgeLeft`, `track.fineNudgeRight`, `track.snapLeft`, ...)
- U-turns on/off, turn direction, skip passes (`youturn.toggle`, `youturn.direction`, `youturn.skipCycle`)
- Headland on/off (`headland.toggle`), contour mode (`contour.toggle`)

**3. Implement and sections**
- Section control: auto master / all manual (`section.master`, `section.manual`), each section on/off (`section.toggle|index`)
- Implement setup: number of sections, section width, overlap, look-ahead, offset (`config.set|tool.numSections:6`, `tool.sectionWidth`, `tool.overlap`, `tool.lookAheadOn`, `tool.offset`, ...)
- Implement type for planning (sprayer, mower, hedger, bin trailer). Our setting, not AgOpenWeb's: changing it costs a depot visit and triggers a replan.

**4. Vehicle and steering setup** (`config.set|key:value`)
- Vehicle: wheelbase, track width, type, antenna height/offset (`vehicle.wheelbase`, `vehicle.trackWidth`, ...)
- Steering: max steer angle, gains, Stanley vs pure pursuit (`autosteer.maxSteerAngle`, `autosteer.proportionalGain`, `autosteer.isStanleyMode`, ...)
- U-turn shape: radius, style, extension (`uturn.radius`, `uturn.style`, `uturn.extension`)
- Saved profiles: load/save vehicle and tool profiles (`profile.load`, `profile.save`)

**5. Fleet settings** (ours, used by the optimizer)
- Name and color, implements list, fuel level and "refuel now", max speed
- Availability (for example "off duty after 2 PM")
- Job rules: pin a job to this tractor, ban job types, priority boost
- Mark broken / repaired, book mechanic, remove from fleet

**6. Advanced (everything else)**
A searchable list of every `config.set` key AgOpenWeb accepts (I pulled about 170 from `RemoteServerWiring.Helpers.cs`: autosteer, gps, machine, roll, tool, tram, uturn, vehicle, display) with a value editor. This guarantees "anything changeable is changeable" without hand-building every control.

#### How it's built: one schema, the UI renders itself
Don't hand-code each control. The backend exposes a **control schema**, and Divi's sheet renders whatever it lists.
```json
{
  "id": "steer",
  "tab": "Drive",
  "label": "Steering",
  "type": "slider",
  "min": -40, "max": 40, "step": 1, "unit": "deg",
  "agopenweb": { "cmd": "sim.setSteer", "arg": "{value}" },
  "needs_manual": true,
  "replans": false
}
```
- `type`: `button`, `toggle`, `slider`, `number`, `select`, `map_pick` (tap the map), `text`
- `agopenweb`: the command to send (`{value}` filled in), or `"config": "tool.sectionWidth"` for config keys
- `fleet`: instead of `agopenweb`, a field in our own fleet model (implements, fuel, availability...)
- `needs_manual`: only allowed while the tractor is in manual mode
- `replans`: the change triggers an optimizer re-plan with explanation

API additions:
| Method | Path | What it does |
|---|---|---|
| GET | `/tractors/{id}/controls` | The schema plus current values |
| POST | `/tractors/{id}/control` | `{ "control": "steer", "value": 12 }` |
| POST | `/tractors/{id}/preview` | Same body, returns the re-plan impact without applying (for "what if") |

#### Rules that keep it safe and keep the score
- **Manual vs AI.** Driving and guidance controls need manual mode. "Take manual control" removes the tractor from AI planning (orange "Manual" badge, its lane hatched). "Hand back to AI" re-plans from wherever the tractor is now. Job progress is never lost.
- **Plan-changing settings preview first.** Changing implements, fuel, availability, or pinning a job shows the impact before applying: "Pinning Spray G to Tractor 1 pushes Mow F past its 3 PM deadline by 20 min. Apply anyway?" Then re-plan + explanation.
- **The Safety Agent still has the last word.** Anything that breaks a hard rule is refused with the reason: "Can't pin Mow C to Tractor 1: it has no mower." / "Can't spray now: wind 14 mph, limit 10 mph."
- **Toggles show true state.** The Tick frame already carries `IsAutoSteerEngaged`, `IsSectionAutoMaster`, `IsYouTurnEnabled`, `IsContourMode`, so the UI shows what AgOpenWeb is actually doing and only sends a toggle when the wanted state differs.
- **Config values:** remember the last value we set per tractor; decoding AgOpenWeb's Config frame (type 8) to read back values is a later improvement.
- **Everything is logged.** Each operator change goes in the event log as `operator_action` with tractor, control, old and new value, and whether it caused a re-plan.

#### Updated roles
- **Person 2:** control schema file, `/controls` endpoints, mapping controls to AgOpenWeb commands and config keys, state read-back from Tick flags.
- **Person 3:** manual-mode handling in the optimizer, `preview` (re-plan without applying), Safety Agent checks for operator changes.
- **Divi:** the control sheet that renders from the schema (tabs, sliders, toggles, map-pick), Manual badge, preview confirm dialog.

#### Priority
After the 2:45 checkpoint, in this order: Drive + manual mode, Fleet settings with preview, Guidance, Implement/sections, Advanced list. The schema approach means each extra control is one JSON entry, so the list can keep growing without UI work.

#### Demo script addition
"Operators can still take over anything." Tap Tractor 2, take manual control, steer it with the slider (it moves on both views), change its implement to a sprayer, see the preview of what the plan gains, apply, hand it back to the AI, and the explanation shows how the fleet re-balanced.

---

### Change 9: Unlimited fleet size is non-negotiable

> Overrides the "about 3 to 5 tractors" limit in Change 4. No part of the system may have a fixed or practical cap on tractor count. The only limit is how much compute we connect, and the system must scale out instead of stopping.

#### The honest constraint, and how we beat it
Each tractor is a full AgOpenWeb instance, and each instance needs real CPU and memory. One laptop will run out at some number of tractors. So "as many as we want" means **scale out across machines**, automatically, not "squeeze more onto one laptop."

#### 1. Compute pool (Fleet Manager places tractors anywhere)
- **Hosts list** in `hosts.json`. Each host is somewhere AgOpenWeb containers can run:
  ```json
  [
    { "id": "laptop-divi",  "docker": "local",                          "max_tractors": "auto" },
    { "id": "laptop-p2",    "docker": "ssh://p2@192.168.1.24",          "max_tractors": "auto" },
    { "id": "cloud-1",      "docker": "ssh://ubuntu@<cloud-vm-ip>",     "max_tractors": "auto" }
  ]
  ```
  `docker` is a Docker context: local, or a remote machine over SSH (`DOCKER_HOST=ssh://...`), so the Fleet Manager starts containers on any host the same way.
- **Placement:** when a tractor is added, the Fleet Manager picks the host with the most free capacity, starts the container there, and records its `ws://<host-ip>:<port>/ws` endpoint.
- **Capacity is measured, not guessed:** at startup, start one container per host, measure CPU and memory while its tractor drives in the simulator, and compute `max_tractors` with 30% headroom. Re-check every minute.
- **Pre-built image on every host** (push it to a registry, or `docker save` / `docker load`), so adding a tractor takes seconds, not a rebuild.
- **Warm pool:** keep 1 to 2 idle containers booted per host. "Add tractor" grabs a warm one instantly and boots a replacement in the background.
- **When everything is full:** never fail silently. The dashboard shows "Fleet at capacity: 18 of 18 tractors. Add a host to grow." with a button that shows how to add one. The orchestrator keeps planning the tractors it has.
- **Already-running AgOpenWeb anywhere** (a real tractor, a teammate's native install) still joins with `endpoint: "ws://..."`. It doesn't count against any host.

#### 2. Make every layer fleet-size independent
| Layer | What changes for unlimited tractors |
|---|---|
| Fleet Gateway | Fully async (one asyncio task per tractor connection, heartbeats on a shared timer). Hundreds of WebSocket connections are fine. |
| World service | Per-tractor state in a dict keyed by id, no fixed arrays. Metrics per tractor and total. |
| Optimizer | OR-Tools routing handles many vehicles; set the time limit by fleet size (1 s small, up to 5 s large). For very large fleets, split by zone (blocks grouped by area) and solve zones in parallel, then repair borders. Greedy fallback always available. |
| Safety Agent | Checks are per tractor and per block, linear in fleet size. |
| Baseline | Same fleet, same changes, any size. |
| Dashboard 3D | Instanced tractor meshes (one draw call for all), route ribbons only for the selected or affected tractors when the fleet is large, labels only on hover. |
| Dashboard panels | Fleet cards become a scrollable, filterable list (by status, implement, host). Timeline lanes virtualized (only visible lanes render) with a "fit all" zoom-out mode that shows each lane as a thin colored strip. |
| Data to the browser | Poses batched into one message per tick for all tractors, throttled (~5 Hz), only changed tractors sent. |
| Explanations | Summarize at fleet level when many tractors move ("12 jobs moved across 7 tractors; the biggest change: ..."), with detail on tap. |

#### 3. Prove it in the demo
- **Live:** as many real AgOpenWeb tractors as our pooled laptops (and any cloud VM) can run, all driving at once.
- **Scale test button:** "Simulate a 50-tractor, 200-job farm" runs the same orchestrator on the MockGateway and shows plan time, jobs assigned, 0 violations. Label it clearly: mock tractors, real orchestrator. It proves the brain scales even beyond the hardware in the room.
- **Line for judges:** "Every tractor you see is a live AgOpenWeb instance. The fleet grows by adding compute, not by changing code. Here's the same orchestrator planning 50."

#### 4. Before the event
- Get Docker on every teammate laptop, pull the image on each, test one remote `docker run` over SSH from the main laptop.
- If you want a cloud VM: create it and test it before the event starts, not during. A cheap multi-core VM adds a lot of tractors.

#### Updated roles
- **Person 2:** compute pool (hosts, placement, capacity measurement, warm pool, remote Docker), async gateway at scale.
- **Person 3:** optimizer time limits and zone splitting, fleet-level explanations, scale-test mode on MockGateway.
- **Divi:** instanced tractors, virtualized lanes, filterable fleet list, capacity banner, scale-test view.

#### Updated "Never cut"
Add: no hard-coded tractor count anywhere, and adding a tractor must work until compute runs out, then say so clearly.

---

### Change 10: Frontend built independently against a mock backend; FastAPI plugs in live later

> The dashboard does not wait for the backend. It runs on its own simulated data until the FastAPI backend is ready, then switches to live with one setting. This only works if both sides follow one contract exactly, so the contract below is now the source of truth for every endpoint and message.

#### How the frontend is structured
- One **data layer** in the frontend with a single interface, two implementations:
  - **MockSource:** an in-browser simulation (like the UI mock) that produces exactly the same REST responses and WebSocket messages the backend will.
  - **LiveSource:** calls FastAPI over REST and listens on the WebSocket.
- Switch with a URL setting: `?source=mock` (default until 2:45) or `?source=live&api=http://localhost:8000`.
- No component ever calls `fetch` or opens a socket directly. Components only talk to the data layer. That's what makes the switch a one-line change.

#### Rule: streams over WebSocket, actions over REST
- **REST** for things the operator does or asks once: add a tractor, trigger an event, approve, ask "why", change a control.
- **WebSocket** for everything that changes continuously: positions, plan, explanations, metrics, coverage, weather. Don't poll REST for live positions.

#### REST endpoints (FastAPI, base `/api`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/state` | Full snapshot (same shape as the WS `snapshot` message) |
| GET | `/scenario` | Blocks, roads, depot, sensitive areas, basemap bounds |
| POST | `/run` | `{ "mode": "ours" \| "baseline" \| "both" }` start or reset |
| POST | `/clock` | `{ "playing": true, "speed": 1 }` pause, resume, speed |
| GET / POST | `/jobs` | List jobs / operator submits a job list |
| PATCH | `/jobs/{id}` | Change priority, deadline, pin to tractor |
| POST | `/events` | `{ "type": "breakdown" \| "block_route" \| "priority_change" \| "weather_change", ... }` |
| GET / POST | `/fleet` | List tractors / add a tractor (one `fleet.json` entry) |
| DELETE | `/fleet/{id}` | Remove a tractor (planned hand-back) |
| GET | `/hosts` | Compute pool and capacity |
| GET | `/tractors/{id}/controls` | Control schema + current values |
| POST | `/tractors/{id}/control` | `{ "control": "steer", "value": 12 }` |
| POST | `/tractors/{id}/preview` | Same body, returns re-plan impact, applies nothing |
| POST | `/tractors/{id}/manual` | `{ "on": true }` take or hand back control |
| GET | `/why/{job_id}` | Counterfactual comparison per tractor |
| GET | `/mechanics?tractor={id}` | Top 4 ranked mechanics |
| POST | `/mechanics/book` | `{ "tractor": "T1", "mechanic": "M1" }` (mock booking) |
| POST | `/approve` | `{ "id": "<pending id>", "decision": "approve" \| "override" }` |
| GET | `/weather` | Timeline + rules + optional live conditions |
| GET | `/metrics` | Ours vs baseline |
| GET | `/log` | Event log (JSON lines) |
| POST | `/scale-test` | `{ "tractors": 50, "jobs": 200 }` returns plan stats (mock tractors) |

#### WebSocket `/ws` messages (server to browser)
Every message is `{ "type": "...", "t": <farm minutes>, "data": { ... } }`.
| type | When | data |
|---|---|---|
| `snapshot` | On connect, and after `/run` | Everything: scenario, fleet, jobs, plan, metrics, weather, pending |
| `poses` | ~5 Hz, batched | `[{ "id", "x", "y", "lat", "lon", "heading", "speed", "status", "fuel", "tool": {...}, "autosteer", "sections" }]` only changed tractors |
| `plan` | After any re-plan | `[{ "tractor", "job", "start", "end" }]` + `"diff"` |
| `explanation` | After any re-plan | `{ "trigger", "text", "facts": {...} }` |
| `jobs` | When job state/progress changes | `[{ "id", "status", "progress", "tractor", "eta", "deadline", "priority", "weather_blocked" }]` |
| `fleet` | Tractor added, removed, state change | Tractor list with lifecycle state and endpoint |
| `metrics` | Every few seconds | `{ "ours": {...}, "baseline": {...}, "violations": 0 }` |
| `weather` | When it changes | Current wind, temp, spray-window status per block |
| `coverage` | ~1 Hz | `{ "tractor", "cells": [[x, y, rgb], ...] }` for Live feed |
| `log` | Each new event log line | One event log entry |
| `pending` | Approval or mechanic needed | `{ "id", "kind": "approval" \| "mechanic", ... }` |
| `capacity` | Pool changes | `{ "used", "max", "hosts": [...] }` |

#### Keeping mock and live identical
- Put the contract in one shared folder, `contract/`: JSON Schemas (or TypeScript types) for every response and message, plus one recorded example file per message type.
- MockSource returns those example shapes. The backend team adds a quick test that validates their responses against the same schemas.
- FastAPI serves `/openapi.json` automatically. Use it at 2:45 to check nothing drifted (and optionally generate types from it).
- Any change to a shape gets written in `contract/` first, and both sides update.

#### Timeline impact
- **Divi:** builds the whole UI on MockSource from now, no blocking. MockSource can start from the UI mock's simulation code.
- **Backend:** implements the same endpoints and messages; at the **2:45 checkpoint**, switch the dashboard to `?source=live`.
- Do one early handshake around **1:30**: `/state` and the `poses` stream only, live, so surprises show up early rather than at 2:45.
- Keep MockSource working after the switch. It is the demo backup if the live backend fails on stage (label it honestly if used).

---

### Change 11: Team names, final split, and re-timed schedule

> Replaces "Divi / Person 2 / Person 3" everywhere above, and replaces earlier timelines. FEATURES.md has the full step-by-step list with these owners.

#### Names
- **Person 2 is Anay** (Platform).
- **Person 3 is Diya** (Brain).
- Swap the two roles if strengths fit the other way; keep the split by role.

#### Final split
**Divi: Frontend**
- The whole dashboard: 3D diorama, Live feed view, glass panels, Dynamic Island, timeline, explanation card, scorecard, activity feed.
- All sheets: Why, mechanic, Add tractor, tractor control panel, approvals.
- MockSource (in-browser simulation in the ARCHITECTURE.md shapes) and the switch to LiveSource.
- `contract/examples/`, demo script, backup video.

**Anay: Platform**
- AgOpenWeb Docker image, containers, compute pool and Fleet Manager (unlimited tractors across laptops).
- AgOpenWeb gateway: heartbeats, commands, Tick and coverage decoding, transit stepping, job completion, live weather guard, control mapping to AgOpenWeb.
- FastAPI app: routes, WebSocket hub, state store, throttling.
- World service: clock, progress, fuel, event engine, event log.
- Final live runs.

**Diya: Brain**
- Scenario data and MockGateway.
- Agents: Navigation, Fleet planner (greedy, then OR-Tools), Safety, Weather, Agronomy, Mechanic.
- Re-planning, explanations, "Why?" counterfactuals, preview, manual-mode planning.
- Baseline, metrics, scale test.
- README and submission.

#### Re-timed schedule (it's 12:20; earlier timelines assumed an earlier start)
| Time | Checkpoint |
|---|---|
| 12:20 to 1:00 | Foundations. **1:00:** one container steered from Python (Anay), greedy plan prints (Diya), dashboard on mock (Divi). |
| 1:00 to 3:00 | Must-haves. **1:45:** live handshake, dashboard shows 3 live AgOpenWeb tractors. **3:00:** full must-have flow live. |
| 3:00 to 4:00 | Stretch, in FEATURES.md order (unlimited tractors first). |
| **4:00** | Feature freeze. |
| 4:00 to 4:40 | Final live runs (ours + baseline), logs, table, README, backup video, submit by 4:40. |
| 4:40 to 5:00 | Buffer. |

#### Checkpoint sync rule
Quick 2-minute check at each checkpoint: what works, what's blocked, what to cut. Shape changes go into ARCHITECTURE.md first.

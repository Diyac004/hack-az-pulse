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

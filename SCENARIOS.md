# SCENARIOS.md: everything the AI does in Harvest Fleet AI

Which AI handles which situation, what it decides, what the operator sees, and where it actually runs. Claims were checked against code on `divi-ai` (dashboard, in-browser mock, `ai-supervisor/`, bridge) and `origin/anay` (FastAPI backend, `backend/app/brain`, `backend/app/core`, `backend/README.md`). Anything I could not verify in code is marked **[unverified]**.

## 1. Two kinds of AI

| | (a) Coordinator agents | (b) AI Supervisor (LLM) |
|---|---|---|
| Nature | Algorithms. Deterministic: same input, same plan. | An LLM that reads a compact summary of the state. |
| Authority | **Decide** (assign, schedule, route, pause), always inside hard constraints. | **Propose only.** The operator approves, the planner re-plans, Safety validates. |
| Members | Fleet planner (greedy multi-order insertion plus bounded relocate/swap improvement; OR-Tools is planned, not built), Safety validator (replays every plan, rejects violations), Navigation (road routing with blocked roads), Weather, Agronomy, Mechanic, Explanations plus "Why?" counterfactuals | Plan reviewer, Implements reviewer, Plots reviewer (vision on aerial-image crops) |
| Code | Python: `backend/app/brain/` (`scheduler.py`, `validator.py`, `navigation.py`, `explanations.py`) on the planner backend. JS port: `dashboard/src/data/mockSource.js`, `mockControls.js` (Mock and mock-backend). | `ai-supervisor/` (Node, port 8060). In-browser fallback: `dashboard/src/data/aiRules.js` |

Important: **the Weather, Agronomy and Mechanic agents exist only in the JS simulation** (Mock and mock-backend). The Python planner backend does not model them (section 5).

**LLM explanation wording.** PROJECT.md Change 6 says an LLM may only reword explanation facts, with numbers, jobs, tractors and times validated unchanged, and may never change a plan. **[unverified] I found no code for this on `divi-ai` or `origin/anay`.** Explanations today are templates (`explainText` in `mockSource.js`, `backend/app/brain/explanations.py`). Treat LLM wording as designed, not shipped.

**Supervisor providers** (`AI_PROVIDER`, `ai-supervisor/README.md`):

| Provider | Notes |
|---|---|
| `agy` (default) | Antigravity CLI, model `claude-sonnet-5-5-low` (`AGY_MODEL`). A review takes about 15 to 60 s. |
| `openai` | `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-5`) |
| `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-opus-5-5`) |
| `rules` | No model: rule-based plan and implements review, no plot review. Also the browser fallback when there is no `&ai=`. Never call it an LLM. |

The model returns a strict JSON action from a closed enum (`patch_priority`, `pin_job`, `ban_type`, `off_duty`, `set_implements`, `disable_block`, `none`). `aiActions.js` validates ids and values against the live snapshot before building the request.

## 2. Where scenarios run

| Short name | What it is |
|---|---|
| **Mock** | In-browser simulation (`?source=mock`). Every feature on, nothing real. |
| **MB** | `mock-backend` (`:8001`): the same simulation behind REST and `/ws`. |
| **Planner** | FastAPI plus Diya's brain plus MockGateway (`:8000`). The scored coordinator demo. |
| **Bridge** | AgOpenWeb bridge (`:8040`): real headless AgOpenWeb tractors. |
| **AI svc** | `ai-supervisor` (`:8060`), beside any contract backend. |

Planner and Bridge columns follow the `capabilities.js` profiles and `backend/README.md` ("Not implemented"). The dashboard disables unsupported features with "Not supported by this backend".

## 3. Scenario catalogue

Legend: Y = works, n = not supported, ~ = partial (see row).

### 3.1 Planning and recovery

| # | Scenario | Trigger | AI | What it decides | On screen | Guarantees | Mock | MB | Planner | Bridge |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Morning plan | Automatic (Planner plans at startup, paused at plan v1), or **Start run** / **Restart day** | Fleet planner + Safety | Assigns every job to a compatible tractor, orders queues to cut travel and idle | Badge "Plan v1 · Feasible"; "Morning plan ready. N jobs across M tractors ... Safety check passed" | 0 violations; deadlines are hard constraints (validator rejects "Deadline missed") | Y | Y | Y (12 jobs, 3 tractors) | ~ one job per tractor, no optimizer |
| 2 | Breakdown mid-job | **Break down...**, pick a tractor; or scripted (Planner: T1 at t=50, off with `HFA_SCRIPTED=0`) | Fleet planner (recovery) + Safety + Explanations | Stops the tractor at once, keeps finished and partial progress, releases its jobs, re-plans onto compatible tractors | Tractor stops, timeline reshuffles; "Tractor 1 broke down N% of the way through Spray E ... Tractor 3 has the only other sprayer ... finishes the remaining ..." | Progress kept, nothing lost or duplicated; no compatible backup means the job stays `pending` with a reason | Y | Y | Y (no mechanic sheet) | ~ breakdown and repair events only |
| 3 | Coverage continuation | After #2, toggle **Map** | Fleet planner | Backup resumes from the exact mid-block point | Broken tractor's painted coverage ends mid-block; backup paints on from there | As #2 | Y | Y | **[unverified]** (README lists coverage as not built) | ~ real coverage painting by AgOpenWeb |
| 4 | Mechanic ranking, booking, Mark repaired | Sheet after a breakdown: **Approve and book** | Mechanic agent (ranks by ETA, rating, ag experience; sample listings M1 to M4) | Recommends one; booking sets arrival and estimated return | "Book a mechanic for Tractor 1?"; van drives out; chip shows **Mark repaired** | Booking does **not** return the tractor; only **Mark repaired** (`tractor_repaired`) does. Listings are samples: "Nothing is booked for real." | Y | Y | n (501; **Mark repaired** still works) | n (repair via event only) |
| 5 | Repaired tractor rejoining | **Mark repaired** | Fleet planner | Re-plans with the tractor back; moves work to it only if that is better | "Tractor 1 repaired at ... N jobs move back to it" or "No remaining work finishes sooner on Tractor 1, so it stays on standby" | The objective (weighted on-time, on-time count, travel, waiting) does not maximise utilisation, so a repaired tractor **may stay idle**. Intended trade-off (INTEGRATION_REPORT #13). | Y | Y | Y | ~ |
| 6 | Block a road (reroute) | **Block road** | Navigation + Fleet planner | Blocks road cells, reroutes traveling tractors, re-times jobs | Barrier on the map; "Farm road blocked ahead of Tractor N. The Navigation Agent rerouted it ... adding about X min" | No straight-line fallback: unreachable means explicit infeasibility. On Planner a driving tractor is committed to its trip: it drives to the last open cell, its job is released, the next re-plan routes around. | Y | Y | Y | n |
| 7 | Unblock a road | Event `unblock_route` via API. **No dashboard button found** in `ui/` (the log/feed renders "Road reopened") | Navigation + planner | Recomputes routes | "Farm road reopened (N cells). Routes recomputed." | As #6 | Y | Y | Y | n |

### 3.2 Weather and agronomy (JS simulation only)

| # | Scenario | Trigger | AI | What it decides | On screen | Guarantees | Mock | MB | Planner | Bridge |
|---|---|---|---|---|---|---|---|---|---|---|
| 8 | Wind gust | **Wind gust** (14 mph blowing toward the sensitive area of a block being sprayed) | Weather + Fleet planner + Safety | Spraying allowed only at 3 to 10 mph, not toward a sensitive area (E canal, H houses, B apiary), up to 100°F, rain under 40% within 2 h. Mowing and hedging stop at 25 mph, hauling at 35. The sprayer pauses and switches to other work. | Wind particles speed up; hatched band on the timeline; "Wind rose to 14 mph at ..., above the 10 mph spray limit. Tractor 3 paused spraying Block G at N% and switched to hauling bins in Block B. Spraying resumes at ..." | Job keeps its progress; tractor stays busy; thresholds live in `WEATHER_RULES`, not hard-wired | Y | Y | n (400; weather shown as "Placeholder weather — not used for spraying decisions") | n |
| 9 | Calm the wind | Same button, label flips to **Calm the wind** (6 mph from the direction furthest from sensitive areas) | Weather | Reopens spray windows | "Wind eased to 6 mph ... inside the 3 to 10 mph spray range"; tractor resumes | Progress kept | Y | Y | n | n |
| 10 | Spray windows, inversion rule, sensitive areas | Automatic, from the scripted timeline (calm dawn under 3 mph blocks spraying) | Weather | Per-job allowed windows; planner forbids start times outside them | Hatched no-spray bands; sensitive areas glow when downwind | Same rules in Mock's baseline twin **[unverified]** | Y | Y | n | n |
| 11 | Heat alert | **Heat alert** (button sends 112°F at 8:00 AM) | Agronomy + Fleet planner | Raises unstarted spray jobs on Blocks G and H to high priority and moves them ahead | "Heat alert from the Agronomy Agent: 112°F expected by ... Kaolin spraying for Blocks G and H moves up to high priority ... done before the peak" (or "cannot finish before the peak") | Only jobs with 0 progress are raised; the text says honestly whether they beat the peak | Y | Y | n (400) | n |

### 3.3 Operator edits, fleet, jobs

| # | Scenario | Trigger | AI | What it decides | On screen | Guarantees | Mock | MB | Planner | Bridge |
|---|---|---|---|---|---|---|---|---|---|---|
| 12 | "Why?" counterfactuals | Tap a timeline pill | Explanations (re-solve with the job forced onto each other tractor) | Reports finish time, travel and idle deltas, deadlines missed, or "No sprayer" | Why sheet with counterfactual bars and Low/Medium/High priority | Numbers come from real re-solves, not narration | Y | Y | n (501) | n |
| 13 | Priority change accepted | Why sheet (`PATCH /api/jobs/{id}`) | Fleet planner + Safety | Re-plans; the edit is committed only if a valid plan is applied | "Spray G: priority Medium → High. It now starts at ..." | Staged edit, commit on valid plan | Y | Y | Y | n |
| 14 | Priority change rejected | Same, but no valid plan accepts it; or an incompatible pin | Safety | Rejects; the job keeps its old values | Toast "Couldn't change priority: no valid plan accepts it — kept High". Incompatible pin: 422 `SAFETY_REJECTED` "Can't pin Hedge D to Tractor 1: it has no hedger." | Old values kept; no WS `jobs` message carries the staged value | Y | Y | Y | n |
| 15 | Impossible deadline | `PATCH` with a deadline the job cannot meet | Safety | Start of day: rejected (`SAFETY_REJECTED`, job unchanged). **Mid-day: known gap (INTEGRATION_REPORT #15)**: the edit can succeed and silently leave the job `pending` and unassigned. | Start of day: failure message. Mid-day: job shows pending with its reason | Start-of-day guarantee holds; the mid-day guarantee does **not** on Planner. **[unverified]** whether Mock matches. | ~ | ~ | ~ (gap) | n |
| 16 | Add tractor | **Add tractor** sheet (pick implements) | Fleet planner | Re-plans; the new tractor takes jobs it finishes sooner, else stays on standby | "Fleet capacity: 3 of 5 tractors"; explanation names the jobs it took and the new finish time | Demo starts at 3, capped at 5 (`HFA_MAX_TRACTORS=5`). Full fleet: button disabled "Fleet is full: 5 of 5 tractors. Remove one to add another."; API `AT_CAPACITY` | Y (cap 5) | Y | Y (cap from `/api/capabilities`) | ~ |
| 17 | Remove tractor | Chip **×** | Fleet planner | Hands its jobs to others | "Tractor 3 is leaving the fleet. N jobs are handed to ..., keeping progress." | Progress kept | Y | Y | Y | ~ |
| 18 | Submit jobs | Job sheet | Fleet planner + `jobInput.js` validation | Validates type, implement, block, duration, priority, deadline; plans the new jobs | "N new jobs added ... goes to Tractor 2, starting at ..., before its ... deadline", or the unassigned reason | Bad block: 400 "There is no block Z on this farm." on the Block field; the sheet refuses after 6:00 PM | Y | Y | Y | n |
| 19 | Pin job | Edit job, or an AI proposal | Fleet planner + Safety | Pins a job to a tractor that has the implement | "Spray A: pinned to Tractor 3" | Incompatible pin refused up front (422) | Y | Y | Y | n |

### 3.4 Cockpit and AgOpenWeb

| # | Scenario | Trigger | AI | What it decides | On screen | Guarantees | Mock | MB | Planner | Bridge |
|---|---|---|---|---|---|---|---|---|---|---|
| 20 | Manual takeover and hand back | Readout card, **Controls**, **Take manual control** / **Hand back to AI** | Fleet planner | Takeover: the tractor leaves AI planning, its jobs move on. Hand back: re-plans from where it stands. | Orange MANUAL badge, hatched lane; "Tractor N is under manual control and out of AI planning." | Progress kept; manual tractors are excluded from plans | Y | Y | n (501) | Y (real) |
| 21 | Drive this line / AB line follow | Cockpit **Guidance** tab, **New AB line** (tap A then B), **Drive this line** | Operator-driven; AgOpenWeb steers on the Bridge | Autosteer follows the line. Anything that re-plans previews first. | Preview of jobs moved and deadlines affected, then **Apply** | Cross-track error under 2 cm on straights (measured on real AgOpenWeb, bridge README) | Y (sim) | Y (sim) | n | Y (real) |
| 22 | Implement swap with preview | Cockpit **Implement** tab | Fleet planner (same planner for preview and apply) | Swap costs a 10 min depot visit; re-plans | Preview: moved and re-timed jobs, travel/idle delta, deadlines missed; refused if unsafe | preview == apply | Y | Y | n | n |
| 23 | Real autosteer, U-turns, deadman, geofence | Bridge with real AgOpenWeb containers | AgOpenWeb + bridge guard (`lib/guard.mjs`); **not** our scheduler | AgOpenWeb steers, turns and paints coverage. Deadman drops autosteer about 1.6 s after our heartbeat stops (measured 1570 to 1674 ms). The geofence stops a tractor outside the farm; the guard re-engages autosteer after about 2.5 s of loss. | Readout card "AgOpenWeb ws://... · heartbeat" (or "Simulated") | One job per tractor, no optimizer; metrics are placeholders; scorecard says "Scorecard comes from the planner backend (FastAPI)." | n | n | n | Y |

### 3.5 Lateness, overtime, scorecard

| # | Scenario | Trigger | AI | What it decides | On screen | Guarantees | Mock | MB | Planner | Bridge |
|---|---|---|---|---|---|---|---|---|---|---|
| 24 | Late and overtime warnings | Any re-plan that pushes work late or past 6 PM | Safety + Explanations | Flags missed deadlines and work past sunset | Plan badge "Overtime" or "N late"; overflow marker past 6 PM; "... will now miss its ... deadline by about ..." / "Work now runs ... past sunset" | Late finishes show on their own scorecard row ("Finished late"), never hidden behind "0 violations" | Y | Y | Y (an explicit backend overtime flag was requested in FRONTEND_NEEDS.md) | n |
| 25 | End-of-day scorecard vs FCFS | **Skip to sunset** (6× clock) or run to the end | Metrics + FCFS baseline | Compares ours with first come, first served: completed, on time, travel, idle, violations | "Day complete" keynote, "Ours vs first come, first served" | **Planner: measured** (same simulator, same operator actions replayed; `baseline_source: "simulated"` means a Python twin; sample day: travel 76 vs 148 min, idle 80 vs 272 min; one scenario, not a benchmark). **Mock/MB: simulated** (scaled formula in `metricsOut()`, not a second run). **Bridge: not measured**; only "Jobs done (bridge)". | Sim | Sim | Measured | Not measured |

### 3.6 AI Supervisor (LLM, via AI svc)

| # | Scenario | Trigger | What it proposes | On screen | Approval path and guarantees |
|---|---|---|---|---|---|
| 26 | Plan findings | New plan version, fleet or spray-permission change (debounced, at least 20 s apart), or **Review now** | Late job: raise priority. Overtime, idle tractor: advice. Also `pin_job`, `ban_type`, `off_duty`. | AI Supervisor card: severity, title, why, preview when available | Operator approves, backend re-plans, Safety validates. Priority edits have no preview in the contract (the UI says so). |
| 27 | Implements after a breakdown | Same triggers | `set_implements`, e.g. "No working tractor carries a sprayer": names the tractor with least remaining work, notes the depot visit | Finding with a **preview** (moved, re-timed, travel/idle delta) | Preview, then **Approve**. Stale or busy: 409; refused preview: 422. |
| 28 | Plot vision | **Review now** with `&ai=`; best on **Satellite** | Crops each block and the depot from `naip.png` and asks if it is orchard. Blocks A and E flagged "houses, not orchard"; proposal `disable_block` | Flagged blocks outlined on the map; **Show Block A**; **Approve** "Exclude Block A from planning" | Event `block_disabled` with `proposed_by: "ai_supervisor"`. Block A's jobs go to Unassigned ("Block A is excluded from planning: ...") with progress kept. Explanation: "AI Supervisor proposed, operator approved, Safety check passed." Cached per scenario. |
| 29 | Rules fallback | No `&ai=` | Late-job priority raise, overtime and idle advice, missing implement. No plot review. | Panel labelled "rules" | Approvals go through the in-browser sim or the connected backend |

What the Supervisor can apply, by backend:

| Backend | Priority / pin job | Controls, implements, off-duty | Exclude block |
|---|---|---|---|
| mock-backend (`:8001`) | approvable | approvable | approvable |
| Planner (`:8000`) | approvable | advice only ("Not supported by this backend") | advice only |
| Bridge (`:8040`) | advice only | advice only | advice only |
| Mock with `&ai=` | The service reviews **its own** `API=` backend, not the in-browser sim; the panel says so | | |

`block_disabled` is a **proposal** (`AI_SUPERVISOR_PROPOSAL.md`, not yet accepted into ARCHITECTURE.md); the Planner backend does not adopt it.

### 3.7 Upcoming

| # | Scenario | Status |
|---|---|---|
| 30 | **"AI demo" scripted button** | Being built on branch `ai-demo`. At the time of writing that branch has no commits beyond `divi-ai`, so nothing to verify. Do not describe its behaviour until it lands. |

## 4. What the AI never does

- **No LLM plan decisions.** Assignment, ordering, routing and pausing come from algorithms. The LLM only proposes closed-enum actions (and, by design, rewords text).
- **No Safety bypass.** Every applied action goes through the normal REST mutation and the validator. A plan with a missed deadline, wrong implement, fuel shortfall or committed-trip violation is rejected, and a rejected edit leaves old values intact.
- **No invented numbers.** Counterfactuals come from re-solves. The Supervisor gets compact facts only: no weather where the backend does not enforce it, no metrics where they are not measured (`ai-supervisor/reviewers.mjs`). Action ids are checked against the snapshot.
- **No silent apply.** The Supervisor never applies anything itself; the operator clicks **Approve**.

## 5. Honesty notes

- Mock and MB baselines are **simulated** (a scaled formula). The Planner baseline is a measured FCFS twin of the same day, still labelled `simulated`.
- Bridge metrics are **not measured**; the dashboard shows only "Jobs done (bridge)".
- On Planner, weather is a static calm **placeholder** (`constraints.weather` off). Weather and heat events return 400; Why, mechanics, approvals, cockpit and scale test return 501.
- Capabilities hide unsupported features instead of letting the operator hit errors.
- Real AgOpenWeb tractors exist only on the Bridge, in AgOpenWeb's simulator mode, not physical machines. AgOpenWeb is **not** connected to the Python scheduler.
- Known gap: mid-day impossible deadline (#15). Known trade-off: repaired tractor may stay idle (#5).
- Planner's scenario has 12 jobs; the in-browser simulation has 11 (J1 to J11).
- Planner claims come from `backend/README.md` and `INTEGRATION_REPORT.md` (tested at 7df3d39 / 20d266e) and a read of `backend/app/main.py` on `origin/anay`. **[unverified]** I did not run the backend for this document; `GET /api/capabilities` is described in DEMO.md and the integration report, but `main.py` at `origin/anay` (7df3d39) does not define it.

## 6. How to run each mode

Dashboard: `cd dashboard && npm install && npx vite build && npx vite preview --port 5173` (rehearsal: `npx vite --port 5173`).

| Mode | Start | URL |
|---|---|---|
| **Mock** | nothing | `http://localhost:5173/?source=mock` |
| **mock-backend** | `cd mock-backend && npm install && PORT=8001 npm start` | `http://localhost:5173/?source=live&api=http://localhost:8001&pace=6` |
| **Planner** | once: `python -m venv .venv && .venv/bin/python -m pip install -r backend/requirements.txt`. Then: `cd backend && HFA_MAX_TRACTORS=5 ../.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000` | `http://localhost:5173/?source=live&api=http://localhost:8000` (starts with 3 tractors, Add tractor up to 5; no `?pace=`) |
| **Bridge** (Docker Desktop running) | once: `cd agopenweb-bridge && npm install && ./run-agopenweb.sh && ./run-agopenweb.sh stop`. Then from the repo root: `MAX_TRACTORS=3 REAL_SLOTS=3 node agopenweb-bridge/server.mjs` | `http://localhost:5173/?source=live&api=http://localhost:8040` |
| **AI Supervisor (agy)** | `cd ai-supervisor && npm install`, then from the repo root `AI_PROVIDER=agy AGY_MODEL=claude-sonnet-5-5-low API=http://localhost:8001 node ai-supervisor/server.mjs` (port 8060; `API=http://localhost:8000` for Planner) | add `&ai=http://localhost:8060`, e.g. `http://localhost:5173/?source=live&api=http://localhost:8001&ai=http://localhost:8060` |
| **Supervisor, no model** | `AI_PROVIDER=rules` or omit `&ai=` | in-browser rules reviewer |
| **OpenAI / Anthropic** | `AI_PROVIDER=openai OPENAI_API_KEY=...` or `AI_PROVIDER=anthropic ANTHROPIC_API_KEY=...` | same `&ai=` URL |

The **Mock | Live** switch (top-right of the 3D view) keeps `&ai=`. Supervisor tests: `cd ai-supervisor && npm test` (no model calls). Plot beat: open the mock-backend URL with `&ai=`, switch to **Satellite**, click **Review now**, **Show Block A**, **Approve**.

# CLAUDE.md

Guidance for Claude Code in this repository.

## Project

Hack Arizona / AgX Arizona Summit, challenge "Run the Fleet": **Harvest Fleet AI**, a coordinator that plans, re-plans and explains work for a citrus farm's autonomous tractors (our farm: real groves in Mesa, Arizona, East Valley, by Falcon Field). Freeze 4:00 PM on demo day.

Source-of-truth docs (read the relevant one before coding):
- `PROJECT.md`: base doc plus numbered **Changes 1 to 11**; later Changes override earlier text (Change 6 replaces the LLM orchestrator with an optimizer).
- `ARCHITECTURE.md`: backend/API contract. **Contract rule:** change the shape here first; never ship a different shape "just for now." **§13 is authoritative** (Operations, 202 mutations, snapshot, metrics).
- `FEATURES.md`: ordered build plan with "Done when" checks. `FRONTEND_PLAN.md`: dashboard milestones. `FRONTEND_NEEDS.md`: open asks for Anay/Diya. `DEMO.md`: demo script, pre-flight, Q&A.

## Layout

- `dashboard/`: Vite + vanilla JS + three@0.128.0. `src/data/` (data layer), `src/ui/`, `src/scene/`.
- Three backends, three roles (keep them separate):
  - `backend/` (`:8000`): **the scored coordinator demo.** Anay's FastAPI backend + Diya's Python scheduler/validator (`app/brain`), executing on MockGateway (simulated tractors). Models deadlines, fuel, implements, safety, progress-preserving breakdown recovery. Weather, mechanic, Why and cockpit are 501 there.
  - `mock-backend/` (`:8000`): offline backup. Wraps the dashboard's in-browser simulation behind the REST/WS contract. Not our Python scheduler. Same port as `backend/`, run one at a time.
  - `agopenweb-bridge/` (`:8040`): real headless AgOpenWeb containers through the same contract. **Bypasses the Python scheduler**; its travel/idle/violation zeros are placeholders, not measured results. Use only for the "real AgOpenWeb tractors" moment. Protocol notes in its README.
- Wording: the source badge says which backend is **connected**; only a tractor whose card says "AgOpenWeb ... heartbeat" is a **real AgOpenWeb** tractor. Never conflate them.
- `ai-supervisor/`: LLM reviewer (`:8060`) that proposes plan, implement and plot fixes the operator approves (contract proposal: `AI_SUPERVISOR_PROPOSAL.md`; README there).
- `contract/examples/`: one JSON per REST response and WS message.
- `textures/`: tractor, house and orchard SVG concepts (`node textures/_build/build.mjs` regenerates). `reference/`: `ui-mock.html`, the visual reference. `tools/fetch-basemap.mjs`: satellite basemap fetch script. `sketch/`: throwaway first sketch.

## Commands

```sh
# dashboard (cd dashboard): npm run dev (vite :5173), npm run build, npm run preview (use the build for demos)
# tests, from the repo root (both pass):
node dashboard/src/data/selftest.mjs
node dashboard/src/data/mockControls.test.mjs

# real backend, scored demo (from repo root; Python 3.11+; .venv/Scripts/python on Windows)
python -m venv .venv && .venv/bin/python -m pip install -r backend/requirements.txt   # once
cd backend && ../.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000   # plans at startup, paused at plan v1; Play starts the day (HFA_AUTORUN=0: plan v0, wait for POST /api/run)
PYTHONPATH=backend .venv/bin/python -m unittest discover -s backend/tests/brain -v    # also tests/platform, tests/integration
# dashboard: ?source=live&api=http://localhost:8000

# simulated backend (cd mock-backend)
npm install && npm start          # :8000 (PORT=, PACE=, QUIET=1); npm run smoke in a second terminal

# real AgOpenWeb (cd agopenweb-bridge)
npm install && ./run-agopenweb.sh && ./run-agopenweb.sh stop   # first time: builds image
npm test                          # decoder tests, no Docker
# from repo root, one line (Docker Desktop must run):
MAX_TRACTORS=3 REAL_SLOTS=3 node agopenweb-bridge/server.mjs   # full mode; REAL_SLOTS=1 = hot-seat

# AI Supervisor (cd ai-supervisor && npm install; npm test). Dashboard: &ai=http://localhost:8060 (without it: in-browser "rules" reviewer)
AI_PROVIDER=agy API=http://localhost:8000 node ai-supervisor/server.mjs   # or AI_PROVIDER=openai|anthropic|rules
```

URL params: `?source=mock|live`, `&api=http://localhost:8000` (FastAPI backend, or mock-backend instead) or `:8040` (bridge), `?pace=` (farm min per real second, default 1.2), `?view=map|3d`, `?debug=perf`.

**Run node servers by path** (`node agopenweb-bridge/server.mjs`) and **never `pkill` by name** (`pkill -f "node server.mjs"` kills other agents' servers). Other agents edit code concurrently: stay within your assigned files.

## Data-layer rule

Components talk only to `dashboard/src/data/index.js`: `start()`, `store` (`get`/`subscribe`), `api.*`, `sourceInfo`. Never import `mockSource.js` or `liveSource.js` from UI code. Both sources emit exactly the ARCHITECTURE.md §13 shapes, so live vs mock is one setting.

## Architecture

```
Dashboard --REST /api/*, WS /ws--> backend (FastAPI | mock-backend | agopenweb-bridge)
                                      --ws per tractor--> AgOpenWeb containers (headless)
```

- The dashboard never talks to AgOpenWeb; only a backend gateway does (`TractorGateway`: `AgOpenWebGateway`, `MockGateway`).
- **Brain = algorithm, not an LLM**: Fleet planner (greedy, then OR-Tools), Navigation (A*), Safety, Weather, Agronomy, Mechanic, Explain. An LLM may only reword explanations. The planner is `backend/app/brain` on the FastAPI backend; `?source=mock` and `mock-backend` use the simulated version.
- Rolling re-plan on any event: freeze done and in-progress work, re-solve the rest, Safety Agent, apply, log, explain. Baseline is an FCFS dispatcher on the same scenario and events.
- Deadlines are a modeled hard constraint (validator rule "Deadline missed"). `violations` counts broken constraints in applied/executed plans; the dashboard also shows "Finished late" separately so lateness is never hidden.
- Hackathon fleet cap: 5 tractors (the scale-to-50 work is cut).

### Invariants (ARCHITECTURE.md §8)
1. One in-memory state store feeds REST, WS and the event log.
2. Every applied plan passed the Safety Agent; rejections log `safety_reject`, never a `plan`.
3. Each re-plan emits `plan`, `explanation`, then changed `jobs`.
4. Work is never lost or duplicated; a reassigned job keeps its `progress`.
5. Lists, not fixed arrays; tractors are plug-and-play.
6. Deterministic runs: seed all randomness.
7. REST returns within 2 s; slow work returns 202 and finishes over WS.

### Conventions (ARCHITECTURE.md §2-3)
- `snake_case` keys; string IDs (`T1`, `J1`, blocks `A`..`H`, `M1`, `P1`).
- Farm time `t` = minutes since 6:00 AM; suffixes `_min` (durations), `_t` (times).
- Missing values are `null` (never omit the key); empty lists `[]`. `manual` is a boolean on a tractor, not a status.
- WS envelope `{type, t, seq, data}`; `poses` throttled to 5 Hz, progress and `coverage` to 1 Hz; never forward raw AgOpenWeb frames.
- Event log: `event_log_ours.jsonl` and `event_log_baseline.jsonl`; every line has `t` and `kind`.

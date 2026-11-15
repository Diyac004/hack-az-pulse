# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Hack Arizona / AgX Arizona Summit hackathon project, challenge "Run the Fleet": **Harvest Fleet AI**, a coordinator that plans, re-plans, and explains work for a citrus farm's fleet of autonomous tractors. The repo currently holds only design docs, no code yet. There are no build, lint, or test commands until the code lands; add them here once it does.

The three docs are the source of truth. Read the relevant one before writing code:

- `PROJECT.md`: the base doc plus numbered **Changes 1 to 11**. Later Changes override the base sections and earlier Changes. For example, Change 6 replaces the LLM orchestrator with an optimizer.
- `ARCHITECTURE.md`: the backend/API contract (enums, object shapes, REST, WebSocket, event log, Pydantic models, FastAPI skeleton). **Contract rule:** to change a shape, update this doc first. Never ship a different shape "just for now."
- `FEATURES.md`: an ordered build plan by owner, with a "Done when" check for each step and a cut order if the team falls behind.

## Planned layout and commands

The planned top-level layout is `backend/` (FastAPI), `dashboard/`, `infra/` (Docker for AgOpenWeb), `data/` (`scenario.json`), and `contract/examples/` (one JSON per REST response and WS message type).

- Backend: Python 3.11+, Pydantic v2. Run it with `uvicorn app.main:app --host 0.0.0.0 --port 8000`.
- Dashboard dev origin: `http://localhost:5173`. Pick the data source with `?source=mock|live`.
- AgOpenWeb containers: .NET 10, `--headless`, simulator mode, one per tractor on ports 5174, 5175, and so on.
- Contract check: a backend test calls every endpoint, captures one of each WS message, and validates each against the Pydantic models. Keep `/openapi.json` enabled so drift against `ARCHITECTURE.md` can be checked.

## Architecture (big picture)

```
Dashboard (browser) --REST /api/*, WS /ws--> FastAPI (one asyncio process)
  api/ ws/ core/ agents/ gateway/ baseline/ metrics/
        --ws per tractor (internal)--> AgOpenWeb containers (headless)
```

- **The dashboard never talks to AgOpenWeb.** Only the backend's `gateway/` does. It goes through a `TractorGateway` interface with `AgOpenWebGateway` and `MockGateway` implementations, so everything else builds against the mock.
- **The dashboard data layer** has `MockSource` (in-browser, replays the contract shapes) and `LiveSource` behind one interface. When the backend returns the contract shapes, switching to live is one setting.
- **Brain = algorithm, not an LLM.** Agents (Weather, Agronomy, Fleet, Navigation, Safety, Mechanic, Explain) wrap a planner. The Fleet planner is greedy first, then OR-Tools vehicle routing with time windows behind the same interface. Greedy is the fallback if OR-Tools times out. Navigation is A* on a road grid. "Why?" answers come from counterfactual re-solves. An LLM may only reword explanations.
- **Rolling re-plan on any event:** freeze completed and in-progress jobs, rebuild from live state using only the remaining work, re-solve, run the Safety Agent, apply, log the diff, and explain.
- **Baseline** is an FCFS dispatcher run on the identical scenario, events, weather, and fleet changes, for the ours-vs-baseline metrics.

### Invariants the dashboard relies on (ARCHITECTURE.md §8)
1. A single in-memory state store. REST, WS, and the event log are all built from it.
2. Every applied plan has passed the Safety Agent. Rejections are logged as `safety_reject` and never sent as `plan`.
3. Each re-plan emits WS messages in the order `plan`, then `explanation`, then the changed `jobs`.
4. Work is never lost or duplicated. A reassigned job keeps its `progress`.
5. No fleet-size cap. Use lists, never fixed arrays. Tractors are plug-and-play, even mid-day.
6. Runs are deterministic: seed all randomness.
7. REST returns within 2 s. Slow work returns "accepted" and finishes over WS.

### Conventions (ARCHITECTURE.md §2–3)
- JSON keys are `snake_case`. IDs are strings: `T1`, `J1`, blocks `A`..`H`, `M1`, `P1`.
- Farm time `t` is minutes since 6:00 AM. Fields use the suffixes `_min` (durations) and `_t` (times).
- Missing values are `null`; never omit the key. Empty lists are `[]`.
- Enum strings must match §3 exactly. `manual` is a boolean on a tractor, not a status.
- WS envelope: `{type, t, seq, data}`. Throttle `poses` to 5 Hz batched, and job progress and `coverage` to 1 Hz. Never forward raw AgOpenWeb frames.
- Event log: one file per run, `event_log_ours.jsonl` and `event_log_baseline.jsonl`. Every line has `t` and `kind`.

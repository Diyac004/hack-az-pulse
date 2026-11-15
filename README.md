# Harvest Fleet AI — Pulse

Run the Fleet · Hack Arizona / AgX Arizona Summit · American Tractor Company challenge

A fleet coordinator for three simulated farm tractors: submit jobs, assign compatible equipment, respect fuel and deadlines, track progress, and reassign unfinished work after a breakdown. Explanations come from recorded scheduling facts.

## Submission links

- [Code](https://github.com/Diyac004/hack-az-pulse)
- [Measured baseline comparison](submission/RESULTS.md)
- [Exact demo scenario: tractors, fields, jobs and breakdown](submission/demo-run/scenario.json)
- [Coordinator demo event log](submission/demo-run/event_log_ours.jsonl)
- [FCFS baseline event log](submission/demo-run/event_log_baseline.jsonl)
- [Machine-readable results and evidence hashes](submission/demo-run/results.json)
- [Two-minute demo script](DEMO.md)

## What actually runs

**The scored demo uses our own Python MockGateway simulator**, with the FastAPI backend and our algorithmic brain. Navigation uses cached BFS on equal-cost roads; scheduling uses multi-order greedy insertion plus moves/swaps; an independent validator checks modeled constraints before execution. Progress is preserved by work-unit accounting. REST accepts actions; WebSocket streams state and operation updates.

The optional **AI Supervisor** has plan, implement and aerial-plot reviewers. With a configured model provider it makes LLM suggestions for operator approval; without the AI service the dashboard uses explicitly labeled rules. It does not replace deterministic scheduling or validation. Some suggested controls remain advisory because the FastAPI backend does not implement them.

**AgOpenWeb is a separate optional bridge demonstration**, not the execution engine for the measured coordinator results. Do not attribute bridge steering or placeholder metrics to the Python scheduler. See [backend details](backend/README.md), [AI setup](ai-supervisor/README.md), and [bridge setup](agopenweb-bridge/README.md).

## Quick start — backend and dashboard

Prerequisites: Python 3.11+ and Node.js 18+ with npm. No API keys, LLM provider, Docker or AgOpenWeb are needed for the scored demo.

From the repository root, macOS/Linux:

```bash
python -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
cd backend
../.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Windows PowerShell:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r backend/requirements.txt
cd backend
..\.venv\Scripts\python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

In a second terminal, from repository root:

```bash
cd dashboard
npm ci
npm run build
npm run preview -- --host 0.0.0.0
```

Open **http://localhost:5173/?source=live&api=http://localhost:8000**.

The backend plans the day at startup and stays paused. Wait for the initial plan, then press Play. Tractor 1 has a scripted breakdown at farm minute 50. For a manual-only demonstration, set `HFA_SCRIPTED=0` before starting the backend; do not manually break/repair T1 before minute 50 and expect its separate scheduled event to disappear.

The dashboard hides/disables unsupported features based on `/api/capabilities`. Weather, mechanic booking, full cockpit controls and counterfactual Why are not part of the working FastAPI demonstration. Submit jobs using Add jobs. Use the existing job sheet for supported edits. A run/restart resets the day.

## Reproduce the submission results

With backend dependencies installed, from repository root:

```bash
PYTHONPATH=backend .venv/bin/python backend/scripts/package_submission.py
```

PowerShell:

```powershell
$env:PYTHONPATH="backend"
.venv\Scripts\python backend/scripts/package_submission.py
```

This regenerates the tracked `submission/` artifacts. The existing headless runner also works: `PYTHONPATH=backend python -m app.core.runner --mode both`.

## Verification

With the virtual environment active (PowerShell: set `$env:PYTHONPATH="backend"` first):

```bash
PYTHONPATH=backend python -m unittest discover -s backend/tests/brain -v
PYTHONPATH=backend python -m unittest discover -s backend/tests/platform -v
PYTHONPATH=backend python -m unittest discover -s backend/tests/integration -v
node --test ai-supervisor/test/*.test.mjs
```

## Limitations

This is a heuristic simulation, not a globally optimal scheduler or real-tractor safety controller. Speeds, fuel rates and work durations are illustrative. Healthy driving tractors remain committed to their current destination; it is not unrestricted mid-drive routing. Refueling, weather enforcement, implement swaps and some optional supervisor actions are not implemented in the scored path. The comparison is one scenario, with identical rules and events; no guarantee of improvement on every scenario is claimed. LLM network calls and AgOpenWeb operation require separate configuration and have not been credited with the benchmark gains.

Team: Diya — brain; Anay — platform and execution; Divi — dashboard and optional AI/AgOpenWeb services.

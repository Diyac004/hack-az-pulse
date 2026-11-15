# Submission verification

Verified against runtime source commit `9698334` with packaging/documentation changes only.

- Clean Python 3.12 virtual environment installed the exact committed backend requirements successfully. The resolved environment is recorded in `demo-run/environment.txt`.
- Python brain suite: 23 passed.
- Python gateway suite: 26 passed.
- Python integration suite: 61 passed.
- AI-supervisor suite: 38 passed using mocks/deterministic fixtures, not paid/live model calls.
- Dashboard: `npm ci` and production `npm run build` passed.
- A real local Uvicorn server in the clean environment passed `backend/scripts/demo_client.py`: HTTP 202 operations, WebSocket plan/explanation updates, scripted T1 breakdown and an additional manual T2 breakdown. This smoke check is separate from the default-scenario comparison artifacts.
- Packaged full-day logs parsed successfully, contain 12 distinct job completions per policy, include a scripted breakdown, and contain no executed violation records. SHA-256 hashes match results.json.

No live LLM-provider call, Docker/AgOpenWeb launch, Windows/macOS clean install, deployment or organizer-form submission was performed in this verification. Provider adapter tests do not establish model account availability. A Starlette/httpx test-client deprecation warning was observed without test failures.

The source commit identifies the runtime used for the packaged comparison. The packaging commit adds the entry-point README, corrected demo script, regeneration script and submission evidence; it does not modify coordinator behavior.

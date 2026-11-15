# Scored demo: Harvest Fleet AI / Pulse

This script is for **FastAPI + the Python brain + MockGateway**. Other modes are optional separate demonstrations and do not supply the measured scorecard results.

## Preflight

1. Follow the root README to start the backend and built dashboard.
2. Open `http://localhost:5173/?source=live&api=http://localhost:8000`.
3. Wait for startup planning to finish. The day is paused; the plan version is at least 1.
4. Check 3 tractors, 8 fields, 12 jobs. Wait for the matching simulated baseline to populate; unavailable metrics must remain labeled unavailable.
5. Use the default scripted scenario for the submitted comparison: T1 breaks at farm minute 50. Do not add extra manual events if quoting that run's final numbers.
6. Have `submission/RESULTS.md` and the two submission event logs open as fallback evidence.
7. Optional: record a rehearsal locally. A recording is useful but not part of the five required artifacts.

## Two-minute script

| Time | Show | Say |
|---|---|---|
| 0:00–0:20 | Paused map, tractors and timeline | "Autonomous tractors still need someone to decide which machine does which job, and what happens when one fails. Pulse coordinates that work." |
| 0:20–0:40 | Plan and job list | "We check implements, fuel, travel, deadlines and conflicts before applying a plan. This demo uses our own simulated tractors." |
| 0:40–1:10 | Play; let T1's scripted breakdown at minute 50 happen; pause to explain | "The failed tractor stops. Completed work stays recorded. Our coordinator reassigns the remaining work and explains what changed." |
| 1:10–1:30 | Updated timeline and explanation | "The planner tries different job orders and queue positions, improves through moves and swaps, then an independent validator checks the replacement plan." |
| 1:30–1:50 | Finish/fast-forward the day; compare scorecard or saved results | "On this submitted scenario both policies finish 12 jobs on time. Our coordinator uses 76 travel minutes versus 148, and 80 idle minutes versus 272. Both use the same simulator and events." |
| 1:50–2:00 | Final map and results | "Our goal is less manual coordination, with recoverable progress and decisions an operator can inspect." |

Verify the numbers against the regenerated results before speaking. If extra manual events occur, use the matching live scorecard instead; do not substitute the submitted scenario's numbers.

## Exact algorithm explanation

- Navigation: cached BFS on an equal-cost four-neighbor road grid.
- Fleet: multi-order greedy insertion, then bounded moves/swaps.
- Objective: weighted on-time jobs, on-time count, travel, planned waiting. Measured idle comes from execution, not that planning proxy.
- Safety: deterministic validation of compatibility, timing, fuel reserve, roads, field occupancy and progress preservation.
- Execution: FastAPI world state, version-gated plan application, MockGateway and WebSocket updates.
- FCFS baseline: submission order, first feasible compatible tractor, same simulation rules.
- No guarantee of global optimality or superiority on every scenario.

## Optional AI Supervisor — separate, only if configured and rehearsed

See `ai-supervisor/README.md`. Start the service with your available provider and point its API setting to FastAPI. The dashboard needs `&ai=http://localhost:8060` to use the external service. Without it, the in-browser supervisor is labeled rules.

The plan, implement and vision-plot reviewers propose structured changes. The operator approves supported actions and the normal backend performs replanning/validation. Unsupported changes stay advisory. LLM wording may rephrase explanations with template fallback. Do not claim LLM suggestions produced the submitted benchmark gains, a measured candidate-plan comparison exists, or automatic LLM application is implemented.

A demonstration against a provider requires actual configured credentials/CLI. Test suite provider mocks do not prove real network model execution. Do not enable an untested provider during the pitch.

## Optional AgOpenWeb bridge — separate steering demonstration

See `agopenweb-bridge/README.md`. It has a separate server and does not execute the Python fleet scheduler. Label the mode explicitly. Its travel/idle/violation placeholders are not benchmark evidence. Do not call FastAPI's MockGateway tractors AgOpenWeb tractors.

## Not in the scored FastAPI demo

Do not script mechanic booking, wind/heat enforcement, cockpit/manual steering, aerial coverage painting, counterfactual Why, or implement swapping. These are absent from this backend or belong to other modes; the UI capabilities gate them.

## Final export if the presented run differs

Download `GET /api/log` after the real demo session. The committed artifacts were generated from a reproducible headless demonstration of the default scenario, not a claim of a browser/on-stage recording. If you add manual events, preserve them and use a baseline replay with the same events.

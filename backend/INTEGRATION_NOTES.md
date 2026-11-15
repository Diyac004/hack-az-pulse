# Review of Anay's draft brain fixtures

Reviewed main commit d5b6580. No public frontend shape changes are needed for these internal corrections.

## Compatible pieces

Snapshot includes versioning, time, road map, tractors, fuel burn, work units, frozen work and constraints. Result separates proposals from application: Anay assigns plan.version and applies only validated current-state results. This matches BRAIN.md.

## Corrections and integration decisions

- The route from (15,3) to (10,8) is 10 cells: at 0.5 cells/min it takes 20 minutes. After frozen work ends at 160, travel ends at 180 and 60 minutes of remaining work finishes at 240.
- The route from (1,6) to (3,6) is two cells: at 0.6 cells/min it takes 3.333 minutes. Work starts at 144.833 and ends at 189.833.
- The result's moved-from assignment and travel/idle deltas cannot generally be derived from this snapshot: add optional previous-plan/assignment history internally before claiming those facts. The breakdown trigger alone does not establish the failed tractor's job. Until provided, explanation generation must omit unavailable deltas/history.
- `constraints.refuel: true` currently lacks refill duration/rate and availability. Initial implementation will return an explicit unsupported-constraint outcome for enabled refueling/weather, rather than silently violating them. Anay can disable them for the first fixture, or agree additional inputs before enabling them.
- A working tractor's actual position can be inside a field, and travel can start at fractional road positions. Anay must provide a physically timed field/road connector and current-edge progress; the router will not snap or teleport. Initial router supports integer road endpoints and returns an explicit reason otherwise.
- Frozen work must identify activity type, tractor, job and remaining occupancy; ongoing travel additionally needs its remaining route. Fuel projections must charge only remaining time from snapshot.t, not already executed work.
- Capability compatibility is currently represented only by implements. For the first fixture, job type to implement mapping is explicit; separately modeled vehicle capabilities need an internal field before they can be checked independently.
- Public Plan.solver_status remains the finalized API enum. Internal planning failures/timeouts must be mapped by Anay's operation layer, not forwarded as new public enum values.

## Current branch progress

`diya/brain` contains initial Pydantic snapshot models, a cached equal-cost road BFS router, and five foundation tests. This is not a complete scheduler or validator yet. Model parsing is not proof of plan feasibility.

Run from the repository root:

```bash
PYTHONPATH=backend python -m unittest discover -s backend/tests/brain -v
```

Requires Python 3.11+ and Pydantic v2. Next: independent plan validator, scheduling, and breakdown recovery. The original uploaded draft examples remain unchanged to avoid passing hand-edited illustrative results off as computed plans.

## Implemented brain milestone (current diya/brain branch)

Pure API is now available:

```python
from app.brain import BrainSnapshot, plan, validate, explain
result = plan(BrainSnapshot.model_validate(snapshot_dict))
# Only apply if result.validation.passed and source_state_version is still current.
# Assign public plan.version in the platform, not in the brain.
text = explain(result)
```

Implemented: previous-plan/remaining-route parsing, multi-order greedy insertion, independent plan replay validation, preserved ongoing work, remainder reassignment, explicit unassigned reasons, factual explanations, and FCFS dispatch policy (`plan(snapshot, policy="fcfs")`). Caller must still persist actual progress and supply each new snapshot; this is not a running simulation.

Run the single-snapshot demonstration from repository root:

```bash
pip install -r backend/requirements-brain.txt
PYTHONPATH=backend python -m app.brain contract/examples/brain_snapshot.json
PYTHONPATH=backend python -m unittest discover -s backend/tests/brain -v
```

The public proposal matches ARCHITECTURE.md Plan after the platform adds version. Internal PlanningResult validation status must be honored before exposing or executing entries. No changes to Divi's existing contract are introduced.

Limitations for Anay:

- Enabled refueling/weather and frozen travel return explicit unsupported outcomes in v1. Keep disabled until integrated.
- Future-position snapshots without explicit frozen work are rejected for that assignment, not silently accepted. Actual field connectors and ongoing travel are next integration work.
- Planning search is budgeted between candidate evaluations, not forcibly terminated mid-validation; run it outside the event loop.
- Idle-time tie-breaker currently uses planned waiting as a proxy. Exact simulated idle metrics and full-run FCFS comparison still require the world service. No performance superiority is claimed.
- Completed work is preserved through remaining-duration accounting. Execution must retain the same work-unit records; the planner does not update them.
- Greedy insertion rebuilds downstream queues and validates them. Moves/swaps, OR-Tools, counterfactual Why, and complete retiming diffs remain future work.
- The explanation diff currently reports changed ownership and new assignments; delta travel/idle claims are omitted until both plans are measured.

Tests cover recovery, unchanged inputs, compatibility, fuel, deadline infeasibility, duplicate work, route validity, frozen-work preservation, unsupported options, deterministic plan entries and public Plan serialization. They do not establish real-world vehicle safety or end-to-end gateway correctness.

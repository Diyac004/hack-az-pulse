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

# Brain implementation plan

> Owner: Diya. Platform/API owner: Anay. Frontend owner: Divi.
> Status: implementation plan, not implemented functionality.
> Companion to ARCHITECTURE.md and FEATURES.md. Existing public API shapes remain authoritative until coordinated changes are accepted there.

## 1. Goal and scope

Build a fast, correct fleet coordinator for Run the Fleet: compatible assignments, deadlines and fuel feasibility, progress-preserving breakdown recovery, factual explanations, and measured results against FCFS.

Three core components correspond to the suggested agents: Fleet, Navigation, and Safety. They are deterministic Python modules; LLM calls are not required. Explanations, baseline policy, and metrics support them. Weather, Agronomy, Mechanic, distributed compute, and advanced optimizers follow the working core.

No algorithm guarantees a competition win. Demonstrate measured behavior and disclose model assumptions.

## 2. Ownership

| Owner | Responsibilities |
|---|---|
| Diya | Navigation, scheduling, plan validation, recovery planning, explanation facts/templates, FCFS dispatch policy, metric definitions/calculations, brain tests |
| Anay | FastAPI routes, WebSocket transport, authoritative state, simulation clock, movement/progress/fuel execution, event ingestion, gateway and AgOpenWeb integration, log persistence |
| Divi | Dashboard, forms, visualization, API client, explanations and comparison display |

Anay owns state mutations. Diya's planner reads a snapshot and returns a proposal. Runtime invariant checks use Diya's validation rules, invoked by Anay's world service. Baseline and ours run through the same execution mechanics. Agree file ownership before editing shared models or API routes.

## 3. Routing

### Initial implementation

- Four-neighbor road grid with explicit field entrances and depot access.
- On equal-cost edges, run BFS from relevant nodes to obtain exact shortest distances and recoverable paths.
- Cache by map version and source node. Include current tractor positions as needed.
- Increment map version on blockage changes; invalidate affected cache entries (full invalidation is acceptable initially).
- Unreachable destinations produce explicit infeasibility, not straight-line fallbacks.
- Convert distance to travel minutes using shared cell size and tractor speed. Never compare grid distances with minutes without conversion.

For single destination searches, A* with Manhattan distance is a valid alternative on a four-neighbor equal-cost grid. For weighted roads, use Dijkstra or A* with an admissible heuristic scaled to minimum edge cost. Benchmark before changing the router.

Routing optimizes modeled road travel. It does not provide obstacle clearance, tractor collision avoidance, or turning-radius feasibility. AgOpenWeb field guidance remains behind Anay's gateway. Define the grid-to-guidance coordinate conversion jointly.

## 4. Scheduling

### Hard constraints

Before scoring any insertion, enforce:

- Operational, automatically available tractor; manual/offline/broken tractors excluded.
- Required capability and compatible implement.
- No overlapping travel, work, wait, refueling, or implement changes per tractor.
- Feasible routes and field occupancy restrictions.
- Completion by the job's effective deadline.
- Fuel for travel and work plus a feasible return to depot while preserving the configured reserve.
- Completed work unchanged and each unfinished work unit owned at most once.
- Weather windows and implement change times only when those features are actually modeled; use the same rules in both policies.

If refueling stops are not implemented, reject work exceeding the available fuel budget. Do not pretend fuel is restored automatically. An infeasible job stays visible and eligible for reconsideration.

### First working scheduler

1. Preserve valid healthy ongoing activities and completed work.
2. Try priority-first, earliest-deadline-first, and fewest-compatible-tractors-first orderings; break ties deterministically.
3. For each job, evaluate feasible tractors and queue insertion positions. Recompute downstream travel, timing, fuel, and occupancy.
4. Choose the best valid insertion; retain the best complete candidate schedule across orderings.
5. Leave impossible jobs unassigned with specific reasons.
6. Bound search time; return the best validated feasible result found.

If v1 only appends jobs, call it greedy append scheduling until insertion positions are implemented.

### Objective

Compare valid schedules lexicographically:

1. Maximize the sum of priorities of jobs completed on time.
2. Maximize the number of on-time jobs.
3. Minimize total travel minutes.
4. Minimize total idle minutes, measured with the shared definition.

Also report total completed jobs and productive work minutes, including partial work. These measures expose tradeoffs; weighted job count is an illustrative value proxy, not a claim of real crop economics. Evaluate the full horizon so simply declining work does not appear efficient.

### Improvement

Try bounded job relocations and swaps, accepting only fully validated objective improvements. Preserve deterministic tie-breaking and record candidate rejection reasons.

An optional time-limited OR-Tools optimizer may use the same interface after the heuristic works. Choose and document the actual formulation (CP-SAT or Routing), including travel sequencing, optional jobs, deadlines, remaining work, and fuel. Do not assume a generic vehicle-routing example covers these constraints.

Always distinguish feasible, proven optimal, timeout/unknown, and no-feasible-result outcomes. Retain a validated heuristic fallback. A proven optimum applies only to the mathematical model and its objective. Wall-clock solver limits may affect reproducibility; log solver settings, seed, version and result, and do not promise identical plans solely from a seed.

## 5. State, progress and recovery

Internal authoritative state includes state version, simulation time, positions, fuel, current activities, job/work-unit progress, queues, map version, and external constraints.

Track numbered work units such as rows, with completed work minutes. Derive existing API `progress` and `remaining_min` from those records. Initially assume interrupted work resumes from recorded progress; document this abstraction.

On a breakdown:

1. Anay immediately stops execution and captures authoritative state.
2. Preserve completed units, partial progress, actual position and fuel.
3. Release failed tractor's unfinished work and reconsider queued work.
4. Preserve healthy ongoing work only where still feasible.
5. Plan from the updated snapshot; do not reset progress or teleport tractors.
6. Validate, then apply atomically only if the snapshot's state version remains current.
7. Otherwise discard the stale result and replan from fresh state.
8. Broadcast applied plan, explanation, and changed jobs in the existing contract order.

No backup means pending work with an explicit reason. Approval cannot bypass physical constraints. Any operator deadline revision is logged and original-deadline results remain available.

## 6. Proposed internal interface: agree with Anay first

These are proposed Python interfaces, not new public HTTP endpoints:

```python
plan(snapshot: BrainSnapshot) -> PlanningResult
validate(snapshot: BrainSnapshot, plan: ProposedPlan) -> ValidationResult
find_route(request: RouteRequest) -> RouteResult
```

`BrainSnapshot`: state version, map version, simulation time/horizon, grid/roads/entrances/depot, tractor capabilities/implements/pose/fuel/availability, jobs/deadlines/work units, frozen activities, and enabled constraints.

`PlanningResult`: source state version, proposed plan compatible with public `Plan`, unassigned reasons, decision facts, solver/status, planning duration, and validation result.

`RouteResult`: reachable flag, path, distance, travel time where tractor speed is provided, and failure reason.

`ValidationResult`: passed flag and structured rule violations with affected tractor/job IDs.

Reuse shared Pydantic models. Keep internal records richer than public presentation objects rather than introducing incompatible copies. Planner functions do not perform network calls, broadcast messages, or mutate the world.

Anay runs CPU-heavy search outside the asyncio event loop. Agree cancellation/coalescing for consecutive events: superseded work must not apply later. Repeated requests/events need IDs so retries do not apply them twice.

## 7. Frontend/API coordination

Keep current REST paths, WebSocket envelope, tractor/job presentation, and plan/explanation ordering from ARCHITECTURE.md. Public shape changes must be accepted there first and communicated to Divi.

### Proposed additions requiring coordination

| Change | Backend purpose | Frontend impact |
|---|---|---|
| Nullable `Job.unassigned_reason` | Explain infeasibility without losing jobs | Display reason in job details |
| `Plan.solver_status` | Distinguish feasible/optimal/fallback outcomes | Optional solver status label |
| Async operation result for slow calls | Meet the two-second REST rule during replans | Handle accepted operation and pending/completed/failed updates |
| Additional comparison fields | Weighted completion, productive minutes, rejected candidates, replan duration | Optional expanded scorecard |

The current contract promises completed plans in some REST responses while also requiring slow work to finish asynchronously. Agree exact HTTP 202 payload, operation ID and update message before implementing that alternative. Do not silently return a different shape.

State versions, work-unit records and route caches can remain backend-internal. Keep numeric `progress` and `remaining_min` unchanged for the frontend. No agent chat, token metrics, or agent activity panel is required.

Current `dropped` terminology must not imply permanent deletion of temporarily infeasible work. Agree whether to expose such jobs as `pending` with reasons; do not introduce enum values without updating the contract.

## 8. Baseline, metrics and verification

Use the supplied starter dispatcher if available; otherwise disclose FCFS: submission order, first available feasible compatible tractor, no optimization, unfinished work requeued after breakdown.

Same simulator, physical constraints, weather, fuel reserve, progress, fleet changes and event times for both policies. Only dispatch differs. A live-vs-twin comparison needs demonstrated equivalent execution semantics and explicit source labels; prefer a common deterministic simulator for controlled algorithm evaluation.

Measure completed/on-time jobs, weighted on-time completion, productive minutes, travel, idle, executed violations, unresolved work, and planning latency. Keep rejected candidates separate from executed violations. Report wins, ties and losses; greedy is not guaranteed to beat FCFS.

Required scenarios:

- Normal mixed jobs and scarce implements.
- Breakdown while traveling and while working.
- No compatible backup.
- Insufficient fuel and unreachable destination.
- Impossible deadline.
- Repeated breakdowns and stale planner result.
- Blockage, weather pause, or refueling interruption if implemented.

Assertions cover constraints, monotonic progress, single ownership, no reassignment of completed units, deterministic heuristic results, and identical external events across runs. Capture timing at several fleet sizes without calling support unlimited: dynamic lists still have measured compute limits.

## 9. Files and implementation milestones

Proposed files, subject to agreement on existing project layout:

```text
backend/app/brain/
  contracts.py
  navigation.py
  scheduler.py
  validator.py
  recovery.py
  explanations.py
  baseline.py
backend/tests/brain/
contract/examples/
  brain_snapshot.json
  brain_result.json
```

The two internal fixtures are next deliverables; this document does not claim they exist yet. Anay retains shared models, API routes and execution code.

1. Agree snapshot/result fixtures and units with Anay; flag proposed API changes to Divi.
2. Produce routes and one validated static schedule.
3. Integrate snapshot-to-plan with Anay's MockGateway world.
4. Demonstrate breakdown recovery, facts-based explanation and log.
5. Run fair baseline comparison and required scenarios.
6. Improve search based on measured weaknesses.
7. Attempt OR-Tools, AgOpenWeb expansion, weather or repair features only after core success.

First complete milestone: three tractors execute valid jobs; one fails; completed work is preserved; remaining work is reassigned or explicitly flagged; dashboard shows explanation and actual baseline results.

## 10. Optional repair extension

Create a repair ticket alongside reassignment. Rank preloaded providers by expertise, availability and distance; simulate operator-approved booking. A repair ETA is advisory. Only an explicit return-to-service confirmation makes the tractor schedulable again. Real outreach and diagnosis are outside this milestone.

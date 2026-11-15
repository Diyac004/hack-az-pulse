"""Brain adapter: snapshot -> Diya's plan() -> validate/stale gate -> atomic apply.

`replan_sync` is used by the headless runner and the tests. The async engine
does the same three steps but runs plan() in a worker thread
(see app/core/engine.py).
"""
from __future__ import annotations

from app.brain import explain, plan as brain_plan

from .state import World

MAX_ATTEMPTS = 3
# The brain's improvement search stops when it converges (~0.4 s on the demo
# scenario) or when this wall-clock budget runs out. A budget that can run out
# makes results depend on machine load, so give it room to converge; every
# replan log line records whether the search completed.
PLAN_BUDGET_MS = 10_000


def run_planner(snapshot: dict, policy: str):
    return brain_plan(snapshot, policy=policy, budget_ms=PLAN_BUDGET_MS)


def replan_sync(world: World, trigger: dict) -> dict:
    """Plan from the current state and apply it if it is valid and current.

    Returns the World.apply_result outcome, or {"applied": False,
    "reason": "superseded"} if the state kept changing under the planner.
    """
    # Operator edits in the trigger are staged for this plan only, and committed
    # or rolled back depending on whether a valid plan is applied.
    undos = world.stage_edits(trigger.get("edits", []))
    if trigger.get("edits") and not undos:
        return {"applied": False, "reason": "edit_rejected"}
    outcome = {"applied": False, "reason": "superseded"}
    for _ in range(MAX_ATTEMPTS):
        snapshot = world.to_brain_snapshot(trigger)
        result = run_planner(snapshot, world.policy)
        outcome = world.apply_result(result, trigger, explain)
        if outcome.get("reason") != "stale":
            break
    world.finish_edits(undos, outcome["applied"], edit_failure_reason(outcome))
    return outcome


def edit_failure_reason(outcome: dict) -> str:
    if outcome.get("applied"):
        return ""
    if outcome.get("reason") == "superseded":
        return "The farm kept changing while planning; previous values kept."
    rules = sorted({v.get("rule", "") for v in outcome.get("violations", [])} - {""})
    return "No valid plan accepts this change" + (f" ({', '.join(rules)})" if rules else "") + "; previous values kept."


def merge_triggers(triggers: list[dict]) -> dict | None:
    """Several triggers in one tick -> one re-plan (the planner sees all changes)."""
    if not triggers:
        return None
    first = dict(triggers[0])
    edits = [e for t in triggers for e in t.get("edits", [])]
    if edits:
        first["edits"] = edits
    if len(triggers) > 1:
        first["also"] = [t["type"] for t in triggers[1:]]
    return first

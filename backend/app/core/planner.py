"""Brain adapter: snapshot -> Diya's plan() -> validate/stale gate -> atomic apply.

`replan_sync` is used by the headless runner and the tests. The async engine
does the same three steps but runs plan() in a worker thread
(see app/core/engine.py).
"""
from __future__ import annotations

from app.brain import explain, plan as brain_plan

from .state import World

MAX_ATTEMPTS = 3


def replan_sync(world: World, trigger: dict) -> dict:
    """Plan from the current state and apply it if it is valid and current.

    Returns the World.apply_result outcome, or {"applied": False,
    "reason": "superseded"} if the state kept changing under the planner.
    """
    for _ in range(MAX_ATTEMPTS):
        snapshot = world.to_brain_snapshot(trigger)
        result = brain_plan(snapshot, policy=world.policy)
        outcome = world.apply_result(result, trigger, explain)
        if outcome.get("reason") != "stale":
            return outcome
    return {"applied": False, "reason": "superseded"}


def merge_triggers(triggers: list[dict]) -> dict | None:
    """Several triggers in one tick -> one re-plan (the planner sees all changes)."""
    if not triggers:
        return None
    first = dict(triggers[0])
    if len(triggers) > 1:
        first["also"] = [t["type"] for t in triggers[1:]]
    return first

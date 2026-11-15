"""Async engine: tick loop + one planning worker + WebSocket delivery.

- The tick loop advances the World every 0.2 s (sim minutes = real seconds x
  clock speed) and sends throttled poses/jobs/clock/metrics.
- Plan-producing work runs as Operations on a single worker, so only one plan
  is ever in flight. Diya's plan() runs in a thread (off the event loop).
  Sim time is held still while planning, so a fresh snapshot is never made
  stale by the clock; REST changes in the meantime still make it stale, and
  then it is recomputed (up to 3 times) or marked superseded.
- All World mutations happen on the event loop with no awaits inside them,
  which serializes state commits.
"""
from __future__ import annotations

import asyncio
import copy
import os
import time
from pathlib import Path
from typing import Awaitable, Callable

from app import models as m
from app.brain import explain

from .operations import Operations
from .planner import MAX_ATTEMPTS, edit_failure_reason, merge_triggers, run_planner
from .twin import lookup, run_twin, twin_key
from .runner import load_scenario
from .state import World, WorldError
from app.ws.hub import Hub

TICK_S = 0.2
CLOCK_EVERY_S = 1.0
METRICS_EVERY_S = 2.0
PROGRESS_EVERY_S = 1.0


class Engine:
    def __init__(self, scenario_path: Path | str, log_dir: Path | str):
        self.scenario = load_scenario(scenario_path)
        self.scenario["max_tractors"] = int(os.environ.get("HFA_MAX_TRACTORS", self.scenario.get("max_tractors", 8)))
        if os.environ.get("HFA_SCRIPTED", "1").lower() in {"0", "false", "no"}:
            self.scenario["events"] = []
        self.log_dir = Path(log_dir)
        self.hub = Hub()
        self.ops = Operations()
        self.epoch = 0
        self.busy = False
        self._twin: tuple[str, dict] | None = None        # (key it was computed for, samples)
        self._twin_task: asyncio.Task | None = None
        self.world = self._new_world("ours")
        self._queue: asyncio.Queue | None = None
        self._tasks: list[asyncio.Task] = []
        self._last_poses: dict[str, tuple] = {}

    def _new_world(self, mode: str) -> World:
        base = self.world.state_version + 1 if hasattr(self, "world") else 0
        w = World(copy.deepcopy(self.scenario), mode, self.log_dir / f"event_log_{mode}.jsonl", version_base=base)
        w.counterpart = self._baseline_at
        return w

    # ================================================================ baseline twin (core/twin.py)

    def _twin_key(self) -> str:
        return twin_key(self.scenario.get("name", ""), self.world.injected)

    def _baseline_at(self, t: float) -> m.RunMetrics | None:
        """The matching baseline at farm time t, or None if it isn't ready."""
        if self._twin and self._twin[0] == self._twin_key():
            return lookup(self._twin[1], t)
        return None

    def baseline_status(self) -> str:
        return "ready" if self._twin and self._twin[0] == self._twin_key() else "computing"

    def _refresh_twin(self) -> None:
        """Start computing the twin for the current operator actions, if needed."""
        key = self._twin_key()
        if (self._twin and self._twin[0] == key) or (self._twin_task and not self._twin_task.done()):
            return
        injected = copy.deepcopy(self.world.injected)

        async def compute():
            samples = await asyncio.to_thread(run_twin, self.scenario, injected, "baseline")
            self._twin = (key, samples)
        self._twin_task = asyncio.create_task(compute())

    # ================================================================ lifecycle

    async def start(self, autorun: bool = False) -> None:
        self._queue = asyncio.Queue()
        self._tasks = [asyncio.create_task(self._tick_loop()), asyncio.create_task(self._worker())]
        if autorun:
            self.run("ours", play=False)     # cold start: day planned, paused until Play

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    # ================================================================ delivery

    def flush(self) -> None:
        for type_, data in self.world.drain():
            self.hub.broadcast(type_, self.world.t, data)

    def snapshot(self) -> dict:
        w = self.world
        snap = m.Snapshot(
            clock=w.clock_view(), scenario=w.scenario_view(), fleet=w.fleet_view(), jobs=w.jobs_view(),
            plan=w.plan, explanations=w.explanations[:10], metrics=w.metrics_view(),
            weather=w.weather_view(), pending=[], capacity=w.capacity_view(),
            log_tail=list(reversed(w.log[-20:])), operations=self.ops.listing(),
        )
        return m.dump(snap)

    def _op(self, op_id: str, **changes) -> m.Operation:
        op = self.ops.update(op_id, self.world.t, **changes)
        self.hub.broadcast("operation", self.world.t, m.dump(op))
        return op

    # ================================================================ operations

    def submit(self, kind: str, source: str, message: str,
               action: Callable[[str], Awaitable[None]]) -> m.Operation:
        op = self.ops.create(kind, source, self.world.t, message)
        self.hub.broadcast("operation", self.world.t, m.dump(op))
        self._queue.put_nowait((self.epoch, op.id, action))
        return op

    def submit_replan(self, source: str, message: str, trigger: dict, kind: str = "replan",
                      on_success: Callable[[], None] | None = None) -> m.Operation:
        return self.submit(kind, source, message, lambda op_id: self._replan(op_id, trigger, on_success))

    async def _worker(self) -> None:
        while True:
            epoch, op_id, action = await self._queue.get()
            if epoch != self.epoch:
                continue                       # reset already marked it superseded
            self.busy = True
            try:
                await action(op_id)
            except Exception as e:             # never leave an operation hanging
                if self.ops.get(op_id).status in {"queued", "running"}:
                    self._op(op_id, status="failed", message="Internal error while planning.",
                             error=m.OperationError(code="INTERNAL", message=str(e)))
            finally:
                self.busy = False

    async def _replan(self, op_id: str, trigger: dict, on_success: Callable[[], None] | None) -> None:
        self._op(op_id, status="running")
        world = self.world
        # Operator edits are staged for this plan only (state.py: stage_edits).
        undos = world.stage_edits(trigger.get("edits", []))
        if trigger.get("edits") and not undos:
            self.flush()
            self._op(op_id, status="failed", message="The change no longer applies; nothing was changed.",
                     error=m.OperationError(code="CONFLICT", message=world.log[-1].get("reason", "Edit rejected.")))
            return
        outcome: dict = {"applied": False, "reason": "superseded"}
        for _ in range(MAX_ATTEMPTS):
            epoch = self.epoch
            snap = world.to_brain_snapshot(trigger)
            result = await asyncio.to_thread(run_planner, snap, world.policy)
            if epoch != self.epoch:
                return                          # reset happened; already superseded
            outcome = world.apply_result(result, trigger, explain)
            if outcome.get("reason") != "stale":
                break
        world.finish_edits(undos, outcome["applied"], edit_failure_reason(outcome))
        if outcome["applied"]:
            if on_success:
                on_success()
            self.flush()                        # plan, explanation, jobs, (edit log + job), fleet, metrics
            self._op(op_id, status="succeeded", plan_version=outcome["plan_version"],
                     solver_status=outcome["solver_status"], message="New plan applied.",
                     result=m.PlanOperationResult(applied_plan_version=outcome["plan_version"],
                                                  unassigned_job_ids=outcome["unassigned"]))
        elif outcome.get("reason") == "superseded":
            self.flush()
            self._op(op_id, status="superseded", message="State kept changing while planning; a newer re-plan will follow.")
        else:
            self.flush()                        # safety_reject (+ edit_rejected) log lines
            detail = "; ".join(v.get("detail", "") for v in outcome.get("violations", [])) or "No valid plan."
            msg = ("No valid plan accepts this change; it was not applied and the previous plan stays in place."
                   if undos else "No valid plan could be applied; the previous plan stays in place.")
            self._op(op_id, status="failed", solver_status="no_feasible_plan", message=msg,
                     error=m.OperationError(code="SAFETY_REJECTED", message=detail,
                                            details={"violations": outcome.get("violations", [])}))

    # ================================================================ actions used by the API

    def run(self, mode: str, play: bool = True) -> m.Operation:
        """Reset the day and plan it. `play=False` leaves the clock paused (cold start)."""
        if mode != "ours":
            raise WorldError(400, "INVALID_INPUT", "The live server runs mode 'ours'. The FCFS baseline is "
                             "computed automatically on the same day and events (metrics.baseline); "
                             "for logs use: python -m app.core.runner --mode both.")
        new = self._new_world(mode)
        self.epoch += 1
        for op in self.ops.active():
            self._op(op.id, status="superseded", message="Replaced by a new run.")
        self.world = new
        self._last_poses = {}
        self.hub.broadcast("snapshot", new.t, self.snapshot())

        def go():
            self.world.playing = play
        return self.submit_replan("run", "Planning the day.", {"type": "run"}, kind="run", on_success=go)

    def set_clock(self, playing: bool | None, speed: float | None) -> dict:
        w = self.world
        if speed is not None:
            w.speed = speed
        if playing is not None:
            if playing and w.ended:
                raise WorldError(409, "CONFLICT", "The day has ended. Start a new run.")
            if playing and w.plan.version == 0:
                raise WorldError(409, "CONFLICT", "Start a run first (POST /api/run).")
            w.playing = playing
        clock = w.clock_view()
        self.hub.broadcast("clock", w.t, clock)
        return clock

    def after_mutation(self) -> None:
        self.flush()

    # ================================================================ tick loop

    async def _tick_loop(self) -> None:
        last = time.monotonic()
        last_clock = last_metrics = last_progress = last
        while True:
            await asyncio.sleep(TICK_S)
            now = time.monotonic()
            real, last = now - last, now
            w = self.world
            if w.playing and not w.ended and not self.busy and self._queue.empty():
                trigger = merge_triggers(w.step(real * w.speed))
                self.flush()                    # breakdown status goes out before the re-plan op
                if trigger:
                    self.submit_replan("events", self._trigger_message(trigger), trigger)
                if w.ended:
                    self.hub.broadcast("clock", w.t, w.clock_view())
            self._refresh_twin()                # baseline for the current operator actions
            if now - last_progress >= PROGRESS_EVERY_S and not self.busy:
                w.emit_progress()
                last_progress = now
            self.flush()
            self._send_poses()
            if now - last_clock >= CLOCK_EVERY_S:
                self.hub.broadcast("clock", w.t, w.clock_view())
                last_clock = now
            if now - last_metrics >= METRICS_EVERY_S and not self.busy:   # 13.3: nothing between running and plan
                self.hub.broadcast("metrics", w.t, w.metrics_view())
                last_metrics = now

    def _send_poses(self) -> None:
        changed = []
        for p in self.world.poses_view():
            key = (p["status"], p["pose"]["x"], p["pose"]["y"], p["pose"]["heading_deg"],
                   round(p["fuel_pct"], 1), p["current_job"])
            if self._last_poses.get(p["id"]) != key:
                self._last_poses[p["id"]] = key
                changed.append(p)
        if changed:
            self.hub.broadcast("poses", self.world.t, {"tractors": changed})

    @staticmethod
    def _trigger_message(trigger: dict) -> str:
        kind = trigger["type"]
        if kind == "breakdown":
            return f"{trigger.get('tractor')} broke down. Replanning unfinished work."
        if kind == "tractor_idle":
            return f"{trigger.get('tractor')} is free. Looking for work it can take."
        if kind == "halted":
            return f"{trigger.get('tractor')} hit a blocked road. Replanning."
        return f"{kind.replace('_', ' ').capitalize()}. Replanning."

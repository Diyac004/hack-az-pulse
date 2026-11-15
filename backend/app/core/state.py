"""World: the authoritative state store (ARCHITECTURE.md section 8, rule 1).

Owns positions (via the gateway), fuel, assignments, work-unit progress, the
applied plan, explanations, the event log and metrics. Everything the API and
WebSocket send is built from here, so they never disagree.

Synchronous on purpose: the async engine and the headless runner both drive
it, and every mutation is atomic (no awaits inside). Outgoing WebSocket
messages are queued in `outbox` in contract order and drained by the caller.

Planner integration (Diya's brain, v1 limits documented in backend/README.md):
- A tractor driving to its next job is snapshotted as already at that field's
  entrance, with its job frozen from the arrival time and the remaining
  travel fuel already deducted. The brain doesn't model ongoing travel yet;
  this keeps it valid without teleporting anything in the real world.
- A tractor finishing a cell with no job (e.g. just repaired mid-road) is
  marked unavailable until it reaches the cell; its Idle report re-plans.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.brain.contracts import FarmMap
from app.gateway.base import (
    Arrived, GatewayError, Halted, Idle, Idled, Moved, Stopped, TractorSpec, Travel, WorkDone,
    Worked, orders_from_plan,
)
from app.gateway.mock import MockGateway
from app import models as m

EPS = 1e-6
COLORS = ["#0A84FF", "#BF5AF2", "#FF9F0A", "#30D158", "#FF375F", "#5E5CE6", "#64D2FF", "#FFD60A"]
VERB = {"spray": "Spray", "mow": "Mow", "hedge": "Hedge", "haul_bins": "Haul bins"}
REQUIRED = {"spray": "sprayer", "mow": "mower", "hedge": "hedger", "haul_bins": "bin_trailer"}
POLICY = {"ours": "multi", "baseline": "fcfs"}
PUBLIC_SCENARIO_KEYS = ["name", "grid", "depot", "roads", "blocks", "blocked_cells",
                        "sensitive", "basemap", "geo"]


class WorldError(Exception):
    """Rejected request. `code` uses the ARCHITECTURE.md error codes."""

    def __init__(self, status: int, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details or {}


@dataclass
class JobRec:
    id: str
    type: str
    implement: str
    block: str
    priority: int
    deadline_t: float
    original_deadline_t: float
    units: list[list[float]]                 # [[minutes, done_min], ...]
    pinned_to: str | None = None
    status: str = "pending"
    tractor: str | None = None
    start_t: float | None = None             # planned (or actual once started)
    end_t: float | None = None
    started_t: float | None = None
    done_t: float | None = None
    unassigned_reason: str | None = None
    done_priority: int | None = None         # priority frozen at completion (13.4)

    @property
    def duration(self) -> float:
        return sum(u[0] for u in self.units)

    @property
    def remaining(self) -> float:
        return sum(u[0] - u[1] for u in self.units)

    @property
    def progress(self) -> float:
        return 1 - self.remaining / self.duration if self.duration else 1.0

    def add_work(self, minutes: float) -> float:
        """Fill rows in order. Returns minutes that didn't fit (should be 0)."""
        left = minutes
        for u in self.units:
            room = u[0] - u[1]
            if room > EPS and left > EPS:
                take = min(room, left)
                u[1] += take
                left -= take
        return left


@dataclass
class TractorRec:
    id: str
    name: str
    color: str
    implements: list[str]
    speed: float
    fuel: float
    burn_travel: float
    burn_work: float
    status: str = "idle"
    issue: str | None = None
    reserve_warned: bool = False


@dataclass
class Counters:
    travel_min: float = 0.0
    idle_min: float = 0.0
    productive_min: float = 0.0
    violations: int = 0
    replan_ms_last: float | None = None


class World:
    def __init__(self, scenario: dict, mode: str = "ours", log_path: Path | None = None,
                 version_base: int = 0):
        if mode not in POLICY:
            raise WorldError(400, "INVALID_INPUT", f"Run mode '{mode}' is not supported yet. Use 'ours' or 'baseline'.")
        self.scenario = scenario
        self.mode = mode
        self.policy = POLICY[mode]
        self.day_minutes = float(scenario.get("day_minutes", 720))
        self.unit_min = float(scenario.get("work_unit_min", 20))
        self.t = 0.0
        self.playing = False
        self.speed = 1.0
        self.ended = False
        self.state_version = version_base
        self.map_version = 0
        self.blocked: set[tuple[int, int]] = {tuple(c) for c in scenario.get("blocked_cells", [])}
        self.entrances = {b: [tuple(c) for c in cells] for b, cells in scenario["entrances"].items()}
        self.blocks = {b["id"] for b in scenario["blocks"]}
        self.counters = Counters()
        self.outbox: list[tuple[str, Any]] = []
        self.explanations: list[dict] = []
        self.log: list[dict] = []
        self.log_path = log_path
        if log_path:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_path.write_text("")
        self._n_expl = 0
        self._n_job = 0
        self._n_tractor = 0
        self._color_i = 0
        self.plan = m.Plan(version=0, entries=[], solver="greedy", solve_ms=0, solver_status="feasible")
        self.events = sorted(scenario.get("events", []), key=lambda e: e["t"])
        self._dirty_jobs: set[str] = set()       # status/assignment changes: sent at once
        self._progress_jobs: set[str] = set()    # progress only: sent by emit_progress (~1 Hz)
        self._zero_cut_at: float | None = None
        self.injected: list[dict] = []                     # operator actions with farm time (for the twin)
        # Set by the engine: farm time -> the matching baseline's metrics at that
        # time, or None when no matching baseline is ready (see core/twin.py).
        self.counterpart = None

        self.gateway = MockGateway(self.farm(), t0=0.0)
        self.tractors: dict[str, TractorRec] = {}
        self.jobs: dict[str, JobRec] = {}
        for spec in scenario["tractors"]:
            self._add_tractor(spec["id"], spec.get("name"), spec["implements"], spec["speed"],
                              spec["fuel_pct"], spec["fuel_burn_pct_per_min"],
                              (spec["start"]["x"], spec["start"]["y"]), announce=False)
        for j in scenario["jobs"]:
            self._add_job(j, announce=False)

    # ================================================================ helpers

    def farm(self) -> FarmMap:
        s = self.scenario
        return FarmMap(grid=s["grid"], roads=s["roads"], blocked_cells=sorted(self.blocked),
                       depot=s["depot"], entrances=self.entrances, cell_m=s["geo"]["cell_m"])

    def bump(self) -> None:
        self.state_version += 1

    def emit(self, type_: str, data: Any) -> None:
        self.outbox.append((type_, data))

    def drain(self) -> list[tuple[str, Any]]:
        out, self.outbox = self.outbox, []
        return out

    def write_log(self, kind: str, at: float | None = None, **fields) -> dict:
        entry = {"t": round(self.t if at is None else at, 3), "kind": kind, **fields}
        self.log.append(entry)
        if self.log_path:
            with self.log_path.open("a") as f:
                f.write(json.dumps(entry) + "\n")
        self.emit("log", entry)
        return entry

    def _get_tractor(self, tid: str) -> TractorRec:
        if tid not in self.tractors:
            raise WorldError(404, "NOT_FOUND", f"There is no tractor called {tid}.")
        return self.tractors[tid]

    def _get_job(self, jid: str) -> JobRec:
        if jid not in self.jobs:
            raise WorldError(404, "NOT_FOUND", f"There is no job called {jid}.")
        return self.jobs[jid]

    def _operational(self, tr: TractorRec) -> bool:
        return tr.status not in {"broken", "removing", "offline"}

    def _unfinished_compatible(self, tr: TractorRec) -> bool:
        return any(j.status not in {"done", "dropped"} and j.implement in tr.implements
                   and (not j.pinned_to or j.pinned_to == tr.id) for j in self.jobs.values())

    # ================================================================ fleet and jobs

    def _add_tractor(self, tid, name, implements, speed, fuel, burn, cell, announce=True) -> TractorRec:
        if tid in self.tractors:
            raise WorldError(409, "CONFLICT", f"Tractor {tid} already exists.")
        try:
            self.gateway.add_tractor(TractorSpec(tid, tuple(cell), speed))
        except GatewayError as e:
            raise WorldError(400, "INVALID_INPUT", str(e)) from None
        tr = TractorRec(tid, name or f"Tractor {tid.lstrip('T')}", COLORS[self._color_i % len(COLORS)],
                        list(implements), speed, float(fuel), burn["travel"], burn["work"])
        self._color_i += 1
        self.tractors[tid] = tr
        if announce:
            self.bump()
            self.write_log("tractor_added", tractor=tid, host="mock", endpoint=None)
            self.write_log("tractor_ready", tractor=tid)
            self.emit("fleet", {"tractors": self.fleet_view()})
        return tr

    def add_tractor(self, entry: m.FleetEntry) -> dict:
        tid = entry.id or self._next_tractor_id()
        start = (entry.start.x, entry.start.y) if entry.start else (self.scenario["depot"]["x"], self.scenario["depot"]["y"])
        burn = self.scenario["tractors"][0]["fuel_burn_pct_per_min"] if self.scenario["tractors"] else {"travel": 0.05, "work": 0.1}
        tr = self._add_tractor(tid, entry.name, entry.implements, entry.speed, entry.fuel_pct, burn, start)
        return self.tractor_view(tr)

    def _next_tractor_id(self) -> str:
        n = 1
        while f"T{n}" in self.tractors:
            n += 1
        return f"T{n}"

    def remove_tractor(self, tid: str) -> None:
        tr = self._get_tractor(tid)
        self._release_work(tid, "tractor_removed")
        self.gateway.remove_tractor(tid)
        del self.tractors[tid]
        self.bump()
        self.write_log("tractor_removed", tractor=tid)
        self.emit("fleet", {"tractors": self.fleet_view()})
        self._emit_dirty_jobs()

    def _add_job(self, j: dict, announce=True) -> JobRec:
        jid = j.get("id") or self._next_job_id()
        if jid in self.jobs:
            raise WorldError(409, "CONFLICT", f"Job {jid} already exists.")
        if j["block"] not in self.blocks:
            raise WorldError(400, "INVALID_INPUT", f"There is no block {j['block']} on this farm.")
        if REQUIRED[j["type"]] != j["implement"]:
            raise WorldError(400, "INVALID_INPUT",
                             f"A {j['type']} job needs a {REQUIRED[j['type']]}, not a {j['implement']}.")
        n_units = max(1, math.ceil(j["duration_min"] / self.unit_min - EPS))
        size = j["duration_min"] / n_units
        rec = JobRec(jid, j["type"], j["implement"], j["block"], j["priority"], j["deadline_t"],
                     j["deadline_t"], [[size, 0.0] for _ in range(n_units)])
        self.jobs[jid] = rec
        if announce:
            self._dirty_jobs.add(jid)
        return rec

    def _next_job_id(self) -> str:
        n = len(self.jobs) + 1
        while f"J{n}" in self.jobs:
            n += 1
        return f"J{n}"

    def add_jobs(self, jobs: list[m.JobInput]) -> list[str]:
        ids = {j.id for j in jobs if j.id}
        if len(ids) != len([j for j in jobs if j.id]):
            raise WorldError(400, "INVALID_INPUT", "The same job ID appears twice.")
        for j in jobs:                                   # validate all before adding any
            if j.id and j.id in self.jobs:
                raise WorldError(409, "CONFLICT", f"Job {j.id} already exists.")
            if j.block not in self.blocks:
                raise WorldError(400, "INVALID_INPUT", f"There is no block {j.block} on this farm.")
            if REQUIRED[j.type] != j.implement:
                raise WorldError(400, "INVALID_INPUT", f"A {j.type} job needs a {REQUIRED[j.type]}, not a {j.implement}.")
        added = [self._add_job(j.model_dump()).id for j in jobs]
        self.bump()
        self.write_log("event", type="jobs_submitted", jobs=added)
        self._emit_dirty_jobs()
        return added

    # ---------------------------------------------------------------- operator edits (staged)
    #
    # A job edit (PATCH /jobs, priority_change) is not authoritative until a valid
    # plan accepts it: stage_edits() applies it for the planner only (no log, no
    # broadcast), finish_edits() then commits it, or restores the previous values
    # if no valid plan could be applied. A failed edit leaves no trace in state.

    def check_patch(self, jid: str, patch: m.JobPatch) -> None:
        """Cheap checks done before accepting the request (section 13.2)."""
        job = self._get_job(jid)
        if job.status in {"done", "dropped"}:
            raise WorldError(409, "CONFLICT", f"{jid} is already {job.status}.")
        if not patch.model_dump(exclude_none=True):
            raise WorldError(400, "INVALID_INPUT", "Nothing to change: send priority, deadline_t or pinned_to.")
        if patch.pinned_to is not None:
            tr = self._get_tractor(patch.pinned_to)
            if job.implement not in tr.implements:
                raise WorldError(422, "SAFETY_REJECTED",
                                 f"Can't pin {self.label(job)} to {tr.name}: it has no {job.implement}.",
                                 {"rule": "implement_match"})

    def stage_edits(self, edits: list[dict]) -> list[dict]:
        """Apply edits for planning. Each edit: {job, patch, log_type, reason}.
        Returns undo records. An edit that is no longer valid is skipped and logged."""
        undos = []
        for e in edits:
            patch = m.JobPatch(**e["patch"])
            try:
                self.check_patch(e["job"], patch)
            except WorldError as err:
                self.write_log("event", type="edit_rejected", job=e["job"], changes=e["patch"], reason=err.message)
                continue
            job = self.jobs[e["job"]]
            changes = patch.model_dump(exclude_none=True)
            undos.append({**e, "changes": changes, "old": {k: getattr(job, k) for k in changes}})
            for k, v in changes.items():
                setattr(job, k, v)
        if undos:
            self.bump()
        return undos

    def finish_edits(self, undos: list[dict], applied: bool, why: str = "") -> None:
        """Commit staged edits after a valid plan was applied, or restore them."""
        for u in undos:
            job = self.jobs.get(u["job"])
            if job is None:
                continue
            if applied:
                self.write_log("event", type=u.get("log_type", "job_patch"), job=u["job"], changes=u["changes"],
                               original_deadline_t=job.original_deadline_t, reason=u.get("reason"))
                if not u.get("replayed"):                       # scenario/twin edits are already scripted
                    self.record_injected({"type": "job_patch", "job": u["job"], "patch": u["changes"],
                                          "log_type": u.get("log_type", "job_patch"), "reason": u.get("reason")})
                self._dirty_jobs.add(u["job"])
            else:
                for k, v in u["old"].items():
                    if getattr(job, k) == u["changes"][k]:       # untouched since staging
                        setattr(job, k, v)
                self.write_log("event", type="edit_rejected", job=u["job"], changes=u["changes"],
                               reason=why or "No valid plan accepts this change; previous values kept.")
        if undos:
            self.bump()
            self._emit_dirty_jobs()

    # ================================================================ events (immediate part)

    def breakdown(self, tid: str, issue: str | None) -> None:
        """Stop first (section 13.2), before any planning."""
        tr = self._get_tractor(tid)
        if tr.status == "broken":
            raise WorldError(409, "CONFLICT", f"{tr.name} is already broken down.")
        self.gateway.stop(tid)
        tr.status, tr.issue = "broken", issue
        self._release_work(tid, "breakdown")
        self.bump()
        self.write_log("event", type="breakdown", tractor=tid, issue=issue)
        self.emit("fleet", {"tractors": self.fleet_view()})
        self._emit_dirty_jobs()

    def repaired(self, tid: str) -> None:
        tr = self._get_tractor(tid)
        if tr.status != "broken":
            raise WorldError(409, "CONFLICT", f"{tr.name} is not broken.")
        self.gateway.resume(tid)
        tr.status, tr.issue = "idle", None
        self.bump()
        self.write_log("tractor_repaired", tractor=tid)
        self.emit("fleet", {"tractors": self.fleet_view()})

    def block_route(self, cells: list[tuple[int, int]] | None, unblock=False) -> list[tuple[int, int]]:
        if not cells:
            if unblock:
                raise WorldError(400, "INVALID_INPUT", "Say which cells to unblock.")
            cells = self._pick_block_cells()
        roads = {(x, y) for x in range(self.scenario["grid"]["width"]) for y in range(self.scenario["grid"]["height"])
                 if y in self.scenario["roads"]["rows"] or x in self.scenario["roads"]["cols"]}
        bad = [c for c in cells if tuple(c) not in roads]
        if bad:
            raise WorldError(400, "INVALID_INPUT", f"These cells are not roads: {bad}.")
        if not unblock:
            occupied = {self.gateway.pose(t).cell for t in self.tractors} | {self.gateway.pose(t).anchor for t in self.tractors}
            entr = {c for cs in self.entrances.values() for c in cs}
            clash = [c for c in cells if tuple(c) in occupied | entr | {(self.scenario['depot']['x'], self.scenario['depot']['y'])}]
            if clash:
                raise WorldError(409, "CONFLICT", f"Can't block {clash}: a tractor, field entrance or the depot is there.")
        for c in cells:
            (self.blocked.discard if unblock else self.blocked.add)(tuple(c))
        self.map_version += 1
        self.gateway.update_map(self.farm())
        if not unblock:
            self._stop_short_of_blocks()
        self.bump()
        self.write_log("event", type="unblock_route" if unblock else "block_route", cells=[list(c) for c in cells])
        return [tuple(c) for c in cells]

    def _stop_short_of_blocks(self) -> None:
        """A tractor whose current drive crosses a newly blocked cell drives to the
        last open cell and stops; its job goes back to the planner."""
        for tid in self.tractors:
            route = self.gateway.remaining_route(tid)
            hit = next((i for i, c in enumerate(route) if i > 0 and c in self.blocked), None)
            if hit is None:
                continue
            self.gateway.assign(tid, [Travel(tuple(route[:hit]))])
            self._release_work(tid, "road_blocked")
            self.write_log("event", type="reroute_needed", tractor=tid, stop_at=list(route[hit - 1]))

    def _pick_block_cells(self) -> list[tuple[int, int]]:
        """No cells given: block a cell ahead on some tractor's route (demo reroute)."""
        entr = {c for cs in self.entrances.values() for c in cs}
        for tid in self.tractors:
            route = self.gateway.remaining_route(tid)
            for c in route[2:-1]:
                if c not in entr:
                    return [c]
        raise WorldError(409, "CONFLICT", "No tractor is driving right now, so there's no route to block. Pass cells explicitly.")

    def record_injected(self, ev: dict) -> None:
        """An operator action accepted by the API, kept with its farm time so the
        baseline twin can replay exactly the same day (see core/twin.py)."""
        self.injected.append({"t": self.t, **ev})

    def _release_work(self, tid: str, why: str) -> None:
        """Jobs owned by a tractor that stops: keep progress, drop the owner."""
        for j in self.jobs.values():
            if j.tractor == tid and j.status not in {"done", "dropped"}:
                j.tractor = None
                j.status = "paused" if j.progress > EPS else "pending"
                j.start_t = j.end_t = None
                j.unassigned_reason = f"Waiting for re-plan ({why.replace('_', ' ')})."
                self._dirty_jobs.add(j.id)

    # ================================================================ time

    def next_event_t(self) -> float | None:
        return self.events[0]["t"] if self.events else None

    def step(self, dt: float) -> list[dict]:
        """Advance sim time by up to dt. Stops early, at the exact time, at a
        scheduled event, the end of the day, or the moment a tractor needs a
        re-plan (idle with work waiting, or a blocked road). So results don't
        depend on the tick size. Returns re-plan triggers for the caller."""
        if self.ended or dt <= 0:
            return []
        target = min(self.t + dt, self.day_minutes)
        nxt = self.next_event_t()
        if nxt is not None and nxt <= target:
            target = max(nxt, self.t)
        decision = self._next_decision_t(target - self.t)
        if decision is not None and decision <= self.t + EPS:
            if self._zero_cut_at == self.t:      # already handled this instant: don't spin
                decision = None
            self._zero_cut_at = self.t
        if decision is not None:
            target = decision
        triggers = self._apply_reports(self.gateway.advance(target - self.t), target - self.t)
        self.t = target
        self.bump()
        while self.events and self.events[0]["t"] <= self.t + EPS:
            triggers.append(self.apply_scheduled(self.events.pop(0)))
        if self.t >= self.day_minutes - EPS:
            self.ended, self.playing = True, False
            self.write_log("event", type="day_end")
            self.emit("metrics", self.metrics_view())
        self._emit_dirty_jobs()
        return [t for t in triggers if t]

    def apply_scheduled(self, ev: dict) -> dict | None:
        """Scenario events, and operator actions replayed by the baseline twin."""
        kind = ev["type"]
        try:
            if kind == "breakdown":
                self.breakdown(ev["tractor"], ev.get("issue"))
            elif kind == "tractor_repaired":
                self.repaired(ev["tractor"])
            elif kind in {"block_route", "unblock_route"}:
                self.block_route(ev.get("cells"), unblock=kind == "unblock_route")
            elif kind in {"priority_change", "job_patch"}:
                patch = ev.get("patch") or {"priority": ev.get("priority"), "deadline_t": ev.get("deadline_t")}
                patch = {k: v for k, v in patch.items() if v is not None}
                return {"type": kind, "job": ev["job"], "scheduled": True,
                        "edits": [{"job": ev["job"], "patch": patch, "reason": ev.get("reason"),
                                   "log_type": ev.get("log_type", kind), "replayed": True}]}
            elif kind == "jobs_submitted":
                self.add_jobs([m.JobInput(**j) for j in ev["jobs"]])
            elif kind == "tractor_added":
                self.add_tractor(m.FleetEntry(**ev["entry"]))
            elif kind == "tractor_removed":
                self.remove_tractor(ev["tractor"])
            else:
                self.write_log("event", type=kind, skipped="not supported in this build")
                return None
        except WorldError as e:
            self.write_log("event", type=kind, skipped=e.message)
            return None
        return {"type": kind, **{k: v for k, v in ev.items() if k not in {"t", "type"}}, "scheduled": True}

    def _wants_work(self, tr: TractorRec) -> bool:
        """Operational, and a compatible job is waiting for an owner."""
        return self._operational(tr) and any(
            j.status in {"pending", "paused"} and j.implement in tr.implements
            and (not j.pinned_to or j.pinned_to == tr.id) for j in self.jobs.values())

    def _next_decision_t(self, dt: float) -> float | None:
        """Earliest time within dt at which a tractor will need a re-plan."""
        for r in self.gateway.preview(dt):
            tr = self.tractors.get(r.tractor)
            if tr is None:
                continue
            if isinstance(r, Halted) or (isinstance(r, Idle) and self._wants_work(tr)):
                return r.t
        return None

    def _idle_minutes(self, tr: TractorRec, a: float, b: float, unfinished0: set[str],
                      done_at: dict[str, float]) -> float:
        """Part of [a, b] during which a compatible job was still unfinished.
        A job finished inside this step stops counting at its exact finish time."""
        ends = [done_at.get(j, math.inf) for j in unfinished0
                if self.jobs[j].implement in tr.implements
                and (not self.jobs[j].pinned_to or self.jobs[j].pinned_to == tr.id)]
        if not ends:
            return 0.0
        return max(0.0, min(b, max(ends)) - a)

    def _apply_reports(self, reports, dt: float) -> list[dict]:
        triggers = []
        unfinished0 = {j.id for j in self.jobs.values() if j.status not in {"done", "dropped"}}
        done_at: dict[str, float] = {}
        idled = []
        # Moved/Worked are per-tick totals stamped at the tick's end, while events
        # carry their exact time: apply the minutes first, then the events.
        reports = sorted(reports, key=lambda r: 0 if isinstance(r, (Moved, Worked)) else 1)
        for r in reports:
            tr = self.tractors.get(r.tractor)
            if tr is None:
                continue
            if isinstance(r, Moved):
                tr.fuel -= r.minutes * tr.burn_travel
                self.counters.travel_min += r.minutes
            elif isinstance(r, Idled):
                idled.append((tr, r.start, r.end))
            elif isinstance(r, Worked):
                job = self.jobs.get(r.job)
                if job is None:
                    continue
                if job.status == "done":
                    self._violation("completed_work", tr.id, job.id, "Work reported on a finished job")
                    continue
                if job.started_t is None:
                    job.started_t = r.t - r.minutes
                    self.write_log("job_started", at=job.started_t, job=job.id, tractor=tr.id, block=job.block)
                overflow = job.add_work(r.minutes)
                if overflow > EPS:
                    self._violation("duplicate_work", tr.id, job.id, f"{overflow:.2f} min beyond the job's rows")
                done = r.minutes - overflow
                tr.fuel -= done * tr.burn_work
                self.counters.productive_min += done
                self._progress_jobs.add(job.id)          # throttled: see emit_progress()
            elif isinstance(r, WorkDone):
                job = self.jobs.get(r.job)
                if job and job.status != "done" and job.remaining <= EPS:
                    job.status, job.done_t, job.end_t, job.done_priority = "done", r.t, r.t, job.priority
                    done_at[job.id] = r.t
                    on_time = r.t <= job.deadline_t + EPS
                    self.write_log("job_done", at=r.t, job=job.id, tractor=tr.id, on_time=on_time)
                    self._dirty_jobs.add(job.id)
                    self.emit("metrics", self.metrics_view())
            elif isinstance(r, Halted):
                self.write_log("event", at=r.t, type="halted", tractor=tr.id, cell=list(r.cell), reason=r.reason)
                self._release_work(tr.id, "road blocked")
                triggers.append({"type": "halted", "tractor": tr.id, "reason": r.reason})
            elif isinstance(r, Idle):
                if self._wants_work(tr):
                    triggers.append({"type": "tractor_idle", "tractor": tr.id})
            elif isinstance(r, (Arrived, Stopped)):
                pass
        for tr, a, b in idled:                      # Idled is only reported for operational tractors
            self.counters.idle_min += self._idle_minutes(tr, a, b, unfinished0, done_at)
        for tr in self.tractors.values():
            if tr.status != "broken":
                tr.status = self._public_status(tr.id)
            if self._operational(tr) and tr.fuel < self.scenario["constraints"]["fuel_reserve_pct"] - EPS and not tr.reserve_warned:
                tr.reserve_warned = True
                self._violation("fuel_reserve", tr.id, None, f"Fuel at {tr.fuel:.1f}%")
        self._refresh_job_statuses()
        return triggers

    def _violation(self, rule, tractor, job, detail):
        self.counters.violations += 1
        self.write_log("violation", rule=rule, tractor=tractor, detail={"job": job, "detail": detail})

    def _public_status(self, tid: str) -> str:
        st = self.gateway.pose(tid).status
        return {"waiting": "idle"}.get(st, st)

    def _refresh_job_statuses(self) -> None:
        for j in self.jobs.values():
            if j.status in {"done", "dropped"} or j.tractor is None:
                continue
            p = self.gateway.pose(j.tractor) if j.tractor in self.tractors else None
            new = "assigned"
            if p and p.job == j.id:
                new = {"traveling": "traveling", "working": "working"}.get(p.status, "assigned")
            if new != j.status:
                j.status = new
                self._dirty_jobs.add(j.id)

    def _emit_dirty_jobs(self) -> None:
        if self._dirty_jobs:
            self.emit("jobs", {"jobs": [self.job_view(self.jobs[j]) for j in sorted(self._dirty_jobs) if j in self.jobs]})
            self._progress_jobs -= self._dirty_jobs
            self._dirty_jobs.clear()

    def emit_progress(self) -> None:
        """Progress-only job updates; the engine calls this at most once a second."""
        self._dirty_jobs |= self._progress_jobs
        self._progress_jobs.clear()
        self._emit_dirty_jobs()

    # ================================================================ brain adapter: snapshot

    def _committed_trips(self) -> dict[str, tuple[tuple, str, float]]:
        """Tractors currently driving to a job: {id: (remaining route, job, arrival time)}.
        The route starts at the tractor's anchor (next whole cell)."""
        trips = {}
        for tid, tr in self.tractors.items():
            if tr.status == "broken":
                continue
            p = self.gateway.pose(tid)
            route = self.gateway.remaining_route(tid)
            if route and p.job in self.jobs:                 # what it is doing, not a status label
                trips[tid] = (route, p.job, p.anchor_t + (len(route) - 1) / tr.speed)
        return trips

    def to_brain_snapshot(self, trigger: dict) -> dict:
        tractors, frozen = [], []
        trips = self._committed_trips()
        for tr in self.tractors.values():
            p = self.gateway.pose(tr.id)
            x, y = p.cell
            fuel = tr.fuel
            status = tr.status if tr.status == "broken" else "idle"
            route = self.gateway.remaining_route(tr.id)
            if tr.status != "broken" and p.status == "working" and p.job:
                job = self.jobs[p.job]
                status = "working"
                frozen.append({"tractor": tr.id, "job": job.id, "kind": "work", "start_t": self.t,
                               "end_t": self.t + job.remaining, "remaining_route": None})
            elif tr.id in trips:
                # Committed trip: Brain v1 can't plan ongoing travel, so it sees the
                # tractor at the destination entrance with the job frozen from the
                # exact arrival time and the rest of the drive's fuel already spent.
                # (Planner input only: public positions stay the real ones.)
                trip_route, job_id, arrive = trips[tr.id]
                job = self.jobs[job_id]
                x, y = trip_route[-1]
                fuel -= (arrive - self.t) * tr.burn_travel
                status = "traveling"
                frozen.append({"tractor": tr.id, "job": job.id, "kind": "work", "start_t": arrive,
                               "end_t": arrive + job.remaining, "remaining_route": None})
            elif tr.status != "broken" and route:
                status = "unavailable"          # finishing a cell with no job; its Idle re-plans
                x, y = p.anchor
            tractors.append({
                "id": tr.id, "status": status, "manual": False, "implements": tr.implements,
                "speed_cells_per_min": tr.speed, "x": x, "y": y, "fuel_pct": max(0.0, min(100.0, fuel)),
                "fuel_burn_pct_per_min": {"travel": tr.burn_travel, "work": tr.burn_work},
                "available_from_t": None,
            })
        frozen_jobs = {f["job"] for f in frozen}
        jobs = []
        for j in self.jobs.values():
            if j.status == "dropped":
                continue
            jobs.append({
                "id": j.id, "type": j.type, "implement": j.implement, "block": j.block,
                "priority": j.priority, "deadline_t": j.deadline_t,
                "status": j.status if j.id in frozen_jobs or j.status == "done" else "pending",
                "pinned_to": j.pinned_to,
                "work_units": [{"unit": i + 1, "minutes": u[0], "done_min": min(u[1], u[0])}
                               for i, u in enumerate(j.units)],
            })
        prev = None
        if self.plan.version > 0:
            prev = {"version": self.plan.version,
                    "entries": [e.model_dump() | {"route": [[int(a), int(b)] for a, b in e.route]}
                                for e in self.plan.entries]}
        s = self.scenario
        return {
            "state_version": self.state_version, "map_version": self.map_version,
            "t": self.t, "horizon_t": self.day_minutes, "trigger": trigger,
            "map": {"grid": s["grid"], "roads": s["roads"], "blocked_cells": sorted(self.blocked),
                    "depot": s["depot"], "entrances": self.entrances, "cell_m": s["geo"]["cell_m"]},
            "tractors": tractors, "jobs": jobs, "frozen": frozen,
            "constraints": s["constraints"], "previous_plan": prev,
        }

    # ================================================================ brain adapter: apply

    def apply_result(self, result, trigger: dict, explain_fn) -> dict:
        """Apply a PlanningResult atomically, or refuse it.

        Returns {"applied": bool, "reason": ..., "plan_version", "unassigned"}.
        Refuses stale results (state changed since the snapshot) and anything
        that didn't pass Diya's validator. Nothing changes on refusal except
        the safety_reject log line.
        """
        if result.source_state_version != self.state_version:
            return {"applied": False, "reason": "stale"}

        def reject(status: str, violations: list[dict]) -> dict:
            self.write_log("safety_reject", trigger=trigger.get("type"), status=status, violations=violations)
            return {"applied": False, "reason": "rejected", "violations": violations}

        if not result.validation.passed or result.status != "feasible":
            return reject(result.status, [v.model_dump() for v in result.validation.violations])

        # The brain's entries, plus the committed rest of any trip in progress
        # (the brain froze that tractor's job from its arrival; the public
        # timeline still shows the drive). Execution orders are built from these
        # same entries, so what is displayed is what runs.
        entries = [e.model_dump() for e in result.plan.entries]
        for tid, (route, job, arrive) in self._committed_trips().items():
            frozen = [e for e in entries if e["tractor"] == tid and e["kind"] == "work" and e["job"] == job]
            if not frozen or abs(frozen[0]["start_t"] - arrive) > EPS:
                return reject("invalid_result", [{"rule": "committed_trip", "detail":
                              f"{tid} is driving to {job} (arrives at {arrive:.2f}); the plan must keep that work from its arrival"}])
            if any(e["tractor"] == tid and e["start_t"] < arrive - EPS for e in entries):
                return reject("invalid_result", [{"rule": "committed_trip", "detail":
                              f"{tid} has plan entries before it arrives at {arrive:.2f}"}])
            entries.append({"tractor": tid, "job": job, "kind": "travel", "start_t": self.t,
                            "end_t": arrive, "route": [list(c) for c in route]})
        entries.sort(key=lambda e: (e["start_t"], e["tractor"], e["kind"]))

        # Public Plan, built (and enum-checked) before anything changes.
        diff = result.plan.diff or {}
        kept = {mv["job"]: mv.get("progress_kept") for mv in result.facts.get("moved", [])}
        try:
            if result.plan.solver_status == "no_feasible_plan":
                raise ValueError("no_feasible_plan is an operation outcome, never an applied plan (13.1)")
            new_plan = m.Plan(
                version=self.plan.version + 1, entries=entries, solver=result.plan.solver,
                solve_ms=int(round(result.plan.solve_ms)), solver_status=result.plan.solver_status,
                diff=m.PlanDiff(moved=[m.MovedJob(**{"progress_kept": kept.get(mv.get("job")), **mv})
                                       for mv in diff.get("moved", [])],
                                retimed=diff.get("retimed", []), dropped=diff.get("dropped", []),
                                added=diff.get("added", [])))
        except (ValueError, TypeError) as e:      # pydantic ValidationError is a ValueError
            return reject("invalid_result", [{"rule": "public_contract", "detail": str(e).splitlines()[0]}])

        # Every tractor's orders, checked before any are given (all or nothing).
        orders = {}
        for tid, tr in self.tractors.items():
            if tr.status == "broken":
                continue
            if self.gateway.remaining_route(tid) and self.gateway.pose(tid).job is None:
                continue                                    # finishing a cell with no job: leave it be
            orders[tid] = orders_from_plan(entries, tid)
        try:
            for tid, o in orders.items():
                self.gateway.check(tid, o)
        except GatewayError as e:
            return reject("gateway_refused", [{"rule": "gateway", "detail": str(e)}])
        for tid, o in orders.items():
            self.gateway.assign(tid, o)

        old_owner = {j.id: j.tractor for j in self.jobs.values()}
        self.plan = new_plan
        work = {e["job"]: e for e in entries if e["kind"] == "work"}
        unassigned = {u.job: u for u in result.unassigned}
        for j in self.jobs.values():
            if j.status in {"done", "dropped"}:
                continue
            before = (j.tractor, j.status, j.start_t, j.end_t, j.unassigned_reason)
            if j.id in work:
                e = work[j.id]
                j.tractor, j.start_t, j.end_t, j.unassigned_reason = e["tractor"], e["start_t"], e["end_t"], None
                if j.status in {"pending", "paused"}:
                    j.status = "assigned"
            else:
                j.tractor, j.start_t, j.end_t = None, None, None
                j.status = "pending"
                u = unassigned.get(j.id)
                j.unassigned_reason = self._reason_text(u) if u else "Not in the current plan."
            if (j.tractor, j.status, j.start_t, j.end_t, j.unassigned_reason) != before:
                self._dirty_jobs.add(j.id)
        self._refresh_job_statuses()
        self.counters.replan_ms_last = round(result.solve_ms, 3)
        self.bump()

        self._n_expl += 1
        facts = dict(result.facts)
        facts["unassigned"] = [u.model_dump() for u in result.unassigned]
        expl = m.Explanation(id=f"X{self._n_expl}", t=self.t, trigger=trigger.get("type", "replan"),
                             text=explain_fn(result), facts=facts, plan_version=self.plan.version)
        self.explanations.insert(0, m.dump(expl))
        # Contract order (sections 8.3 and 13.3): plan, explanation, jobs, then other state.
        self.emit("plan", m.dump(self.plan))
        self.emit("explanation", m.dump(expl))
        self._emit_dirty_jobs()
        search_complete = not result.facts.get("search_budget_exhausted", False)
        if trigger.get("type") == "run":
            self.write_log("plan", plan_version=self.plan.version, solver=self.plan.solver,
                           solve_ms=self.plan.solve_ms, assigned=len(work), search_complete=search_complete)
        else:
            self.write_log("replan", trigger=trigger.get("type"), plan_version=self.plan.version,
                           replan_ms=round(result.solve_ms, 3), changes=result.facts.get("moved", []),
                           safety="pass", explanation_id=expl.id, search_complete=search_complete)
        if any(old_owner.get(j.id) != j.tractor for j in self.jobs.values()):
            self.emit("fleet", {"tractors": self.fleet_view()})
        self.emit("metrics", self.metrics_view())
        return {"applied": True, "plan_version": self.plan.version, "unassigned": sorted(unassigned),
                "solver_status": self.plan.solver_status}

    @staticmethod
    def _reason_text(u) -> str:
        d = u.detail
        if "unavailable or incompatible" in d and "no road" not in d and "deadline" not in d:
            return "No operational tractor has the right implement for this job."
        return f"No valid assignment right now ({d})."

    # ================================================================ public views

    def label(self, j: JobRec) -> str:
        return f"{VERB[j.type]} {j.block}"

    def _geo(self, x: float, y: float) -> tuple[float, float]:
        g = self.scenario["geo"]
        lat = g["origin_lat"] - y * g["cell_m"] / 111_320
        lon = g["origin_lon"] + x * g["cell_m"] / (111_320 * math.cos(math.radians(g["origin_lat"])))
        return round(lat, 7), round(lon, 7)

    def tractor_view(self, tr: TractorRec) -> dict:
        p = self.gateway.pose(tr.id)
        lat, lon = self._geo(p.x, p.y)
        mph = p.speed_cells_per_min * self.scenario["geo"]["cell_m"] * 60 / 1609.344
        queue = [e.job for e in self.plan.entries if e.tractor == tr.id and e.kind == "work"
                 and e.job in self.jobs and self.jobs[e.job].status in {"assigned"} and e.job != p.job]
        model = m.Tractor(
            id=tr.id, name=tr.name, color=tr.color, implements=tr.implements, status=tr.status,
            manual=False, fuel_pct=round(tr.fuel, 2),
            pose=m.Pose(x=round(p.x, 4), y=round(p.y, 4), lat=lat, lon=lon,
                        heading_deg=round(p.heading_deg, 1), speed_mph=round(mph, 2)),
            current_job=p.job if tr.status != "broken" else None, queue=queue,
            available_from_t=None, host="mock", agopenweb=None,
        )
        return m.dump(model)

    def fleet_view(self) -> list[dict]:
        return [self.tractor_view(tr) for tr in self.tractors.values()]

    def job_view(self, j: JobRec) -> dict:
        eta = j.end_t if j.status not in {"done", "dropped", "pending", "paused"} else None
        if j.status not in {"done", "pending", "paused"} and j.tractor in self.tractors:
            p = self.gateway.pose(j.tractor)
            if p.job == j.id and p.status == "working":
                eta = self.t + j.remaining
        return m.dump(m.Job(
            id=j.id, type=j.type, label=self.label(j), implement=j.implement, block=j.block,
            duration_min=round(j.duration, 3), remaining_min=round(j.remaining, 3),
            progress=round(min(1.0, max(0.0, j.progress)), 4), priority=j.priority,
            deadline_t=j.deadline_t, status=j.status, tractor=j.tractor,
            start_t=j.started_t if j.started_t is not None else j.start_t,
            end_t=j.end_t, eta_t=round(eta, 3) if eta is not None else None,
            weather_blocked=False, pinned_to=j.pinned_to, unassigned_reason=j.unassigned_reason,
        ))

    def jobs_view(self) -> list[dict]:
        return [self.job_view(j) for j in self.jobs.values()]

    def run_metrics(self) -> m.RunMetrics:
        done = [j for j in self.jobs.values() if j.status == "done"]
        on_time = [j for j in done if j.done_t <= j.deadline_t + EPS]
        return m.RunMetrics(
            jobs_total=len([j for j in self.jobs.values() if j.status != "dropped"]),
            completed=len(done), on_time=len(on_time),
            travel_min=round(self.counters.travel_min, 3), idle_min=round(self.counters.idle_min, 3),
            violations=self.counters.violations,
            weighted_on_time=sum(j.done_priority or j.priority for j in on_time),
            productive_min=round(self.counters.productive_min, 3),
            original_deadline_on_time=len([j for j in done if j.done_t <= j.original_deadline_t + EPS]),
            replan_ms_last=self.counters.replan_ms_last,
            rejected_candidates=None,
        )

    def metrics_view(self) -> dict:
        """This run's metrics, and the baseline only when it is a matching run.

        `baseline` is FCFS on the same scenario with every operator action so
        far replayed at the same farm time, read at the same farm minute
        (core/twin.py). `baseline_source` is "simulated" (the Python twin runs
        on the same simulator). When no matching baseline is ready (just
        started, or still recomputing after an operator action), both are
        null: never a stale or different-day run.
        """
        base = self.counterpart(self.t) if self.counterpart else None
        return m.dump(m.Metrics(ours=self.run_metrics(), baseline=base,
                                baseline_source="simulated" if base is not None else None))

    def clock_view(self) -> dict:
        return m.dump(m.Clock(t=round(self.t, 3), playing=self.playing, speed=self.speed,
                              day_minutes=self.day_minutes, mode=self.mode, ended=self.ended))

    def scenario_view(self) -> dict:
        out = {k: self.scenario[k] for k in PUBLIC_SCENARIO_KEYS if k in self.scenario}
        out["blocked_cells"] = [list(c) for c in sorted(self.blocked)]
        return out

    def poses_view(self) -> list[dict]:
        keys = ("id", "status", "manual", "pose", "tool", "fuel_pct", "current_job", "agopenweb")
        return [{k: v[k] for k in keys} for v in self.fleet_view()]

    def weather_view(self) -> dict:
        """Static placeholder: weather rules are not modeled yet (constraints.weather = false)."""
        calm = m.WeatherNow(wind_mph=5, wind_from_deg=200, temp_f=88, rain_prob=0)
        return m.dump(m.Weather(current=calm, forecast=[m.WeatherPoint(t=0, **calm.model_dump())],
                                spray_allowed_now={b: True for b in sorted(self.blocks)}))

    def capacity_view(self) -> dict:
        n = len(self.tractors)
        return m.dump(m.Capacity(used=n, max=n, hosts=[m.HostInfo(id="mock", docker="none", tractors=n,
                                                                    max_tractors=n, online=True)]))

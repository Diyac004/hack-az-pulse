"""MockGateway: fake tractors that move cell by cell on sim time.

Deterministic (no randomness, tractors processed in insertion order) and
tick-size independent: leftover time inside a tick carries into the next
order, and every event is stamped with its exact sim time.

Rules (from backend/INTEGRATION_NOTES.md):
- No teleporting: tractors move one 4-neighbour road cell at a time.
- pose().anchor is always a whole road cell; mid-move it is the next cell,
  with anchor_t = when the tractor gets there.
- stop() freezes the tractor where it is; the state store keeps progress.
- No fleet-size cap.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
import math

from app.brain.contracts import FarmMap

from .base import (
    Arrived, Cell, GatewayError, Halted, Idle, Moved, Order, Pose, ReachedCell,
    Report, Stopped, TractorSpec, Travel, Work, WorkDone, Worked,
)

EPS = 1e-9


def _heading(a: Cell, b: Cell) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    return math.degrees(math.atan2(dx, -dy)) % 360.0


@dataclass
class _Tractor:
    id: str
    cell: Cell
    speed: float
    heading: float
    status: str = "idle"
    path: deque = field(default_factory=deque)     # cells still to enter
    frac: float = 0.0                              # progress toward path[0]
    orders: deque = field(default_factory=deque)
    current: Order | None = None
    work_left: float = 0.0
    reported_idle: bool = True

    @property
    def mid_cell(self) -> bool:
        return bool(self.path) and self.frac > EPS

    @property
    def anchor(self) -> Cell:
        return self.path[0] if self.mid_cell else self.cell

    @property
    def job(self) -> str | None:
        return self.current.job if self.current else None


class MockGateway:
    def __init__(self, farm: FarmMap, t0: float = 0.0):
        self.t = t0
        self._tractors: dict[str, _Tractor] = {}
        self._pending: list[Report] = []
        self.update_map(farm)

    # ------------------------------------------------------------ map

    def update_map(self, farm: FarmMap) -> None:
        """Call on block_route / unblock_route. Affects segments not yet begun."""
        blocked = {tuple(c) for c in farm.blocked_cells}
        self._roads = {
            (x, y)
            for x in range(farm.grid.width) for y in range(farm.grid.height)
            if y in farm.roads.rows or x in farm.roads.cols
        }
        self._open = self._roads - blocked

    # ------------------------------------------------------------ fleet

    def add_tractor(self, spec: TractorSpec) -> None:
        if spec.id in self._tractors:
            raise GatewayError(f"tractor {spec.id} already exists")
        if spec.speed_cells_per_min <= 0:
            raise GatewayError("speed must be positive")
        cell = tuple(spec.cell)
        if cell not in self._roads:
            raise GatewayError(f"{spec.id} must start on a road cell, got {cell}")
        self._tractors[spec.id] = _Tractor(spec.id, cell, spec.speed_cells_per_min,
                                           spec.heading_deg)

    def remove_tractor(self, tractor_id: str) -> None:
        self._get(tractor_id)
        del self._tractors[tractor_id]

    def tractor_ids(self) -> list[str]:
        return list(self._tractors)

    # ------------------------------------------------------------ orders

    def assign(self, tractor_id: str, orders: list[Order]) -> None:
        """Replace the tractor's orders (called whenever a plan is applied).

        A tractor caught mid-move first finishes entering its next cell, so the
        first Travel route must start at pose().anchor. Validates everything
        before changing anything.
        """
        tr = self._get(tractor_id)
        if tr.status == "broken":
            raise GatewayError(f"{tractor_id} is broken; resume() it first")
        at = tr.anchor
        for o in orders:
            if isinstance(o, Travel):
                self._check_route(tractor_id, o.route, at)
                at = o.route[-1]
            elif isinstance(o, Work):
                if o.minutes < 0:
                    raise GatewayError("work minutes must be >= 0")
            else:
                raise GatewayError(f"unknown order {o!r}")

        if tr.mid_cell:
            tr.path = deque([tr.path[0]])      # finish the current segment only
        else:
            tr.path.clear()
            tr.frac = 0.0
        tr.orders = deque(orders)
        tr.current = None
        tr.work_left = 0.0
        tr.reported_idle = False
        tr.status = "traveling" if tr.path else "idle"

    def stop(self, tractor_id: str) -> None:
        """Breakdown: freeze in place. Keeps a mid-move segment so the tractor
        can finish entering its next cell after resume()."""
        tr = self._get(tractor_id)
        tr.orders.clear()
        tr.current = None
        tr.work_left = 0.0
        if tr.mid_cell:
            tr.path = deque([tr.path[0]])
        else:
            tr.path.clear()
        tr.status = "broken"
        self._pending.append(Stopped(tractor_id, self.t))

    def resume(self, tractor_id: str) -> None:
        """Repaired: back to idle (finishes its frozen segment if it had one)."""
        tr = self._get(tractor_id)
        if tr.status != "broken":
            return
        tr.status = "traveling" if tr.path else "idle"
        tr.reported_idle = False

    # ------------------------------------------------------------ readback

    def pose(self, tractor_id: str) -> Pose:
        tr = self._get(tractor_id)
        x, y = self._xy(tr)
        moving = tr.status == "traveling" and bool(tr.path)
        anchor_t = self.t
        if tr.mid_cell and tr.status != "broken":
            anchor_t = self.t + (1.0 - tr.frac) / tr.speed
        return Pose(x=x, y=y, heading_deg=tr.heading,
                    speed_cells_per_min=tr.speed if moving else 0.0,
                    status=tr.status, cell=tr.cell, anchor=tr.anchor,
                    anchor_t=anchor_t, job=tr.job)

    # ------------------------------------------------------------ time

    def advance(self, dt_min: float) -> list[Report]:
        if dt_min < 0:
            raise GatewayError("dt must be >= 0")
        reports, self._pending = self._pending, []
        end = self.t + dt_min
        for tr in self._tractors.values():
            reports.extend(self._advance_one(tr, self.t, end))
        self.t = end
        reports.sort(key=lambda r: r.t)   # stable: same-time reports keep order
        return reports

    def _advance_one(self, tr: _Tractor, start: float, end: float) -> list[Report]:
        out: list[Report] = []
        now = start
        moved_cells = moved_min = 0.0
        worked: dict[str, float] = {}

        while end - now > EPS and tr.status != "broken":
            # 1. driving: always finish the path before anything else
            if tr.path:
                nxt = tr.path[0]
                if tr.frac <= EPS and nxt not in self._open:
                    out.append(Halted(tr.id, now, tr.cell, "road_blocked"))
                    tr.path.clear(); tr.frac = 0.0
                    tr.orders.clear(); tr.current = None
                    tr.status = "idle"; tr.reported_idle = True
                    break
                tr.status = "traveling"
                tr.heading = _heading(tr.cell, nxt)
                step = min(end - now, (1.0 - tr.frac) / tr.speed)
                tr.frac += step * tr.speed
                now += step
                moved_cells += step * tr.speed
                moved_min += step
                if tr.frac >= 1.0 - EPS:
                    tr.cell = tr.path.popleft()
                    tr.frac = 0.0
                    out.append(ReachedCell(tr.id, now, tr.cell))
                    if not tr.path and isinstance(tr.current, Travel):
                        out.append(Arrived(tr.id, now, tr.cell, tr.current.job))
                        tr.current = None
                continue

            # 2. pick up the next order
            if tr.current is None:
                if not tr.orders:
                    tr.status = "idle"
                    if not tr.reported_idle:
                        out.append(Idle(tr.id, now, tr.cell))
                        tr.reported_idle = True
                    break
                tr.current = tr.orders.popleft()
                tr.reported_idle = False
                if isinstance(tr.current, Work):
                    tr.work_left = tr.current.minutes

            # 3. wait for its start time
            nb = tr.current.not_before_t
            if nb is not None and nb - now > EPS:
                tr.status = "waiting"
                now = min(end, nb)
                continue

            # 4. run it
            if isinstance(tr.current, Travel):
                tr.path.extend(tr.current.route[1:])
                if not tr.path:                      # zero-length route
                    out.append(Arrived(tr.id, now, tr.cell, tr.current.job))
                    tr.current = None
                continue

            tr.status = "working"                    # Work
            step = min(end - now, tr.work_left)
            tr.work_left -= step
            now += step
            if step > 0:
                worked[tr.current.job] = worked.get(tr.current.job, 0.0) + step
            if tr.work_left <= EPS:
                out.append(WorkDone(tr.id, now, tr.current.job))
                tr.current = None

        if moved_cells > EPS:
            p = self._xy(tr)
            out.append(Moved(tr.id, end, p[0], p[1], tr.heading, moved_cells, moved_min))
        for job, minutes in worked.items():
            out.append(Worked(tr.id, end, job, minutes))
        return out

    # ------------------------------------------------------------ internals

    @staticmethod
    def _xy(tr: _Tractor) -> tuple[float, float]:
        x, y = tr.cell
        if tr.path and tr.frac > EPS:
            nx, ny = tr.path[0]
            return x + (nx - x) * tr.frac, y + (ny - y) * tr.frac
        return float(x), float(y)

    def _get(self, tractor_id: str) -> _Tractor:
        try:
            return self._tractors[tractor_id]
        except KeyError:
            raise GatewayError(f"unknown tractor {tractor_id}") from None

    def _check_route(self, tid: str, route: tuple[Cell, ...], start: Cell) -> None:
        if not route:
            raise GatewayError(f"{tid}: empty route")
        if tuple(route[0]) != tuple(start):
            raise GatewayError(f"{tid}: route starts at {route[0]}, tractor will be at {start}")
        for a, b in zip(route, route[1:]):
            if abs(a[0] - b[0]) + abs(a[1] - b[1]) != 1:
                raise GatewayError(f"{tid}: route jumps from {a} to {b}")
        for c in route[1:]:
            if tuple(c) not in self._open:
                raise GatewayError(f"{tid}: route uses {c}, which is not an open road cell")

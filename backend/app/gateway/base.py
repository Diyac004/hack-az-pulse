"""TractorGateway: the layer that actually moves tractors.

The world service (state store) owns all truth: job progress, fuel, plans.
A gateway only executes orders and reports what physically happened.
MockGateway (pure Python, sim time) and AgOpenWebGateway (real simulator)
implement the same interface, so swapping them changes one line.

Coordinates are grid cells from scenario.json. y grows southward (row 0 is the
north edge), so heading 0 = north (-y), 90 = east (+x), 180 = south, 270 = west.
Times are sim minutes from 6:00 AM.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Union

Cell = tuple[int, int]


class GatewayError(ValueError):
    """An order the gateway refuses (unknown tractor, broken route, ...)."""


# ---------------------------------------------------------------- inputs

@dataclass(frozen=True)
class TractorSpec:
    id: str
    cell: Cell                       # starting road cell (whole cell)
    speed_cells_per_min: float
    heading_deg: float = 0.0


@dataclass(frozen=True)
class Travel:
    """Drive along road cells. route[0] must be where the tractor will be."""
    route: tuple[Cell, ...]
    job: str | None = None           # job being travelled to (for reports)
    not_before_t: float | None = None


@dataclass(frozen=True)
class Work:
    """Work `minutes` on a job at the current cell (block entrance)."""
    job: str
    minutes: float
    not_before_t: float | None = None


Order = Union[Travel, Work]


# ---------------------------------------------------------------- outputs

@dataclass(frozen=True)
class Moved:
    """Aggregated per tick: distance and time spent driving (for fuel)."""
    tractor: str
    t: float
    x: float
    y: float
    heading_deg: float
    cells: float
    minutes: float


@dataclass(frozen=True)
class ReachedCell:
    tractor: str
    t: float
    cell: Cell


@dataclass(frozen=True)
class Arrived:
    """A Travel order finished."""
    tractor: str
    t: float
    cell: Cell
    job: str | None


@dataclass(frozen=True)
class Worked:
    """Aggregated per tick: work minutes done on a job (state fills work units)."""
    tractor: str
    t: float
    job: str
    minutes: float


@dataclass(frozen=True)
class WorkDone:
    """A Work order used up its minutes."""
    tractor: str
    t: float
    job: str


@dataclass(frozen=True)
class Idle:
    """The tractor ran out of orders."""
    tractor: str
    t: float
    cell: Cell


@dataclass(frozen=True)
class Halted:
    """Could not continue (e.g. road ahead blocked). Orders cleared."""
    tractor: str
    t: float
    cell: Cell
    reason: str


@dataclass(frozen=True)
class Stopped:
    """Breakdown confirmed. Tractor frozen in place, orders cleared."""
    tractor: str
    t: float


Report = Union[Moved, ReachedCell, Arrived, Worked, WorkDone, Idle, Halted, Stopped]


@dataclass(frozen=True)
class Pose:
    x: float
    y: float
    heading_deg: float
    speed_cells_per_min: float       # 0 when not moving
    status: str                      # idle | waiting | traveling | working | broken
    cell: Cell                       # last whole cell reached
    anchor: Cell                     # whole road cell to plan from (next cell if mid-move)
    anchor_t: float                  # when the tractor is at `anchor`
    job: str | None


# ---------------------------------------------------------------- interface

class TractorGateway(Protocol):
    t: float

    def add_tractor(self, spec: TractorSpec) -> None: ...
    def remove_tractor(self, tractor_id: str) -> None: ...
    def assign(self, tractor_id: str, orders: list[Order]) -> None: ...
    def stop(self, tractor_id: str) -> None: ...
    def resume(self, tractor_id: str) -> None: ...
    def advance(self, dt_min: float) -> list[Report]: ...
    def pose(self, tractor_id: str) -> Pose: ...
    def tractor_ids(self) -> list[str]: ...


# ---------------------------------------------------------------- helpers

def orders_from_plan(entries: list[dict], tractor_id: str) -> list[Order]:
    """Turn one tractor's PlanEntry dicts (public Plan shape) into orders.

    travel -> Travel(route), work -> Work(end_t - start_t minutes).
    start_t becomes not_before_t, so tractors never start early.
    """
    mine = sorted((e for e in entries if e["tractor"] == tractor_id),
                  key=lambda e: e["start_t"])
    orders: list[Order] = []
    for e in mine:
        if e["kind"] == "travel":
            orders.append(Travel(tuple(tuple(c) for c in e["route"]),
                                 e.get("job"), e["start_t"]))
        elif e["kind"] == "work":
            orders.append(Work(e["job"], e["end_t"] - e["start_t"], e["start_t"]))
        else:
            raise GatewayError(f"plan entry kind '{e['kind']}' is not supported yet")
    return orders

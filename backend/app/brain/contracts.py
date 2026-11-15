"""Internal snapshot subset shared with the platform; no world mutation."""
from typing import Literal
from pydantic import BaseModel as PydanticBaseModel, ConfigDict, Field, model_validator


class BaseModel(PydanticBaseModel):
    model_config = ConfigDict(allow_inf_nan=False)


class Point(BaseModel):
    x: float
    y: float


class Grid(BaseModel):
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class Roads(BaseModel):
    rows: list[int]
    cols: list[int]


class FarmMap(BaseModel):
    grid: Grid
    roads: Roads
    blocked_cells: list[tuple[int, int]]
    depot: Point
    entrances: dict[str, list[tuple[int, int]]]
    cell_m: float = Field(gt=0)


class Burn(BaseModel):
    travel: float = Field(ge=0)
    work: float = Field(ge=0)


class Tractor(BaseModel):
    id: str
    status: str
    manual: bool
    implements: list[str]
    speed_cells_per_min: float = Field(gt=0)
    x: float
    y: float
    fuel_pct: float = Field(ge=0, le=100)
    fuel_burn_pct_per_min: Burn
    available_from_t: float | None


class WorkUnit(BaseModel):
    unit: int
    minutes: float = Field(gt=0)
    done_min: float = Field(ge=0)

    @model_validator(mode='after')
    def valid_progress(self):
        if self.done_min > self.minutes:
            raise ValueError('Completed work exceeds unit duration')
        return self


class Job(BaseModel):
    id: str
    type: str
    implement: str
    block: str
    priority: int = Field(ge=1, le=3)
    deadline_t: float
    status: str
    pinned_to: str | None
    work_units: list[WorkUnit] = Field(min_length=1)

    @property
    def remaining_min(self):
        return sum(u.minutes - u.done_min for u in self.work_units)


class FrozenEntry(BaseModel):
    tractor: str
    job: str | None
    kind: Literal['work', 'travel', 'wait', 'refuel', 'swap_implement']
    start_t: float
    end_t: float
    remaining_route: list[tuple[int, int]] | None = None


class Constraints(BaseModel):
    fuel_reserve_pct: float = Field(ge=0, le=100)
    refuel: bool
    weather: bool


class BrainSnapshot(BaseModel):
    state_version: int = Field(ge=0)
    map_version: int = Field(ge=0)
    t: float
    horizon_t: float
    trigger: dict
    map: FarmMap
    tractors: list[Tractor]
    jobs: list[Job]
    frozen: list[FrozenEntry]
    constraints: Constraints
    previous_plan: "PreviousPlan | None" = None

    @model_validator(mode='after')
    def consistent(self):
        if self.horizon_t < self.t:
            raise ValueError('Horizon precedes current time')
        for objects in (self.tractors, self.jobs):
            ids = [obj.id for obj in objects]
            if len(ids) != len(set(ids)):
                raise ValueError('Duplicate IDs')
        for job in self.jobs:
            ids = [u.unit for u in job.work_units]
            if len(ids) != len(set(ids)):
                raise ValueError('Duplicate work units')
        return self


class PlanEntry(BaseModel):
    tractor: str
    job: str | None
    kind: Literal['travel', 'work', 'wait', 'refuel', 'swap_implement']
    start_t: float
    end_t: float
    route: list[tuple[int, int]] = Field(default_factory=list)


class PreviousPlan(BaseModel):
    version: int
    entries: list[PlanEntry]


class Violation(BaseModel):
    rule: str
    detail: str
    tractor: str | None = None
    job: str | None = None


class ValidationResult(BaseModel):
    passed: bool
    violations: list[Violation]


class ProposedPlan(BaseModel):
    solver: Literal['greedy'] = 'greedy'
    solve_ms: int = 0
    solver_status: Literal['feasible', 'no_feasible_plan'] = 'feasible'
    entries: list[PlanEntry]
    diff: dict = Field(default_factory=lambda: {'moved': [], 'retimed': [], 'dropped': [], 'added': []})


class Unassigned(BaseModel):
    job: str
    reason: str
    detail: str


class PlanningResult(BaseModel):
    source_state_version: int
    status: Literal['feasible', 'infeasible', 'unsupported']
    solver: str = 'greedy'
    solve_ms: float
    plan: ProposedPlan
    unassigned: list[Unassigned]
    facts: dict
    validation: ValidationResult


BrainSnapshot.model_rebuild()

"""Public API models: ARCHITECTURE.md section 9 plus the section 13 amendment.

Every REST response and WebSocket `data` payload is built through these
models, so a shape that drifts from the contract fails loudly here.
Serialize with `dump(model)` (by_alias so MovedJob.from_ -> "from").
"""
from typing import Literal, Optional, Union

from pydantic import BaseModel, Field, model_validator

TractorStatus = Literal[
    "starting", "ready", "idle", "traveling", "working", "refueling", "waiting_weather",
    "broken", "awaiting_mechanic", "repair_scheduled", "repairing", "removing", "offline",
]
JobStatus = Literal["pending", "assigned", "traveling", "working", "paused", "done", "dropped"]
JobType = Literal["spray", "mow", "hedge", "haul_bins"]
Implement = Literal["sprayer", "mower", "hedger", "bin_trailer"]
PlanKind = Literal["travel", "work", "refuel", "wait", "swap_implement"]
RunMode = Literal["ours", "baseline", "both"]
SolverStatus = Literal["feasible", "optimal", "fallback", "no_feasible_plan"]


def dump(model: BaseModel) -> dict:
    return model.model_dump(mode="json", by_alias=True)


# ---------------------------------------------------------------- fleet

class Pose(BaseModel):
    x: float
    y: float
    lat: float
    lon: float
    heading_deg: float
    speed_mph: float


class ToolPose(BaseModel):
    lat: float
    lon: float
    heading_deg: float
    width_m: float


class AgOpenWebInfo(BaseModel):
    endpoint: str
    connected: bool
    heartbeat_age_ms: Optional[int]
    autosteer: bool
    section_master: bool
    youturn: bool


class Tractor(BaseModel):
    id: str
    name: str
    color: str
    implements: list[Implement]
    status: TractorStatus
    manual: bool = False
    fuel_pct: float
    pose: Pose
    tool: Optional[ToolPose] = None
    current_job: Optional[str] = None
    queue: list[str] = Field(default_factory=list)
    available_from_t: Optional[float] = None
    host: Optional[str] = None
    agopenweb: Optional[AgOpenWebInfo] = None


# ---------------------------------------------------------------- jobs and plans

class Job(BaseModel):
    id: str
    type: JobType
    label: str
    implement: Implement
    block: str
    duration_min: float
    remaining_min: float
    progress: float = 0.0
    priority: int = Field(ge=1, le=3)
    deadline_t: float
    status: JobStatus = "pending"
    tractor: Optional[str] = None
    start_t: Optional[float] = None
    end_t: Optional[float] = None
    eta_t: Optional[float] = None
    weather_blocked: bool = False
    pinned_to: Optional[str] = None
    unassigned_reason: Optional[str] = None


class PlanEntry(BaseModel):
    tractor: str
    job: Optional[str]
    kind: PlanKind
    start_t: float
    end_t: float
    route: list[tuple[float, float]] = Field(default_factory=list)


class MovedJob(BaseModel):
    job: str
    to: str
    from_: Optional[str] = Field(default=None, alias="from")
    progress_kept: Optional[float] = None

    model_config = {"populate_by_name": True}


class RetimedJob(BaseModel):
    job: str
    old_start_t: float
    new_start_t: float


class PlanDiff(BaseModel):
    moved: list[MovedJob] = Field(default_factory=list)
    retimed: list[RetimedJob] = Field(default_factory=list)
    dropped: list[str] = Field(default_factory=list)
    added: list[str] = Field(default_factory=list)


class Plan(BaseModel):
    version: int
    entries: list[PlanEntry]
    solver: Literal["ortools", "greedy"]
    solve_ms: int
    solver_status: SolverStatus
    diff: PlanDiff = Field(default_factory=PlanDiff)


class Explanation(BaseModel):
    id: str
    t: float
    trigger: str
    text: str
    facts: dict
    plan_version: Optional[int] = None


# ---------------------------------------------------------------- metrics, weather, misc

class RunMetrics(BaseModel):
    jobs_total: int
    completed: int
    on_time: int
    travel_min: float
    idle_min: float
    violations: int
    weighted_on_time: Optional[int] = None
    productive_min: Optional[float] = None
    original_deadline_on_time: Optional[int] = None
    replan_ms_last: Optional[float] = None
    rejected_candidates: Optional[int] = None


class Metrics(BaseModel):
    ours: RunMetrics
    baseline: Optional[RunMetrics] = None
    baseline_source: Optional[Literal["live", "simulated"]] = None


class WeatherNow(BaseModel):
    wind_mph: float
    wind_from_deg: float
    temp_f: float
    rain_prob: float


class WeatherPoint(WeatherNow):
    t: float


class Weather(BaseModel):
    current: WeatherNow
    forecast: list[WeatherPoint]
    spray_allowed_now: dict[str, bool]
    spray_blocked_reason: dict[str, str] = Field(default_factory=dict)
    spray_windows: dict[str, list[tuple[float, float]]] = Field(default_factory=dict)
    live_conditions: Optional[dict] = None


class MechanicOption(BaseModel):
    id: str
    name: str
    source: str
    distance_mi: float
    rating: float
    reviews: int
    mobile: bool
    ag_equipment: bool
    eta_min: float
    est_cost: float
    repair_min_estimate: float
    url: Optional[str] = None
    score: float
    recommended: bool
    reason: Optional[str] = None


class Pending(BaseModel):
    id: str
    kind: Literal["approval", "mechanic"]
    title: Optional[str] = None
    text: Optional[str] = None
    plan_version: Optional[int] = None
    tractor: Optional[str] = None
    issue: Optional[str] = None
    options: list[MechanicOption] = Field(default_factory=list)


class HostInfo(BaseModel):
    id: str
    docker: str
    tractors: int
    max_tractors: int
    cpu_pct: Optional[float] = None
    online: bool


class Capacity(BaseModel):
    used: int
    max: int
    hosts: list[HostInfo]
    warm: int = 0


class Clock(BaseModel):
    t: float
    playing: bool
    speed: float
    day_minutes: float = 720
    mode: RunMode = "ours"
    ended: bool = False


# ---------------------------------------------------------------- section 13.7 operations

class OperationError(BaseModel):
    code: str
    message: str
    details: dict = Field(default_factory=dict)


class PlanOperationResult(BaseModel):
    applied_plan_version: int
    unassigned_job_ids: list[str]


class RepairOperationResult(BaseModel):
    tractor: str
    mechanic: str
    arrival_t: float
    estimated_return_t: float


class ApprovalOperationResult(BaseModel):
    pending_id: str
    decision: Literal["approve", "override"]
    applied_plan_version: Optional[int]


_RESULT_FOR_KIND = {
    "run": PlanOperationResult,
    "replan": PlanOperationResult,
    "repair_booking": RepairOperationResult,
    "approval": ApprovalOperationResult,
}


class Operation(BaseModel):
    id: str
    kind: Literal["run", "replan", "repair_booking", "approval"]
    status: Literal["queued", "running", "succeeded", "failed", "superseded"]
    source: Literal["run", "jobs", "job_patch", "events", "manual", "control", "mechanics_book", "approve"]
    created_t: float
    updated_t: float
    message: str
    plan_version: Optional[int]
    solver_status: Optional[SolverStatus]
    result: Optional[Union[PlanOperationResult, RepairOperationResult, ApprovalOperationResult]]
    error: Optional[OperationError]

    @model_validator(mode="after")
    def terminal_consistency(self):
        if self.status == "succeeded":
            if self.error is not None or not isinstance(self.result, _RESULT_FOR_KIND[self.kind]):
                raise ValueError("succeeded operations need the matching result and no error")
        elif self.status == "failed":
            if self.error is None or self.result is not None:
                raise ValueError("failed operations need an error and no result")
        elif self.result is not None:
            raise ValueError(f"{self.status} operations have no result")
        return self


# ---------------------------------------------------------------- snapshot

class Snapshot(BaseModel):
    clock: Clock
    scenario: dict
    fleet: list[Tractor]
    jobs: list[Job]
    plan: Plan
    explanations: list[Explanation]
    metrics: Metrics
    weather: Weather
    pending: list[Pending]
    capacity: Capacity
    log_tail: list[dict]
    operations: list[Operation]


# ---------------------------------------------------------------- request bodies

class JobInput(BaseModel):
    id: Optional[str] = None
    type: JobType
    implement: Implement
    block: str
    duration_min: float = Field(gt=0)
    priority: int = Field(ge=1, le=3)
    deadline_t: float


class JobsBody(BaseModel):
    jobs: list[JobInput] = Field(min_length=1)


class JobPatch(BaseModel):
    priority: Optional[int] = Field(default=None, ge=1, le=3)
    deadline_t: Optional[float] = None
    pinned_to: Optional[str] = None


class RunBody(BaseModel):
    mode: RunMode = "ours"


class ClockBody(BaseModel):
    playing: Optional[bool] = None
    speed: Optional[float] = Field(default=None, gt=0, le=600)


class EventInput(BaseModel):
    type: Literal[
        "breakdown", "block_route", "unblock_route", "priority_change", "weather_change",
        "heat_alert", "ripening_change", "tractor_repaired",
    ]
    tractor: Optional[str] = None
    issue: Optional[str] = None
    cells: Optional[list[tuple[int, int]]] = None
    job: Optional[str] = None
    priority: Optional[int] = Field(default=None, ge=1, le=3)
    deadline_t: Optional[float] = None
    reason: Optional[str] = None


class StartCell(BaseModel):
    x: int
    y: int


class FleetEntry(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None
    implements: list[Implement] = Field(min_length=1)
    fuel_pct: float = Field(default=100, ge=0, le=100)
    speed: float = Field(default=1.0, gt=0)
    start: Optional[StartCell] = None
    endpoint: str = "auto"

# Harvest Fleet AI: Backend Architecture and API Contract

> **Audience:** backend team (Person 2, Person 3).
> **Purpose:** the exact format the dashboard expects. The frontend is being built right now against a mock that returns these shapes. If the backend returns the same shapes, switching the dashboard to live is one setting.
> **Rule:** if you need to change a shape, change it here first and tell Divi. Do not ship a different shape "just for now."

---

## 1. Stack

**FastAPI for everything the dashboard touches.**
- REST endpoints for actions and one-off queries.
- One WebSocket endpoint (`/ws`) for everything live. FastAPI handles WebSockets natively.
- Run with `uvicorn app.main:app --host 0.0.0.0 --port 8000`.
- Python 3.11+, Pydantic v2 models for every request, response, and message (Section 9 has them).

The dashboard never talks to AgOpenWeb. Only the backend does (Fleet Gateway, internal). AgOpenWeb details stay inside the backend.

```
Dashboard (browser)
   |  REST  http://<host>:8000/api/...
   |  WS    ws://<host>:8000/ws
FastAPI app (one process, asyncio)
   |-- api/        REST routes
   |-- ws/         WebSocket hub (broadcast + throttling)
   |-- core/       state store (single source of truth), clock, event engine, event log
   |-- agents/     weather, agronomy, fleet (optimizer + greedy), navigation, safety, mechanic, explain
   |-- gateway/    TractorGateway interface, AgOpenWebGateway, MockGateway, Fleet Manager, compute pool
   |-- baseline/   FCFS dispatcher (same scenario, same events)
   `-- metrics/    ours vs baseline
        |
        |  ws://<host>:5174/ws, :5175, ... (one per tractor, internal only)
   AgOpenWeb containers (headless, simulator mode)
```

### Settings
- CORS: allow the dashboard dev origin (`http://localhost:5173` and any LAN IP used in the demo). Simplest for the hackathon: `allow_origins=["*"]`.
- All REST routes live under `/api`. The WebSocket is at `/ws` (no `/api` prefix).
- FastAPI's `/openapi.json` must stay on. We use it to check for drift at the 2:45 switch.

---

## 2. Conventions (apply everywhere)

| Thing | Format |
|---|---|
| JSON keys | `snake_case` |
| IDs | strings. Tractors `T1`, `T2`, ... Jobs `J1`, `J2`, ... Blocks `A`..`H`. Mechanics `M1`.. Pending items `P1`.. |
| Farm time `t` | **number, minutes since the start of the farm day (6:00 AM)**. Float allowed. Day length in `clock.day_minutes`. The dashboard formats it as a clock. |
| Durations | minutes (`_min` suffix) |
| Deadlines, start, end, ETA | farm time `t` values (`_t` suffix) |
| Grid position | `x`, `y` floats in grid cells. Origin top-left (north-west). `x` grows east, `y` grows south. |
| Geo position | `lat`, `lon` WGS84 decimal degrees |
| Heading | degrees, 0 = north, clockwise (`heading_deg`) |
| Speed | mph (`speed_mph`) |
| Wind direction | `wind_from_deg`: where the wind comes from, meteorological convention |
| Fuel | percent 0 to 100 (`fuel_pct`) |
| Progress | 0 to 1 (`progress`) |
| Priority | integer 1 to 3 (3 = high) |
| Temperature | °F (`temp_f`) |
| Colors | hex string `#0A84FF` (backend assigns tractor colors from the palette in Section 8) |
| Missing value | `null`, never omit the key |
| Lists | always arrays, empty `[]` when none |

---

## 3. Enums (exact strings)

```text
TractorStatus  = starting | ready | idle | traveling | working | refueling | waiting_weather
               | broken | awaiting_mechanic | repair_scheduled | repairing | removing | offline
JobStatus      = pending | assigned | traveling | working | paused | done | dropped
JobType        = spray | mow | hedge | haul_bins
Implement      = sprayer | mower | hedger | bin_trailer
PlanKind       = travel | work | refuel | wait | swap_implement
EventType      = breakdown | block_route | unblock_route | priority_change | weather_change
               | heat_alert | ripening_change | tractor_added | tractor_removed | tractor_repaired
               | operator_action
RunMode        = ours | baseline | both
PendingKind    = approval | mechanic
ControlType    = button | toggle | slider | number | select | map_pick | text
```

`manual` is not a status. It is a separate boolean on the tractor (a manual tractor can still be `traveling` or `working`).

---

## 4. Core objects

These exact shapes appear inside REST responses and WebSocket messages.

### Tractor
```json
{
  "id": "T1",
  "name": "Tractor 1",
  "color": "#0A84FF",
  "implements": ["sprayer"],
  "status": "working",
  "manual": false,
  "fuel_pct": 72.4,
  "pose": {
    "x": 4.2, "y": 9.5,
    "lat": 33.2041, "lon": -111.6187,
    "heading_deg": 91.0,
    "speed_mph": 5.8
  },
  "tool": { "lat": 33.2040, "lon": -111.6189, "heading_deg": 91.0, "width_m": 6.0 },
  "current_job": "J1",
  "queue": ["J4", "J7"],
  "available_from_t": null,
  "host": "laptop-divi",
  "agopenweb": {
    "endpoint": "ws://localhost:5174/ws",
    "connected": true,
    "heartbeat_age_ms": 120,
    "autosteer": true,
    "section_master": true,
    "youturn": true
  }
}
```
- `available_from_t`: when a broken/repairing tractor is expected back, else `null`.
- `agopenweb` is `null` for MockGateway tractors.

### Job
```json
{
  "id": "J1",
  "type": "spray",
  "label": "Spray E",
  "implement": "sprayer",
  "block": "E",
  "duration_min": 150,
  "remaining_min": 60,
  "progress": 0.6,
  "priority": 3,
  "deadline_t": 330,
  "status": "working",
  "tractor": "T3",
  "start_t": 140,
  "end_t": 205,
  "eta_t": 205,
  "weather_blocked": false,
  "pinned_to": null,
  "unassigned_reason": null
}
```
- For done jobs, `start_t` / `end_t` are actual times. For others, planned times.
- `dropped` jobs have `tractor: null` and a reason in the latest explanation.

### PlanEntry (one bar on the timeline)
```json
{ "tractor": "T3", "job": "J1", "kind": "work", "start_t": 140, "end_t": 205, "route": [] }
```
- `kind: "travel"` entries carry `route` as `[[x, y], ...]` grid points (the road path). `job` is the job being travelled to.
- `kind: "refuel"` and `"wait"` have `job: null`.

### Plan
```json
{
  "version": 7,
  "entries": [ /* PlanEntry */ ],
  "solver": "ortools",
  "solve_ms": 840,
  "solver_status": "feasible",
  "diff": {
    "moved": [ { "job": "J1", "from": "T1", "to": "T3" } ],
    "retimed": [ { "job": "J5", "old_start_t": 300, "new_start_t": 345 } ],
    "dropped": [],
    "added": []
  }
}
```
- `version` increments on every applied plan. `solver` is `ortools` or `greedy`.

### Explanation
```json
{
  "id": "X12",
  "t": 141.5,
  "trigger": "breakdown",
  "text": "Tractor 1 broke down 60% of the way through spraying Block E. Tractor 3 has the only other sprayer and 81% fuel, so it finishes the remaining 40% right after its current job. All deadlines are still met.",
  "facts": {
    "event": { "type": "breakdown", "tractor": "T1" },
    "moved": [ { "job": "J1", "from": "T1", "to": "T3", "progress_kept": 0.6 } ],
    "deadlines_missed": [],
    "travel_delta_min": 12,
    "idle_delta_min": -5
  },
  "plan_version": 7
}
```
- Every number in `text` must come from `facts` or the plan. No invented numbers.

### Metrics
```json
{
  "ours":     { "jobs_total": 12, "completed": 7, "on_time": 7, "travel_min": 88, "idle_min": 12, "violations": 0 },
  "baseline": { "jobs_total": 12, "completed": 5, "on_time": 4, "travel_min": 131, "idle_min": 47, "violations": 0 },
  "baseline_source": "live"
}
```
- `baseline_source`: `live` (real run on containers), `simulated` (fast Python twin), or `null` (not run yet). The dashboard labels it.
- Metric definitions are in PROJECT.md Section 7. Use them exactly.

### Weather
```json
{
  "current": { "wind_mph": 8, "wind_from_deg": 200, "temp_f": 92, "rain_prob": 0 },
  "forecast": [ { "t": 0, "wind_mph": 2, "wind_from_deg": 90, "temp_f": 68, "rain_prob": 0 } ],
  "spray_allowed_now": { "A": true, "B": true, "E": false, "H": true },
  "spray_blocked_reason": { "E": "Wind blowing toward canal (sensitive area)" },
  "spray_windows": { "E": [ [60, 240], [540, 720] ] },
  "live_conditions": null
}
```
- `spray_windows`: per block, list of `[start_t, end_t]` ranges where spraying is allowed.
- `live_conditions`: optional NWS observation, same shape as `current` plus `"source": "NWS"`, or `null`.

### Pending (needs the operator)
```json
{ "id": "P3", "kind": "approval", "title": "Plan misses a deadline", "text": "This plan finishes Mow F 20 min after its 3 PM deadline. Approve or override?", "plan_version": 8 }
```
```json
{
  "id": "P4", "kind": "mechanic", "tractor": "T1", "issue": "hydraulic leak",
  "options": [
    { "id": "M1", "name": "Example Mobile Diesel", "source": "Google", "distance_mi": 12.4,
      "rating": 4.8, "reviews": 132, "mobile": true, "ag_equipment": true,
      "eta_min": 55, "est_cost": 420, "repair_min_estimate": 90, "url": null,
      "score": 0.91, "recommended": true, "reason": "Only mobile ag specialist arriving within 1 hour" }
  ]
}
```

### Capacity (compute pool)
```json
{
  "used": 7, "max": 12,
  "hosts": [ { "id": "laptop-divi", "docker": "local", "tractors": 4, "max_tractors": 5, "cpu_pct": 71, "online": true } ],
  "warm": 2
}
```

### Scenario (static farm layout)
```json
{
  "name": "queen_creek_citrus_day1",
  "grid": { "width": 20, "height": 14 },
  "depot": { "x": 1, "y": 6 },
  "roads": { "rows": [0, 6, 13], "cols": [0, 5, 10, 15] },
  "blocks": [ { "id": "A", "x": 1, "y": 2, "w": 4, "h": 3, "variety": "Navel", "ripeness": 0.4 } ],
  "blocked_cells": [ [7, 6] ],
  "sensitive": [ { "block": "E", "what": "canal", "dir_deg": 90 } ],
  "basemap": { "image_url": "/static/naip.png", "west": -111.62, "east": -111.605, "south": 33.2, "north": 33.212 },
  "geo": { "origin_lat": 33.212, "origin_lon": -111.62, "cell_m": 40 }
}
```
- `geo` lets the dashboard convert between grid and lat/lon the same way the backend does.
- Serve `naip.png` from FastAPI static files at `/static/`.

### Clock
```json
{ "t": 134.2, "playing": true, "speed": 1, "day_minutes": 720, "mode": "ours", "ended": false }
```

---

## 5. REST endpoints

Base: `http://<host>:8000/api`. All bodies JSON. All responses JSON except `/log`, which returns JSON Lines text. Mutation responses use Section 13 operation tracking where specified.

### Errors (every endpoint)
HTTP 4xx/5xx with:
```json
{ "error": { "code": "SAFETY_REJECTED", "message": "Can't pin Mow C to Tractor 1: it has no mower.", "details": { "rule": "implement_match" } } }
```
Codes: `NOT_FOUND`, `INVALID_INPUT`, `SAFETY_REJECTED`, `WEATHER_BLOCKED`, `NEEDS_MANUAL`, `AT_CAPACITY`, `GATEWAY_UNAVAILABLE`, `CONFLICT`, `INTERNAL`.
`message` is shown to the operator as-is, so write it in plain English.

### Endpoint list

| # | Method | Path | Body | Returns |
|---|---|---|---|---|
| 1 | GET | `/state` | | `Snapshot` (same as WS `snapshot.data`) |
| 2 | GET | `/scenario` | | `Scenario` |
| 3 | POST | `/run` | `{ "mode": "ours" }` | `{ "ok": true, "clock": Clock }` then a WS `snapshot` |
| 4 | POST | `/clock` | `{ "playing": true, "speed": 6 }` (either key optional) | `Clock` |
| 5 | GET | `/jobs` | | `Job[]` |
| 6 | POST | `/jobs` | `{ "jobs": [ JobInput ] }` | `{ "jobs": Job[], "plan": Plan, "explanation": Explanation }` |
| 7 | PATCH | `/jobs/{id}` | `{ "priority": 3, "deadline_t": 300, "pinned_to": "T2" }` (any subset) | `{ "job": Job, "plan": Plan, "explanation": Explanation }` |
| 8 | POST | `/events` | `EventInput` (below) | `{ "ok": true, "explanation": Explanation \| null }` |
| 9 | GET | `/fleet` | | `Tractor[]` |
| 10 | POST | `/fleet` | `FleetEntry` (below) | `{ "tractor": Tractor }` with status `starting` (202). Ready arrives later on WS. |
| 11 | DELETE | `/fleet/{id}` | | `{ "ok": true }` (tractor goes `removing`, then disappears from `fleet`) |
| 12 | GET | `/hosts` | | `Capacity` |
| 13 | GET | `/tractors/{id}/controls` | | `{ "controls": Control[], "values": { "<control id>": value } }` |
| 14 | POST | `/tractors/{id}/control` | `{ "control": "steer", "value": 12 }` | `{ "ok": true, "value": 12, "explanation": Explanation \| null }` |
| 15 | POST | `/tractors/{id}/preview` | `{ "control": "implements", "value": ["sprayer"] }` | `Preview` (below), applies nothing |
| 16 | POST | `/tractors/{id}/manual` | `{ "on": true }` | `{ "tractor": Tractor, "explanation": Explanation \| null }` |
| 17 | GET | `/why/{job_id}` | | `Why` (below) |
| 18 | GET | `/mechanics?tractor=T1` | | `{ "options": MechanicOption[] }` |
| 19 | POST | `/mechanics/book` | `{ "tractor": "T1", "mechanic": "M1" }` | `{ "ok": true, "arrival_t": 196, "return_t": 286 }` (mock booking only) |
| 20 | POST | `/approve` | `{ "id": "P3", "decision": "approve" }` or `"override"` | `{ "ok": true }` |
| 21 | GET | `/weather` | | `Weather` |
| 22 | GET | `/metrics` | | `Metrics` |
| 23 | GET | `/log` | | `text/plain` JSON lines (the event log file) |
| 24 | POST | `/scale-test` | `{ "tractors": 50, "jobs": 200 }` | `{ "tractors": 50, "jobs": 200, "assigned": 196, "dropped": 4, "violations": 0, "solve_ms": 3120, "solver": "ortools" }` |

### Request shapes

`JobInput`
```json
{ "id": "J13", "type": "mow", "implement": "mower", "block": "G", "duration_min": 60, "priority": 2, "deadline_t": 480 }
```

`EventInput` (one of)
```json
{ "type": "breakdown", "tractor": "T1", "issue": "hydraulic leak" }
{ "type": "block_route", "cells": [[9, 6], [9, 7]] }
{ "type": "unblock_route", "cells": [[9, 6]] }
{ "type": "priority_change", "job": "J2", "priority": 3, "deadline_t": 330, "reason": "Block C ripening faster" }
{ "type": "weather_change", "wind_mph": 14, "wind_from_deg": 250, "temp_f": 104, "rain_prob": 10 }
{ "type": "heat_alert", "temp_f": 112, "at_t": 480 }
```
If `block_route` has no `cells`, the backend picks road cells on a tractor's current route (so the demo always shows a reroute).

`FleetEntry`
```json
{ "id": "T4", "name": "Tractor 4", "implements": ["mower", "hedger"], "fuel_pct": 75, "speed": 1.0, "start": { "x": 3, "y": 6 }, "endpoint": "auto" }
```
`id` may be omitted; the backend assigns the next free one. `endpoint` is `"auto"` or a `ws://` URL.

### Response shapes

`Control` (tractor control schema, PROJECT.md Change 8)
```json
{
  "id": "steer", "tab": "Drive", "label": "Steering", "type": "slider",
  "min": -40, "max": 40, "step": 1, "unit": "deg", "options": null,
  "needs_manual": true, "replans": false, "help": "Steering angle of the simulated tractor"
}
```
- `tab`: `Drive` | `Guidance` | `Implement` | `Vehicle` | `Fleet` | `Advanced`
- `options` for `select`: `[{ "value": "sprayer", "label": "Sprayer" }]`
- The AgOpenWeb command mapping stays in the backend; the dashboard never sees command strings.

`Preview`
```json
{
  "allowed": true,
  "refused_reason": null,
  "plan": { /* Plan, not applied */ },
  "explanation": { /* Explanation describing the impact */ },
  "metrics_delta": { "travel_min": -18, "idle_min": -6, "late_jobs": 1 }
}
```

`Why`
```json
{
  "job": "J1",
  "chosen": "T3",
  "options": [
    { "tractor": "T3", "feasible": true,  "reason": null, "finish_t": 205, "travel_delta_min": 0,  "idle_delta_min": 0,  "deadlines_missed": [] },
    { "tractor": "T1", "feasible": false, "reason": "Broken down", "finish_t": null, "travel_delta_min": null, "idle_delta_min": null, "deadlines_missed": [] },
    { "tractor": "T2", "feasible": false, "reason": "No sprayer", "finish_t": null, "travel_delta_min": null, "idle_delta_min": null, "deadlines_missed": [] }
  ],
  "method": "counterfactual"
}
```
- `method`: `counterfactual` (re-solved with the job forced onto each tractor) or `estimate` (greedy append estimate). Feasible options always include real numbers.

`Snapshot`
```json
{
  "clock": { /* Clock */ },
  "scenario": { /* Scenario */ },
  "fleet": [ /* Tractor */ ],
  "jobs": [ /* Job */ ],
  "plan": { /* Plan */ },
  "explanations": [ /* last 10 Explanation, newest first */ ],
  "metrics": { /* Metrics */ },
  "weather": { /* Weather */ },
  "pending": [ /* Pending */ ],
  "capacity": { /* Capacity */ },
  "log_tail": [ /* last 20 event log entries, newest first */ ]
}
```

---

## 6. WebSocket `/ws`

- Server to browser only (actions use REST). The browser may send `{"type":"ping"}`; reply `{"type":"pong"}`.
- On connect: send one `snapshot` immediately.
- Envelope for every message:
```json
{ "type": "poses", "t": 134.2, "seq": 5812, "data": { } }
```
`seq` increases by 1 per message per connection (the dashboard uses it to detect gaps and re-fetch `/state`).

| type | When | `data` |
|---|---|---|
| `snapshot` | On connect, after `/run`, after any reset | `Snapshot` |
| `clock` | Every second, and on play/pause/speed change | `Clock` |
| `poses` | ~5 Hz | `{ "tractors": [ { "id", "status", "manual", "pose", "tool", "fuel_pct", "current_job", "agopenweb" } ] }` only tractors that changed |
| `fleet` | Tractor added, removed, status/lifecycle change, implements change | `{ "tractors": Tractor[] }` full list |
| `jobs` | Job status/progress change (progress throttled to ~1 Hz) | `{ "jobs": Job[] }` only changed jobs |
| `plan` | Every applied plan | `Plan` |
| `explanation` | Every re-plan and notable event | `Explanation` |
| `metrics` | Every 2 s, and after a job completes | `Metrics` |
| `weather` | When conditions or spray permissions change | `Weather` |
| `coverage` | ~1 Hz, per tractor that painted | `{ "tractor": "T3", "cell_m": 0.5, "origin": { "lat": 33.2, "lon": -111.62 }, "cells": [[x, y, rgb_int], ...] }` |
| `pending` | Added or resolved | `{ "pending": Pending[] }` full current list |
| `capacity` | Pool change | `Capacity` |
| `log` | Each new event log line | One event log entry (Section 7) |

### Throttling rules
- `poses`: at most 5 per second, batched across all tractors (one message per tick, never one per tractor).
- `jobs` progress: at most 1 per second per job.
- `coverage`: at most 1 per second per tractor; send only new cells since the last message.
- Never forward raw AgOpenWeb frames.

---

## 7. Event log (hand-in artifact)

File `event_log.jsonl`, one JSON object per line, also streamed as WS `log` and served by `GET /api/log`.
```json
{"t": 0, "kind": "plan", "plan_version": 1, "solver": "ortools", "solve_ms": 610, "assigned": 12}
{"t": 120, "kind": "event", "type": "breakdown", "tractor": "T1", "issue": "hydraulic leak"}
{"t": 120, "kind": "replan", "trigger": "breakdown", "plan_version": 2, "replan_ms": 840, "changes": [{"job": "J1", "from": "T1", "to": "T3", "progress_kept": 0.6}], "safety": "pass", "explanation_id": "X2"}
{"t": 176, "kind": "job_done", "job": "J1", "tractor": "T3", "on_time": true}
{"t": 181, "kind": "operator_action", "tractor": "T2", "control": "implements", "old": ["mower"], "new": ["mower", "sprayer"], "replanned": true}
{"t": 200, "kind": "tractor_added", "tractor": "T4", "host": "laptop-p2", "endpoint": "ws://192.168.1.24:5175/ws"}
{"t": 205, "kind": "agopenweb", "tractor": "T3", "what": "job_started", "detail": {"field": "Block_E", "ab": [33.2, -111.61, 33.2, -111.605]}}
{"t": 260, "kind": "violation", "rule": "fuel_reserve", "tractor": "T2", "detail": {}}
```
Every log line has `t` and `kind`. `kind` values: `plan`, `event`, `replan`, `job_started`, `job_done`, `job_dropped`, `operator_action`, `tractor_added`, `tractor_removed`, `tractor_ready`, `mechanic_search`, `mechanic_booked`, `tractor_repaired`, `weather`, `agopenweb`, `safety_reject`, `violation`.
Write a separate file per run: `event_log_ours.jsonl`, `event_log_baseline.jsonl`.

---

## 8. Backend rules the dashboard relies on

1. **Single source of truth.** One in-memory state store. REST responses, WS messages, and the log are all built from it, so they never disagree.
2. **Every applied plan has passed the Safety Agent.** A rejected plan is never sent as `plan`. Rejections go to the log as `safety_reject`.
3. **Every re-plan sends three things, in this order:** `plan`, `explanation`, `jobs` (changed ones). The dashboard animates the timeline on `plan` and types the explanation on `explanation`.
4. **Work is never lost or duplicated.** A reassigned job keeps `progress`; `remaining_min` shrinks accordingly.
5. **Tractor colors** assigned by order of creation, then repeat: `#0A84FF`, `#BF5AF2`, `#FF9F0A`, `#30D158`, `#FF375F`, `#5E5CE6`, `#64D2FF`, `#FFD60A`.
6. **No fleet-size cap in code.** Lists, never fixed-length arrays. `AT_CAPACITY` only when the compute pool is actually full.
7. **Deterministic runs.** Same scenario + same events = same plans (seed any randomness). Ours and baseline use identical scenario, events, weather, and fleet changes.
8. **Timeouts.** REST calls return within 2 s. Anything slower (adding a tractor, a big re-plan) returns immediately with an accepted status and finishes over WebSocket.

---

## 9. Pydantic models (copy into `app/models.py`)

```python
from typing import Literal, Optional, Union
from pydantic import BaseModel, Field

TractorStatus = Literal[
    "starting", "ready", "idle", "traveling", "working", "refueling", "waiting_weather",
    "broken", "awaiting_mechanic", "repair_scheduled", "repairing", "removing", "offline",
]
JobStatus = Literal["pending", "assigned", "traveling", "working", "paused", "done", "dropped"]
JobType = Literal["spray", "mow", "hedge", "haul_bins"]
Implement = Literal["sprayer", "mower", "hedger", "bin_trailer"]
PlanKind = Literal["travel", "work", "refuel", "wait", "swap_implement"]
RunMode = Literal["ours", "baseline", "both"]


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
    solver_status: Literal["feasible", "optimal", "fallback", "no_feasible_plan"]
    diff: PlanDiff = Field(default_factory=PlanDiff)


class Explanation(BaseModel):
    id: str
    t: float
    trigger: str
    text: str
    facts: dict
    plan_version: Optional[int] = None


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


class ControlOption(BaseModel):
    value: Union[str, int, float, bool]
    label: str


class Control(BaseModel):
    id: str
    tab: Literal["Drive", "Guidance", "Implement", "Vehicle", "Fleet", "Advanced"]
    label: str
    type: Literal["button", "toggle", "slider", "number", "select", "map_pick", "text"]
    min: Optional[float] = None
    max: Optional[float] = None
    step: Optional[float] = None
    unit: Optional[str] = None
    options: Optional[list[ControlOption]] = None
    needs_manual: bool = False
    replans: bool = False
    help: Optional[str] = None


class WhyOption(BaseModel):
    tractor: str
    feasible: bool
    reason: Optional[str] = None
    finish_t: Optional[float] = None
    travel_delta_min: Optional[float] = None
    idle_delta_min: Optional[float] = None
    deadlines_missed: list[str] = Field(default_factory=list)


class Why(BaseModel):
    job: str
    chosen: Optional[str]
    options: list[WhyOption]
    method: Literal["counterfactual", "estimate"]


class Preview(BaseModel):
    allowed: bool
    refused_reason: Optional[str] = None
    plan: Optional[Plan] = None
    explanation: Optional[Explanation] = None
    metrics_delta: dict = Field(default_factory=dict)


class WsMessage(BaseModel):
    type: str
    t: float
    seq: int
    data: dict
```
Note on `MovedJob`: Python can't use `from` as a field name, so the model uses `from_` with alias `"from"`. Serialize with `model.model_dump(by_alias=True)` so the JSON key is `from`.

---

## 10. FastAPI skeleton (copy into `app/main.py` and fill in)

```python
import asyncio
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Harvest Fleet AI")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory="static"), name="static")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict | None = None):
        self.status, self.code, self.message, self.details = status, code, message, details or {}


@app.exception_handler(ApiError)
async def api_error_handler(_, exc: ApiError):
    return JSONResponse(status_code=exc.status,
                        content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}})


class Hub:
    """Broadcasts WS messages to every connected dashboard."""

    def __init__(self):
        self.clients: dict[WebSocket, int] = {}

    async def connect(self, ws: WebSocket, snapshot: dict, t: float):
        await ws.accept()
        self.clients[ws] = 0
        await self.send(ws, "snapshot", t, snapshot)

    def disconnect(self, ws: WebSocket):
        self.clients.pop(ws, None)

    async def send(self, ws: WebSocket, type_: str, t: float, data: dict):
        self.clients[ws] += 1
        await ws.send_text(json.dumps({"type": type_, "t": t, "seq": self.clients[ws], "data": data}))

    async def broadcast(self, type_: str, t: float, data: dict):
        for ws in list(self.clients):
            try:
                await self.send(ws, type_, t, data)
            except Exception:
                self.disconnect(ws)


hub = Hub()


# --- state access (replace with the real state store in core/) ---
def snapshot() -> dict:
    raise NotImplementedError


def current_t() -> float:
    raise NotImplementedError


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await hub.connect(ws, snapshot(), current_t())
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg.get("type") == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        hub.disconnect(ws)


# --- REST (fill each in from core/ and agents/) ---
@app.get("/api/state")
async def get_state(): return snapshot()

@app.get("/api/scenario")
async def get_scenario(): ...

@app.post("/api/run")
async def post_run(body: dict): ...

@app.post("/api/clock")
async def post_clock(body: dict): ...

@app.get("/api/jobs")
async def get_jobs(): ...

@app.post("/api/jobs")
async def post_jobs(body: dict): ...

@app.patch("/api/jobs/{job_id}")
async def patch_job(job_id: str, body: dict): ...

@app.post("/api/events")
async def post_event(body: dict): ...

@app.get("/api/fleet")
async def get_fleet(): ...

@app.post("/api/fleet", status_code=202)
async def post_fleet(body: dict): ...

@app.delete("/api/fleet/{tractor_id}")
async def delete_fleet(tractor_id: str): ...

@app.get("/api/hosts")
async def get_hosts(): ...

@app.get("/api/tractors/{tractor_id}/controls")
async def get_controls(tractor_id: str): ...

@app.post("/api/tractors/{tractor_id}/control")
async def post_control(tractor_id: str, body: dict): ...

@app.post("/api/tractors/{tractor_id}/preview")
async def post_preview(tractor_id: str, body: dict): ...

@app.post("/api/tractors/{tractor_id}/manual")
async def post_manual(tractor_id: str, body: dict): ...

@app.get("/api/why/{job_id}")
async def get_why(job_id: str): ...

@app.get("/api/mechanics")
async def get_mechanics(tractor: str): ...

@app.post("/api/mechanics/book")
async def post_book(body: dict): ...

@app.post("/api/approve")
async def post_approve(body: dict): ...

@app.get("/api/weather")
async def get_weather(): ...

@app.get("/api/metrics")
async def get_metrics(): ...

@app.get("/api/log", response_class=PlainTextResponse)
async def get_log(): ...

@app.post("/api/scale-test")
async def post_scale_test(body: dict): ...


# --- background loop: tick the world, push throttled WS messages ---
async def tick_loop():
    while True:
        # 1. advance clock, read gateway poses, update job progress, check events and weather
        # 2. run Safety Agent invariants
        # 3. broadcast: poses (<=5 Hz), jobs (<=1 Hz progress), metrics (every 2 s), clock (1 s)
        await asyncio.sleep(0.2)


@app.on_event("startup")
async def start_background():
    asyncio.create_task(tick_loop())
```
Replace the `body: dict` parameters with the Pydantic request models once the models are in place; keep the JSON shapes identical.

---

## 11. Contract checks before the switch

1. `contract/examples/`: one JSON file per response and WS message type, copied from this doc. The dashboard mock uses these.
2. Backend test: call every endpoint and capture one of each WS message, validate them against the Pydantic models (Section 9). Run it before 1:30 and before 2:45.
3. **1:30 handshake:** `GET /api/state` and the `poses` stream live, dashboard on `?source=live`. Fix any mismatch then.
4. **2:45 switch:** full live. Compare `/openapi.json` against this doc.

## 12. Order to implement (backend)

1. `models.py`, `main.py` skeleton, `GET /api/state`, `/ws` with `snapshot` + `poses` from MockGateway. (Needed for the 1:30 handshake.)
2. `/run`, `/clock`, `clock`/`fleet`/`jobs`/`plan`/`metrics` messages.
3. `/events` with breakdown + re-plan + `explanation`.
4. AgOpenWeb gateway behind the same state store.
5. `/fleet` add/remove + `capacity`, `/hosts`.
6. `/why`, `/weather` + `weather` messages, `/mechanics`, `/approve` + `pending`.
7. `/tractors/{id}/controls`, `/control`, `/preview`, `/manual`.
8. `coverage` messages, `/scale-test`, `/log`.


## 13. Final brain/frontend contract — authoritative amendment

This section supersedes conflicting response descriptions, examples and skeleton code above. It is a decided implementation contract, not a proposal. Update the frontend mock and backend models together. Existing REST paths, units and the `plan -> explanation -> jobs` broadcast order remain unchanged.

### 13.1 Job and plan additions

Every Job includes `unassigned_reason: string | null`. Use `status: "pending"`, `tractor: null`, `start_t: null`, `end_t: null`, and `eta_t: null` when no assignment exists. Provide a concise reason such as "No operational tractor has a sprayer." Reconsider on future replans. Reserve `dropped` for explicitly cancelled work; never use it for temporary infeasibility.

Every Plan includes `solver_status`:

| Value | Meaning |
|---|---|
| `feasible` | Valid heuristic/solver schedule; optimality not established |
| `optimal` | Solver proved optimality for the configured model/objective |
| `fallback` | Primary optimization failed/timed out; a validated heuristic plan was applied |
| `no_feasible_plan` | No applicable valid plan was produced; retain valid previous operations |

Use `feasible` for an ordinary greedy run. Missing feasible assignments may appear in a partial valid plan; `no_feasible_plan` is an operation outcome, never a newly applied `plan` broadcast. On reset, the empty initial Plan has version 0 and status `feasible`. No other empty plan is presumed valid without validation. Both backends and frontend require this field.

### 13.2 Async mutation endpoints

The following existing endpoints ALWAYS return HTTP 202 and the Operation object below; they no longer return the original finished-plan bodies:

- `POST /api/run`
- `POST /api/jobs`
- `PATCH /api/jobs/{id}`
- `POST /api/events`
- `POST /api/tractors/{id}/manual`
- `POST /api/mechanics/book`
- `POST /api/approve`

Keep `/fleet` add/remove responses unchanged: lifecycle changes already arrive through fleet messages. Before fleet changes can execute stale work, pause affected execution and invalidate any older planning snapshot. These changes also use the planner's state-version gate.

`POST /api/tractors/{id}/control` remains synchronous for non-replanning controls, using its existing response. For controls whose schema says `replans: true`, reject with HTTP 409 `CONFLICT` while running; otherwise return HTTP 202 Operation and apply the control and valid plan atomically after success. Divi branches on the HTTP status for this endpoint.

Preview, Why and scale-test endpoints retain their existing shapes and have a bounded computation budget. Preview never applies state. If the two-second service budget cannot be met, return HTTP 503 with error code `TIMEOUT`; do not fabricate counterfactuals or scale results. Add `TIMEOUT` to the error enum. Expensive optional endpoints must not block FastAPI's event loop.

Request bodies are unchanged. Validate syntax, references and basic authorization before accepting; those errors remain ordinary HTTP 4xx responses. Perform expensive feasibility checks in the operation. Return 202 promptly after enqueueing; 202 means accepted, not applied.

### Operation

All keys are present; nullable fields are explicit nulls. IDs are unique strings such as `O17`.

```json
{
  "id": "O17",
  "kind": "replan",
  "status": "queued",
  "source": "events",
  "created_t": 120.0,
  "updated_t": 120.0,
  "message": "Breakdown recorded. Replanning unfinished work.",
  "plan_version": null,
  "solver_status": null,
  "result": null,
  "error": null
}
```

- `kind`: `run | replan | repair_booking | approval`.
- `status`: `queued | running | succeeded | failed | superseded`.
- `source`: `run | jobs | job_patch | events | manual | control | mechanics_book | approve`.
- `solver_status`: null or a value from Section 13.1.
- `error`: null or `{ "code": string, "message": string, "details": object }`, same error structure as REST.
- `plan_version`: applied plan version when one exists, otherwise null.
- `result`: null until successful, then one of:
  - `run/replan`: `{ "applied_plan_version": 8, "unassigned_job_ids": ["J9"] }`.
  - `repair_booking`: `{ "tractor": "T1", "mechanic": "M1", "arrival_t": 196, "estimated_return_t": 286 }`.
  - `approval`: `{ "pending_id": "P3", "decision": "approve", "applied_plan_version": null }` (integer if a plan was applied).

Failed operations never broadcast an invalid plan. Use `solver_status: "no_feasible_plan"` and a `SAFETY_REJECTED` error when no validated applicable plan exists. A partial valid plan with unassigned reasons is successful.

Apply breakdown stops immediately upon accepting the event, before LLM/planner work. Keep only unaffected operations that remain safe. A failed recovery plan never resumes a broken tractor. Repair ETA is advisory: booking does not make a tractor schedulable; require explicit return-to-service confirmation through `POST /api/events` with `{ "type": "tractor_repaired", "tractor": "T1" }`.

Plan-producing approvals cannot bypass constraints. The `override` decision rejects the proposal and leaves it unapplied; actual edits use job PATCH and must validate. Deadline edits must retain originals internally and in logs.

### 13.3 WebSocket and reconnection

Add WS message type `operation`; its `data` is the complete Operation, using the existing `t`, `seq`, `data` envelope. Emit on each lifecycle change. Ordinary WS message bodies remain unchanged apart from the new fields documented here.

An operation returning a new plan emits, in order:

1. `operation` running.
2. `plan` (validated, applied).
3. `explanation`.
4. `jobs` (changed jobs).
5. Other changed state messages, including `pending`, `fleet`, and `metrics` where needed.
6. `operation` succeeded, referencing the applied plan version.

The immediate breakdown status may be sent before replanning. No plan-producing operation succeeds until authoritative state has been updated. A new run sends a `snapshot` after reset and then its terminal operation update. Do not send unvalidated proposals as `plan`.

Add `operations: Operation[]` to Snapshot: all active operations plus the most recent 20 terminal operations, newest first. Add `GET /api/operations/{id}` returning Operation or HTTP 404. Retain operation records for the current server session; these are in-memory, not durable job-queue guarantees.

Use a monotonically increasing state version internally. A stale proposal cannot apply: recompute against fresh state or mark the old operation `superseded`. Never mark a superseded operation successful. Serialize state commits and give each socket one outgoing queue/writer to preserve seq and message order; do not use concurrent direct socket sends from REST and tick tasks. The skeleton Hub above must be replaced accordingly. Reset supersedes outstanding work; operation IDs remain unique across resets.

GET state / reconnect snapshot must restore applied truth and active operations. Clients must not infer failure merely because their REST connection timed out. Include optional request header `Idempotency-Key` on async mutations; retries with the same key and identical body return the original operation, while reuse for another endpoint/body returns 409 `CONFLICT`. Store keys for the server session, across resets.

### 13.4 Metrics additions

Add these nullable keys to both `RunMetrics` objects; retain existing fields:

```json
{
  "weighted_on_time": 18,
  "productive_min": 420.0,
  "original_deadline_on_time": 7,
  "replan_ms_last": 42.0,
  "rejected_candidates": 12
}
```

Use null until measured, never invented zeros. Baseline replan duration is null if not measured. Weighted on-time is the sum of priorities frozen when each job is completed; productive minutes count executed nonduplicated work. Original-deadline on-time uses the deadline at job submission. Rejected candidates are diagnostics, not executed violations. Existing `violations` measures executed/applied invariant failures. Show completion beside efficiency so idle-by-declining-work is not presented as an improvement.

### 13.5 Frontend implementation checklist (Divi)

- Read `unassigned_reason`; display on pending job cards/details; clear it on reassignment.
- Show `solver_status` in a small plan badge; never label feasible as optimal.
- Handle 202 on the listed mutations, track Operation.id, and display queued/running without replacing the applied plan with a preview.
- Use per-operation status; one completion must not clear another active operation's loading indicator.
- On succeeded, use streamed state or GET `/api/state`; use the operation result for booking/approval confirmation.
- Show failed errors in plain language; treat superseded as replaced, not successful.
- Restore operation state on snapshot/reconnect. Use idempotency keys for retries of the same action.
- Display extra metrics only when non-null; optional expanded scorecard. No agent chat/LLM metrics required.
- No public `state_version` or work-unit UI is required; backend derives existing progress fields.

### 13.6 Backend implementation checklist (Anay + Diya)

- Add shared Pydantic Operation models and explicit enum/range validation; do not return untyped alternate bodies.
- Anay owns queueing, authoritative state, API/WS delivery, idempotency, and safe execution.
- Diya returns proposals, validation, unassigned reasons, solver status and decision facts without mutating world state.
- Implement with MockGateway first. AgOpenWeb is an interchangeable gateway; do not block the core on multi-host integration.
- Update OpenAPI, frontend mocks and contract fixtures before switching to live. Example fixtures are in `contract/examples/brain/`; they contain synthetic data, not benchmark claims.

### 13.7 Operation Pydantic models

```python
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

class Operation(BaseModel):
    id: str
    kind: Literal["run", "replan", "repair_booking", "approval"]
    status: Literal["queued", "running", "succeeded", "failed", "superseded"]
    source: Literal["run", "jobs", "job_patch", "events", "manual", "control", "mechanics_book", "approve"]
    created_t: float
    updated_t: float
    message: str
    plan_version: Optional[int]
    solver_status: Optional[Literal["feasible", "optimal", "fallback", "no_feasible_plan"]]
    result: Optional[Union[PlanOperationResult, RepairOperationResult, ApprovalOperationResult]]
    error: Optional[OperationError]
```

Enforce result-kind matching and terminal-state consistency in service validation: succeeded requires the appropriate result and null error; failed requires error and null result; queued/running/superseded have null result. A new Snapshot model must include `operations: list[Operation]`. Optional metrics keys must be serialized even when null.

# agopenweb-bridge

Real **AgOpenWeb** tractors (the .NET rewrite of AgOpenGPS, `github.com/AgOpenGPS-Official/AgOpenWeb`), running headless in Docker and served to our dashboard through the same REST and WS contract as `ARCHITECTURE.md`. The folder also works as a **test harness and protocol reference** for the real gateway (Anay). It is not a competing backend: it **bypasses our Python scheduler** (`backend/app/brain`) and has no planner, weather model, mechanic flow or baseline. Its scorecard travel, idle and violation zeros are placeholders, not measured coordinator results. The scored coordinator demo is Anay's FastAPI backend (`backend/`, `:8000`); keep it separate from this bridge (`:8040`). In the UI, the badge says which backend is connected; only a tractor with `agopenweb` non-null (card: "AgOpenWeb connected · heartbeat") is a real AgOpenWeb tractor.

Verified against AgOpenWeb commit `19c15c1` (2026-11-15), `.NET SDK 10.0.404`, Docker Desktop 28.5 on an Apple-silicon Mac (arm64).

## What is real and what is stubbed

| Real (from AgOpenWeb) | Stubbed (bridge only) |
|---|---|
| Tractor pose, heading, speed and tool pose, from Tick frames at about 10 Hz | Plan: one job per tractor (one block each), no optimizer, no travel between blocks |
| Autosteer following an AB line (cross-track error stays under 2 cm on straights) | Clock: farm time = 8:00 AM + real time × `PACE` (display only) |
| AgOpenWeb's own U-turns at the block boundary (`youturn`, radius set by us) | Weather (calm, spraying allowed), metrics (counts only), fuel (static) |
| Section control and coverage painting (frames types 3 and 4, 0.1 m cells) | Hot-seat mode: tractors not in a container are driven by `lib/blockpath.mjs`, which follows the same passes and U-turn geometry |
| Deadman: autosteer and sections drop about 1.7 s after the heartbeat stops | `/why`, `/preview`, `/jobs` POST/PATCH, mechanics, approvals: these return 501 `NOT_IMPLEMENTED`, so a UI breakdown can only be repaired with `POST /api/events {"type":"tractor_repaired"}`. `/api/clock` (pause/speed) is accepted but ignored. Job completion (the last pass) and the `/api/run` reset are coded but not watched end to end |
| Every control in the Controls sheet maps to a real AgOpenWeb command (table below) | Breakdown and repair events only (`POST /api/events` with `breakdown` or `tractor_repaired`) |

## Commands (for Divi)

```bash
cd agopenweb-bridge
npm install                          # ws only
./run-agopenweb.sh                   # once: clones AgOpenWeb to .agopenweb-src/, builds agopenweb:headless (~35 s publish + SDK pull), runs it on :5174
./run-agopenweb.sh stop              # stop that single container (the image stays)

# One real tractor, driven from the terminal; writes captures/agopenweb-A-<stamp>.jsonl
node demo.mjs --seconds=80 --deadman  # needs ./run-agopenweb.sh running

# Contract server (it starts and stops its own containers; stop the single one above first)
node agopenweb-bridge/server.mjs                                  # hot-seat: 3 tractors (max 5), 1 real slot   (run from the repo root)
MAX_TRACTORS=3 REAL_SLOTS=3 node agopenweb-bridge/server.mjs      # full: one container per tractor
# dashboard: http://localhost:5173/?source=live&api=http://localhost:8040
node agopenweb-bridge/record-ws.mjs --seconds=60                  # record what the dashboard receives
npm test                                                          # decoder tests (no Docker)
```

Run the server **by path** (`node agopenweb-bridge/server.mjs`, not `node server.mjs`). Other tools in this repo run `pkill -f "node server.mjs"`, which would match the short form. Ctrl-C stops the server, and it then removes every container labelled `aow-bridge=1`.

Server env: `PORT=8040`, `MAX_TRACTORS=5` (the hackathon cap; `AT_CAPACITY` beyond it), `REAL_SLOTS=1`, `START_TRACTORS=3`, `KPH=12`, `PACE=10`, `AOW_IMAGE=agopenweb:headless`, `AOW_BASE_PORT=5174`, `AOW_MEMORY=512m`, `AOW_CPUS=2`, `PREWARM=1`, `DEMOTE_IDLE_S=20` (a real tractor whose job is done is demoted after this; a tractor handed back to the AI stays real until another tractor needs the slot), `COV_CELL_M=2`, `COVERAGE_COLOR=tractor|agopenweb`, `AOW_ENDPOINTS=ws://hostA:5174/ws,ws://hostB:5174/ws` (use existing instances and skip Docker). `GET /api/bridge` shows the slots, promotion latencies, frame counts, decode errors and `docker stats`.

## Files

| File | What |
|---|---|
| `Dockerfile` | Multi-stage build: `mcr.microsoft.com/dotnet/sdk:10.0` publishes `Platforms/AgOpenWeb.Desktop` (`-p:DesktopOnly=true`, untrimmed), then `mcr.microsoft.com/dotnet/runtime:10.0` runs it non-root with `--headless`. The build context is an AgOpenWeb checkout. The only download outside nuget.org is the SHA-256-pinned SharpIsoTerm `.nupkg` that AgOpenWeb's own csproj fetches. |
| `run-agopenweb.sh` | Builds once and runs one container (`--memory=2g --cpus=2`, publishes `127.0.0.1:5174` only). |
| `lib/wire.mjs` | The WireCodec decoder (Tick, Scene, CoverageInit, CoverageCells, ControlState, Hello, Prompt, Toast) plus an encoder for tests. Strict: any unread byte throws, so layout drift is caught. |
| `client.mjs` | `AgOpenWebClient`: one connection to one tractor. Acquires control, heartbeats every 0.4 s, sends toggles only when the Tick flag differs, provides `waitForTick`, and wraps fields/AB lines/tool/U-turn plus `startJob` / `stop` / `resume` / `pose` / `status`. |
| `demo.mjs` | Drives one job on Block A and records `captures/agopenweb-*.jsonl`. With `--deadman` it also measures the deadman. |
| `server.mjs` | Contract server: N tractors, hot-seat or full mode, controls, operations, capacity. |
| `lib/blockpath.mjs` | Block boustrophedon path, used by the sim, for handoff, and for projecting a real pose to job progress. |
| `lib/farm.mjs`, `scenario.json` | Block → AgOpenWeb field geometry. `scenario.json` is a copy of the dashboard mock's static farm (same 8 blocks and `geo`). |
| `lib/docker.mjs` | Thin `docker` CLI wrapper (execFile, labels, loopback ports, caps, stats). |
| `record-ws.mjs` | Records the bridge's contract-shaped WS stream. |
| `captures/agopenweb-A-*.jsonl` | **Real AgOpenWeb frames**, decoded. The first Scene, first 5 Ticks, every CoverageInit and first 5 CoverageCells also carry `raw_b64` (the exact bytes). |
| `captures/bridge-ws-*.jsonl` | **Contract WS messages** as the dashboard receives them (full mode, 3 real tractors, including a remove and re-add of T3). |

## Protocol notes (observed live, not just read)

**Transport.** HTTP and WebSocket both use port 5174 (`ws://host:5174/ws`). The server binds `0.0.0.0` with a raw `TcpListener` (not Kestrel). Client→server messages are **text** frames, `cmd` or `cmd|arg`. Server→client messages are **binary** frames: byte 0 is the type, then .NET `BinaryWriter` little-endian fields.

- **Strings are `i32 byte length` + UTF-8** (`WireCodec.WriteStr`), **not** 7-bit-length-prefixed as PROJECT.md Change 7 says.
- Point lists are `i32 count` + count × (`f32 E`, `f32 N`). An optional point list is `u8 present` and then the list.

**Connection and control.**
- On connect AgOpenWeb sends Hello (7: `str clientId`, `u8 features`), Scene (1), ControlState (6) and a seed of other frames.
- **Control is first-come** (`WebSocketHub`/`ControlAuthority.Acquire`): the first connection becomes the controller, named "Browser" until it sends `control.acquire|<name>`. Later connections are observers and their `control.acquire` is **denied, with no takeover**, until the holder releases, drops or is deadman-revoked.
- So **`demo.mjs`, `server.mjs` and AgOpenWeb's own web UI cannot drive the same container at once**. The server logs it if another client holds control. Observers still get the frame stream (read from source, not tested with two sockets).
- ControlState is `u8 held`, `str holderId`, `str holderName`. You hold control when `holderId` equals your Hello `clientId`.
- **Deadman:** with no `control.presence` for more than 1500 ms (`ControlAuthority.DeadmanMs`), control is revoked and autosteer and sections turn off. We measured **1570–1674 ms** (2 runs) from the last heartbeat to `autosteer=0`, with toast "AutoSteer and the sections turned off … its link went quiet". Re-acquire with `control.acquire`.
- The simulator is **enabled at boot**, at fix 4 and origin 40.7128,-74.006 (NYC). Do not send `sim.toggleEnable` blindly, because it is a toggle.

**Commands used and verified**

| Command | Arg | Notes |
|---|---|---|
| `control.acquire` / `control.presence` / `control.release` | name / none / none | Heartbeat every 0.4 s |
| `sim.setCoords` | `lat,lon` | Re-initialises the simulator: **heading is reset to north** (`GpsSimulationService.Initialize` sets `_headingRadians = 0`), speed is kept |
| `sim.reverseDir` | none | Heading +180°. Together with setCoords this is the only heading control (there is no set-heading) |
| `sim.speedUp` / `sim.speedDown` / `sim.stop` | none | ±**0.5 km/h** per step. There is no set-speed, so we send `sim.stop` then N × speedUp (12 km/h = 24 sends) |
| `sim.setSteer` / `sim.steerReset` | degrees | Manual steering; verified with a circle at 21° |
| `field.new` | name | Field **origin = the current sim position**, so we teleport to the block's SW corner first. Ignored while another field is open |
| `boundary.fromMapPoints` | `e,n;e,n;…` (field metres) | Outer boundary; needed for U-turns. It also triggers an imagery fetch, which fails offline (toast only) |
| `field.openOnly` | name | Opens an existing field and teleports the sim to its origin. About 0.2 s. **Ignored while a field with unsaved coverage is open** |
| `field.close` | none | If coverage was painted with no job open, AgOpenWeb raises the **unsaved-coverage guard** and the close waits silently. Answer `coverage.saveJob` (or `coverage.discardClose`). `client.closeField()` does this |
| `track.latLonAB` | `latA,lonA,latB,lonB` | Needs an open field. The track is named "AB 360°" / "AB 180°" from its bearing. **The line is the EDGE between passes**: AgOpenWeb drives pass centres at ±(m+½)·toolWidth from it (`RefSideOffset`/`PassGeometry`). An AB laid on the intended pass centre made the tractor drive half a width beside it. We send the line on a pass edge and verified pass centres at E = 3.00 (northbound) and E = 21.02 (southbound) with xte 0 |
| `section.master` / `youturn.toggle` / `autosteer.toggle` / `youturn.direction` | none | Toggles. Read the true state from Tick flags (`sectionMaster`, `youturn`, `autosteer`, `turnIsLeft`) |
| `config.set` | `key:value` | `tool.defaultSectionWidth` is in **cm**, then `tool.numSections:N`. `uturn.radius:3` and `uturn.distanceFromBoundary:0.5` let a 6 m implement turn onto the next pass. With the defaults (8 m radius) AgOpenWeb refuses: "No U-turn fits inside the boundary at this end". Also `autosteer.maxSteerAngle`, `vehicle.wheelbase` |
| `track.swapAB`, `track.nudgeLeft/Right`, `track.snapLeft/Right` | none | Mapped in the controls; sent, but not individually verified |

**Tick (type 2)**, `WireCodec.EncodeTick`. The fixed prefix:

```
off  type  field                 observed units
0    u8    type = 2
1    i64   sceneVersion          bumps on Scene changes (AB line, field, tool)
9    f64   E                     m, field-local (origin = open field's origin; 0,0 when no field)
17   f64   N                     m
25   f32   heading               RADIANS, 0 = north, clockwise (dead-reckoned "render" pose)
29   f32   speed                 METRES PER SECOND (2 x speedUp -> 0.278)
33   u8    fix                   4 in sim
34   i32   nSections
38   u8[n] section state         0 off, 2 auto-on (painting), 4 seen briefly while engaging, 5 seen when out of bounds
```

After the sections the fields are variable-offset, in this order: `f32 crossTrackError` (m), `u8 guidanceActive`, `str lineLabel` (e.g. "↑1L"), `str activeTrackName` (empty = none), `f64 toolE`, `f64 toolN`, `f32 toolHeading` (radians), `u8 toolReady`, `u8 autosteer`, `u8 autosteerAvailable`, `u8 contour`, `u8 sectionMaster`, `u8 sectionManualAll`, `u8 youturn`, `u8 turnIsLeft`, `f32 distanceToTrigger`, `u8 activeTrackClosed`, `f32 roll`, `u8 headlandOn`, `u8 sectionInHeadland`, `u8 autoTrack`, `u8 skipRows`, `u8 skipMode`, `u8 tramMode`, `f32 headlandProximityDistance`, `u8 headlandProximityWarning`, `f32 steerAngleError`, 4 × `f32` chart values, `f64 hitchE`, `f64 hitchN`, `f32 vehicleSteerAngle`, `f64 hostMs`, `u8 youturnExecuting`, `i32 passNumber` (0 = the reference line, ±1 per pass), `f32 nudgeOffset`, `f32 refNudgeMoved`, `u8 refNudgePending`, `u8 hasGoal`, `f64 goalE`, `f64 goalN`, `u8 reverse`, `u8 moduleNotSteering`, `f32 chartGpsHeading`, `u8 tramLights`, `u8 outOfBounds`, `u8 contourAhead`, `f32 contourAheadM`. `lib/wire.mjs` `TICK_FIELDS` is the single source.

Ticks arrive at **about 10 Hz** (1062 in 106 s).

**Scene (type 1):** `i64 version`, `f64 originLat`, `f64 originLon`, `u8 hasField`, `str fieldName`, boundaries, tracks, `optPts headland`, `optPts guidanceLine`, tool sections (`f32 left`, `f32 right` per section, in m relative to the centre: implement width = max(right) − min(left)), and then the rest as in `decodeScene`. It is re-sent on every change and can be large (one was 759 KB when the AB line was created). **The field origin (originLat/Lon) is only in the Scene**, so keep the latest one.

**CoverageInit (type 3):** `f64 cellSize` (0.1 m), `f64 originE`, `f64 originN`, `i32 width`, `i32 height`, `u8 reset`.
- Cell `(x, y)` covers E = originE + x·cellSize and N = originN + **y·cellSize (y grows NORTH)**. We verified this by driving north and watching `cellY` rise.
- `reset=1` means drop everything (a snapshot follows). `reset=0` means the grid grew, so re-anchor.
- An all-zero init with reset=1 means no field.
- After `field.new` alone the grid was about 5000 × 5001 (±250 m). Once the boundary was set it shrank to 2601 × 2201 (the boundary ±50 m).

**CoverageCells (type 4):** `i32 intCount` (= 3 × cells) and then flat `i32` triples `[cellX, cellY, packed]`.
- `packed = alpha<<24 | R<<16 | G<<8 | B`. Alpha is the covered fraction, and **a cell is re-sent with rising alpha**.
- Observed colour `0x98FB98` (packed `0xFF98FB98`).
- A 6 m implement at 12 km/h produces about 2000 cells/s in roughly 10 frames/s.

**Prompt (type 22):** `i32 seq`, `u8 kind`, `str title`, `str message`, `str confirm`, `str cancel`, `str checkbox`, `u8 checked`. Answer with `prompt.answer|seq,1|0,1|0`. None appeared in our flows. The unsaved-coverage guard is a Status-frame flag, not a Prompt.

## Coordinate systems and mapping to our contract

1. **AgOpenWeb field-local E/N (m)** → **lat/lon**, using the open field's Scene origin and AgOpenWeb's own web-client flat-earth formula: `lat = lat0 + N/111320`, `lon = lon0 + E/(111320·cos lat0)` (`lib/geo.mjs`).
   - **Calibration:** we teleported to a known lat/lon and compared the result with the Tick. The error was 0.04 / 0.14 m at (40 m, 40 m) and 0.15 / 0.36 m at (150 m, 100 m). That is about 0.3 % against the host's own `LocalPlane`, and fine for drawing.
2. **lat/lon → grid** (`Scenario.geo`, the same as `dashboard/src/lib/geo.js`): `x = (lon − origin_lon)·mLon/cell_m`, `y = (origin_lat − lat)·111320/cell_m`. Here y grows south and the origin is the centre of cell (0,0).
3. **One AgOpenWeb field per block:**
   - Field `Block_<id>` has its origin at the block's **SW corner**, which is the grid point `(x − 0.5, y + h − 0.5)`.
   - Its boundary is the block rectangle (160 m × 120 m for A–D, 160 m × 160 m for E–H).
   - Passes run north–south, toolWidth apart, with the first one toolWidth/2 inside the west edge and 8 m headlands. U-turns turn into the block (right on northbound passes, left on southbound).
   - The AB we **send** for pass k is its west edge (`passAB(k)`). The line we **draw and log** as `ab` is the pass centre (`passCenter(k)`), and the log also carries `ref_ab`.

**Contract fields filled from AgOpenWeb**

| Contract | Source |
|---|---|
| `pose.lat/lon` | Tick E/N via the Scene origin |
| `pose.x/y` | lat/lon via `scenario.geo` |
| `pose.heading_deg` | Tick heading (rad → deg) |
| `pose.speed_mph` | Tick speed (m/s × 2.237) |
| `tool.lat/lon/heading_deg` | Tick toolE/toolN/toolHeading |
| `tool.width_m` | Scene section span |
| `agopenweb.endpoint` | Slot URL |
| `agopenweb.connected` | Socket open |
| `agopenweb.heartbeat_age_ms` | Time since our last `control.presence` |
| `agopenweb.autosteer` / `section_master` / `youturn` | Tick flags |
| `agopenweb.*` extensions | `real: true`, `slot`, `container`, `tick_age_ms`, `field`, `cross_track_error_m`, `sections[]`, `has_control` |
| Job `progress` | The real pose projected onto the block path (monotone, at most 6 m off the path) |
| `coverage` | AgOpenWeb's 0.1 m cells, aggregated into `COV_CELL_M` (2 m) cells (a cell is painted when about 35 % of its fine cells are) |
| AB line | Logged as `{kind:"agopenweb", what:"job_started", detail:{ab:<pass centre>, ref_ab:<edge line sent>}}`. This is the log entry the dashboard reads for the AB line. An operator-picked `ab_line` control is sent as-is, so that tractor drives half a width beside the tapped line |

`agopenweb` is **null while a tractor is simulated**. The UI chip says "AgOpenWeb connected · heartbeat …" only for tractors that are really in a container.

The bridge sends coverage as `cell_m: 2`, with `origin` at the **farm's NW corner** (grid −0.5, −0.5) and **y growing south**. This is deliberate: the dashboard guesses the axis from where the origin sits (`coverageYSign`), and a NW origin makes that guess correct. Verified in Chrome: `coverageOutside: 0`.

## Hot-seat mode (REAL_SLOTS < MAX_TRACTORS)

All tractors run in the bridge sim until an operation needs AgOpenWeb. That means `POST /tractors/{id}/manual {on:true}`, or any AgOpenWeb control (Drive, Guidance, Implement or Vehicle tabs, or Advanced `config.set`).

1. **Promote.** Take a free warm slot, or demote the least-recently-used non-manual real tractor. Then hand over:
   - `field.openOnly Block_X` (closing the old field and answering the unsaved-coverage guard)
   - tool width and sections, then U-turn radius
   - autosteer off and `sim.stop`
   - `sim.setCoords` to the simulated position on the current pass (or the start of the next pass if it was mid U-turn), plus `sim.reverseDir` if the pass is southbound
   - `track.latLonAB` for that pass
   - section master, U-turns on, turn direction
   - then autosteer and 12 km/h if the AI is driving, or stopped if manual
2. **Demote.** Project the final real pose onto the block path (keeping the progress), stop the container tractor (`sim.stop`, autosteer and sections off), then continue in the sim from there.
3. **Coverage history** lives in the bridge's grid, so it stays continuous across promote and demote. The container's coverage is only a live source while the tractor is promoted.
4. **Every promote, demote and job start** is logged as `kind: "agopenweb"`, with `promote_ms`.
5. **Handing back to the AI** while promoted (`manual {on:false}`) re-runs the handoff from the job's progress point. The tractor snaps back onto its pass, so any manual detour is not kept.

## Measurements (this Mac: 16 GB RAM; Docker VM 7.65 GiB, 8 CPUs)

| What | Number |
|---|---|
| Image `agopenweb:headless` | 735 MB. Publish step 33 s (plus SDK image pull) |
| Container boot until WS connected | 1.2–1.3 s |
| **RAM per container** | Idle 117 MiB. Working (autosteer + painting) 124–137 MiB. Peak seen 137 MiB against a 512 MiB cap |
| **CPU per container** | Idle about 7 %. Working 7.5–10.5 % of one core |
| `docker pause` | 0 % CPU, RAM unchanged (116 MiB). The tractor freezes in place. **It does NOT trip the deadman**: in a 3 s pause test, the heartbeats buffered in TCP arrived on unpause, and autosteer, sections and control were all still held |
| **Promotion (hot-seat)** | **0.9–1.6 s** with prewarmed fields. 1.4–2.0 s when the block field has to be created. A control call that includes demoting the previous tractor takes 1.4–1.8 s end to end. Prewarming all 8 fields takes 6.8 s once at boot |
| Add tractor, full mode | `starting` → `working` in about 2.6 s (container boot plus handoff) |
| Deadman | 1570–1674 ms (2 runs) from the last heartbeat to autosteer off |
| Bridge → dashboard WS | Poses 5 Hz (changed only), coverage 1 Hz per tractor, no seq gaps |

**Recommendation.**
- At about 135 MiB and about 10 % CPU per working tractor, **full mode with 3 containers costs about 0.4 GB RAM and a third of a core**. On this Mac that is cheaper than the browser tab. Use `MAX_TRACTORS=3 REAL_SLOTS=3` for the demo, so every tractor is honestly real and there are no handoff snaps.
- The Docker VM (7.65 GiB) could hold about 30 containers at a 256 MiB cap, but CPU (the repo warns that a CPU-starved instance falsely drops autosteer) and the browser will run out first. Treat about 10–12 per laptop as the practical ceiling.
- Keep hot-seat (`REAL_SLOTS=1`) for large simulated fleets or for weaker laptops.
- `docker pause` saves CPU but not RAM, and it freezes the tractor. It is **not** the "dramatic deadman" of PROJECT.md Change 3, because the deadman never fires. To show the deadman, stop the gateway's heartbeat (kill the gateway process, or run `demo.mjs --deadman`) instead of pausing the container.

## Contract gaps found

1. **AB line has no field.**
   - Gap: the dashboard digs the AB line out of `log` entries (`kind: agopenweb`, `detail.ab`). There is no `Tractor.guidance`.
   - Proposal: `agopenweb.ab: [latA, lonA, latB, lonB] | null`, `agopenweb.pass: int`, `agopenweb.line_name`. AgOpenWeb itself moves the active line by ±toolWidth per pass (`passNumber`), so the reference AB is not the line being driven.
2. **Cross-track error.**
   - Gap: Change 7 lists it in the readout, but there is no contract field.
   - Bridge: we add `agopenweb.cross_track_error_m`. Proposal: make it official.
3. **Per-section state.**
   - Gap: there is no field for it.
   - Bridge: we add `agopenweb.sections` (raw bytes 0/2/4/5). Proposal: `sections: [{on, mode}]` plus `tool.sections_n`.
4. **Coverage axes, packing and extent.** The contract doesn't specify:
   - which corner `origin` is
   - whether y grows north or south
   - whether `rgb_int` carries alpha (AgOpenWeb sends ARGB with fractional alpha)
   - the cell size
   - the grid extent

   The dashboard guesses the axis from the origin's position. Proposal: add `y_axis: "south"|"north"`, `origin_corner: "nw"|"sw"`, `width`, `height`, and document `rgb_int` as 24-bit with alpha stripped. Also add a reset flag (`reset: true`) for when a field reloads, because AgOpenWeb has one.
5. **The snapshot has no coverage.** A reconnecting client misses history, so the bridge replays all of it as `coverage` messages straight after `snapshot`. Proposal: document this, or add a `coverage_url`.
6. **Heading on handoff.** AgOpenWeb has no set-heading command (only reset-to-north via setCoords and +180° via `sim.reverseDir`), so transit hand-offs (Change 3: "step the tractor with `sim.setCoords`") always face north or south unless the gateway steers.
7. **Speed control.** There is no set-speed, only ±0.5 km/h steps (`sim.speedUp`). A "Max speed" slider has to be sent as N commands, and the bridge tracks the commanded speed itself because nothing reads it back.
8. **`Tractor.agopenweb` honesty in hot-seat.** The contract has no way to say "this tractor can become real". The bridge uses `null` versus non-null plus a `real: true` extension. Proposal: `agopenweb.mode: "real"|"simulated"`.
9. **Capacity.** `max_tractors` per host is our configured limit, not measured. There is no field for warm vs bound slots beyond `warm`.
10. **Control values.** The Change 8 schema has no read-back for `config.set` keys (AgOpenWeb's Config frame, type 8, is not decoded yet). The bridge reports the last value it set, or null.

## For Anay: using this as your gateway's integration test

- **Golden bytes.** `captures/agopenweb-A-*.jsonl` contains real frames with `raw_b64`, plus the decoded value next to each. Your Python decoder should give the same numbers for every `raw_b64` line and consume every byte (`test/wire.test.mjs` does exactly this in JS). Note the i32 string-length prefix.
- **Behaviour checks to automate against one container** (`./run-agopenweb.sh`, then your gateway on `ws://localhost:5174/ws`):
  1. After `control.acquire`, ControlState `holderId` equals the Hello `clientId`.
  2. Field open/create:
     - `field.new` after teleporting to the block's SW corner produces a Scene with `originLat/Lon` equal to that corner.
     - Switching fields after painting needs `field.close` and then `coverage.saveJob`.
  3. `track.latLonAB` produces `guidanceActive=1` and a new `sceneVersion`. Autosteer then holds `|crossTrackError| < 0.05` m within about 10 s at 12 km/h.
  4. With `section.master` on, CoverageCells arrive and their cellY rises when driving north.
  5. U-turn: with `uturn.radius = toolWidth/2`, `youturnExecuting` goes 1 then 0 and `passNumber` changes by ±1.
  6. **Deadman:** stop `control.presence`; within about 1.7 s `autosteer` is 0 and the sections are 0.
  7. `stop()` is `sim.stop` plus toggles, after which the speed falls below 0.05 m/s.
- **Interface mapping.** `client.mjs` mirrors `TractorGateway` per tractor:
  - `pose()` → `Pose`
  - `stop()` / `resume()` → breakdown and repair
  - `startJob()` → `Work`
  - `setCoords` steps → `Travel`

  `server.mjs`'s pool is the fleet-level `add_tractor` / `remove_tractor`. Your `advance(dt)` would read `client.tick` rather than integrating.
- **Contract conformance.** Point the dashboard (or `mock-backend/smoke.mjs`-style checks) at `server.mjs` to see what a real AgOpenWeb fleet looks like on the wire. Diff your `/api/state` against `captures/bridge-ws-*.jsonl`.
- **Scaling across laptops (Change 9).**
  - Each laptop runs `run-agopenweb.sh` (or plain `docker run … -p 0.0.0.0:<port>:5174`, published on the LAN deliberately).
  - The bridge or gateway gets `AOW_ENDPOINTS=ws://laptop-a:5174/ws,ws://laptop-b:5174/ws,…` and skips local Docker.
  - Alternatively, point `DOCKER_HOST=ssh://user@laptop-b` at a remote Docker engine and run one pool per host, with `capacity.hosts[]` reporting one entry per host.
  - Every container has its own network namespace, so the single-instance lock and UDP 9999/8888 never collide. Only the WS port is published.

## Safety notes

- We built only from the official AgOpenWeb repo and Microsoft .NET images. We read the Dockerfile and `deploy/linux/package.sh` before building.
- Containers run as the non-root `app` user, publish only `127.0.0.1:<port>`, mount nothing from the host, and are capped by `--memory` and `--cpus`.

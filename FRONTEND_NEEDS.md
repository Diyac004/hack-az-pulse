# FRONTEND_NEEDS.md: what the frontend needs from Anay and Diya

Nothing here blocks the frontend today. For the live check we only need `/api/state` + `/ws` (snapshot + poses) per ARCHITECTURE.md with CORS for localhost:5173.

Priority tags: **Must-before-live**, **Nice-to-have**, **Later-milestone**.

## Anay (platform)

1. **`cells` on `block_route` / `unblock_route`** (Nice-to-have). Without it, live mode cannot draw the road barrier or compute the reroute. Shape: log line `{"type":"block_route","cells":[[x,y],...]}`, or put the blocked cells in a scenario/state update.
2. **`mechanic_booked` log line** (Nice-to-have). Needed for the van animation; without it we only show the sheet and booking. Shape: `{"type":"mechanic_booked","tractor":"T1","mechanic":"M1","from":[x,y],"arrival_t":196,"estimated_return_t":286}`.
3. **Live-feed fields outside the contract** (Later-milestone). The live readout card and overlays need cross-track error, per-section state, the active AB line and the container port. Proposal: `agopenweb.cross_track_m`, `agopenweb.sections: [true,false,...]`, `agopenweb.ab_line: [[lat,lon],[lat,lon]]` (or a grid line), `agopenweb.port`.
4. **Coverage message details** (Must-before-live for Map painting). Please document: axis direction of x,y relative to `origin`; whether `origin` is the cell corner or centre; `rgb_int` packing (we assume 0xRRGGBB); extent. The contract's own example lands off-farm. Also say whether a snapshot replays coverage, otherwise a reload loses the painted area.
5. **Basemap `image_url`** (Nice-to-have). Relative to the backend origin, with bounds that match the 20x14 grid of 40 m cells. Without it the Map view falls back to a plain grid.
6. **Operation `kind` for `/manual` and `/control`; fleet re-plans** (Nice-to-have). Fleet add/remove re-plans have no §13 source. Proposal: `kind: "replan"` with `source: "manual"` / `"control"`, and a new `source: "fleet"` for fleet changes (or say they emit no Operation).
7. **HTTP statuses** (Nice-to-have, document only). The contract is silent. The mock chose: `INVALID_INPUT` 400, `NOT_FOUND` 404, `AT_CAPACITY`/`NEEDS_MANUAL`/`CONFLICT` 409, `SAFETY_REJECTED`/`WEATHER_BLOCKED` 422, `TIMEOUT`/`GATEWAY_UNAVAILABLE` 503, `INTERNAL` 500. The client-only codes `NETWORK`, `CLIENT_TIMEOUT`, `UNCONFIRMED` never come from the server. Please match or tell us.
8. **Connection basics** (Must-before-live). CORS for `:5173` plus the LAN IP; per-connection `seq` starting at 1 on the snapshot; the snapshot includes `operations`; keep `/openapi.json`.

## Diya (brain)

1. **`heat_alert` target blocks** (Nice-to-have). The mock assumes blocks G and H. Which blocks does the real Agronomy agent reprioritize? Without it the live priority colors differ from mock.
2. **Explanation triggers and facts keys** (Must-before-live). Frontend renders triggers `initial_plan`, `tractor_added`, `tractor_removed`, `end_of_day`, `weather_change` (plus the existing ones) and facts keys `unassigned`, `context` (incl. `context.weather`, `context.paused`). An unknown trigger falls back to generic text, so the "cites the 10 mph limit" moment disappears.
3. **Approving a mechanic pending item** (Nice-to-have). Which mechanic gets booked? Mock: the recommended one; `override` = decline. Confirm.
4. **Priority edits** (Nice-to-have). `PATCH /jobs` vs a `priority_change` event: state the conflict rule (last write wins? event only for Agronomy?) so Why-sheet Low/Med/High edits don't fight the heat alert.
5. **Fixtures** (Must-before-live, for contract tests). `plan_feasible.json` is empty at version 8 (should be version 0 per §13.1, or populated); `metrics_not_measured.json` should have a `baseline` object with `baseline_source: null`.
6. **Plan `travel` routes** (Nice-to-have). Entries should carry `route` as grid points. If the travel model differs, publish it. The mock uses road cost 1 and off-road 3.5, plus a speed.
7. **Weather rules** (Must-before-live for wind moment). How long a `weather_change` holds (mock: 120 min); spray windows split vs a single window; paused-job status; temperature limit (mock: 100 F); shape of `live_conditions`.
8. **Overtime flag** (Nice-to-have). Plans running past 6 PM show "Feasible", which judge feedback called wrong. Proposal: `plan.overtime_min: 35` or `solver_status` stays and a new `plan.flags: ["overtime"]`. We would show "Feasible · runs 35 min past sunset".
9. **`map_pick` control value** (Later-milestone). One point or two; grid or lat/lon? Proposal: `{"value":{"cell":[x,y]}}` for one point, `{"value":[{"cell":[x,y]},{"cell":[x,y]}]}` for two.

## How to test against our simulated backend

```sh
cd ~/hack-az-pulse/mock-backend && npm install && npm start     # http://localhost:8000
npm run smoke                                                    # in a second terminal; resets the day first
```

Options: `PORT=9000 npm start`, `PACE=9.6 npm start` (farm minutes per real second), `npm start -- --auto-repair`, `QUIET=1`. Smoke against another port: `API=http://localhost:8765 node smoke.mjs`.

Dashboard: `cd ~/hack-az-pulse/dashboard && npx vite --port 5173`, then open `http://localhost:5173/?source=live&api=http://localhost:8000`. Compare with `?source=mock` (same behavior in-browser). Not implemented in the mock (501): `POST /api/jobs` and the tractor `/controls`, `/control`, `/preview`, `/manual` endpoints.

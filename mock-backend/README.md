# mock-backend

A simulated backend for the dashboard's **live mode**. **This is the offline backup, not the scored coordinator demo.** The scored demo is Anay's FastAPI backend (`backend/`, `cd backend && ../.venv/bin/python -m uvicorn app.main:app --port 8000`; see `backend/README.md`), which runs Diya's Python scheduler. This mock uses the dashboard's simulated planner, so its metrics are simulated. Both listen on `:8000`: run one at a time. It is also separate from `agopenweb-bridge/` (`:8040`). It wraps the in-browser simulation (`dashboard/src/data/mockSource.js`, imported directly, not copied) behind the ARCHITECTURE.md contract: REST in §5 under `/api`, the WebSocket in §6 at `/ws`, and the Operations amendment in §13. Live mode therefore behaves the same as `?source=mock`, but over real HTTP and WS.

## Run

```sh
cd mock-backend && npm install && npm start       # http://localhost:8000
```

Then open the dashboard with `?source=live&api=http://localhost:8000`.

Options:
- `PORT=9000 npm start` changes the port (default 8000).
- `npm start -- --auto-repair` (or `AUTO_REPAIR=1`) sends `tractor_repaired` automatically when a booked repair reaches `estimated_return_t`.
- `QUIET=1` silences the request log.

The farm day runs at the browser mock's pace: 1.2 farm minutes per real second at speed 1, so the whole 720-minute day takes about 10 real minutes (speed 6 / "Skip to sunset" ≈ 1.7 min). Override with `PACE=9.6 npm start` or `npm start -- --pace=9.6` (farm minutes per real second; 9.6 gives the old 75 s day). In mock mode the dashboard takes `?pace=9.6` instead. The clock starts on the first WS connection or `/api` request, not when the server boots. `POST /api/run` resets the day. `POST /api/clock {"speed": 6, "playing": true}` changes the pace.

## Smoke test

```sh
npm start &                 # or PORT=8765 npm start &
npm run smoke               # or API=http://localhost:8765 node smoke.mjs
```

You can run it repeatedly, because it resets the day first with `POST /api/run`. It checks the raw WS stream: the snapshot arrives first with seq 1, seq counts per connection, and an operation's messages arrive in the order running → plan → explanation → jobs → succeeded. It also checks the REST shapes against `contract/examples`, idempotency replays and conflicts, error bodies and statuses, and CORS. Finally it drives the real `dashboard/src/data/liveSource.js` with `store.js` against the server.

## Behaviour

- There is one shared simulation. Each WS client first gets a `snapshot` with seq 1, then every envelope the simulation emits, stamped with that connection's own `seq`. `{"type":"ping"}` gets the reply `{"type":"pong"}`, which has no seq.
- `run`, `events`, `PATCH jobs/{id}`, `mechanics/book` and `approve` return **202 + Operation**. They honour the `Idempotency-Key` header: the same key with the same body returns the same operation, and the same key with a different body returns 409 `CONFLICT`. `POST /fleet` returns 202 `{tractor}` with status `starting`.
- Errors use the body `{"error":{"code","message","details"}}`. HTTP statuses by code: `INVALID_INPUT` 400, `NOT_FOUND` 404, `CONFLICT`/`AT_CAPACITY`/`NEEDS_MANUAL` 409, `SAFETY_REJECTED`/`WEATHER_BLOCKED` 422, `TIMEOUT`/`GATEWAY_UNAVAILABLE` 503, `INTERNAL` 500. Malformed JSON returns 400, an unknown route 404, and a wrong method 405.
- `GET /api/log` returns `text/plain` JSON Lines.
- `GET /openapi.json` returns a static route list. FastAPI would generate the real document.
- CORS allows `*` for GET/POST/PATCH/DELETE/OPTIONS with the headers `Content-Type` and `Idempotency-Key`.

## Not supported (501 `NOT_IMPLEMENTED`)

The browser mock has no implementation for these:
`POST /api/jobs`, `GET /api/tractors/{id}/controls`, `POST /api/tractors/{id}/control`, `POST /api/tractors/{id}/preview`, `POST /api/tractors/{id}/manual`.

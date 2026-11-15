"""FastAPI app: REST under /api, live updates on /ws (ARCHITECTURE.md 5, 6, 13).

    cd backend && uvicorn app.main:app --port 8000

Env: HFA_SCENARIO (default data/scenario.json), HFA_LOG_DIR (default logs/).
"""
from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

from app import models as m
from app.core.engine import Engine
from app.core.state import WorldError

ROOT = Path(__file__).resolve().parents[2]


def _error(status: int, code: str, message: str, details: dict | None = None) -> JSONResponse:
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message, "details": details or {}}})


def create_app(scenario_path: Path | str | None = None, log_dir: Path | str | None = None) -> FastAPI:
    engine = Engine(scenario_path or os.environ.get("HFA_SCENARIO", ROOT / "data" / "scenario.json"),
                    log_dir or os.environ.get("HFA_LOG_DIR", ROOT / "logs"))

    @asynccontextmanager
    async def lifespan(_):
        await engine.start()
        yield
        await engine.stop()

    app = FastAPI(title="Harvest Fleet AI", lifespan=lifespan)
    app.state.engine = engine
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(WorldError)
    async def world_error(_, e: WorldError):
        return _error(e.status, e.code, e.message, e.details)

    @app.exception_handler(RequestValidationError)
    async def bad_request(_, e: RequestValidationError):
        first = e.errors()[0] if e.errors() else {}
        where = ".".join(str(x) for x in first.get("loc", []) if x != "body")
        return _error(400, "INVALID_INPUT", f"Invalid request: {where} {first.get('msg', '')}".strip(),
                      {"errors": json.loads(json.dumps(e.errors(), default=str))})

    # ------------------------------------------------------------ async mutations (13.2)

    def accepted(request: Request, scope: str, body, start) -> JSONResponse:
        """Validate+apply the immediate part, enqueue the operation, return 202.
        Same Idempotency-Key + same body returns the original operation."""
        key = request.headers.get("Idempotency-Key")
        fp = engine.ops.fingerprint(scope, body)
        op = engine.ops.replay(key, fp)
        if op is None:
            op = start()
            engine.ops.remember(key, fp, op.id)
        return JSONResponse(status_code=202, content=m.dump(op))

    @app.post("/api/run")
    async def post_run(body: m.RunBody, request: Request):
        return accepted(request, "run", body.model_dump(), lambda: engine.run(body.mode))

    @app.post("/api/jobs")
    async def post_jobs(body: m.JobsBody, request: Request):
        def start():
            ids = engine.world.add_jobs(body.jobs)
            engine.after_mutation()
            return engine.submit_replan("jobs", f"Planning {len(ids)} new job(s): {', '.join(ids)}.",
                                        {"type": "jobs_submitted", "jobs": ids})
        return accepted(request, "jobs", body.model_dump(), start)

    @app.patch("/api/jobs/{job_id}")
    async def patch_job(job_id: str, body: m.JobPatch, request: Request):
        def start():
            engine.world.patch_job(job_id, body)
            engine.after_mutation()
            return engine.submit_replan("job_patch", f"{job_id} changed. Replanning.",
                                        {"type": "job_patch", "job": job_id})
        return accepted(request, f"job_patch:{job_id}", body.model_dump(), start)

    @app.post("/api/events")
    async def post_event(body: m.EventInput, request: Request):
        w = engine.world

        def need(field):
            if getattr(body, field) is None:
                raise WorldError(400, "INVALID_INPUT", f"A {body.type} event needs '{field}'.")
            return getattr(body, field)

        def start():
            if body.type == "breakdown":
                w.breakdown(need("tractor"), body.issue)              # stop first, then plan
                msg = f"{body.tractor} broke down. Replanning unfinished work."
            elif body.type == "tractor_repaired":
                w.repaired(need("tractor"))
                msg = f"{body.tractor} is back in service. Replanning."
            elif body.type in {"block_route", "unblock_route"}:
                cells = w.block_route(body.cells, unblock=body.type == "unblock_route")
                msg = f"Road {'re-opened' if body.type == 'unblock_route' else 'blocked'} at {[list(c) for c in cells]}. Replanning."
            elif body.type == "priority_change":
                w.priority_change(need("job"), body.priority, body.deadline_t, body.reason)
                msg = f"{body.job} priority changed. Replanning."
            else:
                raise WorldError(400, "INVALID_INPUT",
                                 f"'{body.type}' events are not modeled in this build (weather is off).")
            engine.after_mutation()
            return engine.submit_replan("events", msg, body.model_dump(exclude_none=True))
        return accepted(request, "events", body.model_dump(), start)

    # ------------------------------------------------------------ fleet (unchanged shapes, 13.2)

    @app.post("/api/fleet", status_code=202)
    async def post_fleet(body: m.FleetEntry):
        tractor = engine.world.add_tractor(body)
        engine.after_mutation()
        engine.submit_replan("events", f"{tractor['id']} joined the fleet. Replanning.",
                             {"type": "tractor_added", "tractor": tractor["id"]})
        return {"tractor": tractor}

    @app.delete("/api/fleet/{tractor_id}")
    async def delete_fleet(tractor_id: str):
        engine.world.remove_tractor(tractor_id)
        engine.after_mutation()
        engine.submit_replan("events", f"{tractor_id} left the fleet. Replanning.",
                             {"type": "tractor_removed", "tractor": tractor_id})
        return {"ok": True}

    # ------------------------------------------------------------ reads

    @app.get("/api/state")
    async def get_state():
        return engine.snapshot()

    @app.get("/api/scenario")
    async def get_scenario():
        return engine.world.scenario_view()

    @app.get("/api/jobs")
    async def get_jobs():
        return engine.world.jobs_view()

    @app.get("/api/fleet")
    async def get_fleet():
        return engine.world.fleet_view()

    @app.get("/api/metrics")
    async def get_metrics():
        return engine.world.metrics_view()

    @app.get("/api/weather")
    async def get_weather():
        return engine.world.weather_view()

    @app.get("/api/hosts")
    async def get_hosts():
        return engine.world.capacity_view()

    @app.get("/api/log", response_class=PlainTextResponse)
    async def get_log():
        return "".join(json.dumps(e) + "\n" for e in engine.world.log)

    @app.get("/api/operations/{op_id}")
    async def get_operation(op_id: str):
        return m.dump(engine.ops.get(op_id))

    @app.post("/api/clock")
    async def post_clock(body: m.ClockBody):
        return engine.set_clock(body.playing, body.speed)

    # ------------------------------------------------------------ not built yet

    def not_built(feature: str):
        return _error(501, "INTERNAL", f"{feature} is not implemented in the MockGateway integration yet.",
                      {"not_implemented": True})

    @app.get("/api/tractors/{tractor_id}/controls")
    async def get_controls(tractor_id: str):
        return not_built("Tractor controls")

    @app.post("/api/tractors/{tractor_id}/control")
    async def post_control(tractor_id: str):
        return not_built("Tractor controls")

    @app.post("/api/tractors/{tractor_id}/preview")
    async def post_preview(tractor_id: str):
        return not_built("Preview")

    @app.post("/api/tractors/{tractor_id}/manual")
    async def post_manual(tractor_id: str):
        return not_built("Manual mode")

    @app.get("/api/why/{job_id}")
    async def get_why(job_id: str):
        return not_built("Why?")

    @app.get("/api/mechanics")
    async def get_mechanics():
        return not_built("Mechanic search")

    @app.post("/api/mechanics/book")
    async def post_book():
        return not_built("Mechanic booking")

    @app.post("/api/approve")
    async def post_approve():
        return not_built("Operator approvals")

    @app.post("/api/scale-test")
    async def post_scale_test():
        return not_built("Scale test")

    # ------------------------------------------------------------ websocket

    @app.websocket("/ws")
    async def ws(websocket: WebSocket):
        await engine.hub.serve(websocket, lambda: ("snapshot", engine.world.t, engine.snapshot()))

    return app


app = create_app()

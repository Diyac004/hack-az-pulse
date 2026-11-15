"""The running server: REST (section 5 + 13), operations, and /ws (section 6 + 13.3).

Runs the real engine with its real-time tick loop; clock speed is raised so a
farm day takes a second or two.
"""
import tempfile
import time
import unittest
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)

from fastapi.testclient import TestClient  # noqa: E402

from app import models as m  # noqa: E402
from app.main import create_app  # noqa: E402


def wait_for(fn, timeout=10.0, every=0.05):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = fn()
        if value:
            return value
        time.sleep(every)
    raise AssertionError("timed out waiting for condition")


class ApiCase(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(create_app(log_dir=tempfile.mkdtemp()))
        self.client.__enter__()
        self.c = self.client

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def finished(self, op_id):
        def done():
            op = self.c.get(f"/api/operations/{op_id}").json()
            return op if op["status"] not in {"queued", "running"} else None
        return wait_for(done)

    def start_run(self, speed=None):
        r = self.c.post("/api/run", json={"mode": "ours"})
        self.assertEqual(r.status_code, 202)
        op = self.finished(r.json()["id"])
        self.assertEqual(op["status"], "succeeded")
        if speed:
            self.c.post("/api/clock", json={"speed": speed})
        return op


class Rest(ApiCase):
    def test_state_before_run_matches_contract(self):
        s = m.Snapshot.model_validate(self.c.get("/api/state").json())
        self.assertEqual(s.plan.version, 0)
        self.assertEqual(s.plan.solver_status, "feasible")
        self.assertEqual(len(s.jobs), 12)
        self.assertTrue(all(j.status == "pending" for j in s.jobs))
        self.assertEqual(len(s.fleet), 3)

    def test_run_returns_operation_then_applies_plan(self):
        r = self.c.post("/api/run", json={"mode": "ours"})
        self.assertEqual(r.status_code, 202)
        op = m.Operation.model_validate(r.json())
        self.assertEqual((op.kind, op.source, op.status), ("run", "run", "queued"))
        done = self.finished(op.id)
        self.assertEqual(done["result"], {"applied_plan_version": 1, "unassigned_job_ids": []})
        s = self.c.get("/api/state").json()
        self.assertEqual(s["plan"]["version"], 1)
        self.assertTrue(s["clock"]["playing"])
        self.assertTrue(all(j["tractor"] for j in s["jobs"]))

    def test_submit_jobs_mid_run(self):
        self.start_run()
        r = self.c.post("/api/jobs", json={"jobs": [
            {"type": "mow", "implement": "mower", "block": "E", "duration_min": 40, "priority": 3, "deadline_t": 600}]})
        self.assertEqual(r.status_code, 202)
        self.assertEqual(self.finished(r.json()["id"])["status"], "succeeded")
        job = next(j for j in self.c.get("/api/jobs").json() if j["id"] == "J13")
        self.assertIsNotNone(job["tractor"])

    def test_manual_breakdown_replans_and_keeps_progress(self):
        self.start_run(speed=60)
        wait_for(lambda: next(j for j in self.c.get("/api/jobs").json() if j["id"] == "J1")["progress"] > 0.2)
        self.c.post("/api/clock", json={"playing": False})
        before = {j["id"]: j for j in self.c.get("/api/jobs").json()}
        r = self.c.post("/api/events", json={"type": "breakdown", "tractor": "T1", "issue": "hydraulic leak"})
        self.assertEqual(r.status_code, 202)
        self.assertEqual(r.json()["source"], "events")
        self.assertEqual(self.finished(r.json()["id"])["status"], "succeeded")
        s = self.c.get("/api/state").json()
        fleet = {t["id"]: t for t in s["fleet"]}
        jobs = {j["id"]: j for j in s["jobs"]}
        self.assertEqual(fleet["T1"]["status"], "broken")
        self.assertEqual(jobs["J1"]["tractor"], "T3")
        self.assertGreaterEqual(jobs["J1"]["progress"], before["J1"]["progress"])
        self.assertEqual(s["explanations"][0]["trigger"], "breakdown")
        self.assertIn("J1 moves from T1 to T3", s["explanations"][0]["text"])

    def test_scheduled_breakdown_full_day(self):
        self.start_run(speed=600)
        wait_for(lambda: self.c.get("/api/state").json()["clock"]["ended"], timeout=20)
        metrics = self.c.get("/api/metrics").json()["ours"]
        self.assertEqual((metrics["completed"], metrics["on_time"], metrics["violations"]), (12, 12, 0))
        log = [l for l in self.c.get("/api/log").text.splitlines() if l]
        self.assertTrue(any('"trigger": "breakdown"' in l and '"kind": "replan"' in l for l in log))

    def test_idempotency_key(self):
        self.start_run()
        body = {"jobs": [{"type": "hedge", "implement": "hedger", "block": "A", "duration_min": 20,
                          "priority": 1, "deadline_t": 700}]}
        h = {"Idempotency-Key": "abc-1"}
        a = self.c.post("/api/jobs", json=body, headers=h)
        b = self.c.post("/api/jobs", json=body, headers=h)
        self.assertEqual(a.json()["id"], b.json()["id"])
        self.assertEqual(len(self.c.get("/api/jobs").json()), 13)        # added once
        body["jobs"][0]["priority"] = 2
        c = self.c.post("/api/jobs", json=body, headers=h)
        self.assertEqual((c.status_code, c.json()["error"]["code"]), (409, "CONFLICT"))

    def test_errors_use_contract_shape(self):
        r = self.c.post("/api/events", json={"type": "breakdown", "tractor": "T9"})
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (404, "NOT_FOUND"))
        r = self.c.post("/api/jobs", json={"jobs": [{"type": "spray"}]})
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (400, "INVALID_INPUT"))
        r = self.c.post("/api/events", json={"type": "weather_change", "wind_mph": 14})
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (400, "INVALID_INPUT"))
        r = self.c.get("/api/operations/O999")
        self.assertEqual(r.status_code, 404)
        r = self.c.get("/api/why/J1")
        self.assertEqual(r.status_code, 501)

    def test_fleet_add_and_remove(self):
        self.start_run()
        r = self.c.post("/api/fleet", json={"implements": ["sprayer"], "start": {"x": 0, "y": 0}})
        self.assertEqual(r.status_code, 202)
        tid = r.json()["tractor"]["id"]
        self.assertEqual(tid, "T4")
        wait_for(lambda: not [o for o in self.c.get("/api/state").json()["operations"] if o["status"] in {"queued", "running"}])
        self.assertEqual(len(self.c.get("/api/fleet").json()), 4)
        self.assertEqual(self.c.delete(f"/api/fleet/{tid}").json(), {"ok": True})
        self.assertEqual(len(self.c.get("/api/fleet").json()), 3)


class PlanDiffAndRejection(ApiCase):
    def test_full_diff_reaches_rest_and_websocket(self):
        with self.c.websocket_connect("/ws") as ws:
            ws.receive_json()
            run = self.c.post("/api/run", json={"mode": "ours"}).json()["id"]
            first = None
            while first is None:
                msg = ws.receive_json()
                if msg["type"] == "plan":
                    first = msg["data"]
            self.finished(run)
            self.c.post("/api/clock", json={"playing": False})
            rest = self.c.get("/api/state").json()["plan"]
            self.assertEqual(first["diff"], rest["diff"])
            self.assertEqual(set(rest["diff"]), {"moved", "retimed", "dropped", "added"})
            self.assertEqual(len(rest["diff"]["added"]), 12)
            self.assertEqual((rest["solver"], rest["solver_status"]), ("greedy", "feasible"))

            self.c.post("/api/clock", json={"playing": True, "speed": 60})
            wait_for(lambda: self.c.get("/api/state").json()["clock"]["t"] > 20)
            self.c.post("/api/clock", json={"playing": False})
            op_id = self.c.post("/api/events", json={"type": "breakdown", "tractor": "T1"}).json()["id"]
            op = self.finished(op_id)
            ws_plan = None
            while True:
                msg = ws.receive_json()
                if msg["type"] == "plan":
                    ws_plan = msg["data"]
                if msg["type"] == "operation" and msg["data"]["id"] == op_id and msg["data"]["status"] == "succeeded":
                    break
            rest = self.c.get("/api/state").json()["plan"]
            self.assertEqual(ws_plan, rest)
            self.assertIn("J1", [mv["job"] for mv in rest["diff"]["moved"]])
            self.assertTrue(rest["diff"]["retimed"])
            self.assertEqual(op["solver_status"], rest["solver_status"])
            self.assertEqual(op["plan_version"], rest["version"])

    def test_unmeetable_constraint_fails_the_operation_explicitly(self):
        self.start_run(speed=10)
        wait_for(lambda: self.c.get("/api/state").json()["clock"]["t"] > 4)
        self.c.post("/api/clock", json={"playing": False})
        state = self.c.get("/api/state").json()
        t2 = next(t for t in state["fleet"] if t["id"] == "T2")
        self.assertEqual((t2["status"], t2["current_job"]), ("traveling", "J6"))
        trip = [e for e in state["plan"]["entries"] if e["tractor"] == "T2" and e["kind"] == "travel"]
        self.assertTrue(trip)
        version = state["plan"]["version"]
        r = self.c.patch("/api/jobs/J6", json={"deadline_t": 30})          # can't finish before 51
        self.assertEqual(r.status_code, 202)
        op = self.finished(r.json()["id"])
        self.assertEqual((op["status"], op["solver_status"], op["error"]["code"]),
                         ("failed", "no_feasible_plan", "SAFETY_REJECTED"))
        self.assertIsNone(op["result"])
        self.assertEqual(self.c.get("/api/state").json()["plan"]["version"], version)


class WebSocket(ApiCase):
    def receive_until(self, ws, pred, limit=400):
        seen = []
        for _ in range(limit):
            msg = ws.receive_json()
            seen.append(msg)
            if pred(msg, seen):
                return seen
        raise AssertionError(f"never saw the expected message; got {[x['type'] for x in seen][-20:]}")

    def test_snapshot_first_then_ordered_seq(self):
        with self.c.websocket_connect("/ws") as ws:
            first = ws.receive_json()
            self.assertEqual((first["type"], first["seq"]), ("snapshot", 1))
            m.Snapshot.model_validate(first["data"])
            ws.send_json({"type": "ping"})
            self.c.post("/api/run", json={"mode": "ours"})
            seen = self.receive_until(ws, lambda msg, _: msg.get("type") == "poses")
            seqs = [x["seq"] for x in seen if "seq" in x]
            self.assertEqual(seqs, list(range(2, 2 + len(seqs))))
            self.assertIn({"type": "pong"}, seen)

    def test_breakdown_broadcast_order(self):
        self.start_run(speed=30)
        with self.c.websocket_connect("/ws") as ws:
            ws.receive_json()                                    # snapshot
            r = self.c.post("/api/events", json={"type": "breakdown", "tractor": "T2"})
            op_id = r.json()["id"]
            seen = self.receive_until(ws, lambda msg, _: msg["type"] == "operation"
                                      and msg["data"]["id"] == op_id and msg["data"]["status"] == "succeeded")
            kinds = [x["type"] for x in seen if x["type"] in {"operation", "plan", "explanation", "jobs", "fleet"}]
            mine = [x for x in seen if x["type"] == "operation" and x["data"]["id"] == op_id]
            self.assertEqual([x["data"]["status"] for x in mine], ["queued", "running", "succeeded"])
            i = kinds.index("plan")
            self.assertEqual(kinds[i:i + 3], ["plan", "explanation", "jobs"])
            self.assertLess(kinds.index("fleet"), i)            # broken status before re-plan
            # 13.3: running -> plan -> explanation -> jobs -> other state -> succeeded
            running = next(k for k, x in enumerate(seen) if x["type"] == "operation"
                           and x["data"]["id"] == op_id and x["data"]["status"] == "running")
            between = [x["type"] for x in seen[running + 1:-1] if x["type"] not in {"poses", "clock"}]
            self.assertEqual(between[:3], ["plan", "explanation", "jobs"])
            breakdown_log = next(k for k, x in enumerate(seen) if x["type"] == "log" and x["data"].get("type") == "breakdown")
            self.assertLess(breakdown_log, running)
            for x in seen:
                if x["type"] == "plan":
                    m.Plan.model_validate(x["data"])
                if x["type"] == "explanation":
                    m.Explanation.model_validate(x["data"])
                if x["type"] == "poses":
                    for t in x["data"]["tractors"]:
                        m.Pose.model_validate(t["pose"])


if __name__ == "__main__":
    unittest.main()

"""World + MockGateway + Diya's planner, end to end without the server."""
import copy
import unittest

from app.brain import BrainSnapshot, explain, plan as brain_plan
from app.brain.contracts import PlanningResult, ValidationResult, Violation
from app.core.planner import merge_triggers, replan_sync, run_planner
from app.core.runner import load_scenario, run_day
from app.core.state import World
from app import models as m

SCENARIO = load_scenario()
TOTAL_WORK = sum(j["duration_min"] for j in SCENARIO["jobs"])


def started(mode="ours", scenario=SCENARIO):
    w = World(copy.deepcopy(scenario), mode)
    replan_sync(w, {"type": "run"})
    w.playing = True
    return w


def advance(w, until, dt=0.5):
    while w.t < until - 1e-9 and not w.ended:
        trig = merge_triggers(w.step(min(dt, until - w.t)))
        if trig:
            replan_sync(w, trig)


class Execution(unittest.TestCase):
    def test_full_day_completes_every_job_on_time(self):
        w = run_day(copy.deepcopy(SCENARIO))
        r = w.run_metrics()
        self.assertEqual((r.completed, r.on_time, r.violations), (12, 12, 0))
        self.assertAlmostEqual(r.productive_min, TOTAL_WORK, places=6)

    def test_every_row_done_exactly_once(self):
        w = run_day(copy.deepcopy(SCENARIO))
        for j in w.jobs.values():
            for minutes, done in j.units:
                self.assertAlmostEqual(done, minutes, places=6, msg=j.id)

    def test_tractors_follow_the_plan(self):
        w = started()
        first = {e.job: e for e in w.plan.entries if e.kind == "work"}
        advance(w, 45)                                # before the breakdown
        j6 = w.jobs["J6"]
        self.assertAlmostEqual(j6.started_t, first["J6"].start_t, places=6)
        self.assertEqual(j6.tractor, first["J6"].tractor)

    def test_baseline_uses_the_same_simulator_and_events(self):
        ours, base = run_day(copy.deepcopy(SCENARIO)), run_day(copy.deepcopy(SCENARIO), "baseline")
        ev = lambda w: [(e["t"], e["type"]) for e in w.log if e["kind"] == "event"]
        self.assertEqual(ev(ours), ev(base))
        self.assertEqual(base.run_metrics().violations, 0)

    def test_deterministic(self):
        strip = lambda log: [{k: v for k, v in e.items() if k not in {"replan_ms", "solve_ms"}} for e in log]
        a, b = run_day(copy.deepcopy(SCENARIO)), run_day(copy.deepcopy(SCENARIO))
        self.assertEqual(strip(a.log), strip(b.log))
        plans = [e for e in a.log if e["kind"] in {"plan", "replan"}]
        self.assertTrue(plans and all(e["search_complete"] for e in plans))   # no load-dependent cut-offs


class BreakdownRecovery(unittest.TestCase):
    """Scenario: T1 breaks at t=50, part-way through spraying Block A (J1)."""

    def setUp(self):
        self.w = started()
        advance(self.w, 49.5)
        self.before = self.w.jobs["J1"].progress
        self.t1_pose = self.w.gateway.pose("T1")
        advance(self.w, 50)                            # breakdown + re-plan happen here

    def test_progress_preserved_and_job_reassigned(self):
        j1 = self.w.jobs["J1"]
        self.assertGreater(self.before, 0.5)
        self.assertGreaterEqual(j1.progress, self.before)             # never goes back
        self.assertIn(j1.tractor, {"T3"})                             # only other sprayer
        self.assertEqual(self.w.tractors["T1"].status, "broken")

    def test_replan_is_logged_with_progress_kept(self):
        replans = [e for e in self.w.log if e["kind"] == "replan" and e["trigger"] == "breakdown"]
        self.assertEqual(len(replans), 1)
        moved = {c["job"]: c for c in replans[0]["changes"]}
        self.assertEqual(moved["J1"]["from"], "T1")
        self.assertAlmostEqual(moved["J1"]["progress_kept"], self.w.jobs["J1"].progress, places=6)

    def test_explanation_is_factual(self):
        x = self.w.explanations[0]
        self.assertEqual(x["trigger"], "breakdown")
        self.assertEqual(x["plan_version"], self.w.plan.version)
        self.assertIn("J1 moves from T1 to T3", x["text"])

    def test_broken_tractor_gets_no_work_and_stays_put(self):
        self.assertFalse([e for e in self.w.plan.entries if e.tractor == "T1"])
        advance(self.w, 720)
        p = self.w.gateway.pose("T1")
        self.assertEqual((p.x, p.y), (self.t1_pose.x, self.t1_pose.y))

    def test_finishes_without_lost_or_duplicated_work(self):
        advance(self.w, 720)
        r = self.w.run_metrics()
        self.assertEqual((r.completed, r.violations), (12, 0))
        self.assertAlmostEqual(r.productive_min, TOTAL_WORK, places=6)
        done = [e for e in self.w.log if e["kind"] == "job_done" and e["job"] == "J1"]
        self.assertEqual([d["tractor"] for d in done], ["T3"])

    def test_broadcast_order_plan_explanation_jobs(self):
        w = started()
        advance(w, 49.5)
        w.drain()
        advance(w, 50)
        kinds = [k for k, _ in w.drain() if k in {"plan", "explanation", "jobs", "fleet"}]
        i = kinds.index("plan")
        self.assertEqual(kinds[i:i + 3], ["plan", "explanation", "jobs"])
        self.assertEqual(kinds[0], "fleet")          # breakdown status goes out before re-planning

    def test_repaired_tractor_gets_work_again(self):
        w = self.w
        w.repaired("T1")
        replan_sync(w, {"type": "tractor_repaired", "tractor": "T1"})
        self.assertNotEqual(w.tractors["T1"].status, "broken")
        advance(w, 720)
        self.assertEqual(w.run_metrics().violations, 0)


class AdapterGates(unittest.TestCase):
    def test_snapshot_matches_brain_contract_mid_run(self):
        w = started()
        for t in (0, 5, 20, 60, 150):
            advance(w, t)
            BrainSnapshot.model_validate(w.to_brain_snapshot({"type": "check"}))

    def test_replan_while_driving_keeps_destination_and_arrival(self):
        w = started()
        advance(w, 5)                                   # T2 is on its way to Block E (J6)
        p = w.gateway.pose("T2")
        self.assertEqual((p.status, p.job), ("traveling", "J6"))
        before = {e.job: e.start_t for e in w.plan.entries if e.kind == "work"}
        out = replan_sync(w, {"type": "check"})
        self.assertTrue(out["applied"])
        after = {e.job: e.start_t for e in w.plan.entries if e.kind == "work"}
        self.assertAlmostEqual(after["J6"], before["J6"], places=6)
        advance(w, 60)
        self.assertEqual(w.jobs["J6"].status, "done")

    def test_stale_result_is_refused(self):
        w = started()
        snap = w.to_brain_snapshot({"type": "check"})
        result = run_planner(snap, w.policy)
        w.step(1.0)                                      # world moved on
        version = w.plan.version
        self.assertEqual(w.apply_result(result, {"type": "check"}, explain)["reason"], "stale")
        self.assertEqual(w.plan.version, version)

    def test_invalid_result_is_refused_and_logged(self):
        w = started()
        result = run_planner(w.to_brain_snapshot({"type": "check"}), w.policy)
        bad = result.model_copy(update={"validation": ValidationResult(
            passed=False, violations=[Violation(rule="fuel_reserve", detail="test")])})
        version = w.plan.version
        out = w.apply_result(bad, {"type": "check"}, explain)
        self.assertEqual(out["reason"], "rejected")
        self.assertEqual(w.plan.version, version)
        self.assertEqual(w.log[-1]["kind"], "safety_reject")


    def test_gateway_refusal_applies_nothing(self):
        from app.gateway.base import GatewayError
        w = started()
        advance(w, 5)
        result = run_planner(w.to_brain_snapshot({"type": "check"}), w.policy)
        poses = {t: w.gateway.pose(t) for t in w.tractors}
        real_check = w.gateway.check

        def refuse_t3(tid, orders):
            if tid == "T3":
                raise GatewayError("simulated refusal")
            real_check(tid, orders)
        w.gateway.check = refuse_t3
        version = w.plan.version
        self.assertEqual(w.apply_result(result, {"type": "check"}, explain)["reason"], "rejected")
        self.assertEqual(w.plan.version, version)
        self.assertEqual({t: w.gateway.pose(t) for t in w.tractors}, poses)


class OtherEvents(unittest.TestCase):
    def test_new_jobs_mid_day_get_planned(self):
        w = started()
        advance(w, 100)
        w.add_jobs([m.JobInput(type="mow", implement="mower", block="E", duration_min=40,
                               priority=3, deadline_t=600)])
        replan_sync(w, {"type": "jobs"})
        new = w.jobs["J13"]
        self.assertIsNotNone(new.tractor)
        advance(w, 720)
        self.assertEqual(new.status, "done")

    def test_blocked_road_reroutes(self):
        w = started()
        advance(w, 1)
        cells = w.block_route(None)                      # a cell ahead of a driving tractor
        replan_sync(w, {"type": "block_route"})
        advance(w, 720)
        r = w.run_metrics()
        self.assertEqual((r.completed, r.violations), (12, 0))
        for e in w.plan.entries:
            self.assertFalse(set(map(tuple, e.route)) & set(cells))

    def test_unknown_tractor_and_bad_job_rejected(self):
        w = started()
        from app.core.state import WorldError
        with self.assertRaises(WorldError):
            w.breakdown("T9", None)
        with self.assertRaises(WorldError):
            w.add_jobs([m.JobInput(type="spray", implement="mower", block="A", duration_min=20,
                                   priority=1, deadline_t=100)])
        with self.assertRaises(WorldError):
            w.add_jobs([m.JobInput(type="mow", implement="mower", block="Z", duration_min=20,
                                   priority=1, deadline_t=100)])


if __name__ == "__main__":
    unittest.main()

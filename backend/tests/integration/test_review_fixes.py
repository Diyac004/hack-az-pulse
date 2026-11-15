"""Regression tests for Diya's review: idle metric, full plan diff, mid-drive commitment."""
import copy
import unittest

from app.brain import explain
from app.core.planner import merge_triggers, replan_sync, run_planner
from app.core.runner import load_scenario, run_day
from app.core.state import World
from app import models as m

SCENARIO = load_scenario()


def started(scenario=SCENARIO, mode="ours"):
    w = World(copy.deepcopy(scenario), mode)
    replan_sync(w, {"type": "run"})
    w.playing = True
    return w


def advance(w, until, dt=0.5):
    while w.t < until - 1e-9 and not w.ended:
        trig = merge_triggers(w.step(min(dt, until - w.t)))
        if trig:
            replan_sync(w, trig)


def measured(metrics):
    """Simulation metrics only: replan_ms_last is wall-clock planning time."""
    return {k: v for k, v in metrics.model_dump().items() if k != "replan_ms_last"}


def plan_and_apply(w, trigger):
    """Like replan_sync, but also returns the brain's own result for comparison."""
    result = run_planner(w.to_brain_snapshot(trigger), w.policy)
    return result, w.apply_result(result, trigger, explain)


# ====================================================================== 1. idle metric

class IdleTime(unittest.TestCase):
    def test_full_day_metrics_do_not_depend_on_tick_size(self):
        for mode in ("ours", "baseline"):
            runs = {dt: run_day(copy.deepcopy(SCENARIO), mode, dt=dt).run_metrics() for dt in (0.2, 1, 5)}
            for dt, r in runs.items():
                with self.subTest(mode=mode, dt=dt):
                    self.assertAlmostEqual(r.idle_min, runs[0.2].idle_min, places=6)
                    self.assertAlmostEqual(r.travel_min, runs[0.2].travel_min, places=6)
                    self.assertEqual((r.completed, r.on_time, r.violations),
                                     (runs[0.2].completed, runs[0.2].on_time, runs[0.2].violations))

    def test_idle_stops_at_the_exact_completion_time(self):
        """T3 has nothing to do while T1 sprays J1. It is idle exactly until J1 finishes,
        even when J1 finishes in the middle of a long tick."""
        sc = copy.deepcopy(SCENARIO)
        sc["tractors"] = [
            {**SCENARIO["tractors"][0], "id": "T1", "start": {"x": 2, "y": 6}},
            {**SCENARIO["tractors"][2], "id": "T3", "implements": ["sprayer"], "start": {"x": 19, "y": 13}},
        ]
        sc["jobs"] = [{**SCENARIO["jobs"][0], "duration_min": 40, "deadline_t": 600}]
        sc["events"] = []
        for dt in (0.2, 1, 5, 7.3):
            with self.subTest(dt=dt):
                w = run_day(copy.deepcopy(sc), dt=dt)
                j1 = w.jobs["J1"]
                self.assertEqual(j1.tractor, "T1")
                self.assertAlmostEqual(j1.done_t, 41.0, places=9)        # 1 cell drive + 40 min work
                self.assertAlmostEqual(w.counters.idle_min, 41.0, places=9)  # T3, from 0 until J1 is done

    def test_waiting_for_a_busy_field_counts_as_idle(self):
        w = run_day(copy.deepcopy(SCENARIO))
        waits = sum(e.end_t - e.start_t for e in w.plan.entries if e.kind == "wait")
        self.assertGreaterEqual(w.counters.idle_min + 1e-9, waits)


# ====================================================================== 2. plan diff and solver

class PlanDiff(unittest.TestCase):
    def test_first_plan_lists_every_job_as_added(self):
        w = World(copy.deepcopy(SCENARIO))
        result, out = plan_and_apply(w, {"type": "run"})
        self.assertTrue(out["applied"])
        self.assertEqual(sorted(w.plan.diff.added), sorted(result.plan.diff["added"]))
        self.assertEqual(len(w.plan.diff.added), 12)

    def test_all_diff_fields_and_solver_are_forwarded(self):
        w = started()
        advance(w, 49.5)
        w.breakdown("T1", "test")
        result, out = plan_and_apply(w, {"type": "breakdown", "tractor": "T1"})
        self.assertTrue(out["applied"])
        public = m.dump(w.plan)
        self.assertEqual([{k: mv[k] for k in ("job", "from", "to")} for mv in public["diff"]["moved"]],
                         result.plan.diff["moved"])
        kept = {mv["job"]: mv["progress_kept"] for mv in result.facts["moved"]}
        self.assertEqual({mv["job"]: mv["progress_kept"] for mv in public["diff"]["moved"]}, kept)
        self.assertEqual(public["diff"]["retimed"], result.plan.diff["retimed"])
        self.assertEqual(public["diff"]["dropped"], result.plan.diff["dropped"])
        self.assertEqual(public["diff"]["added"], result.plan.diff["added"])
        self.assertTrue(public["diff"]["retimed"])                     # this breakdown does retime work
        self.assertIn("J1", [mv["job"] for mv in public["diff"]["moved"]])
        self.assertEqual((public["solver"], public["solver_status"]),
                         (result.plan.solver, result.plan.solver_status))
        self.assertEqual(out["solver_status"], result.plan.solver_status)

    def test_other_valid_solver_values_pass_through(self):
        w = World(copy.deepcopy(SCENARIO))
        result = run_planner(w.to_brain_snapshot({"type": "run"}), w.policy)
        result = result.model_copy(update={"plan": result.plan.model_copy(update={"solver": "ortools", "solver_status": "optimal"})})
        self.assertTrue(w.apply_result(result, {"type": "run"}, explain)["applied"])
        self.assertEqual((w.plan.solver, w.plan.solver_status), ("ortools", "optimal"))

    def test_invalid_public_values_are_rejected(self):
        for update in ({"solver": "magic"}, {"solver_status": "no_feasible_plan"},
                       {"diff": {"moved": [{"job": "J1"}], "retimed": [], "dropped": [], "added": []}}):
            with self.subTest(update=update):
                w = World(copy.deepcopy(SCENARIO))
                result = run_planner(w.to_brain_snapshot({"type": "run"}), w.policy)
                bad = result.model_copy(update={"plan": result.plan.model_copy(update=update)})
                out = w.apply_result(bad, {"type": "run"}, explain)
                self.assertEqual(out["reason"], "rejected")
                self.assertEqual(w.plan.version, 0)
                self.assertEqual(w.log[-1]["kind"], "safety_reject")
                self.assertEqual(w.log[-1]["status"], "invalid_result")
                self.assertEqual(w.gateway.pose("T1").status, "idle")      # nothing was dispatched


# ====================================================================== 3. mid-drive commitment

class MidDrive(unittest.TestCase):
    """At t=5, T2 is driving (0,5) -> (0,13) -> (3,13) to haul bins in Block E (J6).
    The 11-cell drive started at 0, so it arrives at 11."""

    def setUp(self):
        self.w = started()
        advance(self.w, 5)
        p = self.w.gateway.pose("T2")
        self.assertEqual((p.status, p.job), ("traveling", "J6"))

    def trip_entry(self, w, tid="T2"):
        return [e for e in w.plan.entries if e.tractor == tid and e.kind == "travel" and e.start_t <= w.t + 1e-9]

    def test_public_position_stays_actual(self):
        replan_sync(self.w, {"type": "check"})
        tv = next(t for t in self.w.fleet_view() if t["id"] == "T2")
        self.assertEqual((tv["pose"]["x"], tv["pose"]["y"]), (0.0, 10.0))     # 5 cells down column 0
        snap = self.w.to_brain_snapshot({"type": "check"})
        planner_view = next(t for t in snap["tractors"] if t["id"] == "T2")
        self.assertEqual((planner_view["x"], planner_view["y"]), (3, 13))    # planner-only projection

    def test_remaining_travel_is_in_the_public_plan_and_matches_execution(self):
        replan_sync(self.w, {"type": "check"})
        [trip] = self.trip_entry(self.w)
        self.assertEqual((trip.job, trip.start_t, trip.end_t), ("J6", 5.0, 11.0))
        self.assertEqual([tuple(c) for c in trip.route], [(0, y) for y in range(10, 14)] + [(1, 13), (2, 13), (3, 13)])
        work = next(e for e in self.w.plan.entries if e.job == "J6" and e.kind == "work")
        self.assertAlmostEqual(work.start_t, trip.end_t)
        advance(self.w, 60)
        arrived = next(e for e in self.w.log if e["kind"] == "job_started" and e["job"] == "J6")
        self.assertAlmostEqual(arrived["t"], trip.end_t, places=6)           # work starts at arrival, not before
        self.assertEqual(self.w.jobs["J6"].status, "done")

    def test_travel_time_and_fuel_counted_exactly_once(self):
        reference = started()
        advance(reference, 60)
        for t in (5, 6.5, 8, 9.25):                                          # repeated re-plans, same trip
            advance(self.w, t)
            out = replan_sync(self.w, {"type": "check"})
            self.assertTrue(out["applied"])
            [trip] = self.trip_entry(self.w)
            self.assertAlmostEqual(trip.end_t, 11.0)                         # arrival never moves
            snap = self.w.to_brain_snapshot({"type": "check"})
            t2 = next(x for x in snap["tractors"] if x["id"] == "T2")
            self.assertAlmostEqual(t2["fuel_pct"], self.w.tractors["T2"].fuel - (11.0 - self.w.t) * 0.05)
        advance(self.w, 60)
        self.assertAlmostEqual(self.w.counters.travel_min, reference.counters.travel_min, places=6)
        self.assertAlmostEqual(self.w.tractors["T2"].fuel, reference.tractors["T2"].fuel, places=6)
        self.assertEqual(self.w.jobs["J6"].done_t, reference.jobs["J6"].done_t)

    def test_breakdown_during_travel_stops_there(self):
        self.w.breakdown("T2", "test")
        out = replan_sync(self.w, {"type": "breakdown", "tractor": "T2"})
        self.assertTrue(out["applied"])
        frozen = self.w.gateway.pose("T2")
        self.assertFalse([e for e in self.w.plan.entries if e.tractor == "T2"])
        advance(self.w, 200)
        self.assertEqual((self.w.gateway.pose("T2").x, self.w.gateway.pose("T2").y), (frozen.x, frozen.y))
        self.assertNotEqual(self.w.jobs["J6"].tractor, "T2")
        self.assertEqual(self.w.run_metrics().violations, 0)

    def test_blockage_ahead_stops_short_and_reroutes(self):
        cells = self.w.block_route([(0, 12)])
        replan_sync(self.w, {"type": "block_route"})
        entered = set()
        while self.w.t < 120:
            self.w.step(0.5)
            entered.add(self.w.gateway.pose("T2").cell)
            if self.w.gateway.pose("T2").status == "idle" and self.w.jobs["J6"].tractor is None:
                replan_sync(self.w, {"type": "tractor_idle"})
        self.assertNotIn((0, 12), entered)
        self.assertNotIn(cells[0], {tuple(c) for e in self.w.plan.entries for c in e.route})
        advance(self.w, 720)
        self.assertEqual(self.w.jobs["J6"].status, "done")
        self.assertEqual(self.w.run_metrics().violations, 0)

    def test_plan_that_breaks_a_constraint_is_rejected_explicitly(self):
        """J6 can't finish before minute 51 (arrive 11 + 40 min). Moving its deadline to 30
        makes every plan that keeps the committed trip invalid: refuse, keep driving."""
        version = self.w.plan.version
        out = replan_sync(self.w, edit("J6", deadline_t=30))
        self.assertFalse(out["applied"])
        self.assertEqual(out["reason"], "rejected")
        self.assertIn("deadline", {v["rule"] for v in out["violations"]})
        self.assertEqual(self.w.plan.version, version)
        self.assertIn("safety_reject", [e["kind"] for e in self.w.log[-2:]])
        advance(self.w, 12)
        self.assertEqual(self.w.gateway.pose("T2").job, "J6")              # still executing the last valid plan


def edit(job, log_type="job_patch", **patch):
    """The trigger the API builds for PATCH /jobs/{id} (staged edit)."""
    return {"type": log_type, "job": job, "edits": [{"job": job, "patch": patch, "log_type": log_type}]}


class StagedEdits(unittest.TestCase):
    """Diya's item 1: a failed edit must leave the previous state intact."""

    def setUp(self):
        self.w = started()
        advance(self.w, 5)                                   # T2 driving to J6: J6 can't finish before 51

    def state(self):
        j = self.w.jobs["J6"]
        return (j.deadline_t, j.priority, j.pinned_to, j.original_deadline_t, self.w.plan.version)

    def test_failed_edit_leaves_previous_state_intact(self):
        before = self.state()
        injected = list(self.w.injected)
        self.w.drain()
        out = replan_sync(self.w, edit("J6", deadline_t=30, priority=1))
        self.assertFalse(out["applied"])
        self.assertEqual(self.state(), before)                              # deadline, priority, plan unchanged
        self.assertEqual(self.w.injected, injected)                         # not replayed in the baseline
        kinds = [(e["kind"], e.get("type")) for e in self.w.log[-2:]]
        self.assertEqual(kinds, [("safety_reject", None), ("event", "edit_rejected")])
        self.assertNotIn(("event", "job_patch"), [(e["kind"], e.get("type")) for e in self.w.log])
        sent = [d for k, d in self.w.drain() if k == "jobs"]
        self.assertTrue(all(j["deadline_t"] == 420 for msg in sent for j in msg["jobs"] if j["id"] == "J6"))

    def test_later_valid_edits_and_replans_still_work(self):
        replan_sync(self.w, edit("J6", deadline_t=30))
        out = replan_sync(self.w, edit("J6", deadline_t=500, priority=3))
        self.assertTrue(out["applied"])
        j = self.w.jobs["J6"]
        self.assertEqual((j.deadline_t, j.priority, j.original_deadline_t), (500, 3, 420))
        self.assertEqual(self.w.log[-1]["type"] if self.w.log[-1]["kind"] == "event" else
                         next(e for e in reversed(self.w.log) if e["kind"] == "event")["type"], "job_patch")
        self.assertEqual(self.w.injected[-1]["patch"], {"deadline_t": 500, "priority": 3})
        self.w.breakdown("T1", "later")                                     # an ordinary later re-plan
        self.assertTrue(replan_sync(self.w, {"type": "breakdown", "tractor": "T1"})["applied"])
        advance(self.w, 720)
        r = self.w.run_metrics()
        self.assertEqual((r.completed, r.violations), (12, 0))

    def test_rollback_does_not_clobber_a_newer_value(self):
        undos = self.w.stage_edits(edit("J6", deadline_t=30)["edits"])
        self.w.jobs["J6"].deadline_t = 450                                  # changed again meanwhile
        self.w.finish_edits(undos, applied=False)
        self.assertEqual(self.w.jobs["J6"].deadline_t, 450)

    def test_scheduled_priority_change_is_staged_too(self):
        sc = copy.deepcopy(SCENARIO)
        sc["events"] = [{"t": 5, "type": "priority_change", "job": "J6", "deadline_t": 30, "reason": "test"}]
        w = run_day(sc)
        self.assertEqual(w.jobs["J6"].deadline_t, 420)
        self.assertIn("edit_rejected", [e.get("type") for e in w.log])
        self.assertEqual(w.run_metrics().completed, 12)


class BaselineTwin(unittest.TestCase):
    """Item 4: the displayed baseline is FCFS on the same day and the same operator actions."""

    def test_no_operator_actions_matches_headless_fcfs(self):
        from app.core.twin import lookup, run_twin
        samples = run_twin(SCENARIO, [])
        full = run_day(copy.deepcopy(SCENARIO), "baseline").run_metrics()
        self.assertEqual(measured(lookup(samples, 720)), measured(full))

    def test_operator_actions_are_replayed_at_the_same_time(self):
        from app.core.twin import lookup, run_twin
        w = started()
        advance(w, 30)
        w.breakdown("T2", "operator"); w.record_injected({"type": "breakdown", "tractor": "T2", "issue": "operator"})
        replan_sync(w, {"type": "breakdown", "tractor": "T2"})
        samples = run_twin(SCENARIO, w.injected)
        self.assertLess(lookup(samples, 720).completed, 12)                 # FCFS also lost T2 at minute 30
        self.assertEqual(measured(lookup(samples, 30.7)), measured(samples[30]))
        unaffected = run_twin(SCENARIO, [])
        self.assertEqual(measured(samples[29]), measured(unaffected[29]))   # identical until the action


if __name__ == "__main__":
    unittest.main()

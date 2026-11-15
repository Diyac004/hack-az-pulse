import json
from pathlib import Path
import unittest

from app.brain.contracts import BrainSnapshot
from app.gateway.base import (
    Arrived, GatewayError, Halted, Idle, Moved, ReachedCell, Stopped, TractorSpec,
    Travel, Work, WorkDone, Worked, orders_from_plan,
)
from app.gateway.mock import MockGateway

ROOT = Path(__file__).resolve().parents[3]
SNAPSHOT = json.loads((ROOT / 'contract/examples/brain_snapshot.json').read_text())
RESULT = json.loads((ROOT / 'contract/examples/brain_result.json').read_text())
FARM = BrainSnapshot.model_validate(SNAPSHOT).map
T0 = SNAPSHOT['t']                      # 141.5, the breakdown moment
T3_ROUTE = next(e['route'] for e in RESULT['plan']['entries']
                if e['tractor'] == 'T3' and e['kind'] == 'travel')


def fixture_gateway():
    """T2 at the depot and T3 at Block C, with the fixture plan assigned."""
    gw = MockGateway(FARM, t0=T0)
    gw.add_tractor(TractorSpec('T2', (1, 6), 0.6))
    gw.add_tractor(TractorSpec('T3', (15, 3), 0.5))
    for tid in ('T2', 'T3'):
        gw.assign(tid, orders_from_plan(RESULT['plan']['entries'], tid))
    return gw


def run(gw, until, dt=0.2):
    out = []
    while gw.t < until - 1e-9:
        out += gw.advance(min(dt, until - gw.t))
    return out


def of(reports, kind, tractor=None):
    return [r for r in reports if isinstance(r, kind) and (tractor is None or r.tractor == tractor)]


def worked(reports, tractor, job):
    return sum(r.minutes for r in of(reports, Worked, tractor) if r.job == job)


class FixturePlan(unittest.TestCase):
    """Tests 1 and 5: the brain_result.json plan plays out on schedule."""

    def setUp(self):
        self.gw = fixture_gateway()
        self.reports = run(self.gw, 260)

    def test_t3_timeline(self):
        done = {r.job: r.t for r in of(self.reports, WorkDone, 'T3')}
        self.assertAlmostEqual(done['J4'], 160, places=6)
        self.assertAlmostEqual(done['J1'], 240, places=6)
        [arr] = of(self.reports, Arrived, 'T3')
        self.assertAlmostEqual(arr.t, 180, places=6)
        self.assertEqual(arr.cell, (10, 8))
        self.assertEqual(arr.job, 'J1')

    def test_t2_timeline(self):
        [arr] = of(self.reports, Arrived, 'T2')
        self.assertAlmostEqual(arr.t, 144.833, places=3)
        [done] = of(self.reports, WorkDone, 'T2')
        self.assertAlmostEqual(done.t, 189.833, places=3)

    def test_work_minutes_exact(self):
        self.assertAlmostEqual(worked(self.reports, 'T3', 'J4'), 18.5, places=6)
        self.assertAlmostEqual(worked(self.reports, 'T3', 'J1'), 60, places=6)
        self.assertAlmostEqual(worked(self.reports, 'T2', 'J9'), 45, places=6)

    def test_idle_once_at_end(self):
        idle = of(self.reports, Idle, 'T3')
        self.assertEqual(len(idle), 1)
        self.assertAlmostEqual(idle[0].t, 240, places=6)
        self.assertEqual(self.gw.pose('T3').status, 'idle')

    def test_travel_fuel_inputs(self):
        moved = of(self.reports, Moved, 'T3')
        self.assertAlmostEqual(sum(m.cells for m in moved), 10, places=6)
        self.assertAlmostEqual(sum(m.minutes for m in moved), 20, places=6)


class Movement(unittest.TestCase):
    """Tests 2, 3, 4: cell by cell, correct headings, whole-cell anchors."""

    def setUp(self):
        self.gw = MockGateway(FARM, t0=160)
        self.gw.add_tractor(TractorSpec('T3', (15, 3), 0.5))
        self.gw.assign('T3', [Travel(tuple(map(tuple, T3_ROUTE)), 'J1')])

    def test_no_teleport(self):
        prev = self.gw.pose('T3')
        reached = []
        while self.gw.t < 181:
            reached += [r.cell for r in of(self.gw.advance(0.2), ReachedCell)]
            p = self.gw.pose('T3')
            self.assertLessEqual(abs(p.x - prev.x) + abs(p.y - prev.y), 0.5 * 0.2 + 1e-9)
            prev = p
        self.assertEqual(reached, [tuple(c) for c in T3_ROUTE[1:]])

    def test_headings(self):
        run(self.gw, 161);  self.assertAlmostEqual(self.gw.pose('T3').heading_deg, 180)  # south
        run(self.gw, 168);  self.assertAlmostEqual(self.gw.pose('T3').heading_deg, 270)  # west
        run(self.gw, 178);  self.assertAlmostEqual(self.gw.pose('T3').heading_deg, 180)  # south

    def test_remaining_route_starts_at_anchor(self):
        run(self.gw, 163)                          # halfway (15,4)->(15,5)
        rest = self.gw.remaining_route('T3')
        self.assertEqual(rest[0], self.gw.pose('T3').anchor)
        self.assertEqual(rest[-1], (10, 8))
        self.assertEqual(len(rest), 7)             # (15,5) .. (10,8)
        run(self.gw, 181)
        self.assertEqual(self.gw.remaining_route('T3'), ())

    def test_wait_entries_are_skipped(self):
        entries = [
            {'tractor': 'T3', 'job': None, 'kind': 'wait', 'start_t': 160, 'end_t': 165, 'route': []},
            {'tractor': 'T3', 'job': 'J1', 'kind': 'work', 'start_t': 165, 'end_t': 170, 'route': []},
        ]
        self.assertEqual(orders_from_plan(entries, 'T3'), [Work('J1', 5, 165)])

    def test_anchor_is_next_whole_cell(self):
        run(self.gw, 163)                          # 1.5 cells along
        p = self.gw.pose('T3')
        self.assertEqual(p.cell, (15, 4))
        self.assertEqual(p.anchor, (15, 5))
        self.assertAlmostEqual(p.anchor_t, 164)
        self.assertAlmostEqual(p.y, 4.5)
        self.assertEqual(p.speed_cells_per_min, 0.5)


class Breakdowns(unittest.TestCase):
    """Tests 6 and 7: stop() freezes in place and nothing else happens."""

    def test_stop_while_working_keeps_partial_minutes(self):
        gw = fixture_gateway()
        before = run(gw, 195)
        gw.stop('T3')
        after = run(gw, 260)
        self.assertAlmostEqual(worked(before, 'T3', 'J1'), 15, places=6)
        self.assertEqual(len(of(after, Stopped, 'T3')), 1)
        self.assertEqual(of(after, Worked, 'T3') + of(after, Moved, 'T3'), [])
        self.assertEqual(gw.pose('T3').status, 'broken')
        self.assertEqual(gw.pose('T3').cell, (10, 8))

    def test_stop_mid_route_freezes_between_cells(self):
        gw = fixture_gateway()
        run(gw, 167)                               # 3.5 cells into the drive
        gw.stop('T3')
        frozen = gw.pose('T3')
        run(gw, 200)
        later = gw.pose('T3')
        self.assertEqual((later.x, later.y, later.status), (frozen.x, frozen.y, 'broken'))
        self.assertEqual(frozen.y, 6)
        self.assertAlmostEqual(frozen.x, 14.5)
        self.assertEqual(frozen.cell, (15, 6))
        self.assertEqual(frozen.anchor, (14, 6))
        with self.assertRaises(GatewayError):
            gw.assign('T3', [])                     # broken: must resume first

    def test_resume_finishes_segment_then_takes_orders(self):
        gw = fixture_gateway()
        run(gw, 167)
        gw.stop('T3')
        run(gw, 170)
        gw.resume('T3')
        gw.assign('T3', [Travel(((14, 6), (13, 6)))])
        r = run(gw, 175)
        self.assertEqual([x.cell for x in of(r, ReachedCell, 'T3')], [(14, 6), (13, 6)])
        self.assertAlmostEqual(of(r, Arrived, 'T3')[0].t, 171 + 2)   # 0.5 cell + 1 cell


class BadOrders(unittest.TestCase):
    """Test 8: refuse instead of teleporting."""

    def setUp(self):
        self.gw = MockGateway(FARM, t0=0)
        self.gw.add_tractor(TractorSpec('T1', (5, 6), 0.5))

    def test_route_with_gap(self):
        with self.assertRaises(GatewayError):
            self.gw.assign('T1', [Travel(((5, 6), (5, 8)))])

    def test_route_through_blocked_cell(self):
        with self.assertRaises(GatewayError):
            self.gw.assign('T1', [Travel(((5, 6), (6, 6), (7, 6), (8, 6)))])

    def test_route_from_wrong_start(self):
        with self.assertRaises(GatewayError):
            self.gw.assign('T1', [Travel(((10, 6), (11, 6)))])

    def test_route_off_road(self):
        with self.assertRaises(GatewayError):
            self.gw.assign('T1', [Travel(((5, 6), (5, 7), (6, 7)))])

    def test_chained_routes_must_connect(self):
        with self.assertRaises(GatewayError):
            self.gw.assign('T1', [Travel(((5, 6), (4, 6))), Travel(((5, 6), (6, 6)))])

    def test_failed_assign_changes_nothing(self):
        self.gw.assign('T1', [Travel(((5, 6), (4, 6)))])
        with self.assertRaises(GatewayError):
            self.gw.assign('T1', [Travel(((9, 9), (9, 8)))])
        r = run(self.gw, 3)
        self.assertEqual(of(r, Arrived)[0].cell, (4, 6))

    def test_unknown_and_duplicate_tractors(self):
        with self.assertRaises(GatewayError):
            self.gw.pose('T9')
        with self.assertRaises(GatewayError):
            self.gw.add_tractor(TractorSpec('T1', (0, 0), 0.5))
        with self.assertRaises(GatewayError):
            self.gw.add_tractor(TractorSpec('T2', (2, 2), 0.5))   # not a road

    def test_road_blocked_after_assign_halts(self):
        farm = FARM.model_copy(deep=True)
        self.gw.assign('T1', [Travel(((5, 6), (5, 5), (5, 4), (5, 3)))])
        run(self.gw, 2.5)                          # past (5,5), heading for (5,4)
        farm.blocked_cells.append((5, 3))
        self.gw.update_map(farm)
        r = run(self.gw, 10)
        [h] = of(r, Halted)
        self.assertEqual(h.cell, (5, 4))
        self.assertEqual(h.reason, 'road_blocked')
        self.assertEqual(self.gw.pose('T1').status, 'idle')


class Robustness(unittest.TestCase):
    """Tests 9-12: tick size, determinism, scale, live fleet changes."""

    def timeline(self, dt):
        r = run(fixture_gateway(), 260, dt)
        key = [(type(x).__name__, x.tractor, round(x.t, 6))
               for x in r if isinstance(x, (Arrived, WorkDone, ReachedCell, Idle))]
        return key, round(worked(r, 'T3', 'J1'), 6)

    def test_tick_size_does_not_matter(self):
        base = self.timeline(0.2)
        for dt in (0.1, 1, 5, 7.3):
            self.assertEqual(self.timeline(dt), base, f'dt={dt}')

    def test_deterministic(self):
        self.assertEqual(run(fixture_gateway(), 260), run(fixture_gateway(), 260))

    def test_fifty_tractors(self):
        gw = MockGateway(FARM, t0=0)
        cells = sorted(c for c in gw._open if c[1] == 0) + sorted(c for c in gw._open if c[1] == 13)
        cells += sorted(c for c in gw._open if c[0] == 0 and 0 < c[1] < 13)
        cells += sorted(c for c in gw._open if c[0] == 15 and 0 < c[1] < 13)
        for i, c in enumerate(cells[:50]):
            gw.add_tractor(TractorSpec(f'T{i}', c, 0.5))
            gw.assign(f'T{i}', [Work(f'J{i}', 10)])
        self.assertEqual(len(gw.tractor_ids()), 50)
        r = run(gw, 12)
        self.assertEqual(len(of(r, WorkDone)), 50)

    def test_add_and_remove_live(self):
        gw = fixture_gateway()
        run(gw, 150)
        gw.add_tractor(TractorSpec('T4', (1, 6), 0.5))
        gw.assign('T4', [Travel(((1, 6), (0, 6)))])
        gw.remove_tractor('T2')
        r = run(gw, 155)
        self.assertEqual(of(r, Arrived, 'T4')[0].cell, (0, 6))
        self.assertEqual(of(r, Worked, 'T2'), [])
        self.assertNotIn('T2', gw.tractor_ids())

    def test_replan_mid_move_finishes_segment_first(self):
        gw = fixture_gateway()
        run(gw, 163)                               # T3 halfway from (15,4) to (15,5)
        p = gw.pose('T3')
        with self.assertRaises(GatewayError):
            gw.assign('T3', [Travel(((15, 4), (15, 3)))])      # can't reverse mid-cell
        gw.assign('T3', [Travel((p.anchor, (15, 4)))])         # plan from the anchor
        r = run(gw, 170)
        self.assertEqual([x.cell for x in of(r, ReachedCell, 'T3')], [(15, 5), (15, 4)])


if __name__ == '__main__':
    unittest.main()

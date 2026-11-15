import json
from pathlib import Path
import unittest
from pydantic import ValidationError
from app.brain.contracts import BrainSnapshot
from app.brain.navigation import RoadRouter

FIXTURE = Path(__file__).resolve().parents[3] / 'contract/examples/brain_snapshot.json'


class Foundations(unittest.TestCase):
    def setUp(self):
        self.data = json.loads(FIXTURE.read_text())
        self.snapshot = BrainSnapshot.model_validate(self.data)
        self.router = RoadRouter(self.snapshot.map, self.snapshot.map_version)

    def test_progress(self):
        self.assertEqual(self.snapshot.jobs[0].remaining_min, 60)
        self.assertEqual(self.snapshot.jobs[1].remaining_min, 18.5)

    def test_fixture_travel(self):
        r = self.router.route((15, 3), (10, 8), .5)
        self.assertTrue(r.reachable)
        self.assertEqual(r.travel_min, 20)
        self.assertNotIn((7, 6), r.path)
        self.assertAlmostEqual(self.router.route((1, 6), (3, 6), .6).travel_min, 10/3)

    def test_invalid_progress(self):
        self.data['jobs'][0]['work_units'][0]['done_min'] = 31
        with self.assertRaises(ValidationError):
            BrainSnapshot.model_validate(self.data)

    def test_no_teleport(self):
        self.assertFalse(self.router.route((10.4, 8), (10, 8), .5).reachable)
        self.assertFalse(self.router.route((7, 6), (10, 8), .5).reachable)

    def test_cache_and_map_isolation(self):
        self.router.route((15, 3), (10, 8), .5)
        self.router.route((15, 3), (1, 6), .5)
        self.assertEqual(len(self.router._trees), 1)
        farm = self.snapshot.map.model_copy(deep=True)
        farm.blocked_cells.append((10, 8))
        other = RoadRouter(farm, 4)
        self.assertFalse(other.route((15, 3), (10, 8), .5).reachable)
        self.assertTrue(self.router.route((15, 3), (10, 8), .5).reachable)


if __name__ == '__main__':
    unittest.main()

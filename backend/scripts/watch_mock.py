"""Watch MockGateway play the fixture plan as a text map.

    PYTHONPATH=backend python backend/scripts/watch_mock.py [--every 4] [--until 250] [--fast]

Map: '=' road, 'X' blocked, '.' field, digits = tractors (T2 -> 2, T3 -> 3).
"""
import argparse
import json
from pathlib import Path
import time

from app.brain.contracts import BrainSnapshot
from app.gateway.base import Arrived, Halted, Idle, Stopped, TractorSpec, WorkDone, orders_from_plan
from app.gateway.mock import MockGateway

ROOT = Path(__file__).resolve().parents[2]


def render(gw, farm):
    marks = {}
    for tid in gw.tractor_ids():
        p = gw.pose(tid)
        marks[(round(p.x), round(p.y))] = tid[1:]
    blocked = {tuple(c) for c in farm.blocked_cells}
    rows = []
    for y in range(farm.grid.height):
        line = []
        for x in range(farm.grid.width):
            if (x, y) in marks:
                line.append(marks[(x, y)])
            elif (x, y) in blocked:
                line.append('X')
            elif y in farm.roads.rows or x in farm.roads.cols:
                line.append('=')
            else:
                line.append('.')
        rows.append(' '.join(line))
    return '\n'.join(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--every', type=float, default=4, help='sim minutes between frames')
    ap.add_argument('--until', type=float, default=250)
    ap.add_argument('--fast', action='store_true', help='no pause between frames')
    args = ap.parse_args()

    snap = json.loads((ROOT / 'contract/examples/brain_snapshot.json').read_text())
    plan = json.loads((ROOT / 'contract/examples/brain_result.json').read_text())['plan']
    farm = BrainSnapshot.model_validate(snap).map

    gw = MockGateway(farm, t0=snap['t'])
    gw.add_tractor(TractorSpec('T2', (1, 6), 0.6))
    gw.add_tractor(TractorSpec('T3', (15, 3), 0.5))
    for tid in gw.tractor_ids():
        gw.assign(tid, orders_from_plan(plan['entries'], tid))

    events = []
    while gw.t < args.until:
        for r in gw.advance(args.every):
            if isinstance(r, (Arrived, WorkDone, Idle, Halted, Stopped)):
                events.append(f't={r.t:7.2f}  {r.tractor}  {type(r).__name__} '
                              f'{getattr(r, "job", "") or getattr(r, "cell", "")}')
        print(f'\n--- t = {gw.t:.1f} ---')
        print(render(gw, farm))
        for tid in gw.tractor_ids():
            p = gw.pose(tid)
            print(f'{tid}  {p.status:9}  at ({p.x:5.2f},{p.y:5.2f})  heading {p.heading_deg:5.1f}  job {p.job}')
        for e in events[-3:]:
            print('  ', e)
        if not args.fast:
            time.sleep(0.3)


if __name__ == '__main__':
    main()

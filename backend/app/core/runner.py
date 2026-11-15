"""Headless, deterministic full-day run (no server, no real time).

    PYTHONPATH=backend python -m app.core.runner --mode ours
    PYTHONPATH=backend python -m app.core.runner --mode both   # ours + FCFS baseline table

Same scenario, same scheduled events, same simulator for both policies; only
dispatch differs. Writes logs/event_log_<mode>.jsonl.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .planner import merge_triggers, replan_sync
from .state import World

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SCENARIO = ROOT / "data" / "scenario.json"


def load_scenario(path: Path | str = DEFAULT_SCENARIO) -> dict:
    return json.loads(Path(path).read_text())


def run_day(scenario: dict, mode: str = "ours", dt: float = 1.0,
            log_path: Path | None = None, until: float | None = None) -> World:
    world = World(scenario, mode, log_path)
    replan_sync(world, {"type": "run"})
    world.playing = True
    stop_at = world.day_minutes if until is None else until
    while not world.ended and world.t < stop_at - 1e-9:
        trigger = merge_triggers(world.step(min(dt, stop_at - world.t)))
        if trigger:
            replan_sync(world, trigger)
    world.drain()
    return world


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default=str(DEFAULT_SCENARIO))
    ap.add_argument("--mode", choices=["ours", "baseline", "both"], default="both")
    ap.add_argument("--logs", default=str(ROOT / "logs"))
    args = ap.parse_args()
    scenario = load_scenario(args.scenario)
    modes = ["ours", "baseline"] if args.mode == "both" else [args.mode]
    rows = {}
    for mode in modes:
        world = run_day(scenario, mode, log_path=Path(args.logs) / f"event_log_{mode}.jsonl")
        rows[mode] = world.run_metrics().model_dump()
        print(f"{mode}: wrote {Path(args.logs) / f'event_log_{mode}.jsonl'}")
    keys = ["jobs_total", "completed", "on_time", "weighted_on_time", "travel_min", "idle_min",
            "productive_min", "violations", "replan_ms_last"]
    print(f"\n{'metric':18}" + "".join(f"{m:>12}" for m in modes))
    for k in keys:
        print(f"{k:18}" + "".join(f"{str(rows[m][k]):>12}" for m in modes))


if __name__ == "__main__":
    main()

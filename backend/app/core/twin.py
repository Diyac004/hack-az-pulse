"""Baseline twin: the comparison the dashboard's scorecard shows.

FCFS (Diya's `policy="fcfs"`) on the same scenario, through the same simulator,
with the live run's operator actions (breakdowns, repairs, road blocks, job
edits, new jobs, fleet changes) replayed at the same farm times. Metrics are
sampled at every whole farm minute, so the live scorecard compares both
policies at the same moment of the same day.

It is recomputed (in a thread) whenever the live run's operator actions
change. Until the matching twin is ready the baseline is shown as unavailable
(null), never as an older run.
"""
from __future__ import annotations

import copy
import json
import math

from app import models as m

from .planner import merge_triggers, replan_sync
from .state import EPS, World


def twin_key(scenario_name: str, injected: list[dict]) -> str:
    return json.dumps({"scenario": scenario_name, "injected": injected}, sort_keys=True, default=str)


def run_twin(scenario: dict, injected: list[dict], mode: str = "baseline") -> dict[int, m.RunMetrics]:
    """Full day for `mode` with `injected` replayed. Returns {farm minute: RunMetrics}."""
    sc = copy.deepcopy(scenario)
    replay = [{k: v for k, v in ev.items()} for ev in injected]
    sc["events"] = sorted(list(sc.get("events", [])) + replay, key=lambda e: e["t"])   # stable: scenario first
    w = World(sc, mode)
    replan_sync(w, {"type": "run"})
    w.playing = True
    samples = {0: w.run_metrics()}
    while not w.ended:
        mark = math.floor(w.t + EPS) + 1
        trigger = merge_triggers(w.step(mark - w.t))
        if trigger:
            replan_sync(w, trigger)
        if w.t >= mark - EPS:
            samples[mark] = w.run_metrics()
    w.drain()
    return samples


def lookup(samples: dict[int, m.RunMetrics], t: float) -> m.RunMetrics | None:
    """Metrics at the most recent whole farm minute <= t."""
    minute = math.floor(t + EPS)
    while minute >= 0 and minute not in samples:
        minute -= 1
    return samples.get(minute)

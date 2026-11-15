# Submission checklist and copy-ready text

## Required artifacts

- Code: https://github.com/Diyac004/hack-az-pulse
- Run instructions and simulator disclosure: https://github.com/Diyac004/hack-az-pulse/blob/main/README.md
- Scenario: https://github.com/Diyac004/hack-az-pulse/blob/main/submission/demo-run/scenario.json
- Demo event log: https://github.com/Diyac004/hack-az-pulse/blob/main/submission/demo-run/event_log_ours.jsonl
- Baseline comparison: https://github.com/Diyac004/hack-az-pulse/blob/main/submission/RESULTS.md
- Baseline event log: https://github.com/Diyac004/hack-az-pulse/blob/main/submission/demo-run/event_log_baseline.jsonl
- Machine-readable evidence: https://github.com/Diyac004/hack-az-pulse/blob/main/submission/demo-run/results.json

## Project title

Harvest Fleet AI — Pulse

## Short description

Pulse coordinates a simulated autonomous tractor fleet: it assigns compatible jobs, checks fuel and deadlines, and replans unfinished work after breakdowns while preserving completed progress. An independent validator gates plans, and the dashboard shows assignments, progress and factual explanations. The scored path uses our Python MockGateway simulator and compares the same farm day against FCFS. Optional LLM reviewers propose operator-approved changes; a separate AgOpenWeb bridge demonstrates guidance but is not the source of the scored coordinator metrics.

## Result statement

In the submitted three-tractor, eight-field, 12-job scenario with a scripted breakdown, both policies finish 12 jobs on time. Our coordinator uses 76 travel tractor-minutes versus FCFS's 148, and 80 idle tractor-minutes versus 272, with zero reported executed violations in both runs. These are scenario-specific simulation results, not guaranteed global improvements.

## Final handoff

All five requested artifact types are included in this repository. The team must still submit these links through the organizer's submission form before its stated deadline. This repository does not itself submit the entry. No claim of prize-track eligibility, receipt or acceptance is made here.

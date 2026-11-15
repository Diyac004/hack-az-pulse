"""Headless single-snapshot demo (not an end-of-day comparison)."""
import argparse
import json
from . import plan, explain

parser=argparse.ArgumentParser()
parser.add_argument('snapshot')
parser.add_argument('--policy', choices=['multi','fcfs'], default='multi')
args=parser.parse_args()
with open(args.snapshot) as f:
    result=plan(json.load(f),policy=args.policy)
print(json.dumps({'result':result.model_dump(),'explanation':explain(result)},indent=2))

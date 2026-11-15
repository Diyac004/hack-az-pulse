import copy
import json
from pathlib import Path
import unittest
from app.brain.contracts import BrainSnapshot, ProposedPlan
from app.brain.scheduler import plan
from app.brain.validator import validate
from app.brain.explanations import explain

FIXTURE=Path(__file__).resolve().parents[3]/'contract/examples/brain_snapshot.json'


class PlanningTests(unittest.TestCase):
    def setUp(self):
        self.data=json.loads(FIXTURE.read_text())

    def test_recovery_preserves_progress_and_input(self):
        original=copy.deepcopy(self.data)
        result=plan(self.data)
        self.assertTrue(result.validation.passed)
        self.assertEqual(self.data,original)
        work={e.job:e for e in result.plan.entries if e.kind=='work'}
        self.assertEqual(work['J1'].tractor,'T3')
        self.assertEqual(work['J1'].end_t-work['J1'].start_t,60)
        self.assertEqual(work['J4'].start_t,141.5)
        self.assertEqual(work['J4'].end_t,160)
        self.assertEqual(result.facts['moved'][0]['progress_kept'],.6)
        self.assertIn('60%',explain(result))

    def test_no_backup(self):
        self.data['tractors'][2]['implements']=['mower']
        result=plan(self.data)
        self.assertTrue(result.validation.passed)
        self.assertIn('J1',[u.job for u in result.unassigned])
        self.assertFalse(any(e.job=='J1' for e in result.plan.entries))

    def test_deadline(self):
        self.data['jobs'][0]['deadline_t']=150
        result=plan(self.data)
        self.assertTrue(result.validation.passed)
        self.assertIn('deadline',next(u.detail for u in result.unassigned if u.job=='J1'))

    def test_low_fuel(self):
        self.data['tractors'][1]['fuel_pct']=10
        result=plan(self.data)
        self.assertTrue(result.validation.passed)
        self.assertIn('J9',[u.job for u in result.unassigned])

    def test_unsupported_refuel(self):
        self.data['constraints']['refuel']=True
        result=plan(self.data)
        self.assertEqual(result.status,'unsupported')
        self.assertFalse(result.validation.passed)

    def test_duplicate_and_bad_route_rejected(self):
        s=BrainSnapshot.model_validate(self.data)
        p=plan(s).plan.model_copy(deep=True)
        p.entries.append(next(e for e in p.entries if e.job=='J1' and e.kind=='work').model_copy())
        self.assertIn('duplicate_job',[v.rule for v in validate(s,p).violations])
        p=plan(s).plan.model_copy(deep=True)
        travel=next(e for e in p.entries if e.kind=='travel')
        travel.route=[travel.route[0],travel.route[-1]]
        self.assertFalse(validate(s,p).passed)

    def test_frozen_work_cannot_disappear(self):
        s=BrainSnapshot.model_validate(self.data)
        self.assertIn('frozen_preservation',[v.rule for v in validate(s,ProposedPlan(entries=[])).violations])

    def test_repeatable_and_fcfs(self):
        a,b=plan(self.data),plan(self.data)
        self.assertEqual(a.plan.entries,b.plan.entries)
        self.assertTrue(plan(self.data,policy='fcfs').validation.passed)

    def test_new_fields_survive_parsing(self):
        s=BrainSnapshot.model_validate(self.data)
        self.assertEqual(s.previous_plan.version,6)
        self.assertIsNone(s.frozen[0].remaining_route)

    def test_no_invented_deltas_or_previous_owner(self):
        del self.data['previous_plan']
        r=plan(self.data)
        self.assertEqual(r.facts['moved'],[])
        self.assertNotIn('travel_delta_min',r.facts)

    def test_future_position_rejected_without_activity(self):
        self.data['tractors'][1]['available_from_t']=170
        r=plan(self.data)
        self.assertIn('future_state_unmodeled',next(u.detail for u in r.unassigned if u.job=='J9'))

    def test_public_plan_serialization(self):
        # Public model comes from the actual documented model snippet.
        from pydantic import BaseModel, Field
        from typing import Literal, Optional
        namespace={'BaseModel':BaseModel,'Field':Field,'Literal':Literal,'Optional':Optional, 'PlanKind':Literal['travel','work','refuel','wait','swap_implement']}
        text=(FIXTURE.parents[2]/'ARCHITECTURE.md').read_text()
        start=text.index('class PlanEntry(BaseModel):')
        end=text.index('class Explanation(BaseModel):',start)
        exec(text[start:end],namespace)
        public=namespace['Plan'].model_validate({'version':7,**plan(self.data).plan.model_dump()})
        self.assertEqual(public.solver_status,'feasible')


if __name__=='__main__':
    unittest.main()

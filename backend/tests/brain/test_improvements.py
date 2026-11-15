import copy
import json
from pathlib import Path
from time import perf_counter
import unittest
from pydantic import ValidationError
from app.brain import BrainSnapshot, plan, validate, explain
from app.brain.navigation import RoadRouter
from app.brain.scheduler import _build, _improve, _score
from app.gateway.base import TractorSpec, Worked, Moved, orders_from_plan
from app.gateway.mock import MockGateway

ROOT=Path(__file__).resolve().parents[3]


class Improvements(unittest.TestCase):
    def setUp(self):
        self.data=json.loads((ROOT/'contract/examples/brain_snapshot.json').read_text())

    def test_nonfinite_state_rejected(self):
        for key in ('t','horizon_t'):
            bad=copy.deepcopy(self.data);bad[key]=float('nan')
            with self.assertRaises(ValidationError):
                BrainSnapshot.model_validate(bad)

    def test_relocation_reduces_travel(self):
        d=self.data;d['frozen']=[];d['previous_plan']=None
        t=d['tractors'][1];t['implements']=['mower'];t['fuel_pct']=100
        d['tractors']=[t]
        d['map']['entrances']={'A':[[3,6]],'B':[[10,8]],'C':[[15,3]]}
        d['jobs']=[{'id':jid,'type':'mow','implement':'mower','block':block,'priority':1,'deadline_t':720,'status':'pending','pinned_to':None,'work_units':[{'unit':1,'minutes':5,'done_min':0}]} for jid,block in [('JA','A'),('JB','B'),('JC','C')]]
        s=BrainSnapshot.model_validate(d);router=RoadRouter(s.map,s.map_version)
        q={'T2':['JB','JA','JC']};initial=_build(s,q,router)
        self.assertTrue(validate(s,initial).passed)
        _,improved,attempts,accepted=_improve(s,q,initial,router,perf_counter()+1)
        self.assertGreater(attempts,0);self.assertGreater(accepted,0)
        self.assertLess(_score(s,improved),_score(s,initial))
        self.assertTrue(validate(s,improved).passed)

    def test_retiming_explanation(self):
        self.data['previous_plan']['entries'].append({'tractor':'T2','job':'J9','kind':'work','start_t':300,'end_t':345,'route':[]})
        r=plan(self.data)
        retimed=next(x for x in r.plan.diff['retimed'] if x['job']=='J9')
        self.assertEqual(retimed['old_start_t'],300)
        self.assertIn('Start times changed for 2 jobs',explain(r))
        from app.brain.explanations import farm_clock
        self.assertEqual(farm_clock(300), '11:00 AM')
        self.assertNotIn('J4',[x['job'] for x in r.plan.diff['retimed']])

    def test_field_work_cannot_overlap(self):
        s=BrainSnapshot.model_validate(self.data)
        p=plan(s).plan.model_copy(deep=True)
        # Put hauling in the same modeled field/time as frozen mowing.
        js=s.jobs[-1];js.block='C';js.implement='mower';js.type='mow'
        s.tractors[1].implements=['mower']
        e=next(e for e in p.entries if e.job=='J9' and e.kind=='work')
        e.start_t=145;e.end_t=190
        self.assertIn('field_conflict',[v.rule for v in validate(s,p).violations])

    def test_low_fuel_return_is_required(self):
        self.data['tractors'][1]['fuel_pct']=15
        # T2 can drive/work without dropping below 10%, but cannot return.
        self.data['tractors'][1]['fuel_burn_pct_per_min']={'travel':1,'work':0}
        r=plan(self.data)
        self.assertIn('return_fuel',next(u.detail for u in r.unassigned if u.job=='J9'))

    def test_computed_plan_executes_and_second_breakdown_preserves_work(self):
        """Real planner + real MockGateway, with a minimal test-only report reducer."""
        s=BrainSnapshot.model_validate(self.data)
        r=plan(s)
        gw=MockGateway(s.map,t0=s.t)
        for t in s.tractors:
            if t.id=='T1':continue
            gw.add_tractor(TractorSpec(t.id,(int(t.x),int(t.y)),t.speed_cells_per_min))
            gw.assign(t.id,orders_from_plan([e.model_dump() for e in r.plan.entries],t.id))
        def apply_reports(reports):
            for report in reports:
                if isinstance(report,Worked):
                    j=next(j for j in s.jobs if j.id==report.job)
                    left=report.minutes
                    for u in j.work_units:
                        amount=min(left,u.minutes-u.done_min)
                        u.done_min+=amount;left-=amount
                    self.assertLess(abs(left),1e-7)
                if isinstance(report,(Worked,Moved)):
                    t=next(t for t in s.tractors if t.id==report.tractor)
                    burn=t.fuel_burn_pct_per_min.work if isinstance(report,Worked) else t.fuel_burn_pct_per_min.travel
                    t.fuel_pct-=report.minutes*burn
        apply_reports(gw.advance(58.5))  # 141.5 -> 200, halfway into recovered J1
        j1=s.jobs[0]
        self.assertAlmostEqual(j1.remaining_min,40)
        gw.stop('T3')
        s.t=200;s.state_version+=1;s.frozen=[]
        for t in s.tractors:
            if t.id=='T1':continue
            pose=gw.pose(t.id);t.x=pose.x;t.y=pose.y
            t.status='broken' if t.id=='T3' else 'idle';t.available_from_t=None
        for j in s.jobs:
            j.status='done' if j.remaining_min<1e-6 else 'paused'
        failed=plan(s)
        self.assertTrue(failed.validation.passed)
        self.assertEqual([u.job for u in failed.unassigned],['J1'])
        # A replacement becomes available; no already-completed work is reissued.
        replacement=s.tractors[2].model_copy(deep=True)
        replacement.id='T4';replacement.status='idle';replacement.x=1;replacement.y=6;replacement.fuel_pct=100
        s.tractors.append(replacement)
        recovery=plan(s)
        self.assertTrue(recovery.validation.passed)
        self.assertEqual([e.job for e in recovery.plan.entries if e.kind=='work'],['J1'])
        gw.add_tractor(TractorSpec('T4',(1,6),replacement.speed_cells_per_min))
        gw.assign('T4',orders_from_plan([e.model_dump() for e in recovery.plan.entries],'T4'))
        apply_reports(gw.advance(150))
        self.assertAlmostEqual(j1.remaining_min,0)
        for j in s.jobs:
            self.assertTrue(all(u.done_min<=u.minutes for u in j.work_units))


if __name__=='__main__':unittest.main()

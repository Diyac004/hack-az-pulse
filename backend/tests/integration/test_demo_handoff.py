"""Small regression tests for Divi's integration report."""
import copy
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from app import models as m
from app.core.engine import Engine
from app.core.runner import load_scenario, DEFAULT_SCENARIO
from app.core.state import World, WorldError
from app.brain import plan, explain


class Handoff(unittest.TestCase):
    def test_capacity_enforced_and_broadcast(self):
        scenario=load_scenario();scenario['max_tractors']=4
        w=World(scenario);w.drain()
        self.assertEqual((w.capacity_view()['used'],w.capacity_view()['max']),(3,4))
        w.add_tractor(m.FleetEntry(implements=['mower'],fuel_pct=80,speed=1))
        self.assertIn('capacity',[kind for kind,_ in w.drain()])
        self.assertEqual(w.capacity_view()['used'],4)
        with self.assertRaises(WorldError) as err:
            w.add_tractor(m.FleetEntry(implements=['mower'],fuel_pct=80,speed=1))
        self.assertEqual(err.exception.code,'AT_CAPACITY')
        self.assertEqual(len(w.tractors),4)
        w.remove_tractor('T4')
        updates=[data for kind,data in w.drain() if kind=='capacity']
        self.assertEqual(updates[-1]['used'],3)

    def test_scripted_switch_keeps_manual_events_possible(self):
        with patch.dict('os.environ',{'HFA_SCRIPTED':'0','HFA_MAX_TRACTORS':'6'}):
            e=Engine(DEFAULT_SCENARIO,tempfile.mkdtemp())
        self.assertEqual(e.world.events,[])
        self.assertEqual(e.scenario['events'],[])  # same scenario feeds the baseline twin
        self.assertEqual(e.world.max_tractors,6)
        e.world.breakdown('T1','manual demo')
        self.assertEqual(e.world.tractors['T1'].status,'broken')

    def test_capabilities_and_http_errors(self):
        from app.main import create_app
        with TestClient(create_app(log_dir=tempfile.mkdtemp(),autorun=False)) as c:
            caps=c.get('/api/capabilities').json()
            self.assertTrue(caps['submitJobs']);self.assertFalse(caps['mechanics'])
            self.assertFalse(caps['events']['heat_alert'])
            for method,path,status in [('GET','/api/nothing',404),('PUT','/api/jobs',405)]:
                response=c.request(method,path)
                self.assertEqual(response.status_code,status)
                self.assertEqual(set(response.json()['error']),{'code','message','details'})
                if status==405:self.assertIn('allow',response.headers)

    def test_readable_bounded_explanations_keep_detailed_facts(self):
        w=World(load_scenario())
        result=plan(w.to_brain_snapshot({'type':'run'}))
        text=explain(result)
        self.assertIn('farm plan is ready',text)
        self.assertNotIn('farm minute',text)
        self.assertLess(len(text),700)
        self.assertEqual(len(result.facts['context']['jobs']),12)
        result.facts['event']={'type':'tractor_added','tractor':'T4'}
        result.facts['moved']=[];result.facts['newly_assigned']=[];result.facts['retimed']=[]
        self.assertIn('Tractor 4 joined',explain(result))
        self.assertIn('No job assignments changed',explain(result))


if __name__=='__main__':unittest.main()

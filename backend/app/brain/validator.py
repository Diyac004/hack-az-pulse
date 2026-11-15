"""Independent schedule replay; never mutates the world."""
from math import isclose
from .contracts import ValidationResult, Violation
from .navigation import RoadRouter

EPS = 1e-6
ACTIVE = {'idle', 'ready', 'working', 'traveling'}
REQUIRED = {'spray':'sprayer', 'mow':'mower', 'hedge':'hedger', 'haul_bins':'bin_trailer'}


def validate(s, plan):
    errors = []
    def fail(rule, detail, tractor=None, job=None):
        errors.append(Violation(rule=rule, detail=detail, tractor=tractor, job=job))
    if s.constraints.refuel or s.constraints.weather:
        fail('unsupported_constraint', 'Refueling/weather not implemented in v1')
    router = RoadRouter(s.map, s.map_version)
    ts = {t.id:t for t in s.tractors}
    js = {j.id:j for j in s.jobs}
    for e in plan.entries:
        if e.tractor not in ts or (e.job is not None and e.job not in js):
            fail('reference', 'Unknown tractor/job', e.tractor, e.job)
        if e.end_t <= e.start_t or e.start_t < s.t-EPS or e.end_t > s.horizon_t+EPS:
            fail('time_bounds', 'Invalid interval/horizon', e.tractor, e.job)
        if e.kind not in {'work','travel','wait'}:
            fail('unsupported_activity', e.kind, e.tractor,e.job)
    for f in s.frozen:
        if f.kind != 'work':
            fail('unsupported_frozen', 'Ongoing travel requires connector implementation', f.tractor,f.job)
        if not any(e.tractor==f.tractor and e.job==f.job and e.kind==f.kind and isclose(e.start_t,max(s.t,f.start_t),abs_tol=EPS) and isclose(e.end_t,f.end_t,abs_tol=EPS) for e in plan.entries):
            fail('frozen_preservation','Ongoing work must remain unchanged',f.tractor,f.job)
    seen = set()
    fields = {}
    for t in s.tractors:
        queue=sorted([e for e in plan.entries if e.tractor==t.id],key=lambda e:(e.start_t,e.end_t))
        if not queue:
            continue
        if t.manual or t.status not in ACTIVE:
            fail('operational','Tractor not automatically available',t.id)
        pos=(t.x,t.y); fuel=t.fuel_pct
        frozen=any(f.tractor==t.id and f.kind=='work' for f in s.frozen)
        available=s.t if frozen else max(s.t,t.available_from_t or s.t)
        if available>s.t+EPS:
            fail('future_state_unmodeled','Future position needs explicit activity and fuel accounting',t.id)
        for e in queue:
            if e.start_t<available-EPS:
                fail('overlap','Overlapping tractor activities',t.id,e.job)
            available=max(available,e.end_t)
            duration=e.end_t-e.start_t
            if e.kind=='travel':
                if not e.route or tuple(e.route[0])!=pos:
                    fail('route_start','Route must start at actual position',t.id,e.job)
                if any(c not in router.cells for c in e.route):
                    fail('route_blocked','Route leaves available roads',t.id,e.job)
                if any(abs(a[0]-b[0])+abs(a[1]-b[1])!=1 for a,b in zip(e.route,e.route[1:])):
                    fail('route_continuity','Nonadjacent route cells',t.id,e.job)
                if e.route:
                    if not isclose(duration,(len(e.route)-1)/t.speed_cells_per_min,abs_tol=EPS):
                        fail('travel_duration','Time disagrees with speed/path',t.id,e.job)
                    pos=tuple(e.route[-1])
                fuel-=duration*t.fuel_burn_pct_per_min.travel
            elif e.kind=='work':
                j=js.get(e.job)
                if j is None:
                    fail('work_job','Work needs known job',t.id,e.job);continue
                if j.id in seen:
                    fail('duplicate_job','Remaining work assigned twice',t.id,j.id)
                seen.add(j.id)
                if j.status in {'done','dropped'} or j.remaining_min<=EPS:
                    fail('completed_work','Completed/cancelled job reassigned',t.id,j.id)
                if j.implement not in t.implements or (j.pinned_to and j.pinned_to!=t.id) or REQUIRED.get(j.type)!=j.implement:
                    fail('compatibility','Capability/implement/pin mismatch',t.id,j.id)
                if pos not in s.map.entrances.get(j.block,[]):
                    fail('work_location','Work not at field entrance',t.id,j.id)
                if not isclose(duration,j.remaining_min,abs_tol=EPS):
                    fail('progress','Duration differs from remaining work',t.id,j.id)
                if e.end_t>j.deadline_t+EPS:
                    fail('deadline','Deadline missed',t.id,j.id)
                fields.setdefault(j.block,[]).append(e)
                fuel-=duration*t.fuel_burn_pct_per_min.work
            if fuel<s.constraints.fuel_reserve_pct-EPS:
                fail('fuel_reserve','Fuel below reserve',t.id,e.job)
            depot=s.map.depot
            r=router.route(pos,(depot.x,depot.y),t.speed_cells_per_min)
            if not r.reachable or fuel-(r.travel_min or 0)*t.fuel_burn_pct_per_min.travel<s.constraints.fuel_reserve_pct-EPS:
                fail('return_fuel','Cannot return with reserve',t.id,e.job)
    for block,tasks in fields.items():
        for i,a in enumerate(tasks):
            for b in tasks[i+1:]:
                if max(a.start_t,b.start_t)<min(a.end_t,b.end_t)-EPS:
                    fail('field_conflict',f'Overlapping work in {block}',b.tractor,b.job)
    return ValidationResult(passed=not errors,violations=errors)

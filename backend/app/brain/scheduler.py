"""Multi-order greedy insertion, independently validated before returning."""
from time import perf_counter
from .contracts import BrainSnapshot, PlanEntry, ProposedPlan, PlanningResult, Unassigned
from .navigation import RoadRouter
from .validator import validate, ACTIVE, EPS


def _frozen(s):
    return [PlanEntry(tractor=f.tractor,job=f.job,kind=f.kind,start_t=max(s.t,f.start_t),end_t=f.end_t,route=f.remaining_route or []) for f in s.frozen]


def _build(s, queues, router):
    entries=_frozen(s)
    js={j.id:j for j in s.jobs}
    for t in s.tractors:
        own=[e for e in entries if e.tractor==t.id]
        now=max([s.t,t.available_from_t or s.t]+[e.end_t for e in own])
        pos=(t.x,t.y)
        for jid in queues[t.id]:
            j=js[jid]
            candidates=[]
            for entrance in s.map.entrances.get(j.block,[]):
                r=router.route(pos,entrance,t.speed_cells_per_min)
                if r.reachable:
                    candidates.append((r.travel_min,entrance,r))
            if not candidates:
                return None
            travel,entrance,r=min(candidates,key=lambda v:(v[0],v[1]))
            if travel>EPS:
                entries.append(PlanEntry(tractor=t.id,job=j.id,kind='travel',start_t=now,end_t=now+travel,route=list(r.path)))
                now+=travel
            # Wait for previously constructed work in the same field.
            start=now
            for other in sorted([e for e in entries if e.kind=='work' and js[e.job].block==j.block],key=lambda e:e.start_t):
                if start<other.end_t-EPS and start+j.remaining_min>other.start_t+EPS:
                    start=other.end_t
            if start>now+EPS:
                entries.append(PlanEntry(tractor=t.id,job=None,kind='wait',start_t=now,end_t=start))
            entries.append(PlanEntry(tractor=t.id,job=j.id,kind='work',start_t=start,end_t=start+j.remaining_min))
            now=start+j.remaining_min;pos=entrance
    return ProposedPlan(entries=sorted(entries,key=lambda e:(e.start_t,e.tractor,e.kind)))


def _score(s,p):
    jobs={j.id:j for j in s.jobs}
    work=[e for e in p.entries if e.kind=='work']
    travel=sum(e.end_t-e.start_t for e in p.entries if e.kind=='travel')
    # Exact idle comparison is produced by the shared simulator; this is a planning proxy.
    wait=sum(e.end_t-e.start_t for e in p.entries if e.kind=='wait')
    return (-sum(jobs[e.job].priority for e in work),-len(work),round(travel,9),round(wait,9))


def plan(snapshot: BrainSnapshot | dict, policy='multi', budget_ms=1000) -> PlanningResult:
    """Return a proposal only; caller applies with source-state-version gate.

    budget_ms bounds candidate search, not a hard process-level timeout.
    policy='fcfs' selects the first feasible queue append in submission order.
    """
    if policy not in {'multi','fcfs'} or budget_ms<=0:
        raise ValueError('Expected multi/fcfs and a positive search budget')
    s=BrainSnapshot.model_validate(snapshot) if isinstance(snapshot,dict) else snapshot
    began=perf_counter()
    base=ProposedPlan(entries=_frozen(s))
    initial=validate(s,base)
    if not initial.passed:
        unsupported=any(v.rule.startswith('unsupported') for v in initial.violations)
        base.solver_status='no_feasible_plan'
        return PlanningResult(source_state_version=s.state_version,status='unsupported' if unsupported else 'infeasible',solve_ms=(perf_counter()-began)*1000,plan=base,unassigned=[Unassigned(job=j.id,reason='invalid_snapshot',detail='; '.join(v.detail for v in initial.violations)) for j in s.jobs if j.remaining_min>EPS and j.status not in {'done','dropped'}],facts={'event':s.trigger},validation=initial)
    router=RoadRouter(s.map,s.map_version)
    frozen_ids={f.job for f in s.frozen}
    todo=[j for j in s.jobs if j.id not in frozen_ids and j.remaining_min>EPS and j.status not in {'done','dropped'}]
    def count(j):
        return sum(t.status in ACTIVE and not t.manual and j.implement in t.implements and (not j.pinned_to or j.pinned_to==t.id) for t in s.tractors)
    orders=[todo] if policy=='fcfs' else [sorted(todo,key=lambda j:(-j.priority,j.deadline_t,j.id)),sorted(todo,key=lambda j:(j.deadline_t,-j.priority,j.id)),sorted(todo,key=lambda j:(count(j),j.deadline_t,-j.priority,j.id))]
    best=base; best_reasons={j.id:['Search budget exhausted'] for j in todo}
    exhausted=False
    for order in orders:
        queues={t.id:[] for t in s.tractors}; current=base;reasons={}
        for j in order:
            choices=[]; rejected=[]
            for t in s.tractors:
                if (perf_counter()-began)*1000>budget_ms:
                    exhausted=True;break
                if t.status not in ACTIVE or t.manual or j.implement not in t.implements or (j.pinned_to and j.pinned_to!=t.id):
                    rejected.append(f'{t.id}: unavailable or incompatible');continue
                positions=[len(queues[t.id])] if policy=='fcfs' else range(len(queues[t.id])+1)
                for pos in positions:
                    if (perf_counter()-began)*1000>budget_ms:
                        exhausted=True;break
                    candidate_queues={tid:list(q) for tid,q in queues.items()}
                    candidate_queues[t.id].insert(pos,j.id)
                    proposed=_build(s,candidate_queues,router)
                    if proposed is None:
                        rejected.append(f'{t.id}: no road path');continue
                    check=validate(s,proposed)
                    if check.passed:
                        choices.append((_score(s,proposed),t.id,pos,proposed,candidate_queues))
                        if policy=='fcfs':break
                    else:
                        rejected.extend(f'{t.id}: {v.rule}' for v in check.violations)
                if policy=='fcfs' and choices:break
            if choices:
                _,_,_,current,queues=min(choices,key=lambda c:(c[0],c[1],c[2]))
            else:
                reasons[j.id]=sorted(set(rejected)) or ['Search budget exhausted']
        if _score(s,current)<_score(s,best) or best is base:
            best=current;best_reasons=reasons
        if exhausted:break
    old={e.job:e.tractor for e in s.previous_plan.entries if e.kind=='work'} if s.previous_plan else {}
    assigned={e.job:e.tractor for e in best.entries if e.kind=='work'}
    moved=[{'job':jid,'from':old[jid],'to':tid,'progress_kept':1-next(j.remaining_min/sum(u.minutes for u in j.work_units) for j in s.jobs if j.id==jid)} for jid,tid in assigned.items() if jid in old and old[jid]!=tid]
    best.diff['moved']=[{k:v for k,v in m.items() if k!='progress_kept'} for m in moved]
    unassigned=[Unassigned(job=j.id,reason='no_feasible_assignment',detail='; '.join(best_reasons.get(j.id,['No feasible insertion found']))) for j in todo if j.id not in assigned]
    elapsed=round((perf_counter()-began)*1000,3);best.solve_ms=round(elapsed)
    return PlanningResult(source_state_version=s.state_version,status='feasible',solve_ms=elapsed,plan=best,unassigned=unassigned,facts={'event':s.trigger,'moved':moved,'newly_assigned':[{'job':jid,'to':tid} for jid,tid in assigned.items() if jid not in old],'deadlines_missed':[],'search_budget_exhausted':exhausted},validation=validate(s,best))

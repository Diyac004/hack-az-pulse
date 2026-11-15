"""Bounded, factual operator summaries. Detailed changes remain in facts/diff."""
def farm_clock(t):
    minute = round(t) + 6 * 60
    day, minute = divmod(minute, 24 * 60)
    hour, minute = divmod(minute, 60)
    return f"{hour % 12 or 12}:{minute:02d} {'AM' if hour < 12 else 'PM'}" + (f' (+{day} day)' if day else '')


def explain(result):
    if not result.validation.passed:
        return 'No new plan applied. ' + '; '.join(dict.fromkeys(v.detail for v in result.validation.violations))
    facts = result.facts
    context = facts.get('context', {})
    jobs, tractors = context.get('jobs', {}), context.get('tractors', {})
    job_name = lambda jid: jobs.get(jid, jid)
    tractor_name = lambda tid: tractors.get(tid, f"Tractor {tid.removeprefix('T')}" if tid else 'tractor')
    event = facts.get('event', {})
    kind, tid = event.get('type'), event.get('tractor')
    opening = {
        'run': 'The farm plan is ready.',
        'tractor_added': f'{tractor_name(tid)} joined the fleet.',
        'tractor_removed': f'{tractor_name(tid)} was removed from the fleet.',
        'tractor_repaired': f'{tractor_name(tid)} returned to service.',
        'breakdown': f'{tractor_name(tid)} broke down.',
        'block_route': 'A farm road was blocked.',
        'unblock_route': 'A farm road reopened.',
        'job_patch': 'The job change was accepted.',
        'priority_change': 'Job priorities or deadlines changed.',
        'jobs_submitted': 'New jobs were submitted.',
        'tractor_idle': 'A tractor became available.',
    }.get(kind, 'The farm plan was updated.')
    parts = [opening]
    moved = facts.get('moved', [])
    added = facts.get('newly_assigned', [])
    for m in moved[:2]:
        progress = m.get('progress_kept', 0)
        saved = f" {progress:.0%} is already completed and will not be repeated." if progress > 0 else ''
        parts.append(f"{job_name(m['job'])} moves from {tractor_name(m['from'])} to {tractor_name(m['to'])}.{saved}")
    if len(moved) > 2:
        parts.append(f'{len(moved)-2} other jobs change tractors.')
    if added:
        if len(added) == 1:
            a=added[0]
            parts.append(f"{job_name(a['job'])} is assigned to {tractor_name(a['to'])}.")
        else:
            parts.append(f'{len(added)} jobs received assignments.')
    retimed = facts.get('retimed', [])
    if len(retimed) == 1:
        r=retimed[0]
        parts.append(f"{job_name(r['job'])} now starts at {farm_clock(r['new_start_t'])}, previously {farm_clock(r['old_start_t'])}.")
    elif retimed:
        later = sum(r['new_start_t'] > r['old_start_t'] for r in retimed)
        parts.append(f'Start times changed for {len(retimed)} jobs: {later} later and {len(retimed)-later} earlier.')
    if kind == 'tractor_repaired' and not any(m['to'] == tid for m in moved) and not any(a['to'] == tid for a in added):
        parts.append('No queued jobs were transferred to the repaired tractor; the current search found no preferred valid reassignment. Ongoing work remains committed.')
    elif kind in {'tractor_added','tractor_removed'} and not moved and not added:
        parts.append('No job assignments changed.')
    for u in result.unassigned[:2]:
        parts.append(f'{job_name(u.job)} remains unassigned: {u.detail}.')
    if len(result.unassigned)>2:
        parts.append(f'{len(result.unassigned)-2} additional jobs remain unassigned; see job details.')
    return ' '.join(parts)

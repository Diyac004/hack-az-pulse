"""Plain-language facts only; no external calls."""
def explain(result):
    if not result.validation.passed:
        return 'No plan applied. ' + '; '.join(v.detail for v in result.validation.violations)
    parts=[]
    for m in result.facts.get('moved',[]):
        parts.append(f"{m['job']} moves from {m['from']} to {m['to']}; {m['progress_kept']:.0%} of work is already completed.")
    for a in result.facts.get('newly_assigned',[]):
        parts.append(f"{a['job']} assigned to {a['to']}.")
    for r in result.facts.get('retimed', []):
        parts.append(f"{r['job']} now starts at farm minute {r['new_start_t']:.2f}, previously {r['old_start_t']:.2f}.")
    for u in result.unassigned:
        parts.append(f'{u.job} remains pending: {u.detail}.')
    return ' '.join(parts) or 'Validated plan preserves ongoing work.'

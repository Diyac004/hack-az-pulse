// AI Supervisor actions (DOM-free, shared by ai-supervisor/server.mjs and the in-browser rules reviewer).
//
// A reviewer (LLM or rules) only PROPOSES a closed-enum action with ids. This module validates the ids/values
// against the current Snapshot and turns the action into a concrete contract request. The backend's planner and
// Safety Agent still decide: every applied action goes through the normal REST mutation (202 Operation) and is
// validated there. Nothing here mutates state.
//
// action = { kind, job, tractor, block, priority, value, implements }   (unused keys null)
//   kind: patch_priority | pin_job | ban_type | off_duty | set_implements | disable_block | none

export const ACTION_KINDS = ['patch_priority', 'pin_job', 'ban_type', 'off_duty', 'set_implements', 'disable_block', 'none'];
export const IMPLEMENTS = ['sprayer', 'mower', 'hedger', 'bin_trailer'];
export const JOB_TYPES = ['spray', 'mow', 'hedge', 'haul_bins'];
const IMPL_NAME = { sprayer: 'sprayer', mower: 'mower', hedger: 'hedger', bin_trailer: 'bin trailer' };
const TYPE_NAME = { spray: 'spraying', mow: 'mowing', hedge: 'hedging', haul_bins: 'bin hauling' };
const OFF_DUTY_TIMES = [300, 360, 420, 480, 540, 600, 660];

/** Which capability each kind needs on the connected backend. */
export const KIND_NEEDS = {
  patch_priority: 'patch_job', pin_job: 'patch_job', ban_type: 'controls', off_duty: 'controls',
  set_implements: 'controls', disable_block: 'block_disabled', none: null,
};

const clockText = (t) => {
  if (t == null || !isFinite(t)) return '—';
  const m = Math.round(t) + 360, h = Math.floor(m / 60) % 24, mm = m % 60;
  return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const unfinished = (j) => j && j.status !== 'done' && j.status !== 'dropped';

/** Normalise a raw model action: unknown kind -> none, missing keys -> null. */
export function normAction(a) {
  const x = a && typeof a === 'object' ? a : {};
  const kind = ACTION_KINDS.includes(x.kind) ? x.kind : 'none';
  return {
    kind, job: x.job ?? null, tractor: x.tractor ?? null, block: x.block ?? null,
    priority: x.priority ?? null, value: x.value ?? null,
    implements: Array.isArray(x.implements) ? x.implements.filter((i) => IMPLEMENTS.includes(i)) : null,
  };
}

/**
 * Validate an action against a Snapshot. Returns {ok:true, request, label, replans, preview} or {ok:false, reason}.
 *  request: {method, path, body}   (path is relative to the backend's /api)
 *  preview: null, or {tractor, body} for POST /api/tractors/{id}/preview (same planner as apply)
 */
export function resolveAction(action, state) {
  const a = normAction(action);
  const s = state || {};
  const jobs = s.jobs || [], fleet = s.fleet || [], blocks = (s.scenario && s.scenario.blocks) || [];
  const job = a.job ? jobs.find((j) => j.id === a.job) : null;
  const tr = a.tractor ? fleet.find((t) => t.id === a.tractor) : null;
  const trName = tr ? tr.name || tr.id : a.tractor;
  const no = (reason) => ({ ok: false, reason });
  switch (a.kind) {
    case 'none': return no('No action proposed (advisory).');
    case 'patch_priority': {
      if (!job) return no(`Job ${a.job} does not exist.`);
      if (!unfinished(job)) return no(`${job.label || job.id} is already ${job.status}.`);
      const p = Number(a.priority);
      if (!Number.isInteger(p) || p < 1 || p > 3) return no('Priority must be 1, 2 or 3.');
      if (p === job.priority) return no(`${job.label || job.id} is already priority ${p}.`);
      return { ok: true, replans: true, request: { method: 'PATCH', path: `/jobs/${encodeURIComponent(job.id)}`, body: { priority: p } }, preview: null,
        label: `Set ${job.label || job.id} to ${p === 3 ? 'high' : p === 2 ? 'medium' : 'low'} priority` };
    }
    case 'pin_job': {
      if (!job) return no(`Job ${a.job} does not exist.`);
      if (!unfinished(job)) return no(`${job.label || job.id} is already ${job.status}.`);
      if (!tr) return no(`Tractor ${a.tractor} is not in the fleet.`);
      if (!(tr.implements || []).includes(job.implement)) return no(`${trName} has no ${IMPL_NAME[job.implement] || job.implement}.`);
      if (job.pinned_to === tr.id) return no(`${job.label || job.id} is already pinned to ${trName}.`);
      return { ok: true, replans: true, request: { method: 'PATCH', path: `/jobs/${encodeURIComponent(job.id)}`, body: { pinned_to: tr.id } },
        preview: { tractor: tr.id, body: { control: 'pin_job', value: job.id } }, label: `Pin ${job.label || job.id} to ${trName}` };
    }
    case 'ban_type': {
      if (!tr) return no(`Tractor ${a.tractor} is not in the fleet.`);
      const v = a.value == null ? 'none' : String(a.value);
      if (v !== 'none' && !JOB_TYPES.includes(v)) return no(`Unknown job type "${v}".`);
      const body = { control: 'ban_type', value: v };
      return { ok: true, replans: true, request: { method: 'POST', path: `/tractors/${encodeURIComponent(tr.id)}/control`, body }, preview: { tractor: tr.id, body },
        label: v === 'none' ? `Let ${trName} take any job type` : `Never assign ${TYPE_NAME[v]} to ${trName}` };
    }
    case 'off_duty': {
      if (!tr) return no(`Tractor ${a.tractor} is not in the fleet.`);
      const t = a.value == null ? null : Number(a.value);
      if (t != null && !OFF_DUTY_TIMES.includes(t)) return no(`Off-duty time must be one of ${OFF_DUTY_TIMES.map(clockText).join(', ')}.`);
      const now = s.clock ? s.clock.t : 0;
      if (t != null && t <= now) return no(`${clockText(t)} has already passed.`);
      const body = { control: 'off_duty_t', value: t };
      return { ok: true, replans: true, request: { method: 'POST', path: `/tractors/${encodeURIComponent(tr.id)}/control`, body }, preview: { tractor: tr.id, body },
        label: t == null ? `Keep ${trName} available all day` : `Send ${trName} off duty at ${clockText(t)}` };
    }
    case 'set_implements': {
      if (!tr) return no(`Tractor ${a.tractor} is not in the fleet.`);
      const want = a.implements || [];
      if (!want.length) return no('Name at least one implement.');
      const cur = (tr.implements || []).slice().sort().join(','), nxt = want.slice().sort().join(',');
      if (cur === nxt) return no(`${trName} already carries ${want.map((i) => IMPL_NAME[i]).join(' + ')}.`);
      const body = { control: 'implements', value: want };
      return { ok: true, replans: true, request: { method: 'POST', path: `/tractors/${encodeURIComponent(tr.id)}/control`, body }, preview: { tractor: tr.id, body },
        label: `Switch ${trName} to ${want.map((i) => IMPL_NAME[i]).join(' + ')}` };
    }
    case 'disable_block': {
      const b = blocks.find((x) => x.id === a.block);
      if (!b) return no(`Block ${a.block} does not exist.`);
      const off = ((s.scenario && s.scenario.disabled_blocks) || []).some((d) => d.block === b.id);
      if (off) return no(`Block ${b.id} is already excluded from planning.`);
      const reason = String(a.value || 'Not an orchard on the satellite image.').slice(0, 160);
      return { ok: true, replans: true, request: { method: 'POST', path: '/events', body: { type: 'block_disabled', block: b.id, reason, proposed_by: 'ai_supervisor' } }, preview: null,
        label: `Exclude Block ${b.id} from planning` };
    }
    default: return no('Unknown action.');
  }
}

/** Stable identity of a proposal, so the same advice is not re-raised after it was approved or dismissed. */
export function findingKey(reviewer, action, fallbackTitle = '') {
  const a = normAction(action);
  if (a.kind === 'none') return `${reviewer}:none:${String(fallbackTitle).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`;
  return [reviewer, a.kind, a.job, a.tractor, a.block, a.priority, a.value, a.implements && a.implements.slice().sort().join('+')].map((v) => (v == null ? '' : v)).join(':');
}

/** Compact preview summary for the UI (from a contract Preview body). */
export function summarizePreview(p, state) {
  if (!p) return null;
  const jobs = (state && state.jobs) || [];
  const label = (id) => { const j = jobs.find((x) => x.id === id); return j ? j.label || j.id : id; };
  const diff = (p.plan && p.plan.diff) || {};
  const md = p.metrics_delta || {};
  return {
    allowed: !!p.allowed, refused_reason: p.refused_reason ?? null,
    moved: (diff.moved || []).map((m) => ({ job: m.job, label: label(m.job), from: m.from, to: m.to })),
    retimed: (diff.retimed || []).map((r) => ({ job: r.job, label: label(r.job), old_start_t: r.old_start_t, new_start_t: r.new_start_t })),
    deadlines_missed: ((p.explanation && p.explanation.facts && p.explanation.facts.deadlines_missed) || []).map((id) => ({ job: id, label: label(id) })),
    travel_delta_min: md.travel_min ?? null, idle_delta_min: md.idle_min ?? null, late_jobs_delta: md.late_jobs ?? null,
    text: (p.explanation && p.explanation.text) || null,
    plan_version: (p.plan && p.plan.version) ?? null,
  };
}

export const AI_ATTRIBUTION = 'AI Supervisor proposed, operator approved, Safety check passed';

/** AI action capabilities from data/capabilities.js (detectCapabilities / ALL_ON). */
export function aiCapsFrom(c) {
  if (!c) return { patch_job: true, controls: true, preview: true, events: true, block_disabled: true, metrics_measured: true, weather_enforced: true, source: 'assumed' };
  return { patch_job: !!c.patchJob, controls: !!c.controls, preview: !!c.controls, events: true, block_disabled: !!(c.events && c.events.block_disabled),
    metrics_measured: c.metricsMeasured !== false, weather_enforced: c.weatherEnforced !== false, source: c.backend || 'unknown' };
}
export { clockText as aiClock };

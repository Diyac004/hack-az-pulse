// Rule-based AI Supervisor reviewer ("rules", no model). DOM-free. Used by the dashboard when no ?ai= service is
// connected, and by ai-supervisor/server.mjs with AI_PROVIDER=rules. Same raw finding shape as the LLM reviewers:
//   { reviewer: 'plan'|'implements'|'plots', severity, title, why, action }
// It cannot look at imagery, so it never produces plot findings (the panel says a vision model is needed).
import { aiClock as clock } from './aiActions.js';

const IMPL_NAME = { sprayer: 'sprayer', mower: 'mower', hedger: 'hedger', bin_trailer: 'bin trailer' };
const DOWN = new Set(['broken', 'awaiting_mechanic', 'repair_scheduled', 'repairing', 'offline', 'removing', 'starting']);
const open = (j) => j.status !== 'done' && j.status !== 'dropped';
const usable = (t) => !DOWN.has(t.status) && !t.manual;
const mins = (n) => `${Math.round(n)} min`;

function workLeft(state, trId) {
  const now = state.clock ? state.clock.t : 0;
  let work = 0, end = now;
  for (const e of (state.plan && state.plan.entries) || []) {
    if (e.tractor !== trId || e.end_t <= now) continue;
    if (e.kind === 'work') work += e.end_t - Math.max(e.start_t, now);
    end = Math.max(end, e.end_t);
  }
  return { work, end };
}

export function rulesReview(state) {
  const s = state || {};
  const jobs = (s.jobs || []).filter(open), fleet = s.fleet || [];
  const dayEnd = (s.clock && s.clock.day_minutes) || 720;
  const plan = [], impl = [];
  // late jobs that are not yet high priority -> raise
  const late = jobs.filter((j) => j.tractor && j.end_t != null && j.end_t > j.deadline_t + 0.5 && j.priority < 3)
    .sort((a, b) => (b.end_t - b.deadline_t) - (a.end_t - a.deadline_t)).slice(0, 2);
  for (const j of late) {
    const by = j.end_t - j.deadline_t;
    plan.push({ reviewer: 'plan', severity: by > 30 ? 'high' : 'medium', title: `${j.label} finishes ${mins(by)} late`,
      why: `${j.label} is planned to finish at ${clock(j.end_t)}, after its ${clock(j.deadline_t)} deadline. Raising it to high priority lets the optimizer move it ahead of lower-priority work.`,
      action: { kind: 'patch_priority', job: j.id, priority: 3 } });
  }
  // overtime past sunset
  for (const t of fleet.filter(usable)) {
    const { end } = workLeft(s, t.id);
    if (end > dayEnd + 5) plan.push({ reviewer: 'plan', severity: 'medium', title: `${t.name || t.id} works ${mins(end - dayEnd)} past sunset`,
      why: `${t.name || t.id}'s planned work ends at ${clock(end)}, ${mins(end - dayEnd)} after the ${clock(dayEnd)} end of day. Consider moving work or adding a tractor.`, action: { kind: 'none' } });
  }
  // idle tractors while work waits
  const waiting = jobs.filter((j) => !j.tractor && !/excluded from planning/.test(j.unassigned_reason || '')); // excluded blocks wait on purpose
  for (const t of fleet.filter((x) => usable(x) && !x.current_job && !(x.queue || []).length)) {
    if (!waiting.length) break;
    plan.push({ reviewer: 'plan', severity: 'low', title: `${t.name || t.id} is idle while ${waiting.length} job${waiting.length === 1 ? '' : 's'} wait`,
      why: `${t.name || t.id} has no work, and ${waiting.map((j) => j.label).slice(0, 3).join(', ')} ${waiting.length === 1 ? 'is' : 'are'} unassigned (${waiting[0].unassigned_reason || 'no compatible tractor'}).`, action: { kind: 'none' } });
  }
  // implements: unassigned because no operational tractor carries the implement -> lightest-loaded tractor adds it
  const need = new Map();
  for (const j of waiting) if (/has a /.test(j.unassigned_reason || '') && !/excluded/.test(j.unassigned_reason || '')) need.set(j.implement, [...(need.get(j.implement) || []), j]);
  for (const [im, js] of need) {
    const cand = fleet.filter((t) => usable(t) && !(t.implements || []).includes(im)).map((t) => ({ t, left: workLeft(s, t.id).work })).sort((a, b) => a.left - b.left)[0];
    if (!cand) continue;
    const cur = cand.t.implements || [];
    const next = cur.length >= 2 ? [cur[0], im] : [...cur, im];
    const total = js.reduce((a, j) => a + (j.remaining_min ?? j.duration_min), 0);
    impl.push({ reviewer: 'implements', severity: 'high', title: `No working tractor carries a ${IMPL_NAME[im]}`,
      why: `${js.map((j) => j.label).join(', ')} (${mins(total)} of work) ${js.length === 1 ? 'is' : 'are'} unassigned because no operational tractor has a ${IMPL_NAME[im]}. ${cand.t.name || cand.t.id} has the least remaining work (${mins(cand.left)}); fitting it costs a depot visit.`,
      action: { kind: 'set_implements', tractor: cand.t.id, implements: next } });
  }
  return { plan, implements: impl, plots: [] };
}

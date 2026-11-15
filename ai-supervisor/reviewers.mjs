// The three AI Supervisor reviewers: compact facts in, strict-JSON proposals out.
// Each reviewer is ONE LLM call. The model never sees raw dumps, only the numbers below, and it can only
// propose closed-enum actions (dashboard/src/data/aiActions.js); the server validates and builds the requests.
import { ACTION_KINDS, IMPLEMENTS, JOB_TYPES, aiClock as clock } from '../dashboard/src/data/aiActions.js';

const r0 = (v) => (v == null || !isFinite(v) ? null : Math.round(v));
const unfinished = (j) => j.status !== 'done' && j.status !== 'dropped';
const DOWN = new Set(['broken', 'awaiting_mechanic', 'repair_scheduled', 'repairing', 'offline', 'removing', 'starting']);

/** Compact, numbers-first view of a Snapshot for the plan / implements reviewers. */
export function compactFacts(s, caps = {}) {
  const now = s.clock ? s.clock.t : 0;
  const dayEnd = (s.clock && s.clock.day_minutes) || 720;
  const entries = (s.plan && s.plan.entries) || [];
  const perTr = new Map();
  for (const e of entries) {
    if (e.end_t <= now) continue;
    const p = perTr.get(e.tractor) || { work_min: 0, travel_min: 0, wait_min: 0, other_min: 0, end_t: now };
    const d = e.end_t - Math.max(e.start_t, now);
    if (e.kind === 'work') p.work_min += d; else if (e.kind === 'travel') p.travel_min += d; else if (e.kind === 'wait') p.wait_min += d; else p.other_min += d;
    p.end_t = Math.max(p.end_t, e.end_t);
    perTr.set(e.tractor, p);
  }
  const open = (s.jobs || []).filter(unfinished);
  const disabled = ((s.scenario && s.scenario.disabled_blocks) || []).map((d) => d.block);
  const tractors = (s.fleet || []).map((t) => {
    const p = perTr.get(t.id);
    return {
      id: t.id, name: t.name, status: t.status, manual: !!t.manual, implements: t.implements, fuel_pct: r0(t.fuel_pct),
      current_job: t.current_job, queue: t.queue,
      remaining_work_min: p ? r0(p.work_min) : 0, remaining_travel_min: p ? r0(p.travel_min) : 0, weather_wait_min: p ? r0(p.wait_min) : 0,
      planned_finish: p ? clock(p.end_t) : null, overtime_min: p && p.end_t > dayEnd ? r0(p.end_t - dayEnd) : 0,
      idle_now: !DOWN.has(t.status) && !t.manual && !t.current_job && !(t.queue || []).length,
    };
  });
  const jobs = open.map((j) => ({
    id: j.id, label: j.label, type: j.type, implement: j.implement, block: j.block, status: j.status, tractor: j.tractor,
    priority: j.priority, deadline: clock(j.deadline_t), planned_finish: j.end_t != null ? clock(j.end_t) : null,
    late_by_min: j.end_t != null && j.end_t > j.deadline_t ? r0(j.end_t - j.deadline_t) : 0,
    remaining_min: r0(j.remaining_min ?? j.duration_min * (1 - (j.progress || 0))), progress_pct: r0((j.progress || 0) * 100),
    pinned_to: j.pinned_to ?? null, weather_blocked: !!j.weather_blocked, unassigned_reason: j.unassigned_reason ?? null,
  }));
  const w = s.weather || {};
  const blockedNow = Object.entries(w.spray_blocked_reason || {}).filter(([, v]) => v).map(([b, why]) => ({ block: b, why }));
  const windows = Object.fromEntries(Object.entries(w.spray_windows || {}).map(([b, ws]) => [b, (ws || []).map(([a, c]) => `${clock(a)}-${clock(c)}`)]));
  const m = (s.metrics && s.metrics.ours) || {};
  return {
    now: clock(now), now_t: r0(now), day_ends: clock(dayEnd),
    plan: s.plan ? { version: s.plan.version, solver_status: s.plan.solver_status } : null,
    tractors, open_jobs: jobs, done_jobs: (s.jobs || []).filter((j) => j.status === 'done').length,
    excluded_blocks: disabled,
    // never hand the model placeholders: weather only where the backend enforces it, metrics only where measured
    weather: caps.weather_enforced !== false && w.current ? { now: w.current, spraying_blocked_now: blockedNow, spray_windows: windows } : null,
    metrics: caps.metrics_measured !== false ? { completed: m.completed ?? null, on_time: m.on_time ?? null, travel_min: m.travel_min ?? null, idle_min: m.idle_min ?? null } : null,
  };
}

// ---------------------------------------------------------------- shared schema pieces
const nstr = { type: ['string', 'null'] };
const actionSchema = (kinds) => ({
  type: 'object', additionalProperties: false,
  required: ['kind', 'job', 'tractor', 'block', 'priority', 'value', 'implements'],
  properties: {
    kind: { type: 'string', enum: kinds },
    job: nstr, tractor: nstr, block: nstr,
    priority: { type: ['integer', 'null'] },
    value: { type: ['string', 'integer', 'null'] },
    implements: { type: ['array', 'null'], items: { type: 'string', enum: IMPLEMENTS } },
  },
});
const findingsSchema = (kinds) => ({
  type: 'object', additionalProperties: false, required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['severity', 'title', 'why', 'action'],
        properties: { severity: { type: 'string', enum: ['high', 'medium', 'low'] }, title: { type: 'string' }, why: { type: 'string' }, action: actionSchema(kinds) },
      },
    },
  },
});

const GROUND_RULES = `You are the AI Supervisor for Harvest Fleet AI, an autonomous citrus-farm tractor fleet in Mesa, Arizona.
An optimizer plans the work and a Safety Agent validates every plan. You do NOT control tractors. You review and PROPOSE
changes that a human operator approves; the optimizer then re-plans and the Safety Agent checks the result.
Rules:
- Use only the facts given. Every number you mention must come from the facts. Cite the numbers (times, minutes, %).
- "why" is plain English for a farm manager, 1-3 short sentences. "title" is under 70 characters.
- Propose at most one action per finding, using ids from the facts. If no listed action fits, use kind "none" (advisory).
- Jobs on excluded_blocks are intentionally unassigned (the operator excluded those blocks); never flag them.
- Prefer few, high-value findings (0-4). If the plan looks fine, return an empty findings list and say so in summary.
- Farm times are clock times (6:00 AM start). Priority: 3 = high, 2 = medium, 1 = low.`;

// ---------------------------------------------------------------- 1. plan reviewer
export const PLAN_KINDS = ['patch_priority', 'pin_job', 'ban_type', 'off_duty', 'none'];
export function planPrompt(facts, caps) {
  const allowed = PLAN_KINDS.filter((k) => k === 'none' || caps[k]);
  return {
    name: 'plan_review',
    system: GROUND_RULES,
    user: `Review the current fleet plan: assignments, travel vs work, idle tractors, late jobs (late_by_min > 0),
overtime after ${facts.day_ends}, weather spray windows, fairness between tractors, odd detours, unassigned jobs.
Action kinds you may propose on this backend: ${allowed.join(', ')}.
- patch_priority: {job, priority} raise/lower a job's priority so the optimizer orders it differently.
- pin_job: {job, tractor} require that tractor to do the job (it must carry the job's implement).
- ban_type: {tractor, value: one of ${JOB_TYPES.join('|')}|none} never give that job type to the tractor.
- off_duty: {tractor, value: minutes since 6:00 AM, one of 300,360,420,480,540,600,660 or null} tractor stops taking work after that time.
- none: advisory only (explain what the operator should consider).
Unused action keys must be null.

FACTS (JSON):
${JSON.stringify(facts)}`,
    schema: findingsSchema(allowed),
  };
}

// ---------------------------------------------------------------- 2. implements reviewer
export const IMPL_KINDS = ['set_implements', 'none'];
export function implementsPrompt(facts, caps) {
  const allowed = IMPL_KINDS.filter((k) => k === 'none' || caps[k]);
  const need = {};
  for (const j of facts.open_jobs) { const n = need[j.implement] || (need[j.implement] = { jobs: 0, remaining_min: 0, unassigned: 0 }); n.jobs++; n.remaining_min += j.remaining_min || 0; if (!j.tractor) n.unassigned++; }
  return {
    name: 'implements_review',
    system: GROUND_RULES,
    user: `Review which implements each tractor carries for the REMAINING work. Implements: ${IMPLEMENTS.join(', ')}
(sprayer -> spray jobs, mower -> mow, hedger -> hedge, bin_trailer -> haul_bins). A tractor may carry one or two.
Changing implements costs a depot visit (a swap stop plus the drive there and back), so only propose a change when remaining work
clearly needs it: e.g. jobs unassigned because no operational tractor has the implement, or one implement's workload
is far larger than the tractors carrying it can finish by ${facts.day_ends}.
Action kinds you may propose on this backend: ${allowed.join(', ')}.
- set_implements: {tractor, implements: [...]} the full new implement list for that tractor.
- none: advisory only.
Unused action keys must be null.

REMAINING WORK BY IMPLEMENT: ${JSON.stringify(need)}
FACTS (JSON):
${JSON.stringify(facts)}`,
    schema: findingsSchema(allowed),
  };
}

// ---------------------------------------------------------------- 3. plot reviewer (vision)
export const LAND_USE = ['orchard', 'other_crop', 'houses', 'roads_or_paved', 'bare_ground', 'water', 'mixed'];
export const plotSchema = {
  type: 'object', additionalProperties: false, required: ['plots'],
  properties: {
    plots: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'land_use', 'orchard_pct', 'confidence', 'evidence'],
        properties: {
          id: { type: 'string' },
          land_use: { type: 'string', enum: LAND_USE },
          orchard_pct: { type: 'integer' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          evidence: { type: 'string' },
        },
      },
    },
  },
};
export function plotPrompt(targets) {
  return {
    name: 'plot_review',
    system: 'You are the AI Supervisor for Harvest Fleet AI. You check whether the farm map matches the ground, using 0.5 m/pixel USGS NAIP aerial images (north up).',
    user: `Each image is one planned work area on a citrus farm in Mesa, Arizona, cropped from the aerial photo with one extra cell
(40 m) of context. The AMBER rectangle in each image is the area itself; judge only what is inside the amber rectangle.
For every image answer:
- land_use: what mostly covers the area inside the rectangle (${LAND_USE.join(', ')}). Citrus orchards look like regular
  rows of round dark-green tree crowns. Houses look like roofs, driveways, pools, lawns, cul-de-sacs.
- orchard_pct: your estimate (0-100) of the rectangle covered by orchard trees.
- confidence and a short evidence sentence naming what you see (e.g. "four roofs, two pools and a cul-de-sac").
Areas: ${targets.map((t) => `${t.id} (${t.kind === 'depot' ? 'equipment depot / fleet hub, 40 x 40 m' : 'orchard block'})`).join(', ')}.
Return one entry per area id, in the same order.`,
    schema: plotSchema,
  };
}

const lc = (s) => { const t = String(s || 'no orchard rows').trim().replace(/\.$/, ''); return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t; };

/** Plot answers -> raw findings (server side, deterministic): non-orchard blocks -> disable_block; depot -> advisory. */
export function plotFindings(plots, scenario) {
  const out = [];
  const blocks = new Set(((scenario && scenario.blocks) || []).map((b) => b.id));
  for (const p of plots || []) {
    const pct = Math.max(0, Math.min(100, Number(p.orchard_pct) || 0));
    const notOrchard = p.land_use !== 'orchard' && p.land_use !== 'other_crop' && pct < 50;
    if (!notOrchard) continue;
    const what = { houses: 'houses', roads_or_paved: 'roads / paving', bare_ground: 'bare ground', water: 'water', mixed: 'mixed land' }[p.land_use] || p.land_use;
    if (p.id === 'depot') {
      out.push({ reviewer: 'plots', severity: 'medium', title: `Depot sits on ${what}, not a yard`,
        why: `The aerial photo at the depot cell shows ${lc(p.evidence)} (about ${pct}% orchard). Tractors drive in and out of here all day; check the depot location.`,
        action: { kind: 'none' }, plot: { id: 'depot', land_use: p.land_use, orchard_pct: pct, confidence: p.confidence, evidence: p.evidence } });
    } else if (blocks.has(p.id)) {
      out.push({ reviewer: 'plots', severity: p.confidence === 'low' ? 'medium' : 'high', title: `Block ${p.id} is ${what}, not orchard`,
        why: `The aerial photo of Block ${p.id} shows ${lc(p.evidence)} (about ${pct}% orchard). Sending tractors to spray or mow here would drive through ${what === 'houses' ? 'backyards' : what}.`,
        action: { kind: 'disable_block', block: p.id, value: `Aerial photo shows ${what}, not orchard (${pct}% trees).` },
        plot: { id: p.id, land_use: p.land_use, orchard_pct: pct, confidence: p.confidence, evidence: p.evidence } });
    }
  }
  return out;
}

export { ACTION_KINDS };

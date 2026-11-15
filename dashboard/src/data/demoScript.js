// "Play AI demo": a scripted walk through everything the planner, the agents and the AI Supervisor handle, with
// captions a presenter can narrate. DOM-free (Node-testable): the UI (ui/aiDemo.js) injects everything that touches
// the page as `ctx`, and the runner below owns order, pause/stop and capability skips.
//
// Every step uses the real data-layer api on the connected source and waits for its Operation (or the state it
// produces) before the next one. Captions are filled from state (counts, re-plan time, raised blocks, the
// reviewer), never hard-coded numbers, and only say "Safety check passed" after the Operation succeeded.
//
//   const r = createDemoRunner({ steps: DEMO_STEPS, ctx, onUpdate })
//   r.play()  r.pause()  r.stop()      r.view -> { status, index, steps: [{id,title,state}], caption }
//
// ctx (from the UI): state(), caps(), api, track(promise) -> terminal Operation | body | null, setSpeed(n),
//   view(), setView('sim'|'live'), mech: {isOpen(), open(trId), options(), select(i), book()},
//   ai: {openSheet(), closeSheet(), highlight(id|null), approve(id) -> bool, flashPlots(on)},
//   onPause(), onResume(), onStop(), onFinish()   (all optional except what a step uses)
import { clockText, plural, listText } from './text.js';

export const SKIP_UNSUPPORTED = 'skipped: not supported by this backend';
export const SKIP_DAY_OVER = 'skipped: the workday is over';

/** Thrown by a step to skip itself with a caption. */
export class DemoSkip extends Error { constructor(reason) { super(reason); this.reason = reason; } }
class DemoAbort extends Error { constructor() { super('demo stopped'); } }

// ---------------------------------------------------------------- helpers (pure)
const DOWN = new Set(['broken', 'awaiting_mechanic', 'repair_scheduled', 'repairing']);
const OUT = new Set(['broken', 'awaiting_mechanic', 'repair_scheduled', 'repairing', 'offline', 'removing', 'starting']);
const unfinished = (j) => j && j.status !== 'done' && j.status !== 'dropped';
const pct = (p) => Math.round((+p || 0) * 100) + '%';
export const msText = (ms) => (ms == null || !isFinite(ms) ? null : ms < 1 ? 'under 1 ms' : Math.round(ms) + ' ms');
export const dayOver = (s) => { const c = s && s.clock; return !!(c && (c.ended || (c.day_minutes && c.t >= c.day_minutes - 5))); };
/** Reason a step that posts `type` can't run here, or null. */
export const eventGate = (type) => (caps, state) => {
  if (((caps && caps.events) || {})[type] === false) return SKIP_UNSUPPORTED;
  if (dayOver(state)) return SKIP_DAY_OVER;
  return null;
};
const okOp = (op) => !!op && (op.status === undefined || op.status === 'succeeded');
const opFail = (op, what) => new Error((op && op.error && op.error.message) || (op && op.message) || `${what} did not apply`);
const firstSentence = (t) => { const s = String(t || '').trim(); const m = /^(.+?[.!?])(\s|$)/.exec(s); return m ? m[1] : s; };
const nameOf = (s, id) => { const t = ((s && s.fleet) || []).find((x) => x.id === id); return t ? t.name || t.id : id; };
const jobOf = (s, id) => ((s && s.jobs) || []).find((j) => j.id === id) || null;

/** Wind gust toward the sensitive area of a block being sprayed now (same rule as the Wind chip). */
export function gustBody(s) {
  const areas = (s.scenario && s.scenario.sensitive) || [];
  const jobs = s.jobs || [];
  const spraying = new Set((s.fleet || []).map((t) => t.current_job && jobs.find((j) => j.id === t.current_job)).filter((j) => j && j.implement === 'sprayer' && j.status === 'working').map((j) => j.block));
  const area = areas.find((a) => spraying.has(a.block)) || areas[0];
  return { type: 'weather_change', wind_mph: 14, wind_from_deg: area ? (area.dir_deg + 180) % 360 : 270 };
}
/** Calm: 6 mph from the direction that blows furthest from every sensitive area (same rule as the chip). */
export function calmBody(s) {
  const areas = (s.scenario && s.scenario.sensitive) || [];
  let best = 0, bestGap = -1;
  for (let from = 0; from < 360; from += 15) {
    const toward = (from + 180) % 360;
    const gap = Math.min(180, ...areas.map((a) => { const d = Math.abs(((toward - a.dir_deg) % 360 + 360) % 360); return d > 180 ? 360 - d : d; }));
    if (gap > bestGap) { bestGap = gap; best = from; }
  }
  return { type: 'weather_change', wind_mph: 6, wind_from_deg: best };
}
const sprayerWorking = (s) => (s.fleet || []).some((t) => { const j = t.current_job && jobOf(s, t.current_job); return j && j.implement === 'sprayer' && j.status === 'working'; });

// ---------------------------------------------------------------- the script
export const DEMO_STEPS = [
  {
    id: 'plan', title: 'Morning plan',
    async run(d) {
      d.caption('Planning the morning…', 'POST /api/run: the Fleet planner assigns every job');
      const op = await d.track(d.api.run('ours'));
      if (!okOp(op)) throw opFail(op, 'The run');
      const v0 = op.plan_version ?? 1;
      await d.waitFor(() => { const s = d.state(); return s.plan && s.plan.version >= v0 && s.clock && !dayOver(s); }, 6000);
      const s = d.state();
      const jobs = (s.jobs || []).filter((j) => j.tractor && unfinished(j));
      const trs = new Set(jobs.map((j) => j.tractor));
      const ms = msText(s.plan && s.plan.solve_ms);
      d.caption(`Morning plan: the Fleet planner assigned ${plural(jobs.length, 'job')} to ${plural(trs.size, 'tractor')}`,
        `Plan v${(s.plan && s.plan.version) ?? v0}${ms ? ' · solved in ' + ms : ''} · deadlines, implements and fuel checked by the Safety Agent`);
      await d.wait(3500);
      d.setSpeed(6);
      d.caption(null, 'Clock at 6× so the day moves');
      await d.wait(1500);
    },
  },
  {
    id: 'breakdown', title: 'Breakdown', needs: eventGate('breakdown'),
    async run(d) {
      const pickTr = () => { const f = d.state().fleet || []; return f.find((t) => t.id === 'T1' && !OUT.has(t.status)) || f.find((t) => t.status === 'working') || f.find((t) => !OUT.has(t.status)); };
      const tr0 = pickTr();
      if (!tr0) throw new DemoSkip('skipped: no running tractor to break');
      d.caption(`Waiting for ${tr0.name || tr0.id} to get into a job…`, null);
      await d.waitFor(() => { const s = d.state(), t = (s.fleet || []).find((x) => x.id === tr0.id), j = t && jobOf(s, t.current_job); return t && t.status === 'working' && j && j.progress >= 0.12; }, 20000);
      const s0 = d.state(), t0 = (s0.fleet || []).find((x) => x.id === tr0.id);
      if (!t0 || OUT.has(t0.status)) throw new DemoSkip(`skipped: ${tr0.name || tr0.id} is not running`);
      const job = jobOf(s0, t0.current_job);
      d.caption(`Breakdown: ${t0.name || t0.id} stops${job ? ' mid-job' : ''}`, job ? `${job.label || job.id} is ${pct(job.progress)} done` : null);
      const op = await d.track(d.api.postEvent({ type: 'breakdown', tractor: t0.id }));
      if (!okOp(op)) throw opFail(op, 'The breakdown');
      d.memo.broken = t0.id;
      const s = d.state();
      const rp = (s.log || []).filter((e) => e && e.kind === 'replan' && e.trigger === 'breakdown').slice(-1)[0];
      const ms = msText(rp && rp.replan_ms != null ? rp.replan_ms : s.plan && s.plan.solve_ms);
      const ch = rp && job ? (rp.changes || []).find((c) => c.job === job.id) : null;
      const kept = job ? jobOf(s, job.id) : null;
      d.caption(`AI re-planned in ${ms || 'moments'}, progress kept`,
        ch && ch.to ? `${job.label || job.id} keeps ${pct(ch.progress_kept ?? (kept && kept.progress))} done and moves to ${nameOf(s, ch.to)}`
          : kept ? `${kept.label || kept.id} keeps ${pct(kept.progress)} done` : (op && op.message) || null);
      await d.wait(2600); // breakdown slow motion + camera move play first
      d.setView('live');
      d.caption(null, 'Map view: coverage keeps growing where the work moved');
      await d.wait(4000);
      d.setView('sim');
      await d.wait(800);
    },
  },
  {
    id: 'mechanic', title: 'Mechanic', after: ['breakdown'],
    needs: (caps) => (caps && caps.mechanics === false ? SKIP_UNSUPPORTED : null),
    async run(d) {
      const id = d.memo.broken;
      d.caption('Mechanic agent searching nearby repair shops…', null);
      if (!(await d.waitFor(() => d.mech.isOpen(), 5000))) d.mech.open(id);
      const opts = await d.waitFor(() => { const o = d.mech.options(); return o && o.length ? o : null; }, 8000);
      if (!opts) throw new DemoSkip('skipped: no mechanic listings came back');
      let ri = opts.findIndex((o) => o.recommended); if (ri < 0) ri = 0;
      const rec = opts[ri];
      d.caption(`Mechanic agent ranked ${plural(opts.length, 'option')}`, `Recommended: ${rec.name}${rec.reason ? ' · ' + rec.reason : ''} (sample listings)`);
      await d.wait(3200);
      d.mech.select(ri);
      const since = (d.state().log || []).length;
      const pend = () => (d.state().pending || []).some((p) => p && p.kind === 'mechanic' && p.tractor === id);
      const hadPending = pend();
      const booked = () => (d.state().log || []).slice(Math.max(0, since - 1)).some((e) => e && e.kind === 'mechanic_booked' && e.tractor === id) || (hadPending && !pend());
      if (!d.mech.book() || !(await d.waitFor(booked, 8000))) {
        const op = await d.track(d.api.bookMechanic(id, rec.id));
        if (!okOp(op)) throw opFail(op, 'The booking');
      }
      d.caption(`Booked the recommended mechanic for ${nameOf(d.state(), id)} (approved automatically in this demo)`, `${rec.name}${rec.eta_min != null ? ' · arrives in ~' + Math.round(rec.eta_min) + ' min (estimate)' : ''}`);
      await d.wait(2500);
    },
  },
  {
    id: 'wind', title: 'Wind gust', needs: eventGate('weather_change'),
    async run(d) {
      if (!d.state().weather) throw new DemoSkip(SKIP_UNSUPPORTED);
      if (!sprayerWorking(d.state())) {
        d.caption('Waiting for a sprayer in the field…', null);
        await d.waitFor(() => sprayerWorking(d.state()) || dayOver(d.state()), 15000);
      }
      if (dayOver(d.state())) throw new DemoSkip(SKIP_DAY_OVER);
      d.caption('Wind gust: 14 mph', 'weather_change sent to the backend');
      const op = await d.track(d.api.postEvent(gustBody(d.state())));
      if (!okOp(op)) throw opFail(op, 'The wind gust');
      const paused = /paused/i.test((op && op.message) || '');
      const x = (d.state().explanations || [])[0];
      d.caption(paused ? 'Weather agent paused spraying (14 mph > 10 mph limit); sprayer switched to other work' : 'Weather agent: 14 mph > 10 mph spray limit; spray windows re-timed',
        (x && x.trigger === 'weather_change' && firstSentence(x.text)) || (op && op.message) || null);
      await d.wait(4500);
      const op2 = await d.track(d.api.postEvent(calmBody(d.state())));
      if (!okOp(op2)) throw opFail(op2, 'Calm');
      d.caption('Calm: wind back to 6 mph, spraying allowed again', (op2 && op2.message) || null);
      await d.wait(2200);
    },
  },
  {
    id: 'heat', title: 'Heat alert', needs: eventGate('heat_alert'),
    async run(d) {
      const t = (d.state().clock || {}).t || 0;
      const at = Math.max(480, Math.ceil(t / 30) * 30 + 60);
      d.caption('Heat alert: 112°F forecast at ' + clockText(at), null);
      const op = await d.track(d.api.postEvent({ type: 'heat_alert', temp_f: 112, at_t: at }));
      if (!okOp(op)) throw opFail(op, 'The heat alert');
      const s = d.state();
      const ev = (s.log || []).filter((e) => e && e.kind === 'event' && e.type === 'heat_alert').slice(-1)[0];
      const blocks = [...new Set(((ev && ev.jobs) || []).map((id) => (jobOf(s, id) || {}).block).filter(Boolean))].sort();
      d.caption(blocks.length ? `Agronomy agent moved ${listText(blocks)} spraying up` : 'Agronomy agent: no unstarted spraying left to move up',
        (op && op.message) || null);
      await d.wait(4000);
    },
  },
  {
    id: 'supervisor', title: 'AI Supervisor',
    needs: (caps, state) => (state && state.ai ? null : 'skipped: AI Supervisor not connected'),
    async run(d) {
      d.setSpeed(1); // slow down while the proposal is on screen
      const ai = () => d.state().ai || {};
      const who = () => { const a = ai(); return a.label === 'rules' || !a.model ? 'rules' : a.model; };
      const before = ai().last_run_at || null;
      d.caption(`AI Supervisor (${who()}) reviewing the plan…`, 'It only proposes; the operator approves');
      try { await d.api.aiReview(); } catch (e) { throw new Error((e && e.message) || 'review failed'); }
      const done = await d.waitFor(() => { const a = ai(); return a.last_run_at && a.last_run_at !== before && a.status !== 'reviewing' && a.status !== 'previewing' ? a : null; }, 45000);
      if (!done) throw new DemoSkip('skipped: the review did not finish in time');
      d.ai.openSheet();
      const findings = (ai().findings || []).filter((f) => f.status !== 'dismissed');
      const plots = findings.filter((f) => f.reviewer === 'plots' && f.action && f.action.block);
      const f = findings.find((x) => (x.reviewer === 'plan' || x.reviewer === 'implements') && !x.advisory && x.status === 'open' && !(x.preview && x.preview.allowed === false));
      const elsewhere = !!(ai().remote && ai().scope_note);
      if (f) {
        d.ai.highlight(f.id);
        d.caption(`AI Supervisor (${who()}) proposes: ${f.label || f.title}`, f.title);
        await d.waitFor(() => { const g = (ai().findings || []).find((x) => x.id === f.id); return !g || g.preview_status !== 'loading'; }, 10000);
        await d.wait(3500); // preview on screen, nothing applied yet
        if (elsewhere) {
          d.caption(`AI Supervisor (${who()}) proposes: ${f.label || f.title}`, 'Not auto-approved: this AI Supervisor applies to a different backend');
          await d.wait(3000);
        } else {
          d.caption(null, 'Operator approves; the optimizer re-plans and the Safety Agent checks it');
          if (!d.ai.approve(f.id)) await d.track(d.api.aiApprove(f.id));
          const out = await d.waitFor(() => {
            const a = ai(), h = (a.history || []).find((x) => x.id === f.id && (x.status === 'applied' || x.status === 'failed'));
            if (h) return h;
            const g = (a.findings || []).find((x) => x.id === f.id);
            return g && (g.status === 'failed' || g.status === 'rejected' || g.status === 'stale') ? { status: 'failed', outcome: g.error } : null;
          }, 20000);
          if (out && out.status === 'applied') d.caption('Operator approved, Safety check passed', `${f.label || f.title}${out.plan_version != null ? ' · plan v' + out.plan_version : ''}`);
          else d.caption('Operator approved; the Safety check refused it, plan unchanged', (out && out.outcome) || 'No result from the backend yet');
          await d.wait(3500);
        }
      } else {
        const adv = findings.filter((x) => x.reviewer !== 'plots').length;
        d.caption(`AI Supervisor (${who()}): nothing to approve right now`, adv ? `${plural(adv, 'advisory note')} shown in the panel` : 'The plan looks fine');
        await d.wait(3500);
      }
      if (plots.length) {
        const lu = (plots[0].plot && plots[0].plot.land_use ? plots[0].plot.land_use.replace(/_/g, ' ') : 'houses');
        d.ai.highlight(null);
        d.ai.flashPlots(true);
        d.caption(`AI: ${lu}, not orchard`, `Block${plots.length === 1 ? '' : 's'} ${listText([...new Set(plots.map((p) => p.action.block))].sort())} flagged from the satellite image; the operator decides`);
        await d.wait(4500);
        d.ai.flashPlots(false);
      }
      d.ai.highlight(null);
      d.ai.closeSheet();
      d.setSpeed(6);
    },
  },
  {
    id: 'repair', title: 'Repair', after: ['breakdown'], needs: (caps) => (((caps && caps.events) || {}).tractor_repaired === false ? SKIP_UNSUPPORTED : null),
    async run(d) {
      const id = d.memo.broken;
      const t = (d.state().fleet || []).find((x) => x.id === id);
      if (!t || !DOWN.has(t.status)) throw new DemoSkip(`skipped: ${id} is already back`);
      const op = await d.track(d.api.postEvent({ type: 'tractor_repaired', tractor: id }));
      if (!okOp(op)) throw opFail(op, 'The repair');
      d.caption(`${id} back; planner rebalanced`, (op && op.message) || null);
      await d.wait(4000);
    },
  },
  {
    id: 'end', title: 'Wrap-up',
    async run(d) {
      d.setSpeed(1);
      d.caption('All decisions made by the planner and agents; AI Supervisor proposals approved by the operator', null);
    },
  },
];

// ---------------------------------------------------------------- runner
/**
 * @param {{steps: object[], ctx: object, sleep?: (ms:number)=>Promise<void>, tickMs?: number, skipHoldMs?: number,
 *          onUpdate?: (view:object)=>void}} o   sleep is injectable so the Node test runs without real timers.
 */
export function createDemoRunner({ steps, ctx, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tickMs = 150, skipHoldMs = 1800, onUpdate = () => {} }) {
  let status = 'idle'; // idle | playing | paused | done | stopped
  let index = -1, run = 0, gate = null, release = null;
  let states = steps.map(() => 'pending');
  let caption = { text: '', detail: null, tone: null };
  let memo = {};
  const view = () => ({ status, index, caption: { ...caption }, steps: steps.map((s, i) => ({ id: s.id, title: s.title, state: states[i] })) });
  const emit = () => { try { onUpdate(view()); } catch (e) { console.error('[demo] onUpdate', e); } };
  const call = (fn, ...a) => { try { return fn && fn(...a); } catch (e) { console.error('[demo]', e); return undefined; } };

  async function wait(ms, my) {
    let left = ms;
    for (;;) {
      if (my !== run || status === 'stopped') throw new DemoAbort();
      if (status === 'paused') { await gate; continue; }
      if (left <= 0) return;
      const slice = Math.min(tickMs, left);
      await sleep(slice);
      if (status !== 'paused') left -= slice;
    }
  }
  async function waitFor(pred, timeoutMs, my) {
    let spent = 0;
    for (;;) {
      if (my !== run || status === 'stopped') throw new DemoAbort();
      if (status !== 'paused') { const v = pred(); if (v) return v; if (spent >= timeoutMs) return null; }
      await wait(tickMs, my); spent += tickMs;
    }
  }

  async function go(my) {
    status = 'playing'; states = steps.map(() => 'pending'); memo = {}; index = -1; emit();
    for (let i = 0; i < steps.length; i++) {
      if (my !== run) return;
      const st = steps[i];
      index = i; states[i] = 'running'; emit();
      const d = {
        ...ctx, memo,
        caption: (text, detail = null, tone = null) => { if (my !== run) return; caption = { text: text == null ? caption.text : text, detail, tone }; emit(); },
        wait: (ms) => wait(ms, my), waitFor: (pred, ms) => waitFor(pred, ms, my),
      };
      try {
        const dep = (st.after || []).find((id) => { const k = steps.findIndex((x) => x.id === id); return k >= 0 && states[k] !== 'done'; });
        if (dep) throw new DemoSkip(`skipped: needs ${steps.find((x) => x.id === dep).title.toLowerCase()} first`);
        const why = st.needs ? st.needs(call(ctx.caps) || {}, call(ctx.state) || {}) : null;
        if (why) throw new DemoSkip(why);
        await st.run(d);
        if (my !== run) return;
        states[i] = 'done'; emit();
      } catch (e) {
        if (e instanceof DemoAbort || my !== run) return;
        const skip = e instanceof DemoSkip;
        states[i] = skip ? 'skipped' : 'failed';
        caption = { text: `${st.title}: ${skip ? e.reason : 'could not run (' + ((e && e.message) || e) + ')'}`, detail: null, tone: skip ? 'skip' : 'err' };
        emit();
        if (!skip) console.warn('[demo] step', st.id, 'failed:', e);
        try { await wait(skipHoldMs, my); } catch { return; }
      }
    }
    if (my !== run) return;
    status = 'done'; emit();
    call(ctx.onFinish);
  }

  return {
    get view() { return view(); },
    get status() { return status; },
    /** Start from the first step (idle/done/stopped) or resume (paused). Resolves when this run ends. */
    play() {
      if (status === 'paused') { status = 'playing'; const r = release; gate = null; release = null; r && r(); call(ctx.onResume); emit(); return Promise.resolve(); }
      if (status === 'playing') return Promise.resolve();
      const my = ++run;
      return go(my);
    },
    pause() {
      if (status !== 'playing') return;
      status = 'paused'; gate = new Promise((r) => { release = r; }); call(ctx.onPause); emit();
    },
    /** Stop: abandon the script where it is, leave the farm state, let the UI restore normal speed. */
    stop() {
      if (status !== 'playing' && status !== 'paused') return;
      run++; status = 'stopped';
      const r = release; gate = null; release = null; r && r();
      states = states.map((x) => (x === 'running' ? 'pending' : x));
      call(ctx.onStop); emit();
    },
  };
}

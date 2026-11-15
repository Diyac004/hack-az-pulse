// Side panel: typed explanation, ours-vs-baseline scorecard, activity feed.
import { clock, esc, plural } from '../lib/format.js';
import { logLine } from '../lib/derive.js';

const n = (v) => (v == null || !isFinite(v) ? null : +v);
export const NOT_MEASURED = 'not measured';
const fmtMin = (v) => (v == null ? NOT_MEASURED : Math.round(v) + ' min');
const fmtN = (v) => (v == null ? NOT_MEASURED : String(Math.round(v)));

const lateOf = (m) => (m && n(m.completed) != null && n(m.on_time) != null ? Math.max(0, n(m.completed) - n(m.on_time)) : null);

/** Rows shown in scorecard + keynote. Extra §13.4 rows only when non-null on either side. */
/** Label for metrics a backend does not measure (AgOpenWeb bridge: no scheduler run; its zeros are placeholders). */
export const NOT_MEASURED_BRIDGE = 'not measured (bridge mode)';

/** opts.measured === false (capabilities.metricsMeasured): travel, idle and violations show as not measured. */
export function scoreRows(metrics, opts = {}) {
  const unmeasured = opts.measured === false;
  const o = (metrics && metrics.ours) || {}, b = (metrics && metrics.baseline) || null;
  const hasBase = !!(metrics && metrics.baseline && metrics.baseline_source);
  const bv = (k) => (hasBase && b ? n(b[k]) : null);
  const rows = [
    { k: 'completed', label: 'Jobs completed', a: n(o.completed), b: bv('completed'), f: fmtN, sub: o.jobs_total != null ? '/' + o.jobs_total : '', better: 'hi' },
    { k: 'on_time', label: 'On time', a: n(o.on_time), b: bv('on_time'), f: fmtN, better: 'hi' },
    // deadlines are a modeled constraint; a late finish also gets its own row so "0 violations" never hides it
    { k: 'late', label: 'Finished late', a: lateOf(o), b: hasBase && b ? lateOf(b) : null, f: fmtN, better: 'lo' },
    { k: 'travel_min', label: 'Travel', a: n(o.travel_min), b: bv('travel_min'), f: fmtMin, unit: 'min', better: 'lo' },
    { k: 'idle_min', label: 'Idle', a: n(o.idle_min), b: bv('idle_min'), f: fmtMin, unit: 'min', better: 'lo' },
  ];
  const extra = [
    ['weighted_on_time', 'Weighted on time', fmtN, 'hi'],
    ['productive_min', 'Productive', fmtMin, 'hi'],
    ['original_deadline_on_time', 'On time (original deadlines)', fmtN, 'hi'],
    ['replan_ms_last', 'Last re-plan', (v) => (v == null ? NOT_MEASURED : Math.round(v) + ' ms'), 'lo', true],
    ['rejected_candidates', 'Plans rejected by safety check', fmtN, null, true],
  ];
  for (const [k, label, f, better, detail] of extra) {
    const a = n(o[k]), bb = bv(k);
    if (a == null && bb == null) continue;
    rows.push({ k, label, a, b: bb, f, better, detail: !!detail, unit: f === fmtMin ? 'min' : k === 'replan_ms_last' ? 'ms' : '' });
  }
  if (unmeasured) for (const r of rows) if (r.k === 'travel_min' || r.k === 'idle_min') { r.a = null; r.nm = NOT_MEASURED_BRIDGE; }
  return { rows, hasBase, violations: unmeasured ? null : n(o.violations) || 0 };
}

export function baselineLabel(metrics) {
  const src = metrics && metrics.baseline_source;
  if (!metrics || !metrics.baseline || !src) return 'Baseline not run yet.';
  if (src === 'live') return 'Baseline: first-come-first-served, run live on the same day & events.';
  if (src === 'simulated') return 'Baseline: first-come-first-served on the same day & events (simulated, not a live run).';
  return 'Baseline: ' + src + '.';
}

/**
 * Baseline hold (Anay 7df3d39): metrics.baseline is null for ~0.5 s after startup and after every operator action
 * while the FCFS twin recomputes. Once a baseline has been seen this run, a transient null keeps the last values
 * (shown dimmed, "updating…") instead of flipping to "not measured". reset() on a new run (POST /run).
 * apply(m) -> { metrics: m with the held baseline filled in, updating: bool }.
 */
export function createBaselineHold() {
  let last = null; // { baseline, baseline_source } from this run
  return {
    reset() { last = null; },
    get seen() { return !!last; },
    apply(m) {
      if (!m) return { metrics: m, updating: false };
      if (m.baseline && m.baseline_source) { last = { baseline: m.baseline, baseline_source: m.baseline_source }; return { metrics: m, updating: false }; }
      if (last) return { metrics: { ...m, baseline: last.baseline, baseline_source: last.baseline_source }, updating: true };
      // a source without numbers yet (or numbers without a source): a baseline exists for this run, values pending
      return { metrics: m, updating: !!(m.baseline_source || m.baseline) };
    },
  };
}

/** AgOpenWeb bridge (capabilities.backend === 'bridge'): its numbers never go on the scorecard. */
export const BRIDGE_SCORE_NOTE = 'Scorecard comes from the planner backend (FastAPI). Bridge mode shows real AgOpenWeb tractors only.';
export const isBridge = (c) => !!c && c.backend === 'bridge';
export const jobsDone = (state) => ((state && state.jobs) || []).filter((j) => j && (j.status === 'done' || j.status === 'completed')).length;

export function createPanel({ caps = () => ({}) } = {}) {
  const exp = document.getElementById('exp');
  const score = document.getElementById('score'), viol = document.getElementById('viol'), basesrc = document.getElementById('basesrc');
  const feed = document.getElementById('feed');
  let typer = null, lastExp = null, worded = null, scoreSig = '', feedSig = '', showDetails = false;
  const hold = createBaselineHold();
  let held = { metrics: null, updating: false };
  score.addEventListener('click', (e) => { if (e.target.closest('[data-det]')) { showDetails = !showDetails; scoreSig = ''; } });

  return {
    explain(text, animate = true) {
      clearInterval(typer);
      const s = String(text || '');
      if (!animate) { exp.textContent = s; return; }
      let i = 0; exp.textContent = '';
      typer = setInterval(() => { i += 3; exp.textContent = s.slice(0, i); if (i >= s.length) clearInterval(typer); }, 16);
    },
    /** Called on snapshot: show newest explanation without typing. */
    seed(state) {
      const x = (state.explanations || [])[0];
      lastExp = x ? x.id : null;
      this.explain(x ? (worded && worded.id === x.id ? worded.text : x.text) : 'Waiting for the first plan…', false);
    },
    onExplanation(x) {
      if (!x || x.id === lastExp) return;
      lastExp = x.id; this.explain(x.text, true);
    },
    /**
     * AI Supervisor wording (ai-supervisor, validated: same numbers, jobs, tractors, times and claims as the
     * template). Shown in place of the template for the current explanation; the plan is never affected.
     */
    setWording(id, text) {
      if (!id || id !== lastExp || !text || (worded && worded.id === id && worded.text === text)) return;
      worded = { id, text }; this.explain(text, false);
    },
    /** New run (POST /run snapshot, or a restarted backend): forget the held baseline. */
    resetBaseline() { hold.reset(); scoreSig = ''; },
    /** Metrics as the scorecard shows them (held baseline filled in) + whether the baseline is updating. */
    shown() { return held; },
    sync(state) {
      const c = caps();
      held = hold.apply(state.metrics);
      const m = held.metrics, upd = held.updating;
      const bridge = isBridge(c);
      const measured = c.metricsMeasured !== false;
      const sig = (bridge ? 'bridge:' + jobsDone(state) + '/' + (state.jobs || []).length : JSON.stringify(m || null)) + showDetails + measured + upd;
      if (sig !== scoreSig) {
        scoreSig = sig;
        score.classList.toggle('bridge', bridge);
        if (bridge) {
          // Anay: "keep the bridge's numbers out of the scorecard". Only a plain count of jobs done, labelled bridge.
          score.innerHTML = '<p class="bnote gl">' + esc(BRIDGE_SCORE_NOTE) + '</p>' +
            '<span style="color:var(--muted)">Jobs done (bridge)</span><span style="font-weight:600">' + jobsDone(state) + '/' + (state.jobs || []).length + '</span>';
          viol.textContent = ''; viol.hidden = true; viol.classList.remove('bad');
          basesrc.textContent = '';
        } else {
          viol.hidden = false;
          const { rows, hasBase, violations } = scoreRows(m, { measured });
          const pending = '<span class="nm">updating…</span>';
          const cell = (v, r) => (v == null ? '<span class="nm">' + (r.nm || NOT_MEASURED) + '</span>' : r.f(v) + (r.sub || ''));
          const bcell = (r) => (hasBase ? cell(r.b, { f: r.f }) : upd ? pending : '<span class="nm">' + NOT_MEASURED + '</span>');
          const row = (r) => '<span style="color:var(--muted)">' + esc(r.label) + '</span><span style="font-weight:600;color:var(--green)">' + cell(r.a, r) + '</span><span class="bcol' + (upd ? ' stale' : '') + '" style="color:var(--faint)">' + bcell(r) + '</span>';
          const main = rows.filter((r) => !r.detail), det = rows.filter((r) => r.detail);
          score.innerHTML = '<span></span><span class="lbl">Ours</span><span class="lbl">Baseline' + (upd && hasBase ? ' <span class="upd">updating…</span>' : '') + '</span>' + main.map(row).join('') +
            (det.length ? '<button class="dtl" data-det>' + (showDetails ? 'Hide details' : 'Details') + '</button>' + (showDetails ? det.map(row).join('') : '') : '');
          viol.textContent = violations == null ? 'Violations ' + NOT_MEASURED_BRIDGE : plural(violations, 'violation');
          viol.title = 'Broken constraints in applied plans (deadlines, implements, fuel, safety). Jobs that finished late are also shown on their own row.';
          viol.classList.toggle('bad', violations > 0);
          basesrc.textContent = upd && !hasBase ? 'Baseline: first-come-first-served on the same day & events, updating…' : baselineLabel(m);
        }
      }
      const log = state.log || [];
      const fs = log.length + ':' + (log[0] ? JSON.stringify(log[0]) : '') + (state.fleet || []).length;
      if (fs !== feedSig) {
        feedSig = fs;
        const lines = [];
        for (const e of log) {
          const h = logLine(e, state);
          if (h) lines.push('<p><span style="color:var(--faint)">' + clock(e.t) + '</span> ' + h + '</p>');
          if (lines.length >= 8) break;
        }
        feed.innerHTML = lines.join('') || '<p style="color:var(--faint)">Nothing yet.</p>';
      }
    },
  };
}

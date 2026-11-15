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

export function createPanel({ caps = () => ({}) } = {}) {
  const exp = document.getElementById('exp');
  const score = document.getElementById('score'), viol = document.getElementById('viol'), basesrc = document.getElementById('basesrc');
  const feed = document.getElementById('feed');
  let typer = null, lastExp = null, scoreSig = '', feedSig = '', showDetails = false;
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
      this.explain(x ? x.text : 'Waiting for the first plan…', false);
    },
    onExplanation(x) {
      if (!x || x.id === lastExp) return;
      lastExp = x.id; this.explain(x.text, true);
    },
    sync(state) {
      const m = state.metrics;
      const measured = caps().metricsMeasured !== false;
      const sig = JSON.stringify(m || null) + showDetails + measured;
      if (sig !== scoreSig) {
        scoreSig = sig;
        const { rows, hasBase, violations } = scoreRows(m, { measured });
        const cell = (v, r) => (v == null ? '<span class="nm">' + (r.nm || NOT_MEASURED) + '</span>' : r.f(v) + (r.sub || ''));
        const row = (r) => '<span style="color:var(--muted)">' + esc(r.label) + '</span><span style="font-weight:600;color:var(--green)">' + cell(r.a, r) + '</span><span style="color:var(--faint)">' + (hasBase ? cell(r.b, { f: r.f }) : '<span class="nm">' + NOT_MEASURED + '</span>') + '</span>';
        const main = rows.filter((r) => !r.detail), det = rows.filter((r) => r.detail);
        score.innerHTML = '<span></span><span class="lbl">Ours</span><span class="lbl">Baseline</span>' + main.map(row).join('') +
          (det.length ? '<button class="dtl" data-det>' + (showDetails ? 'Hide details' : 'Details') + '</button>' + (showDetails ? det.map(row).join('') : '') : '');
        viol.textContent = violations == null ? 'Violations ' + NOT_MEASURED_BRIDGE : plural(violations, 'violation');
        viol.title = 'Broken constraints in applied plans (deadlines, implements, fuel, safety). Jobs that finished late are also shown on their own row.';
        viol.classList.toggle('bad', violations > 0);
        basesrc.textContent = baselineLabel(m);
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

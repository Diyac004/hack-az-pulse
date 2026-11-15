// End-of-day keynote scorecard with rolling numbers.
import { clock, esc } from '../lib/format.js';
import { scoreRows, baselineLabel, BRIDGE_SCORE_NOTE, isBridge, jobsDone } from './panel.js';

export function createKeynote() {
  const el = document.getElementById('key');
  el.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) el.classList.remove('on'); });
  return {
    hide() { el.classList.remove('on'); },
    /** bounds: {top, bottom} px inside #stage that the card must stay within (below island/chips, above dock). */
    /** opts.metrics: what the side scorecard shows (baseline held through a recompute); opts.caps: capabilities. */
    show(state, bounds, opts = {}) {
      if (bounds) {
        el.style.top = bounds.top + 'px';
        el.style.maxHeight = Math.max(160, bounds.bottom - bounds.top) + 'px';
      }
      const D = (state.clock && state.clock.day_minutes) || 720;
      const head = '<p style="margin:0 0 2px;font-size:12px;color:#6e6e73">' + clock(D) + '</p><p style="margin:0 0 10px;font-size:22px;font-weight:600">Day complete</p>';
      if (isBridge(opts.caps)) {
        // same rule as the side panel: no bridge numbers on the scorecard, only a labelled count of jobs done
        el.innerHTML = head + '<div style="display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;border-top:0.5px solid rgba(0,0,0,.08)"><span style="font-size:13px;color:#6e6e73">Jobs done (bridge)</span><b style="font-size:24px;font-weight:600">' + jobsDone(state) + '<span style="font-size:12px;font-weight:400;color:#6e6e73">/' + (state.jobs || []).length + '</span></b></div>' +
          '<p style="font-size:12px;color:#6e6e73;margin:8px 0 0;line-height:1.4">' + esc(BRIDGE_SCORE_NOTE) + '</p><button class="gbtn" data-x style="margin-top:12px">Close</button>';
        el.classList.add('on');
        return;
      }
      const metrics = opts.metrics !== undefined ? opts.metrics : state.metrics;
      const { rows, hasBase, violations } = scoreRows(metrics);
      const stat = (r) => '<div style="display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;border-top:0.5px solid rgba(0,0,0,.08)"><span style="font-size:13px;color:#6e6e73;text-align:left">' + esc(r.label) + '</span><span><b class="roll" data-v="' + (r.a ?? 0) + '" style="font-size:24px;font-weight:600;color:#1E7A3C">' + (r.a == null ? '<span style="font-size:12px;font-weight:400;color:#6e6e73">not measured</span>' : '0') + '</b><span style="font-size:12px;color:#6e6e73"> ' + (r.unit || '') + (hasBase && r.b != null ? ' vs ' + Math.round(r.b) : '') + '</span></span></div>';
      const vr = { label: 'Violations', a: violations, b: hasBase && metrics.baseline ? metrics.baseline.violations : null };
      el.innerHTML = head +
        rows.filter((r) => !r.detail).map(stat).join('') + stat(vr) +
        '<p style="font-size:11px;color:#6e6e73;margin:8px 0 0">' + esc(baselineLabel(metrics) + (opts.updating ? ' Updating…' : '')) + '</p>' +
        '<button class="gbtn" data-x style="margin-top:12px">Close</button>';
      el.classList.add('on');
      el.querySelectorAll('.roll').forEach((r) => {
        if (r.textContent === 'not measured') return;
        const tv = +r.dataset.v, st = performance.now();
        const f = () => { const p = Math.min(1, (performance.now() - st) / 1400), e = 1 - Math.pow(1 - p, 3); r.textContent = Math.round(tv * e); if (p < 1) requestAnimationFrame(f); };
        f();
      });
    },
  };
}

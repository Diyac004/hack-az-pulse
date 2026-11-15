// Fleet chips (keyed by tractor id): fuel ring, status line, spinner while `starting`,
// remove (×) and a dedicated, always-visible "Mark repaired" button while a tractor is down or being repaired.
import { tractorColor, statusInfo, isDown, esc } from '../lib/format.js';

const NS = 'http://www.w3.org/2000/svg';
const R = 10, C = 2 * Math.PI * R;

function ringEl() {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '26'); svg.setAttribute('height', '26'); svg.setAttribute('viewBox', '0 0 26 26'); svg.style.flex = 'none';
  const bg = document.createElementNS(NS, 'circle'), fg = document.createElementNS(NS, 'circle');
  [bg, fg].forEach((c) => { c.setAttribute('cx', '13'); c.setAttribute('cy', '13'); c.setAttribute('r', R); c.setAttribute('fill', 'none'); c.setAttribute('stroke-width', '4'); });
  bg.setAttribute('stroke', 'rgba(0,0,0,.09)');
  fg.setAttribute('stroke-linecap', 'round'); fg.setAttribute('transform', 'rotate(-90 13 13)');
  svg.append(bg, fg); svg._fg = fg; return svg;
}

// Short status for a down tractor; the long label wraps out of a 138 px chip and used to hide the repair button.
const DOWN_SHORT = { broken: 'Broken', awaiting_mechanic: 'Needs mechanic', repair_scheduled: 'Mechanic en route', repairing: 'Repairing' };
const needsRepair = (s) => isDown(s) || s === 'repairing';

export function createChips({ api, ops, onFocus, onRepair, onControls = null }) {
  const root = document.getElementById('chips');
  const map = new Map();

  function make(id) {
    const el = document.createElement('div'); el.className = 'chip gl'; el.dataset.id = id;
    const ring = ringEl();
    const txt = document.createElement('div'); txt.className = 'ctxt';
    const l1 = document.createElement('p'); l1.style.fontWeight = '600';
    const l2 = document.createElement('p'); l2.style.color = '#6e6e73';
    txt.append(l1, l2);
    const x = document.createElement('button'); x.className = 'cx'; x.title = 'Remove tractor'; x.textContent = '×';
    x.addEventListener('click', (e) => { e.stopPropagation(); if (el.classList.contains('busy')) return; ops.track(api.removeTractor(id), { els: el, okText: id + ' leaving the fleet' }); });
    if (onControls) {
      const cb = document.createElement('button'); cb.type = 'button'; cb.className = 'cpb'; cb.title = 'Tractor controls'; cb.setAttribute('aria-label', 'Open tractor controls');
      cb.innerHTML = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 4h10M2 10h10"/><circle cx="5" cy="4" r="1.6"/><circle cx="9" cy="10" r="1.6"/></svg>';
      cb.addEventListener('click', (e) => { e.stopPropagation(); onControls(id); });
      el.appendChild(cb); el.classList.add('has-cpb');
    }
    el.addEventListener('click', (e) => {
      const mr = e.target && e.target.closest && e.target.closest('.mrb');
      if (mr) {
        e.stopPropagation();
        if (mr.classList.contains('busy')) return;
        if (onRepair) onRepair(id, [mr]); else ops.track(api.postEvent({ type: 'tractor_repaired', tractor: id }), { els: [mr] });
        return;
      }
      onFocus && onFocus(id);
    });
    const act = document.createElement('div'); act.className = 'cact';
    const mrb = document.createElement('button'); mrb.type = 'button'; mrb.className = 'mrb'; mrb.textContent = 'Mark repaired';
    act.appendChild(mrb); txt.appendChild(act);
    el.append(ring, txt, x);
    root.appendChild(el);
    return { el, ring, l1, l2, act, sig: '' };
  }

  return {
    clear() { root.innerHTML = ''; map.clear(); },
    sync(state) {
      const fleet = state.fleet || [], jobs = state.jobs || [];
      const seen = new Set();
      fleet.forEach((tr, i) => {
        if (!tr || !tr.id) return;
        seen.add(tr.id);
        let c = map.get(tr.id);
        if (!c) { c = make(tr.id); map.set(tr.id, c); }
        if (c.el.classList.contains('out')) c.el.classList.remove('out');
        const info = statusInfo(tr.status), col = tractorColor(tr, i);
        const fuel = Math.max(0, Math.min(100, +tr.fuel_pct || 0));
        const j = tr.current_job ? jobs.find((x) => x.id === tr.current_job) : null;
        let l2;
        if (tr.status === 'traveling') l2 = j ? 'To ' + esc(j.block || j.label) : 'Traveling';
        else if (tr.status === 'working') l2 = j ? esc(j.label || j.id) : 'Working';
        else if (info.color) l2 = '<span style="color:' + info.color + '">' + esc(info.label) + '</span>';
        else l2 = esc(info.label);
        const down = needsRepair(tr.status);
        // while down: line 1 = id + short status (fuel stays on the ring), line 2 = the Mark repaired button
        if (down) l2 = '';
        if (tr.manual && !down) l2 = '<span class="mbdg">Manual</span>' + l2;
        c.el.classList.toggle('manual', !!tr.manual);
        const l1 = down ? esc(tr.id) + ' · <span style="color:' + (info.color || '#FF453A') + '">' + esc(DOWN_SHORT[tr.status] || info.label) + '</span>' : esc(tr.id) + ' · ' + Math.round(fuel) + '%';
        c.el.classList.toggle('down', down);
        const sig = l1 + l2 + info.ring + col;
        if (sig !== c.sig) {
          c.sig = sig;
          c.l1.innerHTML = l1;
          // keep a busy "Mark repaired" span's spinner state: only rewrite when text changes
          c.l2.innerHTML = l2;
          c.el.title = (tr.name || tr.id) + ' · ' + info.label + ' · fuel ' + Math.round(fuel) + '%';
        }
        const fg = c.ring._fg;
        const spin = info.ring === 'spin';
        c.ring.classList.toggle('spin', spin);
        fg.setAttribute('stroke', isDown(tr.status) ? '#FF453A' : col);
        fg.setAttribute('stroke-dasharray', spin ? (C * 0.3) + ' ' + C : (C * fuel / 100) + ' ' + C);
      });
      for (const [id, c] of map) if (!seen.has(id) && !c.el.classList.contains('out')) {
        c.el.classList.add('out');
        setTimeout(() => { if (c.el.classList.contains('out')) { c.el.remove(); map.delete(id); } }, 360);
      }
    },
  };
}

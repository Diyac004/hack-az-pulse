// Fleet chips (keyed by tractor id): fuel ring, status line, spinner while `starting`,
// remove (×) and "Mark repaired" actions.
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

export function createChips({ api, ops, onFocus }) {
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
    el.addEventListener('click', (e) => {
      if (e.target && e.target.classList && e.target.classList.contains('mr')) {
        e.stopPropagation();
        if (e.target.classList.contains('busy')) return;
        ops.track(api.postEvent({ type: 'tractor_repaired', tractor: id }), { els: [e.target] });
        return;
      }
      onFocus && onFocus(id);
    });
    el.append(ring, txt, x);
    root.appendChild(el);
    return { el, ring, l1, l2, sig: '' };
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
        if (isDown(tr.status) || tr.status === 'repairing') l2 += ' · <span class="mr" style="color:#0A84FF;cursor:pointer">Mark repaired</span>';
        if (tr.manual) l2 = '<span style="color:#5E5CE6">Manual</span> · ' + l2;
        const l1 = esc(tr.id) + ' · ' + Math.round(fuel) + '%';
        const sig = l1 + l2 + info.ring + col;
        if (sig !== c.sig) {
          c.sig = sig;
          c.l1.innerHTML = l1;
          // keep a busy "Mark repaired" span's spinner state: only rewrite when text changes
          c.l2.innerHTML = l2;
          c.el.title = (tr.name || tr.id) + ' · ' + info.label;
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

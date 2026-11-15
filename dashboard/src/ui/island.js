// Dynamic Island pill + toast.
import { clock, isBusy, plural } from '../lib/format.js';

export function createIsland() {
  const island = document.getElementById('island'), itxt = document.getElementById('itxt'), idot = document.getElementById('idot');
  const queue = [];
  let until = 0, sticky = false;
  function show(m) { itxt.textContent = m.text; idot.style.background = m.dot; island.classList.add('big'); until = performance.now() + m.ms; }
  return {
    /** Queue a big moment; consecutive moments each get a beat. */
    moment(m) { if (!m) return; if (m.sticky) { sticky = true; queue.length = 0; show(m); return; } if (m.urgent || m.dot === '#FF453A') { queue.length = 0; show(m); return; } queue.push(m); if (queue.length > 4) queue.shift(); },
    reset() { sticky = false; queue.length = 0; until = 0; },
    /** note: live-link problem text (e.g. "Can't reach localhost:8000 · retrying"); replaces the idle line. */
    tick(state, now, note) {
      if (sticky) return;
      if (now < until) return;
      if (queue.length) { show(queue.shift()); return; }
      if (note) { itxt.textContent = note; idot.style.background = '#FF453A'; island.classList.remove('big'); return; }
      const fleet = (state && state.fleet) || [];
      const w = fleet.filter((x) => isBusy(x.status)).length;
      const t = state && state.clock ? state.clock.t : null;
      itxt.textContent = (t == null ? 'Waiting for data' : clock(t)) + ' · ' + plural(w, 'tractor') + ' working';
      idot.style.background = state && state.connected === false ? '#FF453A' : '#30D158';
      island.classList.remove('big');
    },
  };
}

export function createToast() {
  const el = document.getElementById('toast');
  let timer = null;
  /** action: optional { label, onClick(buttonEl) } rendered as a button inside the toast. */
  return (text, kind, action) => {
    el.textContent = text;
    if (action) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tact'; b.textContent = action.label;
      b.addEventListener('click', (e) => { e.stopPropagation(); if (!b.classList.contains('busy')) action.onClick(b); });
      el.appendChild(b);
    }
    el.className = 'on' + (kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '') + (action ? ' act' : '');
    clearTimeout(timer);
    timer = setTimeout(() => { el.className = ''; }, action ? 8000 : kind === 'err' || kind === 'warn' ? 5200 : 3200);
  };
}

// Glass timeline dock: one lane per tractor (grows to 5, then scrolls), pills keyed by job id that
// spring between lanes on re-plan, colored by PRIORITY with a tractor-colored left edge.
// Also: now line, unassigned tray, plan/solver badge.
import { timelineLayout, SOLVER_LABEL, planHealth } from '../lib/derive.js';
import { hourLabel, esc, priColor, priName, clock, plural, durText } from '../lib/format.js';

const LANE = 32;

export function createDock({ onPill, onLane = null }) {
  const dock = document.getElementById('dock');
  const axis = document.getElementById('axis');
  const lanesOuter = document.getElementById('lanes');
  const wrap = document.getElementById('lanewrap');
  const nowL = document.createElement('div'); nowL.id = 'now'; wrap.appendChild(nowL);
  const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No tractors in the fleet. Add one to start planning.'; wrap.appendChild(empty);

  // floating badges above the dock
  const tray = document.createElement('div'); tray.id = 'tray'; tray.className = 'gl';
  const badge = document.createElement('div'); badge.id = 'planbadge'; badge.className = 'gl';
  dock.append(tray, badge);
  let trayOpen = false;
  tray.addEventListener('click', (e) => {
    const id = e.target.closest && e.target.closest('[data-job]');
    if (id) { onPill(id.dataset.job); return; }
    trayOpen = !trayOpen; tray.classList.toggle('open', trayOpen);
  });

  const lanes = new Map(), pills = new Map(), marks = new Map();
  let axisSig = '';

  function laneEls() {
    const l = document.createElement('div'); l.className = 'lane'; wrap.insertBefore(l, nowL);
    const n = document.createElement('div'); n.className = 'lname'; lanesOuter.appendChild(n);
    if (onLane) { n.setAttribute('role', 'button'); n.tabIndex = 0; n.addEventListener('click', (e) => { e.stopPropagation(); if (n._id) onLane(n._id); }); n.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && n._id) { e.preventDefault(); onLane(n._id); } }); }
    return { l, n };
  }
  function pillEl(id) {
    const d = document.createElement('div'); d.className = 'pill'; d.dataset.job = id;
    d.innerHTML = '<div class="pf"></div><div class="pe"></div><span></span>';
    d.addEventListener('click', (e) => { e.stopPropagation(); onPill(id); });
    d.style.opacity = '0';
    wrap.insertBefore(d, nowL);
    return { d, pf: d.firstChild, pe: d.children[1], sp: d.children[2], lane: null };
  }

  return {
    clear() { for (const m of marks.values()) m.remove(); marks.clear(); for (const p of pills.values()) p.d.remove(); pills.clear(); for (const l of lanes.values()) { l.l.remove(); l.n.remove(); } lanes.clear(); },
    pillEl(jobId) { const p = pills.get(jobId); return p ? p.d : null; },
    sync(state) {
      const D = (state.clock && state.clock.day_minutes) || 720;
      const sig = String(D);
      if (sig !== axisSig) {
        axisSig = sig;
        const ticks = []; for (let m = 0; m <= D + 1e-6; m += 180) ticks.push(m);
        axis.innerHTML = ticks.map((m, i) => '<span style="left:' + (m / D * 100) + '%">' + hourLabel(m, i === 0, i === ticks.length - 1) + '</span>').join('');
      }
      const L = timelineLayout(state);
      // lanes
      const seen = new Set();
      L.lanes.forEach((ln, i) => {
        seen.add(ln.id);
        let e = lanes.get(ln.id); if (!e) { e = laneEls(ln.id); lanes.set(ln.id, e); }
        e.l.style.top = (i * LANE) + 'px'; e.n.style.top = (i * LANE) + 'px';
        e.n.style.color = ln.color; e.n.textContent = ln.name; e.n._id = ln.id;
        // manual: out of AI planning -> hatched lane + orange label (PROJECT.md Change 8)
        e.l.classList.toggle('manual', !!ln.manual); e.n.classList.toggle('manual', !!ln.manual);
        e.n.title = ln.name + (ln.manual ? ' · under manual control' : '') + (onLane ? ' · tap for controls' : '');
        e.l.style.background = 'color-mix(in srgb, ' + ln.color + ' 9%, rgba(0,0,0,.05))';
        e.l.style.opacity = ln.status === 'removing' || ln.status === 'offline' ? '.4' : '1';
      });
      for (const [id, e] of lanes) if (!seen.has(id)) { e.l.remove(); e.n.remove(); lanes.delete(id); }
      const n = L.lanes.length;
      lanesOuter.style.height = Math.max(26, n * LANE - 6) + 'px';
      empty.style.display = n ? 'none' : 'block';

      // pills. Work past the axis end never silently disappears: a pill crossing day end is clipped at the right
      // edge, a pill entirely after it collapses into the lane's overflow marker ("+1 job → 7:40 PM").
      const health = planHealth(state);
      const lateSet = new Set(health.late);
      const over = new Map(); // lane id -> { lane, end, jobs: [{id,label,end}], hidden }
      const want = new Set();
      for (const p of L.pills) {
        want.add(p.id);
        let e = pills.get(p.id); if (!e) { e = pillEl(p.id); pills.set(p.id, e); }
        e.gone = false;
        const past = !p.done && p.start >= D - 1e-6, crosses = !p.done && p.end > D + 0.5;
        if (crosses) {
          const o = over.get(p.tractor) || { lane: p.lane, end: -Infinity, jobs: [], hidden: 0 };
          o.end = Math.max(o.end, p.end); o.jobs.push({ id: p.id, label: p.label, start: p.start, end: p.end }); if (past) o.hidden++;
          over.set(p.tractor, o);
        }
        const st = Math.max(0, Math.min(p.start, D)), en = Math.min(p.end, D);
        const left = st / D * 100, w = past ? 0 : Math.max(2, (en - st) / D * 100);
        e.d.style.left = left + '%'; e.d.style.width = w + '%'; e.d.style.top = (p.lane * LANE + 2) + 'px';
        e.d.style.backgroundColor = p.fill; e.pe.style.background = p.edge;
        e.d.style.opacity = past ? '0' : p.done ? '.45' : '1';
        e.d.style.pointerEvents = past ? 'none' : '';
        e.d.classList.toggle('clip', crosses && !past);
        e.d.classList.toggle('late', !p.done && lateSet.has(p.id));
        e.pf.style.width = (p.progress * 100) + '%';
        if (e.sp.textContent !== p.label) e.sp.textContent = p.label;
        e.d.title = p.label + ' · ' + p.tractor + ' · ' + priName(p.job.priority) + ' priority · ' + clock(p.start) + ' to ' + clock(p.end) +
          (lateSet.has(p.id) ? ' · misses its ' + clock(p.job.deadline_t) + ' deadline by ' + durText(health.lateBy[p.id]) : '');
        if (e.lane != null && e.lane !== p.tractor) { e.d.classList.remove('flash'); void e.d.offsetWidth; e.d.classList.add('flash'); }
        e.lane = p.tractor;
      }
      for (const [id, e] of pills) if (!want.has(id) && !e.gone) {
        e.gone = true; e.d.style.opacity = '0';
        setTimeout(() => { if (e.gone) { e.d.remove(); pills.delete(id); } }, 420);
      }
      // per-lane overflow markers
      for (const [id, o] of over) {
        let m = marks.get(id);
        if (!m) { m = document.createElement('div'); m.className = 'ovf'; m.addEventListener('click', (ev) => { ev.stopPropagation(); if (m._job) onPill(m._job); }); wrap.insertBefore(m, nowL); marks.set(id, m); }
        m.style.top = (o.lane * LANE + 3) + 'px';
        const txt = (o.hidden ? '+' + plural(o.hidden, 'job') + ' ' : '') + '→ ' + clock(o.end);
        if (m.textContent !== txt) m.textContent = txt;
        m.title = 'Runs past ' + clock(D) + ': ' + o.jobs.map((j) => j.label + ' ' + clock(j.start) + ' to ' + clock(j.end)).join('; ');
        m._job = (o.jobs.find((j) => j.start >= D) || o.jobs[0]).id;
      }
      for (const [id, m] of marks) if (!over.has(id)) { m.remove(); marks.delete(id); }

      const t = state.clock ? state.clock.t : 0;
      nowL.style.left = Math.max(0, Math.min(100, t / D * 100)) + '%';

      // unassigned tray
      const un = L.unassigned;
      tray.style.display = un.length ? 'block' : 'none';
      if (un.length) {
        const s = un.map((j) => j.id + j.priority + (j.unassigned_reason || '')).join('|') + trayOpen;
        if (tray._sig !== s) {
          tray._sig = s;
          tray.innerHTML = '<div class="trhead"><i></i>' + un.length + ' unassigned</div><div class="trlist">' + un.map((j) =>
            '<div class="tritem" data-job="' + esc(j.id) + '"><span class="dot" style="background:' + priColor(j.priority) + '"></span><b>' + esc(j.label || j.id) + '</b> ' + esc(j.unassigned_reason || 'Waiting for a compatible tractor') + '</div>').join('') + '</div>';
        }
      } else { trayOpen = false; tray.classList.remove('open'); }

      return L;
    },
    /** Plan badge: solver_status + version, spinner while any op is active. */
    badge(state, activeOps) {
      const p = state.plan;
      const st = p && p.solver_status;
      const act = activeOps && activeOps.length;
      const label = st ? (SOLVER_LABEL[st] || st) : (p ? (p.solver || 'Plan') : 'No plan');
      const h = planHealth(state);
      const D = h.day;
      const sig = (p ? p.version : '-') + label + act + '|' + h.overtimeMin + '|' + h.late.join() + '|' + h.afterDay.join();
      if (badge._sig === sig) return;
      badge._sig = sig;
      badge.className = 'gl ' + (st || 'none') + (act ? ' busy' : '');
      badge.innerHTML = (act ? '<span class="sp"></span>' + (act > 1 ? act + ' requests running · ' : 'Working… · ') : '') +
        'Plan v' + (p && p.version != null ? p.version : '–') + ' · <b>' + esc(label) + '</b>' +
        // solver_status stays as the contract says; these chips say what "feasible" does not: overtime and lateness
        (h.overtimeMin > 0 ? '<span class="wchip ot" title="Planned work ends ' + esc(clock(h.endT)) + ', after the ' + esc(clock(D)) + ' end of day">Overtime +' + h.overtimeMin + ' min</span>' : '') +
        (h.late.length || h.afterDay.length ? '<span class="wchip late" title="Late = planned to finish after its deadline. Deadlines are modeled constraints; late jobs are also counted on the scorecard (Finished late).">' +
          [h.late.length ? h.late.length + ' late' : '', h.afterDay.length ? h.afterDay.length + ' after ' + esc(clock(D)) : ''].filter(Boolean).join(' · ') + '</span>' : '');
      badge.title = st === 'feasible' ? 'Valid schedule; optimality not proven' : st === 'optimal' ? 'Solver proved optimality' : st === 'fallback' ? 'Primary optimizer failed or timed out; validated heuristic plan applied' : '';
    },
  };
}

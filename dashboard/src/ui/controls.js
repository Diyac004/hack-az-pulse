// Side-panel buttons. Every action goes through `api` and is tracked per Operation.
import { tractorColor, isDown, esc } from '../lib/format.js';

export function createControls({ store, api, ops, toast, world, sheets, onBreakdownRequested }) {
  const $ = (id) => document.getElementById(id);
  const bPlay = $('bPlay'), bBreak = $('bBreak'), bBlock = $('bBlock'), bHeat = $('bHeat'), bFast = $('bFast'), bFx = $('bFx'), bAdd = $('bAdd'), bCam = $('bCam');
  const pick = $('breakpick');
  const st = () => store.get() || {};
  let slowmo = null; // { restore } while a breakdown slow-motion override is active

  bPlay.onclick = () => {
    const c = st().clock || {};
    ops.track(api.setClock({ playing: !c.playing }), { els: bPlay });
  };
  bFast.onclick = () => {
    const c = st().clock || {};
    const fast = (slowmo ? slowmo.restore : c.speed) > 1;
    if (slowmo) slowmo.restore = fast ? 1 : 6;
    ops.track(api.setClock({ playing: true, speed: fast ? 1 : 6 }), { els: bFast });
  };
  bFx.onclick = () => { world.fx = !world.fx; bFx.textContent = 'Effects: ' + (world.fx ? 'on' : 'off'); };
  bAdd.onclick = () => sheets.openAdd();
  bCam.onclick = () => world.home();
  bBlock.onclick = () => ops.track(api.postEvent({ type: 'block_route' }), { els: bBlock });
  bHeat.onclick = () => ops.track(api.postEvent({ type: 'heat_alert', temp_f: 112, at_t: 480 }), { els: bHeat });

  // Wind gust / calm (Change 6 demo moment): one click sends weather_change. The label follows the store's
  // current wind, so it is right after a reset, a reconnect or a change made elsewhere.
  const bWind = document.createElement('button'); bWind.id = 'bWind'; bWind.textContent = 'Wind gust';
  bHeat.after(bWind);
  const gusty = () => { const c = st().weather && st().weather.current; return !!(c && c.wind_mph > 10); };
  bWind.onclick = () => {
    const s = st();
    const areas = (s.scenario && s.scenario.sensitive) || [];
    if (gusty()) {
      // calm: 6 mph from the direction that blows furthest from every sensitive area
      let best = 0, bestGap = -1;
      for (let from = 0; from < 360; from += 15) {
        const toward = (from + 180) % 360;
        const gap = Math.min(180, ...areas.map((a) => { const d = Math.abs(((toward - a.dir_deg) % 360 + 360) % 360); return d > 180 ? 360 - d : d; }));
        if (gap > bestGap) { bestGap = gap; best = from; }
      }
      ops.track(api.postEvent({ type: 'weather_change', wind_mph: 6, wind_from_deg: best }), { els: bWind });
      return;
    }
    // gust: 14 mph blowing toward the sensitive area of a block being sprayed now (else the first one)
    const jobs = s.jobs || [];
    const spraying = new Set((s.fleet || []).map((t) => t.current_job && jobs.find((j) => j.id === t.current_job)).filter((j) => j && j.implement === 'sprayer' && j.status === 'working').map((j) => j.block));
    const area = areas.find((a) => spraying.has(a.block)) || areas[0];
    ops.track(api.postEvent({ type: 'weather_change', wind_mph: 14, wind_from_deg: area ? (area.dir_deg + 180) % 360 : 270 }), { els: bWind });
  };

  // Break-down picker: non-broken tractors, T1 (or first) highlighted as default.
  function renderPick() {
    const fleet = (st().fleet || []).map((t, i) => ({ t, i })).filter(({ t }) => !isDown(t.status) && t.status !== 'repairing' && t.status !== 'removing' && t.status !== 'offline');
    if (!fleet.length) { pick.innerHTML = '<div class="none">No running tractors to break.</div>'; return; }
    const def = (fleet.find(({ t }) => t.id === 'T1') || fleet[0]).t.id;
    pick.innerHTML = fleet.map(({ t, i }) => '<button data-t="' + esc(t.id) + '" class="' + (t.id === def ? 'def' : '') + '"><i style="background:' + tractorColor(t, i) + '"></i>' + esc(t.name || t.id) + (t.id === def ? ' <span style="margin-left:auto;font-size:10px;color:#6e6e73">default</span>' : '') + '</button>').join('');
  }
  bBreak.onclick = (e) => { e.stopPropagation(); if (pick.classList.contains('on')) { pick.classList.remove('on'); return; } renderPick(); pick.classList.add('on'); };
  pick.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('[data-t]'); if (!b) return;
    pick.classList.remove('on');
    const id = b.dataset.t;
    onBreakdownRequested && onBreakdownRequested(id);
    ops.track(api.postEvent({ type: 'breakdown', tractor: id }), { els: bBreak });
  });
  document.addEventListener('click', () => pick.classList.remove('on'));

  return {
    /** Labels derive from state.clock, ignoring our own temporary slow-motion override. */
    sync(state) {
      const c = state.clock || {};
      const ended = !!c.ended;
      bPlay.textContent = ended ? 'Day over' : c.playing ? 'Pause' : 'Play';
      bPlay.disabled = ended;
      const speed = slowmo ? slowmo.restore : c.speed;
      bFast.textContent = speed > 1 ? 'Normal speed' : 'Skip to sunset';
      const g = gusty();
      bWind.textContent = g ? 'Calm the wind' : 'Wind gust';
      bWind.title = g ? 'Send weather_change: wind drops to 6 mph, away from sensitive areas' : 'Send weather_change: 14 mph gust toward a sensitive area (above the 10 mph spray limit)';
      // nothing happens after the workday ends (6:00 PM): no new breakdowns, road blocks or weather
      const over = ended || (c.t != null && c.day_minutes != null && c.t >= c.day_minutes);
      bWind.disabled = over || !state.weather;
      for (const b of [bBreak, bBlock, bHeat, bWind]) {
        b.disabled = over || (b === bWind && !state.weather);
        if (over) b.title = 'The workday is over (6:00 PM). Events can only happen during the day.';
        else if (b !== bWind && b.title === 'The workday is over (6:00 PM). Events can only happen during the day.') b.title = '';
      }
      if (over) pick.classList.remove('on');
      const cap = state.capacity, full = !!(cap && cap.max != null && cap.used >= cap.max);
      bAdd.disabled = full;
      bAdd.title = full ? `Fleet is full: ${cap.used} of ${cap.max} tractors. Remove one to add another.` : '';
    },
    /** Brief slow motion: speed 0.15 for ~1.7 s, then restore the speed captured before. */
    slowMotion(ms = 1700) {
      const c = st().clock || {};
      if (!c.playing || slowmo) return;
      slowmo = { restore: c.speed || 1 };
      api.setClock({ speed: 0.15 }).catch(() => {});
      setTimeout(() => {
        const r = slowmo ? slowmo.restore : 1; slowmo = null;
        api.setClock({ speed: r }).catch((err) => toast((err && err.message) || 'Could not restore speed', 'err'));
      }, ms);
    },
    get slowmo() { return !!slowmo; },
  };
}

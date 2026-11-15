// Weather UI (PROJECT.md Change 6 Part B, "Dashboard additions"): weather card in the side panel, glass wind
// compass on the stage, hatched no-spray bands + "Waiting for wind" pills on the timeline, and the 3D layer
// (wind particles, sensitive areas, spray mist). Reads ONLY store.get()/subscribe; owns its own rAF.
import './weather.css';
import { clock, esc } from '../lib/format.js';
import { timelineLayout, noSprayBands, sensitiveState, blockedRanges, windToward, compassShort } from '../lib/derive.js';
import { createWind } from '../scene/wind.js';
import { createSensitive } from '../scene/sensitive.js';
import { createMist } from '../scene/mist.js';

const LANE = 32; // must match ui/dock.js
const SPRAY_MAX = 10, SPRAY_MIN = 3; // display only; the rules live in the backend / data layer

const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l5.5 13.5L12 13.6 6.5 16.5z" fill="currentColor"/></svg>';
const WIND_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 6h8.2a2 2 0 1 0-2-2M1.5 10h11a2 2 0 1 1-2 2M1.5 8h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

/** value of the step-function forecast at t */
function wxAt(forecast, t) {
  let p = null;
  for (const q of forecast || []) if (q.t <= t + 1e-6) p = q;
  return p || (forecast && forecast[0]) || null;
}

export function createWeather({ store, world, farm, tractors, caps = () => ({}) }) {
  const stage = document.getElementById('stage');
  const side = document.querySelector('.side');
  const ctl = side && side.querySelector('.ctl');

  // ---------- weather card (side panel, after the controls) ----------
  const card = document.createElement('div');
  card.className = 'card wx-card'; card.setAttribute('aria-label', 'Weather');
  card.innerHTML =
    '<div class="wx-head"><p class="lbl">Weather</p><span class="wx-pill"></span></div>' +
    '<div class="wx-now">' +
      '<div class="wx-wind"><i class="wx-arrow">' + ARROW + '</i><b class="wx-mph">–</b><small>mph</small><span class="wx-from"></span></div>' +
      '<div class="wx-kv"><span>Temp</span><b class="wx-temp">–</b></div>' +
      '<div class="wx-kv"><span>Rain</span><b class="wx-rain">–</b></div>' +
    '</div>' +
    '<p class="wx-reason"></p>' +
    '<div class="wx-strip"><div class="wx-hours"></div><div class="wx-rows"></div><div class="wx-axis"></div></div>' +
    '<p class="wx-legend"><i class="wx-y"></i>Spray window<i class="wx-n"></i>No spraying</p>' +
    '<p class="wx-live" hidden></p>';
  if (ctl) ctl.after(card); else if (side) side.prepend(card);
  const $c = (s) => card.querySelector(s);
  const elPill = $c('.wx-pill'), elArrow = $c('.wx-arrow'), elMph = $c('.wx-mph'), elFrom = $c('.wx-from'), elTemp = $c('.wx-temp'), elRain = $c('.wx-rain');
  const elReason = $c('.wx-reason'), elHours = $c('.wx-hours'), elRows = $c('.wx-rows'), elAxis = $c('.wx-axis'), elLive = $c('.wx-live');

  // ---------- compass (glass, on the stage above the dock, right) ----------
  const comp = document.createElement('div');
  comp.id = 'wxcompass'; comp.className = 'gl'; comp.setAttribute('role', 'img');
  comp.innerHTML = '<div class="wx-dial"><span class="n">N</span><i class="wx-needle">' + ARROW + '</i></div><b>–</b><small>mph</small>';
  stage.appendChild(comp);
  const dial = comp.querySelector('.wx-dial'), needle = comp.querySelector('.wx-needle'), compMph = comp.querySelector('b');

  // ---------- 3D ----------
  const wind = createWind(world);
  const sens = createSensitive(world);
  const mist = createMist(world);
  const emitters = Array.from({ length: 16 }, () => ({ x: 0, z: 0, hd: 0 }));
  let sprayers = []; // tractor ids spraying right now
  const windNow = { x: 1, z: 0, mph: 0 };

  // ---------- timeline bands (inside the dock's lane wrapper) ----------
  const bandEls = [];
  function syncBands(state) {
    const wrap = document.getElementById('lanewrap'); if (!wrap) return;
    const L = timelineLayout(state);
    const D = (state.clock && state.clock.day_minutes) || 720;
    const bands = noSprayBands(state, L);
    let k = 0;
    L.lanes.forEach((ln, i) => {
      for (const [s, e] of bands.get(ln.id) || []) {
        let el = bandEls[k];
        if (!el) { el = document.createElement('div'); el.className = 'wx-band'; el.setAttribute('aria-hidden', 'true'); bandEls.push(el); }
        if (el.parentNode !== wrap) wrap.appendChild(el); // after the dock's pills: the hatch sits on top, clicks pass through
        el.style.top = (i * LANE) + 'px'; el.style.left = (s / D * 100) + '%'; el.style.width = Math.max(0.3, (e - s) / D * 100) + '%';
        el.title = 'No spraying ' + clock(s) + '–' + clock(e);
        el.style.display = '';
        k++;
      }
    });
    for (let i = k; i < bandEls.length; i++) bandEls[i].style.display = 'none';
    // "Waiting for wind" pills
    for (const p of L.pills) {
      const el = wrap.querySelector('.pill[data-job="' + CSS.escape(p.id) + '"]'); if (!el) continue;
      const wait = !!p.job.weather_blocked && !p.done;
      if (el.classList.contains('wx-wait') !== wait) {
        el.classList.toggle('wx-wait', wait);
        let tag = el.querySelector('.wx-tag');
        if (wait && !tag) { tag = document.createElement('em'); tag.className = 'wx-tag'; tag.innerHTML = WIND_ICON + 'Waiting for wind'; el.appendChild(tag); }
        if (tag) tag.hidden = !wait;
      }
    }
  }

  // ---------- card ----------
  let stripSig = '';
  function syncCard(state) {
    const wx = state.weather;
    card.hidden = !wx;
    comp.hidden = !wx;
    if (!wx) return;
    const cur = wx.current || {};
    const mph = Math.round(+cur.wind_mph || 0), toward = ((+cur.wind_from_deg || 0) + 180) % 360;
    const allowed = wx.spray_allowed_now || {};
    const ids = Object.keys(allowed);
    const okN = ids.filter((b) => allowed[b]).length;
    const reasons = Object.entries(wx.spray_blocked_reason || {});
    elMph.textContent = mph; compMph.textContent = mph;
    elFrom.textContent = 'from ' + compassShort(cur.wind_from_deg);
    elArrow.style.transform = 'rotate(' + toward + 'deg)';
    elTemp.textContent = cur.temp_f != null ? Math.round(cur.temp_f) + '°F' : '–';
    elRain.textContent = cur.rain_prob != null ? Math.round(cur.rain_prob) + '%' : '–';
    const state3 = okN === ids.length ? 'all' : okN === 0 ? 'none' : 'part';
    // Backend that does not enforce weather (capabilities.weatherEnforced false): say so, claim no spray verdict.
    const placeholder = caps().weatherEnforced === false;
    card.classList.toggle('wx-placeholder', placeholder);
    elPill.className = 'wx-pill ' + (placeholder ? 'part' : state3);
    elPill.textContent = placeholder ? 'Placeholder' : state3 === 'all' ? 'Spraying OK' : state3 === 'none' ? 'No spraying' : 'Spray OK on ' + okN + ' of ' + ids.length;
    // the most useful reason: a wind/temp/rain limit shared by every block, else the per-block sensitive-area ones
    let reason = '';
    if (reasons.length) {
      const first = reasons[0][1];
      reason = reasons.every(([, r]) => r === first) && reasons.length === ids.length ? first : reasons.map(([b, r]) => 'Block ' + b + ': ' + r).slice(0, 3).join(' · ');
    } else reason = 'Wind inside the ' + SPRAY_MIN + '–' + SPRAY_MAX + ' mph spray range';
    if (placeholder) reason = 'Placeholder weather — not used for spraying decisions';
    if (elReason.textContent !== reason) elReason.textContent = reason;
    elReason.className = 'wx-reason' + (reasons.length ? ' bad' : '');
    comp.classList.toggle('hi', mph > SPRAY_MAX);
    comp.setAttribute('aria-label', 'Wind ' + mph + ' mph from the ' + compassShort(cur.wind_from_deg));
    comp.dataset.toward = toward;

    // strip: hourly wind + per-block spray windows (only rebuilt when the weather or open spray jobs change)
    const D = (state.clock && state.clock.day_minutes) || 720;
    const open = new Set((state.jobs || []).filter((j) => j.implement === 'sprayer' && j.status !== 'done' && j.status !== 'dropped').map((j) => j.block));
    const sig = JSON.stringify([wx.forecast, wx.spray_windows, allowed, [...open], D]);
    if (sig !== stripSig) {
      stripSig = sig;
      let hours = '';
      for (let m = 0; m < D; m += 60) {
        const p = wxAt(wx.forecast, m + 30);
        const w = p ? Math.round(p.wind_mph) : null;
        const cls = w == null ? '' : w > SPRAY_MAX ? 'hi' : w < SPRAY_MIN ? 'lo' : '';
        hours += '<span class="' + cls + '" title="' + clock(m) + ': ' + (p ? w + ' mph from ' + compassShort(p.wind_from_deg) + ', ' + Math.round(p.temp_f) + '°F' : '') + '">' + (w == null ? '' : w) + '</span>';
      }
      elHours.innerHTML = hours;
      elRows.innerHTML = ids.map((b) => {
        const wins = (wx.spray_windows && wx.spray_windows[b]) || [];
        const seg = (cls, s, e) => '<i class="' + cls + '" style="left:' + (s / D * 100) + '%;width:' + ((e - s) / D * 100) + '%"></i>';
        const bar = wins.map(([s, e]) => seg('wx-y', s, e)).join('') + blockedRanges(wins, D).map(([s, e]) => seg('wx-n', s, e)).join('');
        const label = allowed[b] ? 'Spraying allowed now' : (wx.spray_blocked_reason && wx.spray_blocked_reason[b]) || 'Spraying not allowed now';
        const winTxt = wins.length ? 'Windows ' + wins.map(([s, e]) => clock(s) + '–' + clock(e)).join(', ') : 'No spray window today';
        return '<div class="wx-row' + (open.has(b) ? ' job' : '') + '" title="Block ' + esc(b) + ': ' + esc(label) + '. ' + esc(winTxt) + '"><span>' + esc(b) + '</span><div class="bar">' + bar + '<u></u></div><em class="' + (allowed[b] ? 'wx-y' : 'wx-n') + '"></em></div>';
      }).join('');
      elAxis.innerHTML = ['6a', '9a', '12p', '3p', '6p'].map((h, i) => '<span style="left:' + (i * 25) + '%">' + h + '</span>').join('');
    }
    const t = state.clock ? state.clock.t : 0;
    const nowPct = Math.max(0, Math.min(100, t / D * 100)) + '%';
    elRows.querySelectorAll('.bar u').forEach((u) => { u.style.left = nowPct; });

    const lc = wx.live_conditions;
    elLive.hidden = !lc;
    if (lc) elLive.textContent = 'Live conditions, Queen Creek' + (lc.source ? ' (' + lc.source + ')' : '') + ': ' + Math.round(+lc.wind_mph || 0) + ' mph from ' + compassShort(lc.wind_from_deg) + ', ' + Math.round(+lc.temp_f || 0) + '°F, rain ' + Math.round(+lc.rain_prob || 0) + '%';
  }

  // ---------- store ----------
  let dirty = true, lastSync = 0;
  function syncScene(state) {
    const cur = state.weather && state.weather.current;
    wind.setWeather(cur);
    if (cur) { const v = windToward(cur.wind_from_deg); windNow.x = v.x; windNow.z = v.z; windNow.mph = +cur.wind_mph || 0; }
    sens.sync(farm.grid, sensitiveState(state));
    const jobs = state.jobs || [];
    sprayers = (state.fleet || []).filter((tr) => tr.status === 'working' && tr.current_job && (jobs.find((j) => j.id === tr.current_job) || {}).implement === 'sprayer').map((tr) => tr.id);
  }
  store.subscribe((state, msg) => {
    if (msg && msg.type === 'snapshot') { mist.clear(); sens.clear(); }
    if (msg && (msg.type === 'poses' || msg.type === 'clock' || msg.type === 'log' || msg.type === 'metrics')) { dirty = dirty || msg.type === 'poses'; return; }
    dirty = true;
  });

  // ---------- frame loop ----------
  let last = performance.now(), compRot = null, needleRot = null;
  const _cam = { x: 0, z: 0 };
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const state = store.get() || {};
    if (dirty && now - lastSync > 150) {
      dirty = false; lastSync = now;
      syncScene(state); syncCard(state); syncBands(state);
    } else if (now - lastSync > 1000) { lastSync = now; syncCard(state); syncBands(state); }
    wind.tick(farm.grid, dt);
    sens.tick(now, dt);
    // mist emitters from the interpolated tractor meshes when available, else the last pose
    let n = 0;
    const grid = farm.grid;
    if (grid) for (const id of sprayers) {
      if (n >= emitters.length) break;
      const rec = tractors && typeof tractors.get === 'function' ? tractors.get(id) : null;
      const e = emitters[n];
      if (rec && rec.g) { e.x = rec.g.position.x; e.z = rec.g.position.z; e.hd = rec.g.rotation.y; n++; continue; }
      const tr = (state.fleet || []).find((x) => x.id === id);
      if (!tr || !tr.pose) continue;
      const w = grid.toWorld(tr.pose.x, tr.pose.y); e.x = w.x; e.z = w.z; e.hd = Math.PI - ((+tr.pose.heading_deg || 0) * Math.PI) / 180; n++;
    }
    mist.tick(emitters, n, windNow, dt);
    // compass: rotate so it matches the camera (screen-up = camera forward on the ground)
    const cam = world.cam, tg = world.ctl.target;
    _cam.x = tg.x - cam.position.x; _cam.z = tg.z - cam.position.z;
    const camBearing = (Math.atan2(_cam.x, -_cam.z) * 180) / Math.PI;
    const toward = +comp.dataset.toward || 0;
    const rot = Math.round(-camBearing * 2) / 2;
    if (rot !== compRot) { compRot = rot; dial.style.transform = 'rotate(' + rot + 'deg)'; }
    if (toward !== needleRot) { needleRot = toward; needle.style.transform = 'rotate(' + toward + 'deg)'; }
  }
  requestAnimationFrame(frame);

  return { get wind() { return wind; } };
}

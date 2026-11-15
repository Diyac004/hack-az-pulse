// Harvest Fleet AI dashboard: visual layer. Reads ONLY from the data layer (store/api/sourceInfo).
import './style.css';
import { start, store, api, sourceInfo, capabilities } from './data/index.js';
import { makeGrid, missingScenarioFields, blockedCells, islandMoment, timelineLayout } from './lib/derive.js';
import { clock, isDown, plural } from './lib/format.js';
import { createWorld } from './scene/world.js';
import { createFarm } from './scene/farm.js';
import { createFx } from './scene/fx.js';
import { createTractors } from './scene/tractors.js';
import { createBarriers } from './scene/barriers.js';
import { createVans } from './scene/van.js';
import { createLabels } from './scene/labels.js';
import { createIsland, createToast } from './ui/island.js';
import { createOps } from './ui/ops.js';
import { createPanel } from './ui/panel.js';
import { createDock } from './ui/dock.js';
import { createChips } from './ui/chips.js';
import { createSheets } from './ui/sheets.js';
import { createKeynote } from './ui/keynote.js';
import { createModeSwitch } from './ui/modeSwitch.js';
import { createControls } from './ui/controls.js';
import { createJobSheet } from './ui/jobSheet.js';
import { createLiveFeed } from './scene/livefeed.js';
import { createViewToggle } from './ui/viewToggle.js';
import { createWeather } from './ui/weather.js';
import { createControlPanel } from './ui/controlPanel.js';
import { createMapPick } from './scene/mapPick.js';
import { createAiPanel } from './ui/aiPanel.js';
import { createAiMapMarks } from './ui/aiMapMarks.js';
import { createAiDemo } from './ui/aiDemo.js';

const stage = document.getElementById('stage');
const world = createWorld(stage);
const farm = createFarm(world);
const fx = createFx(world);
const tractors = createTractors(world, farm, fx);
const barriers = createBarriers(world, farm);
const vans = createVans(world, farm);
const labels = createLabels(world, farm);
const toast = createToast();
const island = createIsland();
const ops = createOps({ store, api, toast });
const panel = createPanel({ caps: capabilities.get });
const keynote = createKeynote();
// Live feed (M8): second view of the same fleet (+ its coverage/trails/AB/readout/follow in the 3D view).
// Wraps world.focus/home/overview so they pan the map while it shows.
// Only the toggle may change the view ('user'); the choice survives page reloads (see lib/viewState.js).
const viewToggle = createViewToggle(stage, (v) => live.setView(v, 'user'));
/** One "Mark repaired" path for the chip button, the readout card and the booking toast; spinner per Operation. */
const markRepaired = (id, els) => ops.track(api.postEvent({ type: 'tractor_repaired', tractor: id }), { els: els || [] });
// Tractor Control Panel (M9b): opened from the readout card, a chip's controls button, or a timeline lane label.
let cockpit = null;
const openControls = (id) => cockpit && capabilities.get().controls !== false && cockpit.open(id);
const live = createLiveFeed({ stage, world, store, sourceInfo, toggle: viewToggle, dioramaTractors: tractors, onRepair: markRepaired, onControls: openControls });
const mapPick = createMapPick({ stage, world, getScenario: () => (store.get() || {}).scenario, view: () => live.pickView() });
live.setPickGuard(() => mapPick.active);
{ const setHeat0 = farm.setHeat; farm.setHeat = (b) => { setHeat0(b); live.setHeat(b); }; }

const blockWorld = (b) => {
  const g = farm.grid, blk = g && g.blockById[b]; if (!blk) return null;
  const c = g.blockCenter(blk), w = g.toWorld(c.x, c.y); return { x: w.x, z: w.z };
};
const focusBlock = (b) => { const v = blockWorld(b); if (v) world.focus(v, 2400, 1.5); };

let dock = null; // assigned below; sheets need dockPill lazily
const sheets = createSheets({
  store, api, ops, toast, island, focusBlock,
  dockPill: (id) => (dock ? dock.pillEl(id) : null),
  onBooked: (tr, bookT, arr) => { if (!vans.has(tr)) vans.dispatch(store.get(), tr, bookT, arr); },
  onRepair: markRepaired,
  caps: capabilities.get,
});
dock = createDock({ onPill: (id) => sheets.openWhy(id), onLane: openControls });
// chip click: fly to the tractor and open its readout card
const chips = createChips({ api, ops, onRepair: markRepaired, onControls: openControls, onFocus: (id) => { const p = tractors.worldPos(id); if (p) world.focus(p, 2400); live.select(id); } });
const controls = createControls({ store, api, ops, toast, world, sheets, caps: capabilities.get });
const jobSheet = createJobSheet({ store, api, ops, toast, sheets, caps: capabilities.get });
cockpit = createControlPanel({
  stage, store, api, ops, toast, mapPick,
  onOpen: (id) => { sheets.close(); stage.classList.add('cp-open'); const p = tractors.worldPos(id); if (p) world.focus(p, 2400); },
  onClose: () => stage.classList.remove('cp-open'),
});
// Features the connected backend lacks are hidden (data/capabilities.js); body classes drive the CSS.
capabilities.subscribe((c) => {
  const b = document.body.classList;
  b.toggle('cap-no-controls', c.controls === false);
  b.toggle('cap-no-mechanics', c.mechanics === false);
  if (c.controls === false && cockpit && cockpit.id && cockpit.close) cockpit.close();
});
// Never readout card + cockpit at once: while the cockpit is open the card is hidden (style.css) and tapping a
// tractor in 3D/Map switches the cockpit to it instead.
stage.addEventListener('hf:readout', (e) => { if (cockpit.id && e.detail && e.detail.id && e.detail.id !== cockpit.id) cockpit.open(e.detail.id); });
createWeather({ store, world, farm, tractors, caps: capabilities.get }); // M9a weather UI: card, compass, bands, wind/mist/sensitive areas
// AI Supervisor: side card + sheet (proposals the operator approves) and plot marks on the Map/3D view
const aiPanel = createAiPanel({ stage, store, api, ops, toast, sheets, focusBlock });
const aiMarks = createAiMapMarks({ stage, store, world, live });

// ---------- source badge ----------
const badge = document.getElementById('srcbadge');
const apiHost = (() => { try { return new URL(sourceInfo.api).host; } catch { return sourceInfo.api || ''; } })();
/** Live link problem worth saying out loud, or null: bad api= URL, or the backend was never reached. */
function linkProblem(state) {
  if (sourceInfo.kind !== 'live') return null;
  if (sourceInfo.error) return { badge: 'bad api URL', note: 'Live mode: bad api= URL', title: sourceInfo.error };
  const l = state && state.link;
  if (l && !l.connected && !l.everConnected && l.failures > 0) return { badge: 'no backend', note: "Can't reach " + apiHost + ' · retrying', title: "Can't reach " + sourceInfo.api + ' (WebSocket ' + l.url + '). Retrying with backoff.' };
  return null;
}
// Mock | Live switch (ui/modeSwitch.js) in place of the old MOCK/LIVE badge; same status colours and problems.
const modeSwitch = createModeSwitch({ el: badge, sourceInfo, caps: capabilities.get, linkProblem });
function renderBadge(state) { modeSwitch.sync(state); }
let probToasted = false;
function noteProblem(state) {
  const prob = linkProblem(state);
  if (!prob || probToasted || sourceInfo.error) return prob;
  if (state.link && state.link.failures >= 2) {
    probToasted = true;
    toast("Can't reach the backend at " + sourceInfo.api + '. Start it (backend/README.md), pick another address with ⋯, or use Switch to Mock. Retrying…', 'err');
  }
  return prob;
}

// ---------- per-run moment state ----------
let scenarioSig = null, prevStatus = new Map(), seenMoments = new Set(), keynoteShown = false;
let heat = new Set(), holdPendingUntil = 0, dirty = true, farmT = 0;

function heatBlocksFrom(state, facts) {
  const f = facts || {};
  const direct = f.blocks || (f.event && f.event.blocks);
  if (Array.isArray(direct) && direct.length) return direct;
  const jobs = state.jobs || [];
  const ids = [].concat(f.jobs || [], f.raised || [], (f.reprioritized || []).map((m) => m.job || m));
  let blocks = jobs.filter((j) => ids.includes(j.id)).map((j) => j.block);
  if (!blocks.length) blocks = jobs.filter((j) => j.type === 'spray' && j.priority === 3 && j.status !== 'done').map((j) => j.block);
  return [...new Set(blocks.filter(Boolean))];
}

function ensureScenario(state) {
  const sc = state.scenario;
  const sig = JSON.stringify(sc ? { g: sc.grid, r: sc.roads, b: sc.blocks, d: sc.depot } : null);
  if (sig === scenarioSig) return false;
  scenarioSig = sig;
  const miss = missingScenarioFields(sc);
  if (miss.length) console.warn('[dashboard] scenario missing ' + miss.join(', ') + '; using fallback layout for those fields');
  farm.build(makeGrid(sc));
  tractors.clear(); barriers.clear(); vans.clear(); labels.clear();
  world.resize();
  return true;
}

/** Rebuild the scene from a snapshot. newRun=false (live reconnect / seq-gap resync of the SAME day) keeps the
 *  operator's UI context: open sheets, "Not now" dismissals, the keynote and moments already played. Scene
 *  objects are always cleared and re-synced, so nothing is duplicated. */
function fullReset(state, newRun = true) {
  const rebuilt = ensureScenario(state);
  fx.clear(); tractors.clear(); barriers.clear(); vans.clear(); labels.clear();
  if (newRun || rebuilt) {
    sheets.reset(); keynote.hide(); island.reset(); panel.resetBaseline();
    seenMoments = new Set(); keynoteShown = false;
  }
  heat = new Set(); farm.setHeat([]);
  prevStatus = new Map((state.fleet || []).map((t) => [t.id, t.status]));
  holdPendingUntil = 0;
  farmT = state.clock ? state.clock.t : 0;
  tractors.sync(state, true);
  barriers.sync(blockedCells(state), true);
  // restore heat glow if a heat alert already happened this run
  if ((state.log || []).some((e) => e && e.kind === 'event' && e.type === 'heat_alert')) {
    heat = new Set(heatBlocksFrom(state, null)); farm.setHeat([...heat]);
  }
  panel.seed(state);
  dirty = true;
}

function breakdownMoment(tr) {
  const key = 'bd:' + tr.id + '@' + Math.round(farmT);
  if (seenMoments.has(key)) return;
  seenMoments.add(key);
  const p = tractors.worldPos(tr.id);
  if (p) { fx.ripple(p, '#FF453A'); setTimeout(() => fx.ripple(p, '#FF453A'), 350); world.focus(p, 2600); }
  controls.slowMotion(1700);
  holdPendingUntil = performance.now() + 2600; // let the moment play before the mechanic sheet
}

function onMessage(state, msg) {
  if (!msg) { dirty = true; return; }
  const prevT = farmT;
  if (typeof msg.t === 'number' && isFinite(msg.t)) farmT = msg.t;
  const type = msg.type;
  if (type === 'connection') { dirty = true; return; }
  // A snapshot whose clock went backwards is a new day (POST /run, or a restarted backend); same/later t is a
  // reconnect or resync of the day already on screen.
  if (type === 'snapshot') { fullReset(state, !state.clock || state.clock.t + 0.5 < prevT || prevT === 0); return; }
  if (type === 'poses' || type === 'fleet') {
    tractors.sync(state, false);
    for (const tr of state.fleet || []) {
      const prev = prevStatus.get(tr.id);
      if (prev !== undefined && prev !== tr.status && tr.status === 'broken' && !isDown(prev)) breakdownMoment(tr);
      if (prev !== undefined && prev !== tr.status && isDown(prev) && !isDown(tr.status) && tr.status !== 'repairing') {
        const p = tractors.worldPos(tr.id); if (p) fx.ripple(p, '#30D158');
      }
      prevStatus.set(tr.id, tr.status);
    }
    if (type === 'fleet') { const ids = new Set((state.fleet || []).map((t) => t.id)); for (const id of [...prevStatus.keys()]) if (!ids.has(id)) prevStatus.delete(id); }
  }
  if (type === 'log' && msg.data) {
    const e = msg.data;
    const m = islandMoment(e, state); if (m) island.moment(m);
    if (e.kind === 'mechanic_booked' && e.tractor) vans.dispatch(state, e.tractor, e.t ?? farmT, e.arrival_t, { from: e.from });
    if (e.kind === 'event' && e.type === 'heat_alert') {
      heat = new Set([...heat, ...heatBlocksFrom(state, e)]); farm.setHeat([...heat]);
      const v = heat.size ? blockWorld([...heat][0]) : null; if (v) world.focus(v, 2400);
    }
  }
  if (type === 'explanation' && msg.data) {
    panel.onExplanation(msg.data);
    if (msg.data.trigger === 'heat_alert') {
      heat = new Set([...heat, ...heatBlocksFrom(state, msg.data.facts)]); farm.setHeat([...heat]);
    }
  }
  if (type === 'scenario' || type === 'log' || type === 'plan' || type === 'snapshot') {
    const added = barriers.sync(blockedCells(state), false);
    if (added.length && farm.grid) { const w = farm.grid.toWorld(added[0][0], added[0][1]); world.focus({ x: w.x, z: w.z }, 2200); }
  }
  if (type === 'scenario') ensureScenario(state);
  // The timeline redraws on every plan/jobs message itself, not only from the animation loop: when the clock is
  // paused, or the loop is throttled (background tab, slow frames), a re-plan must still show up at once.
  if ((type === 'plan' || type === 'jobs' || type === 'fleet') && !timelineQueued) {
    timelineQueued = true;
    queueMicrotask(() => { timelineQueued = false; const s = store.get() || {}; dock.sync(s); dock.badge(s, ops.active(s)); chips.sync(s); });
  }
  dirty = true;
}
let timelineQueued = false;

// ---------- stage layout (sheets/toast/keynote avoid the dock and chips) ----------
const dockEl = document.getElementById('dock'), chipsEl = document.getElementById('chips'), islandEl = document.getElementById('island');
let layoutKey = '';
function stageBounds() {
  const r = stage.getBoundingClientRect();
  const chipsB = Math.max(islandEl.getBoundingClientRect().bottom, chipsEl.children.length ? chipsEl.getBoundingClientRect().bottom : 0) - r.top + 8;
  const dockT = dockEl.getBoundingClientRect().top - r.top - 36; // room for the tray / plan badge above the dock
  return { top: Math.round(chipsB), bottom: Math.round(dockT), dockh: Math.round(r.bottom - dockEl.getBoundingClientRect().top - 10) };
}
function syncLayout() {
  const b = stageBounds();
  const open = sheets.openEl();
  const toastB = open ? Math.round(stage.getBoundingClientRect().bottom - open.getBoundingClientRect().top + 8) : b.dockh + 44;
  const key = b.top + '|' + b.dockh + '|' + toastB;
  if (key === layoutKey) return;
  layoutKey = key;
  stage.style.setProperty('--dockh', b.dockh + 'px');
  stage.style.setProperty('--chipsb', b.top + 'px');
  stage.style.setProperty('--toastb', toastB + 'px');
}
// #stage is overflow:hidden but still scrollable by focus()/scrollIntoView; it must never move.
stage.addEventListener('scroll', () => { if (stage.scrollTop || stage.scrollLeft) { stage.scrollTop = 0; stage.scrollLeft = 0; } });

// ---------- throttled DOM sync ----------
let lastSync = 0;
function syncUI(state, now) {
  renderBadge(state);
  noteProblem(state);
  const L = dock.sync(state);
  dock.badge(state, ops.active(state));
  chips.sync(state);
  panel.sync(state);
  controls.sync(state);
  jobSheet.sync(state);
  cockpit.sync(state);
  aiPanel.sync(state);
  labels.sync(state, L.unassigned.map((j) => j.id));
  vans.sync(state);
  sheets.sync(state, now > holdPendingUntil && !keynoteOpen());
  syncLayout();
  const c = state.clock;
  if (c && !keynoteShown && (c.ended || (c.day_minutes && c.t >= c.day_minutes))) {
    keynoteShown = true;
    sheets.close(); syncLayout();
    keynote.show(state, stageBounds(), { ...panel.shown(), caps: capabilities.get() }); world.overview(4000);
    const done = (state.jobs || []).filter((j) => j.status === 'done').length;
    island.moment({ text: 'Day complete · ' + plural(done, 'job') + ' done', dot: '#30D158', sticky: true });
  }
}

function keynoteOpen() { const k = document.getElementById('key'); return !!(k && k.classList.contains('on')); }

// ---------- render loop ----------
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const state = store.get() || {};
  const D = (state.clock && state.clock.day_minutes) || 720;
  world.sky(farmT / D);
  farm.tick(now);
  tractors.tick(state, now, dt);
  barriers.tick(now);
  vans.tick(Object.assign({}, state, { clock: Object.assign({}, state.clock || {}, { t: farmT }) }), now);
  fx.tick(now, dt);
  if (now - lastSync > 200 || (dirty && now - lastSync > 100)) { lastSync = now; dirty = false; syncUI(state, now); }
  island.tick(state, now, (linkProblem(state) || {}).note);
  live.tick(now);
  aiMarks.tick(now);
  if (live.simVisible) world.render(now); // diorama isn't drawn while the Live feed fully covers it
}

// ---------- boot ----------
renderBadge(store.get());
store.subscribe(onMessage);
requestAnimationFrame(loop);
Promise.resolve()
  .then(() => start())
  .then(() => { const s = store.get(); if (s) fullReset(s); })
  .catch((err) => { console.warn('[dashboard] start failed:', (err && (err.code ? err.code + ' ' : '') + err.message) || err); toast('Could not load data: ' + ((err && err.message) || err), 'err'); });

// "▶ AI demo" (ui/aiDemo.js + data/demoScript.js): scripted walk through every agent, Mock / mock-backend only.
createAiDemo({ stage, store, api, ops, sourceInfo, capabilities, sheets, viewToggle });

// Debug handle for the console (read-only use).
window.__hf = { store, api, sourceInfo, world, ops, clock, timelineLayout, live, cockpit, mapPick };

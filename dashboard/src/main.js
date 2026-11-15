// Harvest Fleet AI dashboard: visual layer. Reads ONLY from the data layer (store/api/sourceInfo).
import './style.css';
import { start, store, api, sourceInfo } from './data/index.js';
import { makeGrid, missingScenarioFields, blockedCells, islandMoment, timelineLayout } from './lib/derive.js';
import { clock, isDown } from './lib/format.js';
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
import { createControls } from './ui/controls.js';

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
const panel = createPanel();
const keynote = createKeynote();

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
});
dock = createDock({ onPill: (id) => sheets.openWhy(id) });
const chips = createChips({ api, ops, onFocus: (id) => { const p = tractors.worldPos(id); if (p) world.focus(p, 2400); } });
const controls = createControls({ store, api, ops, toast, world, sheets });

// ---------- source badge ----------
const badge = document.getElementById('srcbadge');
function renderBadge(state) {
  const kind = (sourceInfo && sourceInfo.kind) || 'mock';
  const down = state && state.connected === false;
  badge.className = 'gl ' + (down ? 'down' : kind);
  badge.innerHTML = '<i></i>' + (kind === 'live' ? 'LIVE' : 'MOCK') + (down ? ' · reconnecting' : '');
  badge.title = kind === 'live' ? 'Live backend' + (sourceInfo.api ? ' · ' + sourceInfo.api : '') : 'In-browser mock data source (?source=live to switch)';
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

function fullReset(state) {
  ensureScenario(state);
  fx.clear(); tractors.clear(); barriers.clear(); vans.clear(); labels.clear();
  sheets.reset(); keynote.hide(); island.reset();
  heat = new Set(); farm.setHeat([]);
  seenMoments = new Set();
  prevStatus = new Map((state.fleet || []).map((t) => [t.id, t.status]));
  keynoteShown = false; holdPendingUntil = 0;
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
  if (typeof msg.t === 'number' && isFinite(msg.t)) farmT = msg.t;
  const type = msg.type;
  if (type === 'snapshot') { fullReset(state); return; }
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
  dirty = true;
}

// ---------- throttled DOM sync ----------
let lastSync = 0;
function syncUI(state, now) {
  renderBadge(state);
  const L = dock.sync(state);
  dock.badge(state, ops.active(state));
  chips.sync(state);
  panel.sync(state);
  controls.sync(state);
  labels.sync(state, L.unassigned.map((j) => j.id));
  vans.sync(state);
  sheets.sync(state, now > holdPendingUntil);
  const c = state.clock;
  if (c && !keynoteShown && (c.ended || (c.day_minutes && c.t >= c.day_minutes))) {
    keynoteShown = true;
    keynote.show(state); world.overview(4000);
    const done = (state.jobs || []).filter((j) => j.status === 'done').length;
    island.moment({ text: 'Day complete · ' + done + ' job' + (done === 1 ? '' : 's') + ' done', dot: '#30D158', sticky: true });
  }
}

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
  island.tick(state, now);
  world.render(now);
}

// ---------- boot ----------
renderBadge({ connected: true });
store.subscribe(onMessage);
requestAnimationFrame(loop);
Promise.resolve()
  .then(() => start())
  .then(() => { const s = store.get(); if (s) fullReset(s); })
  .catch((err) => { console.error(err); toast('Could not load data: ' + ((err && err.message) || err), 'err'); });

// Debug handle for the console (read-only use).
window.__hf = { store, api, sourceInfo, world, ops, clock, timelineLayout };

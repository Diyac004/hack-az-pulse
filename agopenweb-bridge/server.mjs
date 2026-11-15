// AgOpenWeb bridge server: real AgOpenWeb tractors behind the dashboard contract (ARCHITECTURE.md §5, §6, §13).
//
//   node agopenweb-bridge/server.mjs            (run by absolute/relative path, not `node server.mjs` from inside
//                                                the folder, if other tools pkill "node server.mjs")
//   env: PORT=8040  MAX_TRACTORS=5  REAL_SLOTS=1  START_TRACTORS=3  KPH=12  PACE=10
//        AOW_IMAGE=agopenweb:headless  AOW_BASE_PORT=5174  AOW_MEMORY=512m  AOW_CPUS=2
//        AOW_ENDPOINTS=ws://hostA:5174/ws,ws://hostB:5174/ws   (use existing AgOpenWeb instances, no Docker)
//        DEMOTE_IDLE_S=20  COV_CELL_M=2  COVERAGE_COLOR=tractor|agopenweb
//
// Model
// - Tractors T1..Tn (no cap in code; MAX_TRACTORS is the configured compute limit -> AT_CAPACITY).
// - REAL_SLOTS AgOpenWeb containers ("slots"). A tractor bound to a slot is REAL: its pose/coverage/flags come
//   from that container's Tick/Coverage frames and every AgOpenWeb control is sent to that container.
//   Other tractors are SIMULATED by lib/blockpath.mjs (same passes and U-turn geometry AgOpenWeb drives).
//   REAL_SLOTS >= MAX_TRACTORS = full mode: one container per tractor, POST /fleet starts a container.
//   REAL_SLOTS < MAX_TRACTORS = hot-seat: a tractor is PROMOTED into a slot when an operation needs AgOpenWeb
//   (manual, any AgOpenWeb control) and DEMOTED back to the simulation when the slot is needed elsewhere.
// - `agopenweb` on each tractor is non-null ONLY while it is really in a container (honest UI chip).
// - Our coverage grid (COV_CELL_M squares, origin = farm NW corner, y grows south) owns history, so coverage
//   is continuous across promote/demote. Real cells: AgOpenWeb's 0.1 m cells aggregated into ours.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { AgOpenWebClient } from './client.mjs';
import { loadScenario, blockGeom } from './lib/farm.mjs';
import { makeBlockPath } from './lib/blockpath.mjs';
import { makeGridGeo, enToLatLon, latLonToEn, MPS_TO_MPH } from './lib/geo.mjs';
import { guardDecision } from './lib/guard.mjs';
import * as docker from './lib/docker.mjs';

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const PORT = +env('PORT', 8040);
const MAX_TRACTORS = +env('MAX_TRACTORS', 5);
const REAL_SLOTS = +env('REAL_SLOTS', 1);
const START_TRACTORS = Math.min(+env('START_TRACTORS', 3), MAX_TRACTORS);
const KPH = +env('KPH', 12);
const PACE = +env('PACE', 10);                 // farm minutes per real minute (clock display only)
const IMAGE = env('AOW_IMAGE', 'agopenweb:headless');
const BASE_PORT = +env('AOW_BASE_PORT', 5174);
const MEMORY = env('AOW_MEMORY', '512m');
const CPUS = env('AOW_CPUS', '2');
const ENDPOINTS = env('AOW_ENDPOINTS', '').split(',').map((s) => s.trim()).filter(Boolean);
const DEMOTE_IDLE_S = +env('DEMOTE_IDLE_S', 20);
const COV_CELL_M = +env('COV_CELL_M', 2);
const COVERAGE_COLOR = env('COVERAGE_COLOR', 'tractor');
const FULL_MODE = !ENDPOINTS.length && REAL_SLOTS >= MAX_TRACTORS;
const SLOT_LIMIT = ENDPOINTS.length || REAL_SLOTS;
const HOST_ID = 'local-docker';

const T0 = Date.now(), DAY0 = 120; // farm clock starts at 8:00
const nowT = () => +(DAY0 + ((Date.now() - T0) / 60000) * PACE).toFixed(2);
const log = (...a) => console.log(`[bridge ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scenario = loadScenario();
const geo = makeGridGeo(scenario.geo);
const COLORS = ['#0A84FF', '#BF5AF2', '#FF9F0A', '#30D158', '#FF375F', '#5E5CE6', '#64D2FF', '#FFD60A'];
const TOOL_WIDTH = { sprayer: 6, mower: 4.5, hedger: 3, bin_trailer: 2.5 };
const IMPL_TYPE = { sprayer: 'spray', mower: 'mow', hedger: 'hedge', bin_trailer: 'haul_bins' };
const IMPL_VERB = { sprayer: 'Spray', mower: 'Mow', hedger: 'Hedge', bin_trailer: 'Haul bins' };
const SEED = [
  { implements: ['sprayer'], block: 'A' }, { implements: ['mower', 'hedger'], block: 'B' }, { implements: ['sprayer', 'bin_trailer'], block: 'E' },
  { implements: ['mower'], block: 'F' }, { implements: ['sprayer'], block: 'C' }, { implements: ['hedger'], block: 'G' },
  { implements: ['sprayer'], block: 'D' }, { implements: ['mower'], block: 'H' },
];
const SPEED_MPS = KPH / 3.6;

// ===================================================================== state
const tractors = new Map();  // id -> tractor
const jobs = new Map();      // id -> job
const slots = [];            // AgOpenWeb containers / endpoints
const logLines = [];         // newest last
const operations = new Map();
let opSeq = 0, jobSeq = 0, planVersion = 1, colorIdx = 0;
const covOwner = new Map();  // coarse cell key -> tractor id (dedupe; first painter wins)
const covPending = new Map(); // tractor id -> [[x, y, rgb], ...] not yet broadcast
const covFine = new Map();   // `${tid}|${key}` -> fine-cell count (real cells aggregation)
const COV_ORIGIN = geo.toLatLon(-0.5, -0.5); // farm NW corner
const covW = Math.ceil((scenario.grid.width * geo.cellM) / COV_CELL_M), covH = Math.ceil((scenario.grid.height * geo.cellM) / COV_CELL_M);
const FINE_THRESHOLD = 0.35;

// ===================================================================== WS hub
const clients = new Set();
function sendTo(c, type, data) { if (c.ws.readyState !== 1) return; c.seq++; c.ws.send(JSON.stringify({ type, t: nowT(), seq: c.seq, data })); }
function broadcast(type, data) { for (const c of clients) sendTo(c, type, data); }

function addLog(entry) {
  const e = { t: nowT(), ...entry };
  logLines.push(e);
  if (logLines.length > 500) logLines.shift();
  broadcast('log', e);
  return e;
}

// ===================================================================== contract shapes
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r6 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e7) / 1e7);

function tractorOut(tr) {
  const p = tr.pose;
  const g = p ? geo.toGrid(p.lat, p.lon) : null;
  return {
    id: tr.id, name: tr.name, color: tr.color, implements: tr.implements.slice(), status: tr.status, manual: tr.manual,
    fuel_pct: r1(tr.fuel),
    pose: p ? { x: Math.round(g.x * 100) / 100, y: Math.round(g.y * 100) / 100, lat: r6(p.lat), lon: r6(p.lon), heading_deg: r1(p.heading), speed_mph: r1(p.speed * MPS_TO_MPH) } : null,
    tool: tr.tool ? { lat: r6(tr.tool.lat), lon: r6(tr.tool.lon), heading_deg: r1(tr.tool.heading), width_m: tr.tool.width } : null,
    current_job: tr.job && jobs.get(tr.job) && jobs.get(tr.job).status !== 'done' ? tr.job : null,
    queue: [], available_from_t: tr.availableFrom ?? null, host: tr.slot ? tr.slot.host : 'bridge-sim',
    agopenweb: agopenwebOut(tr),
  };
}
function agopenwebOut(tr) {
  const s = tr.slot;
  if (!s || !s.client || s.tractorId !== tr.id) return null; // simulated right now: honest null
  const st = s.client.status();
  return {
    endpoint: s.url, connected: st.connected, heartbeat_age_ms: st.heartbeat_age_ms,
    autosteer: st.autosteer, section_master: st.section_master, youturn: st.youturn,
    // extensions (not in §4): proof-of-life + guidance detail
    real: true, slot: s.index, container: s.name || null, tick_age_ms: st.tick_age_ms, field: st.field,
    cross_track_error_m: s.client.tick ? r1(s.client.tick.crossTrackError * 100) / 100 : null,
    sections: s.client.tick ? s.client.tick.sections.slice() : [], has_control: st.has_control,
  };
}
const poseOut = (tr) => { const o = tractorOut(tr); return { id: o.id, status: o.status, manual: o.manual, pose: o.pose, tool: o.tool, fuel_pct: o.fuel_pct, current_job: o.current_job, agopenweb: o.agopenweb }; };

function jobOut(j) {
  const tr = tractors.get(j.tractor);
  const remaining = Math.max(0, j.duration_min * (1 - j.progress));
  return {
    id: j.id, type: j.type, label: j.label, implement: j.implement, block: j.block, duration_min: r1(j.duration_min),
    remaining_min: r1(remaining), progress: Math.round(j.progress * 1000) / 1000, priority: j.priority, deadline_t: j.deadline_t,
    status: j.status, tractor: tr ? tr.id : null, start_t: j.start_t, end_t: j.status === 'done' ? j.end_t : r1(nowT() + remaining), eta_t: r1(j.status === 'done' ? j.end_t : nowT() + remaining),
    weather_blocked: false, pinned_to: null, unassigned_reason: null,
  };
}
function planOut() {
  const entries = [...jobs.values()].filter((j) => j.tractor).map((j) => { const o = jobOut(j); return { tractor: j.tractor, job: j.id, kind: 'work', start_t: o.start_t, end_t: o.end_t, route: [] }; });
  return { version: planVersion, entries, solver: 'greedy', solve_ms: 0, solver_status: 'feasible', diff: { moved: [], retimed: [], dropped: [], added: [] } };
}
function metricsOut() {
  const js = [...jobs.values()], done = js.filter((j) => j.status === 'done');
  const run = { jobs_total: js.length, completed: done.length, on_time: done.filter((j) => j.end_t <= j.deadline_t).length, travel_min: 0, idle_min: 0, violations: 0,
    weighted_on_time: null, productive_min: null, original_deadline_on_time: null, replan_ms_last: null, rejected_candidates: null };
  const nul = Object.fromEntries(Object.keys(run).map((k) => [k, null]));
  return { ours: run, baseline: nul, baseline_source: null };
}
function weatherOut() {
  const ids = scenario.blocks.map((b) => b.id);
  return { current: { wind_mph: 4, wind_from_deg: 200, temp_f: 84, rain_prob: 0 }, forecast: [],
    spray_allowed_now: Object.fromEntries(ids.map((i) => [i, true])), spray_blocked_reason: {},
    spray_windows: Object.fromEntries(ids.map((i) => [i, [[0, 720]]])), live_conditions: null };
}
function capacityOut() {
  const real = slots.filter((s) => s.tractorId).length;
  return { used: tractors.size, max: MAX_TRACTORS,
    hosts: [{ id: HOST_ID, docker: ENDPOINTS.length ? 'remote' : 'local', tractors: real, max_tractors: SLOT_LIMIT, cpu_pct: hostCpu, online: slots.some((s) => s.client && s.client.connected) }],
    warm: slots.filter((s) => s.ready && !s.tractorId).length };
}
const clockOut = () => ({ t: nowT(), playing: true, speed: 1, day_minutes: 720, mode: 'ours', ended: false });
const opsOut = () => [...operations.values()].sort((a, b) => b.created_t - a.created_t).slice(0, 20);
function snapshot() {
  return { clock: clockOut(), scenario, fleet: [...tractors.values()].map(tractorOut), jobs: [...jobs.values()].map(jobOut), plan: planOut(),
    explanations: explanations.slice(0, 10), metrics: metricsOut(), weather: weatherOut(), pending: [], capacity: capacityOut(),
    log_tail: logLines.slice(-20).reverse(), operations: opsOut() };
}
const explanations = [{ id: 'X1', t: DAY0, trigger: 'run',
  text: FULL_MODE
    ? `Bridge mode: every tractor is its own headless AgOpenWeb container (up to ${MAX_TRACTORS}); poses, coverage and autosteer state come from AgOpenWeb.`
    : `Bridge mode: ${SLOT_LIMIT} real AgOpenWeb ${SLOT_LIMIT === 1 ? 'container drives' : 'containers drive'} tractors on demand; the others follow the same passes in our lightweight simulation until an operator needs them in AgOpenWeb.`,
  facts: { event: null, moved: [], deadlines_missed: [], travel_delta_min: null, idle_delta_min: null, real_slots: SLOT_LIMIT, max_tractors: MAX_TRACTORS }, plan_version: 1 }];

function newOperation(kind, source, message) {
  const op = { id: `O${++opSeq}`, kind, status: 'queued', source, created_t: nowT(), updated_t: nowT(), message, plan_version: null, solver_status: null, result: null, error: null };
  operations.set(op.id, op); broadcast('operation', op); return op;
}
function updateOperation(op, patch) { Object.assign(op, patch, { updated_t: nowT() }); broadcast('operation', op); }

// ===================================================================== coverage (our grid)
function covKeyFromLatLon(lat, lon) {
  const f = geo.toFarmM(lat, lon);
  const cx = Math.floor((f.fx + geo.cellM / 2) / COV_CELL_M), cy = Math.floor((f.fy + geo.cellM / 2) / COV_CELL_M);
  if (cx < 0 || cy < 0 || cx >= covW || cy >= covH) return null;
  return [cx, cy];
}
const hexInt = (h) => parseInt(h.slice(1), 16);
function paintCell(tr, cx, cy, rgb) {
  const k = cx * 100000 + cy;
  if (covOwner.has(k)) return;
  covOwner.set(k, tr.id);
  if (!covPending.has(tr.id)) covPending.set(tr.id, []);
  covPending.get(tr.id).push([cx, cy, rgb]);
}
/** Simulated tractor: paint the coarse cells under the tool bar. */
function paintToolBar(tr, centerLat, centerLon, headingDeg, width) {
  const rad = (headingDeg * Math.PI) / 180, px = Math.cos(rad), py = -Math.sin(rad); // perpendicular (east,north) of heading
  const c = latLonToEn(geo.lat0, geo.lon0, centerLat, centerLon);
  const color = hexInt(tr.color);
  for (let w = -width / 2; w <= width / 2 + 1e-6; w += COV_CELL_M / 2) {
    const p = enToLatLon(geo.lat0, geo.lon0, c.e + px * w, c.n + py * w);
    const k = covKeyFromLatLon(p.lat, p.lon); if (k) paintCell(tr, k[0], k[1], color);
  }
}
/** Real tractor: AgOpenWeb fine cells (field-local) -> our coarse cells, painted once enough fine cells hit. */
function onRealCoverage(tr, slot, cells, init) {
  if (!init || !init.cellSize || !slot.client.origin) return;
  const o = slot.client.origin, cs = init.cellSize, need = FINE_THRESHOLD * (COV_CELL_M / cs) ** 2;
  for (const [x, y, rgb] of cells) {
    const p = enToLatLon(o.lat, o.lon, init.originE + (x + 0.5) * cs, init.originN + (y + 0.5) * cs);
    const k = covKeyFromLatLon(p.lat, p.lon); if (!k) continue;
    const kk = k[0] * 100000 + k[1];
    if (covOwner.has(kk)) continue;
    const fk = `${tr.id}|${kk}`, n = (covFine.get(fk) || 0) + 1;
    if (n >= need) { covFine.delete(fk); paintCell(tr, k[0], k[1], COVERAGE_COLOR === 'agopenweb' ? rgb : hexInt(tr.color)); tr.realCells++; } else covFine.set(fk, n);
  }
}
function coverageMsg(tid, cells) { return { tractor: tid, cell_m: COV_CELL_M, origin: { lat: r6(COV_ORIGIN.lat), lon: r6(COV_ORIGIN.lon) }, cells }; }

// ===================================================================== jobs + simulation
function makeJob(tr, blockId) {
  const impl = tr.implements[0], tw = TOOL_WIDTH[impl] || 3;
  const geom = blockGeom(scenario, blockId, { toolWidth: tw });
  const path = makeBlockPath(geom, tw);
  const id = `J${++jobSeq}`;
  const j = { id, type: IMPL_TYPE[impl], label: `${IMPL_VERB[impl]} ${blockId}`, implement: impl, block: blockId,
    duration_min: (path.total / SPEED_MPS / 60) * PACE, progress: 0, priority: 2, deadline_t: 600, status: 'working',
    tractor: tr.id, start_t: nowT(), end_t: null, geom, path, s: 0, toolWidth: tw };
  jobs.set(id, j);
  tr.job = id;
  return j;
}
function freeBlock() {
  const busy = new Set([...jobs.values()].filter((j) => j.status !== 'done').map((j) => j.block));
  return scenario.blocks.map((b) => b.id).find((b) => !busy.has(b)) || scenario.blocks[tractors.size % scenario.blocks.length].id;
}
function setSimPose(tr, j) {
  const p = j.path.at(j.s), ll = j.geom.at(p.e, p.n);
  const back = j.geom.at(p.e - Math.sin((p.heading * Math.PI) / 180) * 1.8, p.n - Math.cos((p.heading * Math.PI) / 180) * 1.8);
  tr.pose = { lat: ll.lat, lon: ll.lon, heading: p.heading, speed: tr.simSpeed };
  tr.tool = { lat: back.lat, lon: back.lon, heading: p.heading, width: j.toolWidth };
  return p;
}
function finishJob(tr, j) {
  j.status = 'done'; j.progress = 1; j.end_t = nowT(); j.s = j.path.total;
  tr.status = 'idle'; tr.simSpeed = 0; tr.idleSince = Date.now();
  addLog({ kind: 'job_done', job: j.id, tractor: tr.id, on_time: j.end_t <= j.deadline_t });
  if (tr.slot) tr.slot.client.stop().catch(() => {});
  jobsDirty.add(j.id);
}
const jobsDirty = new Set();

function simStep(dt) {
  for (const tr of tractors.values()) {
    const j = tr.job && jobs.get(tr.job);
    if (tr.slot) { realStep(tr, j); continue; }
    if (!j || j.status === 'done' || DOWN_STATUSES.includes(tr.status) || tr.manual) { if (tr.pose) tr.pose.speed = 0; continue; }
    const prev = j.path.at(j.s);
    j.s = Math.min(j.path.total, j.s + tr.simSpeed * dt);
    const p = setSimPose(tr, j);
    if (p.onPass && prev.onPass) paintToolBar(tr, tr.tool.lat, tr.tool.lon, p.heading, j.toolWidth);
    const prog = j.s / j.path.total;
    if (Math.floor(prog * 100) !== Math.floor(j.progress * 100)) jobsDirty.add(j.id);
    j.progress = prog;
    if (j.s >= j.path.total - 0.01) finishJob(tr, j);
  }
}

/** Geofence + deadman recovery for a real tractor (lib/guard.mjs explains why). */
function guardReal(tr, j, c, pose, t) {
  if (tr.guardBusy) return;
  const now = Date.now(), working = tr.status === 'working' && !!j && j.status !== 'done';
  const lost = !t.autosteer || !c.hasControl;
  if (!(working && !tr.manual && lost)) tr.lostSince = null; else if (tr.lostSince == null) tr.lostSince = now;
  const d = guardDecision({ g: geo.toGrid(pose.lat, pose.lon), grid: scenario.grid, speedMps: t.speed, working, manual: tr.manual, autosteer: !!t.autosteer, hasControl: c.hasControl, lostSince: tr.lostSince, now });
  if (d === 'geofence') {
    tr.guardBusy = true;
    addLog({ kind: 'agopenweb', tractor: tr.id, what: 'geofence', detail: { lat: pose.lat, lon: pose.lon, reason: 'left the farm; stopped, autosteer off, back to the simulation' } });
    log(`${tr.id} GEOFENCE: outside the farm at ${pose.lat.toFixed(6)},${pose.lon.toFixed(6)}; stopping and demoting`);
    c.send('control.acquire', c.name);
    demote(tr, 'geofence').catch((e) => log(`${tr.id} geofence demote failed: ${e.message}`)).finally(() => { tr.guardBusy = false; tr.lostSince = null; fleetDirty = true; });
  } else if (d === 'reengage' && (!tr.reengagedAt || now - tr.reengagedAt > 5000)) {
    tr.guardBusy = true; tr.reengagedAt = now;
    addLog({ kind: 'agopenweb', tractor: tr.id, what: 'reengage', detail: { autosteer: !!t.autosteer, has_control: c.hasControl } });
    log(`${tr.id} autosteer/control lost (deadman?); re-acquiring and re-engaging`);
    c.send('control.acquire', c.name);
    onSlot(tr.slot, () => c.resume({ speedKph: KPH })).catch((e) => log(`${tr.id} re-engage failed: ${e.message}`)).finally(() => { tr.guardBusy = false; });
  }
}

/** Real tractor: pose from the latest Tick; progress = projection of the real pose onto the block path. */
function realStep(tr, j) {
  if (tr.handingOff) return; // keep the last simulated pose until the container is on the job
  const c = tr.slot.client, t = c.tick, pose = c.pose();
  if (!t || !pose || pose.lat == null) return;
  tr.pose = { lat: pose.lat, lon: pose.lon, heading: pose.heading_deg, speed: t.speed };
  tr.tool = { lat: pose.tool.lat, lon: pose.tool.lon, heading: pose.tool.heading_deg, width: pose.tool.width_m || (j ? j.toolWidth : 3) };
  if (tr.status === 'starting') { tr.status = j && j.status !== 'done' ? 'working' : 'idle'; addLog({ kind: 'tractor_ready', tractor: tr.id }); fleetDirty = true; }
  guardReal(tr, j, c, pose, t);
  if (!j || j.status === 'done' || !c.origin || c.scene.fieldName !== j.geom.field) return;
  const en = latLonToEn(j.geom.origin.lat, j.geom.origin.lon, pose.lat, pose.lon);
  const pr = j.path.project(en.e, en.n, j.s);
  if (pr && pr.d < 6 && pr.s > j.s && pr.s - j.s < 60) { // monotone, no jumps
    j.s = pr.s;
    const prog = j.s / j.path.total;
    if (Math.floor(prog * 100) !== Math.floor(j.progress * 100)) jobsDirty.add(j.id);
    j.progress = prog;
  }
  // job finished: last pass driven to its end (AgOpenWeb has no next pass to turn onto)
  if (j.s >= j.path.total - 2 && !tr.manual) finishJob(tr, j);
}

// ===================================================================== slots (AgOpenWeb containers)
let hostCpu = null;
function makeSlot(index, url, name = null) {
  const s = { index, url, name, host: name ? HOST_ID : new URL(url.replace(/^ws/, 'http')).host, client: null, ready: false, tractorId: null,
    fields: new Set(), queue: Promise.resolve(), promotedAt: 0, lastUsed: 0, error: null };
  slots.push(s);
  return s;
}
/** Serialise all command sequences per slot (promotion, demotion, prewarm, controls). */
function onSlot(s, fn) { const p = s.queue.then(fn, fn); s.queue = p.catch(() => {}); return p; }

async function connectSlot(s) {
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) {
    try {
      const c = new AgOpenWebClient({ url: s.url, id: `slot${s.index}`, name: `FleetAI-bridge-slot${s.index}`, log: (m) => { if (!/presence|speedUp/.test(m)) log(m); } });
      await c.connect({ timeoutMs: 4000 });
      s.client = c; s.ready = true; s.error = null;
      c.on('coverage', ({ cells, init }) => { const tr = s.tractorId && tractors.get(s.tractorId); if (tr) onRealCoverage(tr, s, cells, init); });
      c.on('close', () => { s.ready = false; log(`slot ${s.index} disconnected`); fleetDirty = true; capDirty = true; if (!shuttingDown) setTimeout(() => reconnectSlot(s), 1000); });
      c.on('control', (st) => { if (st.held && st.holderId !== c.clientId) log(`slot ${s.index}: control taken by "${st.holderName}" (another client); AgOpenWeb commands from the bridge are now ignored`); });
      log(`slot ${s.index} connected to ${s.url} in ${Date.now() - t0} ms`);
      capDirty = true;
      return c;
    } catch (e) { s.error = e.message; await sleep(1000); }
  }
  throw new Error(`slot ${s.index}: could not connect to ${s.url}: ${s.error}`);
}
async function reconnectSlot(s) {
  if (shuttingDown || s.ready || s.removed) return;
  try { await connectSlot(s); const tr = s.tractorId && tractors.get(s.tractorId); if (tr) await onSlot(s, () => handoffToReal(tr, s)); } catch (e) { log(e.message); }
}

async function createSlot() {
  const index = slots.length;
  if (ENDPOINTS.length) return makeSlot(index, ENDPOINTS[index]);
  const name = `aow-bridge-${index + 1}`, port = BASE_PORT + index;
  const s = makeSlot(index, `ws://localhost:${port}/ws`, name);
  s.starting = (async () => {
    const t0 = Date.now();
    await docker.startContainer({ name, port, image: IMAGE, memory: MEMORY, cpus: CPUS });
    await connectSlot(s);
    s.bootMs = Date.now() - t0;
    log(`slot ${index}: container ${name} ready in ${s.bootMs} ms (port ${port})`);
  })();
  return s;
}

/** Create block fields in an unbound slot, so later promotions only need field.openOnly. */
function prewarm(s) {
  return onSlot(s, async () => {
    for (const b of scenario.blocks) {
      if (s.tractorId || shuttingDown) return;
      const g = blockGeom(scenario, b.id), name = g.field;
      if (s.fields.has(name)) continue;
      try { await s.client.openOrCreateField(name, { originLat: g.origin.lat, originLon: g.origin.lon, boundary: g.boundary, exists: false }); s.fields.add(name); }
      catch (e) { log(`prewarm ${name} on slot ${s.index}: ${e.message}`); }
    }
    log(`slot ${s.index} prewarmed: ${[...s.fields].join(', ')}`);
  });
}

/** Hand a tractor's current (simulated) state to an AgOpenWeb container. Runs inside onSlot. */
async function handoffToReal(tr, s) {
  const c = s.client, j = tr.job && jobs.get(tr.job), t0 = Date.now();
  if (j && j.status !== 'done') {
    const h = j.path.handoff(j.s);
    j.s = h.s;
    const start = j.geom.at(h.e, h.n);
    const field = j.geom.field;
    await c.openOrCreateField(field, { originLat: j.geom.origin.lat, originLon: j.geom.origin.lon, boundary: j.geom.boundary, exists: s.fields.has(field) ? true : false });
    s.fields.add(field);
    await c.setTool({ widthM: j.toolWidth, sections: 3 });
    c.configSet('uturn.radius', Math.max(3, j.toolWidth / 2)); c.configSet('uturn.distanceFromBoundary', 0.5);
    await c.setAutosteer(false);
    c.send('sim.stop');
    await c.setCoords(start.lat, start.lon, { tolMeters: 2 }).catch((e) => log(e.message));
    // sim.setCoords re-initialises the simulator heading to north; flip for southbound passes.
    if (!h.north) { c.send('sim.reverseDir'); await c.waitForTick((t) => Math.abs(t.heading - Math.PI) < 0.3, 2000, 'heading south').catch((e) => log(e.message)); }
    await c.setABLine(...(h.north ? h.ab : [h.ab[2], h.ab[3], h.ab[0], h.ab[1]]));
    const working = !tr.manual && !DOWN_STATUSES.includes(tr.status);
    await c.setSectionMaster(working);
    await c.setYouTurn(true);
    await c.setTurnDirection(h.turn);
    await c.setAutosteer(working);
    if (working) await c.setSpeedKph(KPH); else c.send('sim.stop');
    // ab = the pass centre the tractor drives (what the dashboard draws); ref_ab = the reference edge line we sent
    const center = h.north ? h.center : [h.center[2], h.center[3], h.center[0], h.center[1]];
    tr.guideAB = center;
    addLog({ kind: 'agopenweb', tractor: tr.id, what: 'job_started', detail: { field, ab: center, ref_ab: c.lastAB, pass: h.k, endpoint: s.url } });
  } else {
    // no job: park the real tractor where the sim had it
    if (tr.pose) await c.setCoords(tr.pose.lat, tr.pose.lon, { tolMeters: 3 }).catch(() => {});
    await c.setAutosteer(false); c.send('sim.stop');
  }
  return Date.now() - t0;
}

/** Bind tractor -> slot (demoting the slot's current tractor if needed). Returns promotion ms. */
async function promote(tr, reason = 'operator') {
  if (tr.slot) return 0;
  let s = slots.find((x) => x.ready && !x.tractorId);
  if (!s) { const booting = slots.find((x) => !x.ready && !x.tractorId && x.starting); if (booting) { await booting.starting; s = booting.ready && !booting.tractorId ? booting : null; } }
  if (!s && slots.length < SLOT_LIMIT) { s = await createSlot(); await s.starting; }
  if (!s) {
    const victims = slots.filter((x) => x.ready && x.tractorId && !tractors.get(x.tractorId)?.manual).sort((a, b) => a.lastUsed - b.lastUsed);
    if (!victims.length) {
      const e = new Error(`All ${SLOT_LIMIT} AgOpenWeb slot${SLOT_LIMIT === 1 ? ' is' : 's are'} held by tractors in manual control. Hand one back to the AI first.`);
      e.code = 'AT_CAPACITY'; e.status = 409; e.details = { real_slots: SLOT_LIMIT }; throw e;
    }
    s = victims[0];
    await demote(tractors.get(s.tractorId), `slot needed by ${tr.id}`, { warm: false });
  }
  const t0 = Date.now();
  s.tractorId = tr.id; tr.slot = s; s.promotedAt = Date.now(); s.lastUsed = Date.now();
  tr.handingOff = true;
  let handoffMs;
  try { handoffMs = await onSlot(s, () => handoffToReal(tr, s)); } finally { tr.handingOff = false; }
  const ms = Date.now() - t0;
  tr.lastPromoteMs = ms;
  promoteStats.push(ms);
  addLog({ kind: 'agopenweb', tractor: tr.id, what: 'promoted', detail: { endpoint: s.url, slot: s.index, reason, promote_ms: ms, handoff_ms: handoffMs, ab: tr.guideAB || null, ref_ab: s.client.lastAB } });
  log(`${tr.id} PROMOTED into slot ${s.index} (${reason}) in ${ms} ms`);
  fleetDirty = true; capDirty = true;
  return ms;
}
const promoteStats = [];

/** Read the real state back into the simulation and free the slot. */
async function demote(tr, reason = 'released', { warm = true } = {}) {
  const s = tr.slot;
  if (!s) return;
  await onSlot(s, async () => {
    const j = tr.job && jobs.get(tr.job);
    const pose = s.client.pose();
    if (j && pose && pose.lat != null) {
      const en = latLonToEn(j.geom.origin.lat, j.geom.origin.lon, pose.lat, pose.lon);
      const pr = j.path.project(en.e, en.n, j.s);
      if (pr && pr.s > j.s) j.s = pr.s;
      j.progress = j.s / j.path.total;
    }
    if (pose && pose.lat != null) tr.pose = { lat: pose.lat, lon: pose.lon, heading: pose.heading_deg, speed: 0 };
    await s.client.stop().catch(() => {});
    tr.simSpeed = tr.status === 'working' && !tr.manual ? SPEED_MPS : 0;
    s.tractorId = null; tr.slot = null;
    addLog({ kind: 'agopenweb', tractor: tr.id, what: 'demoted', detail: { endpoint: s.url, slot: s.index, reason, progress: j ? Math.round(j.progress * 1000) / 1000 : null } });
    log(`${tr.id} DEMOTED from slot ${s.index} (${reason})`);
  });
  fleetDirty = true; capDirty = true;
  if (!FULL_MODE && warm) prewarm(s);
}

// ===================================================================== fleet
async function addTractor(entry = {}) {
  if (tractors.size >= MAX_TRACTORS) {
    const e = new Error(`The fleet is at its configured limit of ${MAX_TRACTORS} tractors (MAX_TRACTORS). Add compute (another Docker host) or raise the limit.`);
    e.code = 'AT_CAPACITY'; e.status = 409; e.details = { max: MAX_TRACTORS }; throw e;
  }
  let n = tractors.size + 1; while (tractors.has(`T${n}`)) n++;
  const id = entry.id || `T${n}`;
  if (tractors.has(id)) { const e = new Error(`${id} already exists.`); e.code = 'CONFLICT'; e.status = 409; throw e; }
  const seed = SEED[(n - 1) % SEED.length];
  const tr = { id, name: entry.name || `Tractor ${id.slice(1)}`, color: COLORS[colorIdx++ % COLORS.length], implements: entry.implements?.length ? entry.implements.slice() : seed.implements.slice(),
    status: 'starting', manual: false, fuel: entry.fuel_pct ?? 80, pose: null, tool: null, job: null, slot: null, simSpeed: SPEED_MPS, realCells: 0, idleSince: null };
  tractors.set(id, tr);
  const j = makeJob(tr, freeBlock());
  setSimPose(tr, j);
  addLog({ kind: 'tractor_added', tractor: id, host: FULL_MODE ? HOST_ID : 'bridge-sim', endpoint: entry.endpoint || 'auto' });
  fleetDirty = true; capDirty = true; jobsDirty.add(j.id); planVersion++; planDirty = true;
  if (FULL_MODE || (tractors.size === 1 && SLOT_LIMIT > 0)) {
    promote(tr, FULL_MODE ? 'own container' : 'first tractor').catch((e) => { log(`${id}: ${e.message}`); tr.status = 'offline'; fleetDirty = true; });
  } else tr.status = 'working';
  return tr;
}
async function removeTractor(id) {
  const tr = tractors.get(id);
  if (!tr) throw httpErr(404, 'NOT_FOUND', `There is no tractor ${id}.`);
  tr.status = 'removing'; fleetDirty = true;
  const s = tr.slot;
  if (s) await demote(tr, 'tractor removed', { warm: !FULL_MODE });
  if (s && FULL_MODE && s.name) { s.removed = true; await s.client.close().catch(() => {}); await docker.stopContainer(s.name); slots.splice(slots.indexOf(s), 1); }
  const j = tr.job && jobs.get(tr.job);
  if (j && j.status !== 'done') { j.status = 'pending'; j.tractor = null; j.unassigned_reason = `${tr.name} was removed from the fleet.`; jobsDirty.add(j.id); }
  tractors.delete(id);
  addLog({ kind: 'tractor_removed', tractor: id });
  fleetDirty = true; capDirty = true;
}

// ===================================================================== controls (Change 8 subset that maps to AgOpenWeb)
const M = { needs_manual: true };
const C = (id, tab, label, type, o = {}) => ({ id, tab, label, type, min: o.min ?? null, max: o.max ?? null, step: o.step ?? null, unit: o.unit ?? null, options: o.options ?? null, needs_manual: !!o.needs_manual, replans: false, help: o.help ?? null, group: o.group ?? null });
const opt = (value, label) => ({ value, label });
const CONTROLS = [
  C('speed_up', 'Drive', 'Faster', 'button', { ...M, group: 'Speed', help: 'sim.speedUp (+0.5 km/h)' }),
  C('speed_down', 'Drive', 'Slower', 'button', { ...M, group: 'Speed', help: 'sim.speedDown (−0.5 km/h)' }),
  C('stop', 'Drive', 'Stop', 'button', { ...M, group: 'Speed', help: 'sim.stop' }),
  C('steer', 'Drive', 'Steering', 'slider', { ...M, group: 'Steering', min: -40, max: 40, step: 1, unit: 'deg', help: 'sim.setSteer' }),
  C('steer_reset', 'Drive', 'Center', 'button', { ...M, group: 'Steering', help: 'sim.steerReset' }),
  C('reverse', 'Drive', 'Reverse', 'button', { ...M, group: 'Steering', help: 'sim.reverseDir' }),
  C('place_here', 'Drive', 'Place here (debug)', 'map_pick', { ...M, group: 'Go somewhere', min: 1, max: 1, help: 'sim.setCoords' }),
  C('autosteer', 'Guidance', 'Autosteer', 'toggle', { ...M, group: 'Steering', help: 'autosteer.toggle (sent only when the Tick flag differs)' }),
  C('ab_line', 'Guidance', 'New AB line', 'map_pick', { ...M, group: 'AB line', min: 2, max: 2, help: 'track.latLonAB' }),
  C('ab_swap', 'Guidance', 'Swap A/B', 'button', { ...M, group: 'AB line', help: 'track.swapAB' }),
  C('nudge_left', 'Guidance', 'Nudge left', 'button', { ...M, group: 'Nudge', help: 'track.nudgeLeft' }),
  C('nudge_right', 'Guidance', 'Nudge right', 'button', { ...M, group: 'Nudge', help: 'track.nudgeRight' }),
  C('snap_left', 'Guidance', 'Snap left', 'button', { ...M, group: 'Nudge', help: 'track.snapLeft' }),
  C('snap_right', 'Guidance', 'Snap right', 'button', { ...M, group: 'Nudge', help: 'track.snapRight' }),
  C('youturn', 'Guidance', 'U-turns', 'toggle', { ...M, group: 'Turns', help: 'youturn.toggle' }),
  C('youturn_dir', 'Guidance', 'Turn direction', 'select', { ...M, group: 'Turns', options: [opt('left', 'Left'), opt('right', 'Right')], help: 'youturn.direction' }),
  C('section_master', 'Implement', 'Section control', 'select', { ...M, group: 'Sections', options: [opt('auto', 'Auto'), opt('manual', 'Manual')], help: 'section.master' }),
  C('num_sections', 'Implement', 'Sections', 'number', { group: 'Setup', min: 1, max: 16, step: 1, help: 'config.set tool.numSections' }),
  C('tool_width', 'Implement', 'Implement width', 'number', { group: 'Setup', min: 1, max: 24, step: 0.5, unit: 'm', help: 'config.set tool.defaultSectionWidth (cm) × sections' }),
  C('max_steer_angle', 'Vehicle', 'Max steer angle', 'number', { group: 'Steering', min: 10, max: 60, step: 1, unit: 'deg', help: 'config.set autosteer.maxSteerAngle' }),
  C('wheelbase', 'Vehicle', 'Wheelbase', 'number', { group: 'Vehicle', min: 1, max: 8, step: 0.05, unit: 'm', help: 'config.set vehicle.wheelbase' }),
  C('uturn_radius', 'Vehicle', 'U-turn radius', 'number', { group: 'U-turn shape', min: 2, max: 30, step: 0.5, unit: 'm', help: 'config.set uturn.radius' }),
  C('name', 'Fleet', 'Name', 'text', { group: 'Identity' }),
  C('color', 'Fleet', 'Color', 'select', { group: 'Identity', options: COLORS.map((c) => opt(c, c)) }),
  C('config', 'Advanced', 'config.set key:value', 'text', { group: 'Raw', help: 'Any AgOpenWeb config.set key (RemoteServerWiring.Helpers.cs), e.g. autosteer.proportionalGain:40' }),
];
const OURS = new Set(['name', 'color']);
function controlValues(tr) {
  const s = tr.slot, c = s && s.client, t = c && c.tick, sc = c && c.scene;
  const cv = tr.controlVals || (tr.controlVals = {});
  return { speed_up: null, speed_down: null, stop: null, steer: cv.steer ?? 0, steer_reset: null, reverse: null, place_here: null,
    autosteer: t ? !!t.autosteer : false, ab_line: c && c.lastAB ? [{ lat: c.lastAB[0], lon: c.lastAB[1] }, { lat: c.lastAB[2], lon: c.lastAB[3] }] : null, ab_swap: null,
    nudge_left: null, nudge_right: null, snap_left: null, snap_right: null, youturn: t ? !!t.youturn : false, youturn_dir: t ? (t.turnIsLeft ? 'left' : 'right') : null,
    section_master: t ? (t.sectionMaster ? 'auto' : 'manual') : null, num_sections: sc ? sc.toolSections.length : null, tool_width: sc ? sc.toolWidth : (jobs.get(tr.job)?.toolWidth ?? null),
    max_steer_angle: cv.max_steer_angle ?? null, wheelbase: cv.wheelbase ?? null, uturn_radius: cv.uturn_radius ?? null, name: tr.name, color: tr.color, config: null };
}
const pt = (v) => { const p = Array.isArray(v) ? v : [v]; return p.map((q) => (q && Number.isFinite(+q.lat) ? q : (q && Number.isFinite(+q.x) ? geo.toLatLon(+q.x, +q.y) : null))); };
async function applyControl(tr, id, value) {
  const def = CONTROLS.find((c) => c.id === id);
  if (!def) throw httpErr(400, 'INVALID_INPUT', `Unknown control "${id}".`, { control: id });
  if (def.needs_manual && !tr.manual) throw httpErr(409, 'NEEDS_MANUAL', `Take manual control of ${tr.name} first.`, { control: id });
  if (OURS.has(id)) { tr[id] = String(value); fleetDirty = true; return value; }
  if (!tr.slot) await promote(tr, `control ${id}`);
  const s = tr.slot, c = s.client; s.lastUsed = Date.now();
  const cv = tr.controlVals || (tr.controlVals = {});
  await onSlot(s, async () => {
    switch (id) {
      case 'speed_up': c.speedUp(); break;
      case 'speed_down': c.speedDown(); break;
      case 'stop': c.send('sim.stop'); break;
      case 'steer': c.setSteer(+value); cv.steer = +value; break;
      case 'steer_reset': c.steerReset(); cv.steer = 0; break;
      case 'reverse': c.send('sim.reverseDir'); break;
      case 'place_here': { const [p] = pt(value); if (!p) throw httpErr(400, 'INVALID_INPUT', 'Pick a point on the map.'); await c.setCoords(+p.lat, +p.lon, { tolMeters: 3 }).catch(() => {}); break; }
      case 'autosteer': await c.setAutosteer(!!value); break;
      case 'ab_line': { const p = pt(value); if (p.length < 2 || !p[0] || !p[1]) throw httpErr(400, 'INVALID_INPUT', 'An AB line needs two points.'); await c.setABLine(+p[0].lat, +p[0].lon, +p[1].lat, +p[1].lon);
        addLog({ kind: 'agopenweb', tractor: tr.id, what: 'ab_line', detail: { ab: c.lastAB, endpoint: s.url } }); break; }
      case 'ab_swap': c.send('track.swapAB'); break;
      case 'nudge_left': c.send('track.nudgeLeft'); break;
      case 'nudge_right': c.send('track.nudgeRight'); break;
      case 'snap_left': c.send('track.snapLeft'); break;
      case 'snap_right': c.send('track.snapRight'); break;
      case 'youturn': await c.setYouTurn(!!value); break;
      case 'youturn_dir': await c.setTurnDirection(value === 'left' ? 'left' : 'right'); break;
      case 'section_master': await c.setSectionMaster(value === 'auto' || value === true); break;
      case 'num_sections': await c.setTool({ widthM: c.scene.toolWidth, sections: Math.max(1, Math.round(+value)) }); break;
      case 'tool_width': await c.setTool({ widthM: +value, sections: c.scene.toolSections.length || 1 }); break;
      case 'max_steer_angle': c.configSet('autosteer.maxSteerAngle', +value); cv.max_steer_angle = +value; break;
      case 'wheelbase': c.configSet('vehicle.wheelbase', +value); cv.wheelbase = +value; break;
      case 'uturn_radius': c.configSet('uturn.radius', +value); cv.uturn_radius = +value; break;
      case 'config': { const m = /^\s*([\w.]+)\s*:\s*(.+)$/.exec(String(value || '')); if (!m) throw httpErr(400, 'INVALID_INPUT', 'Write it as key:value, e.g. autosteer.proportionalGain:40'); c.configSet(m[1], m[2].trim()); break; }
      default: break;
    }
  });
  addLog({ kind: 'operator_action', tractor: tr.id, control: id, old: null, new: value ?? null, replanned: false });
  fleetDirty = true;
  return value ?? null;
}

async function setManual(tr, on) {
  if (on) {
    if (!tr.slot) await promote(tr, 'manual control');
    tr.manual = true;
    await onSlot(tr.slot, async () => { await tr.slot.client.setAutosteer(false); tr.slot.client.send('sim.stop'); });
  } else {
    tr.manual = false;
    const j = tr.job && jobs.get(tr.job);
    if (tr.slot && j && j.status !== 'done') await onSlot(tr.slot, () => handoffToReal(tr, tr.slot)); // AI resumes the job from here
  }
  fleetDirty = true;
}

// ===================================================================== HTTP
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key', 'Access-Control-Max-Age': '600' };
const STATUS = { INVALID_INPUT: 400, NOT_FOUND: 404, CONFLICT: 409, AT_CAPACITY: 409, NEEDS_MANUAL: 409, GATEWAY_UNAVAILABLE: 503, NOT_IMPLEMENTED: 501, INTERNAL: 500 };
function httpErr(status, code, message, details = {}) { const e = new Error(message); Object.assign(e, { status, code, details }); return e; }
const notImpl = (what) => httpErr(501, 'NOT_IMPLEMENTED', `${what} is not supported by the AgOpenWeb bridge.`, { bridge: true });
function reply(res, status, body, type = 'application/json; charset=utf-8') { res.writeHead(status, { ...CORS, 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); }
async function readJson(req) { const ch = []; for await (const c of req) ch.push(c); const raw = Buffer.concat(ch).toString().trim(); if (!raw) return {}; try { return JSON.parse(raw); } catch { throw httpErr(400, 'INVALID_INPUT', 'The request body is not valid JSON.'); } }
const getTr = (id) => { const t = tractors.get(id); if (!t) throw httpErr(404, 'NOT_FOUND', `There is no tractor ${id}.`, { tractor: id }); return t; };

/** Run fn as an async Operation (§13.2): reply 202 now, finish over WS. */
function asOperation(kind, source, message, fn) {
  const op = newOperation(kind, source, message);
  (async () => {
    updateOperation(op, { status: 'running' });
    try { const result = await fn(); updateOperation(op, { status: 'succeeded', result: result ?? { applied_plan_version: planVersion, unassigned_job_ids: [] }, plan_version: planVersion, solver_status: 'feasible' }); }
    catch (e) { updateOperation(op, { status: 'failed', error: { code: e.code || 'INTERNAL', message: e.message, details: e.details || {} } }); }
  })();
  return { status: 202, body: op };
}

// Sample mechanic listings, same as dashboard/src/data/mockSource.js MECHANICS (nothing is booked for real).
const MECHANICS = [
  { id: 'M1', name: 'Sonoran Field Diesel', source: 'Google', distance_mi: 11.8, rating: 4.9, reviews: 212, mobile: true, ag_equipment: true, eta_min: 45, est_cost: 380, repair_min_estimate: 60, url: null, score: 0.93, recommended: true, reason: 'Only mobile ag specialist arriving within an hour' },
  { id: 'M2', name: 'Valley Ag Repair', source: 'BBB', distance_mi: 19.4, rating: 4.7, reviews: 98, mobile: true, ag_equipment: true, eta_min: 80, est_cost: 340, repair_min_estimate: 70, url: null, score: 0.81, recommended: false, reason: 'Cheapest ag specialist, but arrives later' },
  { id: 'M3', name: 'Pinal Tractor Works', source: 'Thumbtack', distance_mi: 23.1, rating: 4.8, reviews: 61, mobile: true, ag_equipment: false, eta_min: 95, est_cost: 410, repair_min_estimate: 65, url: null, score: 0.72, recommended: false, reason: 'Well rated, slowest to arrive' },
  { id: 'M4', name: 'Desert Heavy Equipment', source: 'Google', distance_mi: 16.2, rating: 4.5, reviews: 140, mobile: true, ag_equipment: false, eta_min: 70, est_cost: 460, repair_min_estimate: 80, url: null, score: 0.69, recommended: false, reason: 'Heavy diesel shop, not ag-specific' },
];
const DOWN_STATUSES = ['broken', 'awaiting_mechanic', 'repair_scheduled', 'repairing'];

const ROUTES = [
  ['GET', '/api/state', () => ({ body: snapshot() })],
  ['GET', '/api/scenario', () => ({ body: scenario })],
  ['GET', '/api/fleet', () => ({ body: [...tractors.values()].map(tractorOut) })],
  ['POST', '/api/fleet', async ({ body }) => ({ status: 202, body: { tractor: tractorOut(await addTractor(body)) } })],
  ['DELETE', '/api/fleet/:id', async ({ p }) => { getTr(p.id); await removeTractor(p.id); return { body: { ok: true } }; }],
  ['GET', '/api/hosts', () => ({ body: capacityOut() })],
  ['GET', '/api/jobs', () => ({ body: [...jobs.values()].map(jobOut) })],
  ['GET', '/api/weather', () => ({ body: weatherOut() })],
  ['GET', '/api/metrics', () => ({ body: metricsOut() })],
  ['GET', '/api/log', () => ({ body: logLines.map((l) => JSON.stringify(l)).join('\n') + '\n', type: 'text/plain; charset=utf-8' })],
  ['POST', '/api/clock', () => ({ body: clockOut() })],
  ['POST', '/api/run', () => asOperation('run', 'run', 'Restarting the jobs from the start.', async () => { for (const j of jobs.values()) { j.s = 0; j.progress = 0; j.status = j.tractor ? 'working' : 'pending'; jobsDirty.add(j.id); } covOwner.clear(); covFine.clear(); for (const tr of tractors.values()) { tr.status = 'working'; tr.simSpeed = SPEED_MPS; if (tr.slot) await onSlot(tr.slot, () => handoffToReal(tr, tr.slot)); } for (const c of clients) sendTo(c, 'snapshot', snapshot()); })],
  ['GET', '/api/tractors/:id/controls', ({ p }) => { const tr = getTr(p.id); return { body: { controls: CONTROLS, values: controlValues(tr) } }; }],
  ['POST', '/api/tractors/:id/control', async ({ p, body }) => { const tr = getTr(p.id); const v = await applyControl(tr, body.control, body.value); return { body: { ok: true, value: v, explanation: null } }; }],
  ['POST', '/api/tractors/:id/manual', ({ p, body }) => { const tr = getTr(p.id); const on = !!body.on; return asOperation('replan', 'manual', on ? `Taking manual control of ${tr.name}.` : `Handing ${tr.name} back to the AI.`, () => setManual(tr, on)); }],
  ['POST', '/api/tractors/:id/preview', () => { throw notImpl('Control preview'); }],
  ['POST', '/api/events', ({ body }) => {
    const tr = body.tractor ? getTr(body.tractor) : null;
    if (body.type === 'breakdown' && tr) return asOperation('replan', 'events', `${tr.name} broke down. Stopping it.`, async () => {
      tr.status = 'broken'; tr.simSpeed = 0; addLog({ kind: 'event', type: 'breakdown', tractor: tr.id, issue: body.issue || null });
      if (tr.slot) { await onSlot(tr.slot, () => tr.slot.client.stop()); addLog({ kind: 'agopenweb', tractor: tr.id, what: 'stopped', detail: { endpoint: tr.slot.url } }); }
      fleetDirty = true; });
    if (body.type === 'tractor_repaired' && tr) {
      if (!DOWN_STATUSES.includes(tr.status)) throw httpErr(409, 'CONFLICT', `${tr.name} is not down (${tr.status}).`, { status: tr.status });
      return asOperation('replan', 'events', `${tr.name} returned to service.`, async () => {
        const j = tr.job && jobs.get(tr.job), hasWork = !!(j && j.status !== 'done');
        tr.status = hasWork ? 'working' : 'idle'; tr.simSpeed = hasWork && !tr.manual ? SPEED_MPS : 0;
        tr.booking = null; tr.availableFrom = null; if (!hasWork) tr.idleSince = Date.now();
        addLog({ kind: 'tractor_repaired', tractor: tr.id });
        if (tr.slot && hasWork && !tr.manual) await onSlot(tr.slot, () => handoffToReal(tr, tr.slot));
        fleetDirty = true;
        return { applied_plan_version: planVersion, unassigned_job_ids: [], message: `${tr.name} back in service.` };
      });
    }
    throw notImpl(`Event "${body.type}"`);
  }],
  ['GET', '/api/operations/:id', ({ p }) => { const op = operations.get(p.id); if (!op) throw httpErr(404, 'NOT_FOUND', `No operation ${p.id}.`); return { body: op }; }],
  ['GET', '/api/bridge', () => ({ body: { mode: FULL_MODE ? 'full' : 'hot-seat', real_slots: SLOT_LIMIT, max_tractors: MAX_TRACTORS, promote_ms: promoteStats,
    slots: slots.map((s) => ({ index: s.index, url: s.url, container: s.name, ready: s.ready, tractor: s.tractorId, fields: [...s.fields], boot_ms: s.bootMs ?? null, frames: s.client ? s.client.frameCounts : null, decode_errors: s.client ? s.client.decodeErrors : null })),
    container_stats: lastStats } })],
  ['GET', '/api/why/:id', () => { throw notImpl('Why'); }],
  ['PATCH', '/api/jobs/:id', () => { throw notImpl('Job edits'); }],
  ['POST', '/api/jobs', () => { throw notImpl('Adding jobs'); }],
  ['GET', '/api/mechanics', ({ q }) => {
    const id = q.get('tractor');
    if (!id) throw httpErr(400, 'INVALID_INPUT', 'Say which tractor needs a mechanic (?tractor=T1).', { field: 'tractor' });
    const tr = getTr(id); addLog({ kind: 'mechanic_search', tractor: tr.id, results: MECHANICS.length });
    return { body: { options: MECHANICS.map((m) => ({ ...m })) } };
  }],
  ['POST', '/api/mechanics/book', ({ body }) => {
    const tr = getTr(body.tractor), mech = MECHANICS.find((m) => m.id === body.mechanic);
    if (!mech) throw httpErr(404, 'NOT_FOUND', `Mechanic ${body.mechanic} does not exist.`, { mechanic: body.mechanic });
    if (!['broken', 'awaiting_mechanic'].includes(tr.status)) throw httpErr(409, 'CONFLICT', `${tr.name} does not need a mechanic (${tr.status}).`, { status: tr.status });
    return asOperation('repair_booking', 'mechanics_book', `Booking ${mech.name} for ${tr.name}.`, async () => {
      if (!['broken', 'awaiting_mechanic'].includes(tr.status)) throw httpErr(409, 'CONFLICT', `${tr.name} no longer needs a mechanic.`, { status: tr.status });
      const arrival = r1(nowT() + mech.eta_min), ret = r1(arrival + mech.repair_min_estimate);
      tr.status = 'repair_scheduled'; tr.simSpeed = 0; tr.availableFrom = ret;
      tr.booking = { mechanic: mech.id, arrival_t: arrival, estimated_return_t: ret };
      addLog({ kind: 'mechanic_booked', tractor: tr.id, mechanic: mech.id, name: mech.name, arrival_t: arrival, estimated_return_t: ret });
      fleetDirty = true;
      return { tractor: tr.id, mechanic: mech.id, arrival_t: arrival, estimated_return_t: ret };
    });
  }],
  ['POST', '/api/approve', () => { throw notImpl('Approvals'); }],
];
const compiled = ROUTES.map(([m, pat, fn]) => { const names = []; const re = new RegExp('^' + pat.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '/?$'); return { m, re, names, fn }; });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  try {
    if (url.pathname === '/') return reply(res, 200, { ok: true, service: 'agopenweb-bridge', api: '/api', ws: '/ws', bridge: '/api/bridge' });
    const hits = compiled.map((r) => ({ r, m: r.re.exec(url.pathname) })).filter((x) => x.m);
    if (!hits.length) throw httpErr(404, 'NOT_FOUND', `There is no endpoint at ${url.pathname}.`);
    const hit = hits.find((x) => x.r.m === req.method);
    if (!hit) throw httpErr(405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed on ${url.pathname}.`);
    const p = Object.fromEntries(hit.r.names.map((n, i) => [n, decodeURIComponent(hit.m[i + 1])]));
    const body = ['POST', 'PATCH'].includes(req.method) ? await readJson(req) : undefined;
    const out = await hit.r.fn({ p, body: body || {}, q: url.searchParams });
    reply(res, out.status || 200, out.body, out.type);
  } catch (e) {
    const status = e.status || STATUS[e.code] || 500;
    if (status >= 500 && !e.code) console.error(e);
    reply(res, status, { error: { code: e.code || 'INTERNAL', message: e.message, details: e.details || {} } });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (new URL(req.url || '/', 'http://localhost').pathname !== '/ws') { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws));
});
wss.on('connection', (ws) => {
  const c = { ws, seq: 0 };
  sendTo(c, 'snapshot', snapshot());
  // replay coverage history (the snapshot carries none), chunked per tractor
  const byT = new Map();
  for (const [k, tid] of covOwner) { if (!byT.has(tid)) byT.set(tid, []); const tr = tractors.get(tid); byT.get(tid).push([Math.floor(k / 100000), k % 100000, tr ? hexInt(tr.color) : 0x8e8e93]); }
  for (const [tid, cells] of byT) for (let i = 0; i < cells.length; i += 2000) sendTo(c, 'coverage', coverageMsg(tid, cells.slice(i, i + 2000)));
  clients.add(c);
  ws.on('message', (raw) => { try { if (JSON.parse(String(raw)).type === 'ping') ws.send('{"type":"pong"}'); } catch {} });
  ws.on('close', () => clients.delete(c));
  ws.on('error', () => clients.delete(c));
});

// ===================================================================== loops
let fleetDirty = false, capDirty = false, planDirty = false, shuttingDown = false, lastStats = {};
const lastPoseSent = new Map();
let lastSim = Date.now();
setInterval(() => { // 10 Hz world step
  const now = Date.now(); simStep(Math.min(0.5, (now - lastSim) / 1000)); lastSim = now;
}, 100);
setInterval(() => { // 5 Hz poses (changed only)
  const out = [];
  for (const tr of tractors.values()) {
    const p = poseOut(tr), key = JSON.stringify([p.pose, p.status, p.manual, p.agopenweb && [p.agopenweb.autosteer, p.agopenweb.section_master, p.agopenweb.youturn, Math.round((p.agopenweb.heartbeat_age_ms || 0) / 200)]]);
    if (lastPoseSent.get(tr.id) !== key) { lastPoseSent.set(tr.id, key); out.push(p); }
  }
  if (out.length) broadcast('poses', { tractors: out });
}, 200);
setInterval(() => { // 1 Hz: clock, coverage, jobs, fleet, capacity
  broadcast('clock', clockOut());
  for (const [tid, cells] of covPending) if (cells.length) { broadcast('coverage', coverageMsg(tid, cells)); covPending.set(tid, []); }
  if (jobsDirty.size) { broadcast('jobs', { jobs: [...jobsDirty].map((id) => jobs.get(id)).filter(Boolean).map(jobOut) }); jobsDirty.clear(); }
  if (planDirty) { broadcast('plan', planOut()); planDirty = false; }
  if (fleetDirty) { broadcast('fleet', { tractors: [...tractors.values()].map(tractorOut) }); fleetDirty = false; }
  if (capDirty) { broadcast('capacity', capacityOut()); capDirty = false; }
}, 1000);
setInterval(async () => { // hot-seat housekeeping: release idle / handed-back real tractors when someone waits
  for (const s of slots) {
    const tr = s.tractorId && tractors.get(s.tractorId);
    if (tr && !FULL_MODE && tr.status === 'idle' && tr.idleSince && Date.now() - tr.idleSince > DEMOTE_IDLE_S * 1000) await demote(tr, `idle ${DEMOTE_IDLE_S} s`).catch(() => {});
  }
}, 2000);
setInterval(async () => { // container stats every 10 s (RAM/CPU honesty)
  if (ENDPOINTS.length) return;
  lastStats = await docker.stats().catch(() => ({}));
  const cpus = Object.values(lastStats).map((s) => s.cpu_pct).filter(Number.isFinite);
  hostCpu = cpus.length ? Math.round(cpus.reduce((a, b) => a + b, 0)) : null;
  capDirty = true;
}, 10000);

// ===================================================================== boot
async function main() {
  if (!ENDPOINTS.length) {
    if (!(await docker.dockerAvailable())) throw new Error('Docker is not running (start Docker Desktop), or set AOW_ENDPOINTS to existing AgOpenWeb instances.');
    if (!(await docker.imageExists(IMAGE))) throw new Error(`Image ${IMAGE} not found. Build it: ./agopenweb-bridge/run-agopenweb.sh (builds once).`);
    const n = await docker.removeAllLabelled(); if (n) log(`removed ${n} stale bridge container(s)`);
  }
  server.listen(PORT, () => log(`listening on http://localhost:${PORT}  mode=${FULL_MODE ? 'full (one container per tractor)' : `hot-seat (${SLOT_LIMIT} real slot${SLOT_LIMIT === 1 ? '' : 's'})`}  max_tractors=${MAX_TRACTORS}`));
  const warm = FULL_MODE ? 0 : SLOT_LIMIT; // hot-seat: start all slots warm; full mode: one per tractor as added
  for (let i = 0; i < warm; i++) await createSlot();
  if (warm && env('PREWARM', '1') === '1') { // pre-create every block field so a promotion only needs field.openOnly
    const t = Date.now();
    await Promise.all(slots.map(async (s) => { await s.starting; if (s.ready) await prewarm(s); }));
    log(`prewarm: ${scenario.blocks.length} fields in ${slots.length} slot(s) in ${Date.now() - t} ms`);
  }
  for (let i = 0; i < START_TRACTORS; i++) await addTractor({});
  await Promise.all(slots.map((s) => s.starting).filter(Boolean)).catch((e) => log(e.message));
  for (const s of slots) if (!s.tractorId && s.ready) prewarm(s);
  log(`open the dashboard: http://localhost:5173/?source=live&api=http://localhost:${PORT}`);
}
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  log('shutting down: stopping containers');
  for (const s of slots) { try { await s.client?.close(); } catch {} }
  if (!ENDPOINTS.length) await docker.removeAllLabelled().catch(() => {});
  for (const c of clients) try { c.ws.close(1001); } catch {}
  server.close(); process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
main().catch((e) => { console.error(`[bridge] ${e.message}`); process.exit(1); });

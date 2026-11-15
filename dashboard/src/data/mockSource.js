// MockSource: in-process port of reference/ui-mock.html's simulation that speaks
// the ARCHITECTURE.md contract (§4–§9, amended by §13). DOM-free, no deps.
//
// ---------------------------------------------------------------------------
// Decisions where the contract is silent (contract gaps, least-invasive choice):
//  1. Blocked road cells only live in Scenario (snapshot). block_route /
//     unblock_route are announced through `log` lines {kind:"event", type, cells}
//     and the store patches scenario.blocked_cells from them.
//  2. Mechanic van has no position in the contract. The `mechanic_booked` log
//     line carries {tractor, mechanic, name, arrival_t, estimated_return_t,
//     from:{x,y}}; the van drives from `from` to the tractor pose between the
//     booking `t` and `arrival_t`, and stays until the tractor is repaired.
//  3. Travel model (not in Scenario): Dijkstra on the 4-neighbour grid, road
//     cell cost 1, off-road 3.5, blocked cells impassable; tractors move 0.5
//     cells per farm minute (x FleetEntry.speed). A job is entered at
//     (block.x, block.y - 0.5) and swept in 3 rows (sweepPos) ending at
//     (block.x + 3, block.y + 1.5). speed_mph in poses is nominal (8 travel,
//     4.5 work), not derived from the compressed grid.
//  4. heat_alert has no target blocks in EventInput: the mock treats blocks G
//     and H as heat-exposed (unstarted spray jobs there go to priority 3).
//  5. Explanation.trigger uses EventType names plus "initial_plan",
//     "tractor_added" (on ready), "tractor_removed" and "end_of_day".
//     Explanation.facts always has: event, moved, deadlines_missed,
//     travel_delta_min, idle_delta_min, unassigned, context.
//  6. Re-plans caused by POST/DELETE /fleet have no Operation (§13.2 keeps
//     those responses unchanged and Operation.source has no "fleet" value);
//     they still emit plan -> explanation -> jobs.
//  7. Approving a `mechanic` pending item books the recommended option;
//     `override` declines it (tractor stays down). The mock never raises
//     `approval` pending items on its own.
//  8. Repair (§13.2): booking makes the tractor repair_scheduled -> repairing
//     at arrival_t, but it is NOT schedulable until postEvent({type:
//     "tractor_repaired"}). Option `autoRepair: true` auto-sends that event at
//     estimated_return_t (off by default).
//  9. End of day (t = 720): nothing is marked `dropped` (§13.1). Unfinished
//     in-progress jobs become `paused`; queued ones stay `assigned`.
// 10. Metrics.baseline is faked from our numbers like the UI mock did, with
//     baseline_source "simulated" and all §13.4 extra baseline keys null.
// 11. Failed op: PATCH a job with pinned_to an incompatible tractor ->
//     operation failed (SAFETY_REJECTED, no_feasible_plan), plan unchanged.
//     Debug hook: source.debug.failNext() fails the next run/replan op.
//     Superseded op: two patchJob calls on the same job before the next tick.
// 12. Ops execute on the next sim tick (100 ms real), so the 202 body is the
//     `queued` Operation and WS order is queued -> running -> plan ->
//     explanation -> jobs -> pending/fleet/metrics -> succeeded.
// ---------------------------------------------------------------------------

export const DAY_MIN = 720;
export const TICK_MS = 100;
// Real-time pace at speed 1, in farm minutes per real second. 1.2 => the 720-min day takes 10 real minutes
// (PROJECT.md Change 3: live demo day 10-12 min). Override per source with createMockSource({ pace }).
export const FARM_MIN_PER_REAL_S = 1.2;
/** Valid pace override (farm min per real second) or null. */
export const parsePace = (v) => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n > 0 && n <= 120 ? n : null; };
const GW = 20, GH = 14;
const RX = [0, 5, 10, 15], RY = [0, 6, 13];
const DEPOT = { x: 1, y: 6 };
const VAN_FROM = { x: 0, y: 6 };
const GEO = { origin_lat: 33.212, origin_lon: -111.62, cell_m: 40 };
const COLORS = ['#0A84FF', '#BF5AF2', '#FF9F0A', '#30D158', '#FF375F', '#5E5CE6', '#64D2FF', '#FFD60A'];
const IMPLEMENTS = ['sprayer', 'mower', 'hedger', 'bin_trailer'];
const IMPL_TYPE = { sprayer: 'spray', mower: 'mow', hedger: 'hedge', bin_trailer: 'haul_bins' };
const IMPL_NAME = { sprayer: 'sprayer', mower: 'mower', hedger: 'hedger', bin_trailer: 'bin trailer' };
const IMPL_VERB = { sprayer: 'spraying', mower: 'mowing', hedger: 'hedging', bin_trailer: 'hauling' };
const TOOL_WIDTH = { sprayer: 6, mower: 4.5, hedger: 3, bin_trailer: 2.5 };
const HEAT_BLOCKS = ['G', 'H'];
const POOL_MAX = 24;
const SCHEDULABLE = new Set(['ready', 'idle', 'traveling', 'working', 'waiting_weather']);

const BLOCKS = [
  ['A', 1, 2, 'Navel', 0.4], ['B', 6, 2, 'Valencia', 0.5], ['C', 11, 2, 'Navel', 0.72], ['D', 16, 2, 'Lemon', 0.3],
  ['E', 1, 9, 'Valencia', 0.55], ['F', 6, 9, 'Grapefruit', 0.6], ['G', 11, 9, 'Navel', 0.45], ['H', 16, 9, 'Mandarin', 0.35],
].map(([id, x, y, variety, ripeness]) => ({ id, x, y, w: 4, h: 3, variety, ripeness }));
const BLOCK = Object.fromEntries(BLOCKS.map((b) => [b.id, b]));

// id, label, block, implement, duration, priority, deadline (from the UI mock)
const SEED_JOBS = [
  ['J1', 'Spray E', 'E', 'sprayer', 150, 3, 330], ['J2', 'Mow C', 'C', 'mower', 100, 2, 300],
  ['J3', 'Haul bins C', 'C', 'bin_trailer', 120, 3, 280], ['J4', 'Spray A', 'A', 'sprayer', 110, 2, 500],
  ['J5', 'Mow F', 'F', 'mower', 100, 1, 450], ['J6', 'Spray D', 'D', 'sprayer', 100, 2, 460],
  ['J7', 'Spray G', 'G', 'sprayer', 120, 2, 640], ['J8', 'Hedge H', 'H', 'hedger', 110, 1, 600],
  ['J9', 'Haul bins B', 'B', 'bin_trailer', 100, 2, 560], ['J10', 'Mow B', 'B', 'mower', 90, 1, 700],
  ['J11', 'Spray H', 'H', 'sprayer', 100, 1, 700],
];
const SEED_TRACTORS = [
  { id: 'T1', name: 'Tractor 1', implements: ['sprayer'], fuel_pct: 82 },
  { id: 'T2', name: 'Tractor 2', implements: ['mower', 'hedger'], fuel_pct: 68 },
  { id: 'T3', name: 'Tractor 3', implements: ['sprayer', 'bin_trailer'], fuel_pct: 91 },
];
const MECHANICS = [
  { id: 'M1', name: 'Sonoran Field Diesel', source: 'Google', distance_mi: 11.8, rating: 4.9, reviews: 212, mobile: true, ag_equipment: true, eta_min: 45, est_cost: 380, repair_min_estimate: 60, url: null, score: 0.93, recommended: true, reason: 'Only mobile ag specialist arriving within an hour' },
  { id: 'M2', name: 'Valley Ag Repair', source: 'BBB', distance_mi: 19.4, rating: 4.7, reviews: 98, mobile: true, ag_equipment: true, eta_min: 80, est_cost: 340, repair_min_estimate: 70, url: null, score: 0.81, recommended: false, reason: 'Cheapest ag specialist, but arrives later' },
  { id: 'M3', name: 'Pinal Tractor Works', source: 'Thumbtack', distance_mi: 23.1, rating: 4.8, reviews: 61, mobile: true, ag_equipment: false, eta_min: 95, est_cost: 410, repair_min_estimate: 65, url: null, score: 0.72, recommended: false, reason: 'Well rated, slowest to arrive' },
  { id: 'M4', name: 'Desert Heavy Equipment', source: 'Google', distance_mi: 16.2, rating: 4.5, reviews: 140, mobile: true, ag_equipment: false, eta_min: 70, est_cost: 460, repair_min_estimate: 80, url: null, score: 0.69, recommended: false, reason: 'Heavy diesel shop, not ag-specific' },
];

// ---------------------------------------------------------------- weather (PROJECT.md Change 6 Part B)
/** weather_rules.json defaults. Labels are the law: every threshold lives here, not in code. */
export const WEATHER_RULES = {
  spray: { min_wind_mph: 3, max_wind_mph: 10, max_temp_f: 100, max_rain_prob: 40, rain_lookahead_min: 120, sensitive_half_angle_deg: 45 },
  mow: { max_wind_mph: 25 }, hedge: { max_wind_mph: 25 }, haul_bins: { max_wind_mph: 35 },
  /** a weather_change event overrides the scripted timeline for this long (or until the next weather_change) */
  override_hold_min: 120,
};
/** Scripted hourly timeline (deterministic; ours and baseline face the same weather). wind_from_deg is where the
 *  wind comes FROM; it blows toward wind_from_deg + 180. Calm dawn (inversion risk), southerly morning that
 *  pushes toward the houses north of H, a westerly afternoon toward the canal east of E, an 11 mph gust 1-2 PM. */
export const WEATHER_SCRIPT = [
  [0, 2, 90, 66, 0], [30, 3, 100, 68, 0], [60, 4, 120, 71, 0], [120, 5, 160, 75, 0], [180, 6, 180, 79, 0], [240, 7, 200, 84, 0],
  [300, 8, 215, 88, 0], [360, 9, 240, 92, 5], [420, 11, 250, 95, 10], [480, 8, 250, 97, 5], [540, 6, 255, 98, 0],
  [600, 5, 265, 96, 0], [660, 4, 270, 93, 0], [720, 3, 270, 90, 0],
].map(([t, wind_mph, wind_from_deg, temp_f, rain_prob]) => ({ t, wind_mph, wind_from_deg, temp_f, rain_prob }));
const SENSITIVE = [{ block: 'E', what: 'canal', dir_deg: 90 }, { block: 'H', what: 'houses', dir_deg: 0 }, { block: 'B', what: 'apiary', dir_deg: 270 }];
const angDiff = (a, b) => { const d = Math.abs((((a - b) % 360) + 360) % 360); return d > 180 ? 360 - d : d; };
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const compassName = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
/** Split `R` minutes of work starting no earlier than `c` across allowed windows [[s,e],...]; what does not fit spills past sunset. */
function splitWork(wins, c, R) {
  const segs = [];
  for (const [s, e] of wins) {
    if (R <= 1e-9) break;
    if (e <= c + 1e-9) continue;
    const st = Math.max(s, c), en = Math.min(e, st + R);
    segs.push([st, en]); R -= en - st; c = en;
  }
  if (R > 1e-9) { const st = Math.max(c, DAY_MIN); segs.push([st, st + R]); } // no window left today: spills past sunset (late)
  return segs;
}

// ---------------------------------------------------------------- helpers
const r1 =(v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const apiError = (code, message, details = {}) => ({ code, message, details });
export function fmtClock(m) {
  const h = 6 + Math.floor(m / 60), mm = Math.floor(m % 60), hh = ((h + 11) % 12) + 1;
  return hh + ':' + String(mm).padStart(2, '0') + (h >= 12 ? ' PM' : ' AM');
}
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
const listText = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
const idNum = (id) => parseInt(String(id).replace(/\D/g, ''), 10) || 0;
/** Seeded PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- geometry
const isRoad = (x, y) => RX.includes(x) || RY.includes(y);
const clampX = (v) => Math.max(0, Math.min(GW - 1, Math.round(v)));
const clampY = (v) => Math.max(0, Math.min(GH - 1, Math.round(v)));
const pathCache = new Map();
const blockedKey = (blocked) => [...blocked].sort().join(';');

/** Dijkstra from the UI mock. Returns integer cells from start to target. */
function gridPath(sx, sy, tx, ty, blocked) {
  sx = clampX(sx); sy = clampY(sy); tx = clampX(tx); ty = clampY(ty);
  const ck = blockedKey(blocked) + '|' + sx + ',' + sy + '>' + tx + ',' + ty;
  const hit = pathCache.get(ck);
  if (hit) return hit;
  const N = GW * GH, dist = new Array(N).fill(Infinity), prev = new Array(N).fill(-1), dn = new Array(N).fill(false);
  const id = (x, y) => y * GW + x;
  dist[id(sx, sy)] = 0;
  for (let it = 0; it < N; it++) {
    let u = -1, b = Infinity;
    for (let i = 0; i < N; i++) if (!dn[i] && dist[i] < b) { b = dist[i]; u = i; }
    if (u < 0) break;
    dn[u] = true;
    const ux = u % GW, uy = (u / GW) | 0;
    if (ux === tx && uy === ty) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = ux + dx, ny = uy + dy;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH || blocked.has(nx + ',' + ny)) continue;
      const v = id(nx, ny), c = isRoad(nx, ny) ? 1 : 3.5;
      if (dist[u] + c < dist[v]) { dist[v] = dist[u] + c; prev[v] = u; }
    }
  }
  let out = [];
  let c = id(tx, ty);
  if (dist[c] === Infinity) out = [[sx, sy], [tx, ty]];
  else while (c !== -1) { out.unshift([c % GW, (c / GW) | 0]); c = prev[c]; }
  if (pathCache.size > 20000) pathCache.clear();
  pathCache.set(ck, out);
  return out;
}
/** Movement path like the mock: rounded start cell, road cells, exact target. Walk from index 1. */
function routeTo(x, y, tg, blocked) { return [...gridPath(x, y, tg[0], tg[1], blocked), [tg[0], tg[1]]]; }
function polyLen(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
const travelMinutes = (len, speed) => (len * 2) / (speed || 1);
function sweepPos(blockId, prog) {
  const b = BLOCK[blockId]; const s = prog * 3, row = Math.min(2, Math.floor(s)), f = Math.min(1, s - row);
  return [b.x + (row % 2 ? 3 - f * 3 : f * 3), b.y - 0.5 + row];
}
const entryPoint = (j) => (j.progress > 0 ? sweepPos(j.block, j.progress) : [BLOCK[j.block].x, BLOCK[j.block].y - 0.5]);
const endPoint = (j) => sweepPos(j.block, 1);
const headingDeg = (dx, dy) => ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
function toGeo(x, y) {
  const lat = GEO.origin_lat - (y * GEO.cell_m) / 111320;
  const lon = GEO.origin_lon + (x * GEO.cell_m) / (111320 * Math.cos((GEO.origin_lat * Math.PI) / 180));
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

// ---------------------------------------------------------------- planner (pure)
const jobCmp = (a, b) => b.priority - a.priority || a.deadline_t - b.deadline_t || idNum(a.id) - idNum(b.id);
const unfinished = (j) => j.status !== 'done' && j.status !== 'dropped';
const remainingMin = (j) => j.duration_min * (1 - j.progress);

/**
 * Timeline of one tractor: current job then `queue`. Pure.
 * @returns {{entries: object[], end_t: number, x: number, y: number}}
 */
function tractorSchedule(tr, byId, queue, now, blocked, includeCurrent = true, wx = null) {
  const entries = []; let c = now, x = tr.x, y = tr.y;
  // work [c, ...]: spray work is split across the block's allowed windows with `wait` entries in the gaps
  const work = (j, start, firstStart) => {
    const R = remainingMin(j);
    const segs = wx && j.implement === 'sprayer' ? wx.split(j.block, start, R) : [[start, start + R]];
    let at = start;
    segs.forEach(([s0, e], i) => {
      if (s0 > at + 1e-6) entries.push({ tractor: tr.id, job: null, kind: 'wait', start_t: at, end_t: s0, route: [] });
      entries.push({ tractor: tr.id, job: j.id, kind: 'work', start_t: i === 0 && firstStart != null ? Math.min(firstStart, s0) : s0, end_t: e, route: [] });
      at = e;
    });
    return at;
  };
  const cur = includeCurrent && tr.current_job ? byId.get(tr.current_job) : null;
  if (cur) {
    let ws;
    if (tr.status === 'traveling' && tr.path && tr.pi < tr.path.length) {
      const pts = [[r2(x), r2(y)], ...tr.path.slice(tr.pi)];
      const tt = travelMinutes(polyLen(pts), tr.speed);
      entries.push({ tractor: tr.id, job: cur.id, kind: 'travel', start_t: c, end_t: c + tt, route: pts });
      c += tt; ws = c;
    } else ws = tr.status === 'working' ? (cur._s ?? c) : null;
    c = work(cur, c, ws);
    [x, y] = endPoint(cur);
  }
  for (const id of queue) {
    const j = byId.get(id); if (!j) continue;
    const tg = entryPoint(j);
    const pts = [[r2(x), r2(y)], ...routeTo(x, y, tg, blocked).slice(1)];
    const tt = travelMinutes(polyLen(pts), tr.speed);
    entries.push({ tractor: tr.id, job: j.id, kind: 'travel', start_t: c, end_t: c + tt, route: pts });
    c = work(j, c + tt, null);
    [x, y] = endPoint(j);
  }
  return { entries, end_t: c, x, y };
}

function statusReason(tr) {
  switch (tr.status) {
    case 'broken': case 'awaiting_mechanic': return 'Broken down';
    case 'repair_scheduled': case 'repairing': return 'Being repaired';
    case 'starting': return 'Starting up';
    case 'removing': return 'Leaving the fleet';
    case 'offline': return 'Offline';
    default: return tr.manual ? 'Under manual control' : 'Unavailable';
  }
}
const schedulable = (tr) => SCHEDULABLE.has(tr.status) && !tr.manual;

function unassignedReason(j, tractors) {
  if (j.pinned_to) {
    const p = tractors.find((t) => t.id === j.pinned_to);
    if (!p) return `Pinned to ${j.pinned_to}, which is not in the fleet.`;
    return `Pinned to ${p.name}, which is unavailable (${statusReason(p).toLowerCase()}).`;
  }
  const any = tractors.some((t) => t.implements.includes(j.implement));
  return any ? `No operational tractor has a ${IMPL_NAME[j.implement]}.` : `No tractor in the fleet has a ${IMPL_NAME[j.implement]}.`;
}

/**
 * Greedy rolling planner. In-progress jobs of schedulable tractors are frozen.
 * Remaining work is taken in priority (3 first) then deadline order and given to
 * the compatible schedulable tractor with the earliest finish.
 * @param {{tractors:object[], jobs:object[], blocked:Set<string>, t:number}} p
 */
export function planAssign({ tractors, jobs, blocked, t, wx = null }) {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const sched = tractors.filter(schedulable);
  const frozen = new Set(sched.map((tr) => tr.current_job).filter(Boolean));
  const tails = new Map(sched.map((tr) => [tr.id, tractorSchedule(tr, byId, [], t, blocked, true, wx)]));
  // Weather Agent: spray jobs that cannot run right now go behind doable work, so sprayers haul instead of idling.
  const waitsNow = (j) => !!(wx && j.implement === 'sprayer' && !wx.opensSoon(j.block, t));
  const order = (a, b) => (waitsNow(a) ? 1 : 0) - (waitsNow(b) ? 1 : 0) || jobCmp(a, b);
  const assign = new Map(sched.map((tr) => [tr.id, []]));
  const unassigned = new Map();
  let rejected = 0;
  for (const j of jobs.filter((j) => unfinished(j) && !frozen.has(j.id)).sort(order)) {
    const noWin = wx && j.implement === 'sprayer' ? wx.noWindowReason(j) : null;
    if (noWin) { unassigned.set(j.id, noWin); continue; }
    let best = null;
    for (const tr of tractors) {
      if (!tr.implements.includes(j.implement) || !schedulable(tr) || (j.pinned_to && j.pinned_to !== tr.id)) { rejected++; continue; }
      const tail = tails.get(tr.id);
      const tt = travelMinutes(polyLen([[tail.x, tail.y], ...routeTo(tail.x, tail.y, entryPoint(j), blocked).slice(1)]), tr.speed);
      let fin = tail.end_t + tt + remainingMin(j);
      if (wx && j.implement === 'sprayer') { const segs = wx.split(j.block, tail.end_t + tt, remainingMin(j)); fin = segs[segs.length - 1][1]; }
      if (!best || fin < best.fin - 1e-9 || (Math.abs(fin - best.fin) < 1e-9 && tt < best.tt)) best = { tr, fin, tt };
    }
    if (!best) { unassigned.set(j.id, unassignedReason(j, tractors)); continue; }
    assign.get(best.tr.id).push(j.id);
    const [ex, ey] = endPoint(j);
    tails.set(best.tr.id, { ...tails.get(best.tr.id), end_t: best.fin, x: ex, y: ey });
  }
  return { assign, unassigned, rejected, frozen };
}

/** Count invariant failures of an assignment (implement match, operational, no duplicates). */
function safetyViolations(tractors, jobs) {
  let v = 0; const seen = new Set();
  for (const tr of tractors) {
    for (const id of [tr.current_job, ...tr.queue].filter(Boolean)) {
      const j = jobs.find((x) => x.id === id);
      if (!j || seen.has(id) || !tr.implements.includes(j.implement)) v++;
      seen.add(id);
      if (!schedulable(tr) && tr.queue.includes(id)) v++;
    }
  }
  return v;
}

// ---------------------------------------------------------------- world
/** Weather state: scripted timeline + event overrides, as a step function of farm time. */
function newWx() { return { script: WEATHER_SCRIPT.map((p) => ({ ...p })), overrides: [], wins: null, sig: '' }; }
const WX_KEYS = ['wind_mph', 'wind_from_deg', 'temp_f', 'rain_prob'];
function wxAt(wx, t) {
  for (let i = wx.overrides.length - 1; i >= 0; i--) { const o = wx.overrides[i]; if (t >= o.from - 1e-9 && t < o.to - 1e-9) return o.v; }
  let p = wx.script[0];
  for (const q of wx.script) if (q.t <= t + 1e-9) p = q;
  return p;
}
/** Times where any value (or the 2 h rain look-ahead) can change. */
function wxChangePoints(wx, withRain) {
  const L = WEATHER_RULES.spray.rain_lookahead_min;
  const set = new Set([0]);
  const add = (v) => { if (v > 0 && v < DAY_MIN) set.add(Math.round(v * 100) / 100); };
  for (const p of wx.script) { add(p.t); if (withRain) add(p.t - L); }
  for (const o of wx.overrides) { add(o.from); add(o.to); if (withRain) { add(o.from - L); add(o.to - L); } }
  return [...set].sort((a, b) => a - b);
}
/** Why spraying `block` is not allowed at time t (null = allowed). {rule, text, ...numbers} */
function sprayBlock(wx, block, t) {
  const R = WEATHER_RULES.spray, v = wxAt(wx, t);
  if (v.wind_mph < R.min_wind_mph) return { rule: 'min_wind', text: `Wind ${v.wind_mph} mph is under the ${R.min_wind_mph} mph minimum (inversion risk)`, wind_mph: v.wind_mph, limit: R.min_wind_mph };
  if (v.wind_mph > R.max_wind_mph) return { rule: 'max_wind', text: `Wind ${v.wind_mph} mph exceeds the ${R.max_wind_mph} mph spray limit`, wind_mph: v.wind_mph, limit: R.max_wind_mph };
  const toward = (v.wind_from_deg + 180) % 360;
  const s = SENSITIVE.find((a) => a.block === block && angDiff(toward, a.dir_deg) <= R.sensitive_half_angle_deg);
  if (s) return { rule: 'sensitive_area', text: `Wind blowing toward ${s.what} (sensitive area)`, what: s.what, dir_deg: s.dir_deg, wind_from_deg: v.wind_from_deg };
  if (v.temp_f > R.max_temp_f) return { rule: 'max_temp', text: `${v.temp_f}°F is above the ${R.max_temp_f}°F product limit`, temp_f: v.temp_f, limit: R.max_temp_f };
  let rain = v.rain_prob;
  for (const cp of wxChangePoints(wx, false)) if (cp > t && cp < t + R.rain_lookahead_min) rain = Math.max(rain, wxAt(wx, cp).rain_prob);
  if (rain >= R.max_rain_prob) return { rule: 'rain', text: `${rain}% chance of rain within ${R.rain_lookahead_min / 60} h`, rain_prob: rain, limit: R.max_rain_prob };
  return null;
}
/** Allowed spray windows per block over the day (cached until the weather changes). */
function wxWindows(wx) {
  if (wx.wins) return wx.wins;
  const cps = wxChangePoints(wx, true);
  const out = {};
  for (const b of BLOCKS) {
    const list = [];
    cps.forEach((s, i) => {
      const e = cps[i + 1] ?? DAY_MIN;
      if (e - s < 1e-6 || sprayBlock(wx, b.id, s)) return;
      const last = list[list.length - 1];
      if (last && Math.abs(last[1] - s) < 1e-6) last[1] = e; else list.push([s, e]);
    });
    out[b.id] = list;
  }
  return (wx.wins = out);
}
const sprayAllowed = (wx, block, t) => (wxWindows(wx)[block] || []).some(([s, e]) => t >= s - 1e-9 && t < e - 1e-9);
/** Is a job allowed to run at t under the weather rules? (spray: windows; mow/hedge/haul: wind limits) */
function jobWeatherOk(wx, j, t) {
  if (j.implement === 'sprayer') return sprayAllowed(wx, j.block, t);
  const lim = WEATHER_RULES[IMPL_TYPE[j.implement]];
  return !lim || wxAt(wx, t).wind_mph < lim.max_wind_mph;
}
/** Planner-facing view of the weather (passed into planAssign / tractorSchedule). */
function wxPlanner(wx, now) {
  const wins = wxWindows(wx);
  return {
    allowed: (block, t) => sprayAllowed(wx, block, t),
    /** a window is open now or opens within 45 min (about the drive to a block) */
    opensSoon: (block, t) => (wins[block] || []).some(([s, e]) => e > t + 1e-6 && s < t + 45),
    split: (block, c, R) => splitWork(wins[block] || [], c, R),
    noWindowReason: (j) => {
      if ((wins[j.block] || []).some(([, e]) => e > now + 1e-6)) return null;
      const why = sprayBlock(wx, j.block, now);
      return `No spray window left today for Block ${j.block}${why ? ': ' + why.text.charAt(0).toLowerCase() + why.text.slice(1) : ''}.`;
    },
  };
}
function weatherOut(wx, t) {
  const v = wxAt(wx, t), wins = wxWindows(wx);
  const allowed = {}, reason = {}, windows = {};
  for (const b of BLOCKS) {
    allowed[b.id] = sprayAllowed(wx, b.id, t);
    if (!allowed[b.id]) { const why = sprayBlock(wx, b.id, t); reason[b.id] = why ? why.text : 'Spraying not allowed now'; }
    windows[b.id] = wins[b.id].map(([s, e]) => [r1(s), r1(e)]);
  }
  return {
    current: Object.fromEntries(WX_KEYS.map((k) => [k, v[k]])),
    forecast: wxChangePoints(wx, false).concat(DAY_MIN).filter((x, i, a) => a.indexOf(x) === i).map((p) => ({ t: r1(p), ...Object.fromEntries(WX_KEYS.map((k) => [k, wxAt(wx, p)[k]])) })),
    spray_allowed_now: allowed, spray_blocked_reason: reason, spray_windows: windows, live_conditions: null,
  };
}

function makeJob(id, label, block, implement, duration, priority, deadline) {
  return {
    id, type: IMPL_TYPE[implement], label, implement, block, duration_min: duration, remaining_min: duration, progress: 0,
    priority, deadline_t: deadline, status: 'pending', tractor: null, start_t: null, end_t: null, eta_t: null,
    weather_blocked: false, pinned_to: null, unassigned_reason: 'Not planned yet.',
    _s: null, _e: null, _origDeadline: deadline, _priAtDone: null,
  };
}
const JOB_KEYS = ['id', 'type', 'label', 'implement', 'block', 'duration_min', 'remaining_min', 'progress', 'priority', 'deadline_t', 'status', 'tractor', 'start_t', 'end_t', 'eta_t', 'weather_blocked', 'pinned_to', 'unassigned_reason'];
function jobOut(j) {
  const o = {};
  for (const k of JOB_KEYS) o[k] = j[k] ?? (k === 'weather_blocked' ? false : null);
  o.remaining_min = r1(j.duration_min * (1 - j.progress)); o.progress = Math.round(j.progress * 10000) / 10000;
  o.start_t = r1(j.start_t); o.end_t = r1(j.end_t); o.eta_t = r1(j.eta_t);
  return o;
}

/**
 * @param {{realtime?: boolean, autoRepair?: boolean}} [opts]
 *   realtime: drive tick() from setInterval(100 ms) after connect (default true).
 *   pace: farm minutes per real second at speed 1 (default FARM_MIN_PER_REAL_S = 1.2, a 10-minute day).
 *         The clock speed multiplier (setClock speed) multiplies it. Each tick advances pace*speed*0.1 farm min.
 */
export function createMockSource(opts = {}) {
  const realtime = opts.realtime !== false;
  const autoRepair = !!opts.autoRepair;
  const pace = parsePace(opts.pace) ?? FARM_MIN_PER_REAL_S;
  let w; // world
  let seq = 0, handler = null, timer = null, tickN = 0, realMs = 0;
  let onConnected = null;
  const ops = []; const queue = []; const idem = new Map();
  const ctr = { X: 0, P: 0, O: 0 };
  let failNext = false;
  let tracked = { jobs: new Map(), fleet: '', poses: new Map() };
  let jobDoneFlag = false;

  // ---------------- emission
  function emit(type, data) {
    seq++;
    if (handler) handler({ type, t: r2(w.t), seq, data: clone(data) });
  }
  function addLog(entry) { const e = { t: r2(w.t), ...entry }; w.log.push(e); emit('log', e); }

  // ---------------- output builders
  function tractorOut(tr) {
    const g = toGeo(tr.x, tr.y);
    const curJob = tr.current_job ? w.jobs.find((j) => j.id === tr.current_job) : null;
    const impl = curJob && tr.implements.includes(curJob.implement) ? curJob.implement : tr.implements[0];
    const hd = r1(tr.hd);
    const back = 0.15; const rad = (tr.hd * Math.PI) / 180;
    const tg = toGeo(tr.x - Math.sin(rad) * back, tr.y + Math.cos(rad) * back);
    return {
      id: tr.id, name: tr.name, color: tr.color, implements: tr.implements.slice(), status: tr.status, manual: tr.manual,
      fuel_pct: r1(tr.fuel),
      pose: { x: r2(tr.x), y: r2(tr.y), lat: g.lat, lon: g.lon, heading_deg: hd, speed_mph: tr.status === 'traveling' ? 8 : tr.status === 'working' ? 4.5 : 0 },
      tool: { lat: tg.lat, lon: tg.lon, heading_deg: hd, width_m: TOOL_WIDTH[impl] ?? 3 },
      current_job: tr.current_job, queue: tr.queue.slice(), available_from_t: r1(tr.available_from_t), host: 'mock', agopenweb: null,
    };
  }
  const poseOut = (tr) => { const o = tractorOut(tr); return { id: o.id, status: o.status, manual: o.manual, pose: o.pose, tool: o.tool, fuel_pct: o.fuel_pct, current_job: o.current_job, agopenweb: o.agopenweb }; };
  const clockOut = () => ({ t: r2(w.t), playing: w.playing, speed: w.speed, day_minutes: DAY_MIN, mode: w.mode, ended: w.ended });
  const capacityOut = () => ({ used: w.tractors.length, max: POOL_MAX, hosts: [{ id: 'mock-pool', docker: 'mock', tractors: w.tractors.length, max_tractors: POOL_MAX, cpu_pct: null, online: true }], warm: 0 });
  const scenarioOut = () => ({
    name: 'queen_creek_citrus_day1', grid: { width: GW, height: GH }, depot: { ...DEPOT }, roads: { rows: RY.slice(), cols: RX.slice() },
    blocks: BLOCKS.map((b) => ({ ...b })), blocked_cells: [...w.blocked].map((k) => k.split(',').map(Number)),
    sensitive: [{ block: 'E', what: 'canal', dir_deg: 90 }, { block: 'H', what: 'houses', dir_deg: 0 }, { block: 'B', what: 'apiary', dir_deg: 270 }],
    basemap: { image_url: null, west: -111.62, east: -111.611, south: 33.207, north: 33.212 },
    geo: { ...GEO },
  });
  function metricsOut() {
    const done = w.jobs.filter((j) => j.status === 'done');
    const onTime = done.filter((j) => j._e <= j.deadline_t + 1e-9);
    const ours = {
      jobs_total: w.jobs.filter((j) => j.status !== 'dropped').length, completed: done.length, on_time: onTime.length,
      travel_min: r1(w.acc.travel), idle_min: r1(w.acc.idle), violations: w.acc.violations,
      weighted_on_time: onTime.reduce((s, j) => s + (j._priAtDone ?? j.priority), 0),
      productive_min: r1(w.acc.productive),
      original_deadline_on_time: done.filter((j) => j._e <= j._origDeadline + 1e-9).length,
      replan_ms_last: w.acc.replanMs, rejected_candidates: w.acc.rejected,
    };
    const baseline = {
      jobs_total: ours.jobs_total, completed: Math.max(0, ours.completed - 3), on_time: Math.max(0, ours.on_time - 4),
      travel_min: Math.round(w.acc.travel * 1.38 + 20), idle_min: Math.round(w.acc.idle * 1.9 + 55), violations: 0,
      weighted_on_time: null, productive_min: null, original_deadline_on_time: null, replan_ms_last: null, rejected_candidates: null,
    };
    return { ours, baseline, baseline_source: 'simulated' };
  }
  const isTerminal = (o) => ['succeeded', 'failed', 'superseded'].includes(o.status);
  function opsOut() {
    const sorted = [...ops].sort((a, b) => idNum(b.id) - idNum(a.id));
    let n = 0; return sorted.filter((o) => !isTerminal(o) || ++n <= 20);
  }
  function snapshotOut() {
    return {
      clock: clockOut(), scenario: scenarioOut(), fleet: w.tractors.map(tractorOut), jobs: w.jobs.map(jobOut), plan: w.plan,
      explanations: w.explanations.slice(-10).reverse(), metrics: metricsOut(), weather: weatherOut(w.wx, w.t), pending: w.pending,
      capacity: capacityOut(), log_tail: w.log.slice(-20).reverse(), operations: opsOut(),
    };
  }

  // ---------------- change tracking / throttled flushes
  const jobSig = (o) => JSON.stringify([o.status, o.tractor, o.priority, o.deadline_t, o.pinned_to, o.unassigned_reason, o.weather_blocked]);
  function primeTrackers() {
    flushWeather(true, true);
    tracked = { jobs: new Map(), fleet: fleetSig(), poses: new Map() };
    for (const j of w.jobs) { const o = jobOut(j); tracked.jobs.set(j.id, { sig: jobSig(o), full: JSON.stringify(o), tick: tickN }); }
    for (const tr of w.tractors) tracked.poses.set(tr.id, JSON.stringify(poseOut(tr)));
  }
  function flushJobs({ force = false, always = false } = {}) {
    const changed = [];
    for (const j of w.jobs) {
      const o = jobOut(j), sig = jobSig(o), full = JSON.stringify(o), prev = tracked.jobs.get(j.id);
      if (!prev || prev.sig !== sig || (prev.full !== full && (force || tickN - prev.tick >= 10))) {
        changed.push(o); tracked.jobs.set(j.id, { sig, full, tick: tickN });
      }
    }
    if (changed.length || always) emit('jobs', { jobs: changed });
  }
  function fleetSig() { return JSON.stringify(w.tractors.map((tr) => [tr.id, tr.status, tr.queue, tr.current_job, r1(tr.available_from_t), tr.implements, tr.manual])); }
  function flushFleet() { const s = fleetSig(); if (s !== tracked.fleet) { tracked.fleet = s; emit('fleet', { tractors: w.tractors.map(tractorOut) }); } }
  function flushPoses() {
    const changed = [];
    for (const tr of w.tractors) { const p = poseOut(tr), s = JSON.stringify(p); if (tracked.poses.get(tr.id) !== s) { tracked.poses.set(tr.id, s); changed.push(p); } }
    if (changed.length) emit('poses', { tractors: changed });
  }
  const emitMetrics = () => emit('metrics', metricsOut());
  const emitClock = () => emit('clock', clockOut());
  const emitPending = () => emit('pending', { pending: w.pending });

  // ---------------- world lifecycle
  function newTractor(entry, idx) {
    const start = entry.start || { x: 2 + (idx % 6), y: DEPOT.y };
    return {
      id: entry.id, name: entry.name, color: COLORS[idx % COLORS.length], implements: entry.implements.slice(), status: entry.status || 'idle',
      manual: false, fuel: entry.fuel_pct ?? 75, x: start.x, y: start.y, hd: 0, current_job: null, queue: [], path: [], pi: 0,
      available_from_t: null, speed: entry.speed || 1, readyAt: null, removeAt: null, booking: null,
    };
  }
  function resetWorld(mode = 'ours') {
    w = {
      t: 0, playing: true, speed: w?.speed ?? 1, ended: false, mode, tractors: [], jobs: SEED_JOBS.map((a) => makeJob(...a)),
      blocked: new Set(), planVersion: 0,
      plan: { version: 0, entries: [], solver: 'greedy', solve_ms: 0, solver_status: 'feasible', diff: { moved: [], retimed: [], dropped: [], added: [] } },
      explanations: [], pending: [], log: [], heat: false, wx: newWx(), created: 0,
      acc: { travel: 0, idle: 0, productive: 0, violations: 0, replanMs: null, rejected: null },
    };
    for (const e of SEED_TRACTORS) w.tractors.push(newTractor(e, w.created++));
    for (const j of queue.splice(0)) setOp(j.op, { status: 'superseded', message: 'Superseded by a new run.' });
  }
  const jobById = (id) => w.jobs.find((j) => j.id === id);
  const trById = (id) => w.tractors.find((t) => t.id === id);
  const wxP = () => wxPlanner(w.wx, w.t);
  /** weather_blocked: held and waiting for its window, paused mid-job by weather, or unassignable for weather. */
  function refreshWeatherFlags() {
    const held = new Map(w.tractors.filter((tr) => tr.current_job).map((tr) => [tr.current_job, tr]));
    for (const j of w.jobs) {
      if (!unfinished(j)) { j.weather_blocked = false; continue; }
      const tr = held.get(j.id);
      if (tr) j.weather_blocked = tr.status === 'waiting_weather' || (tr.status === 'traveling' && !jobWeatherOk(w.wx, j, w.t));
      else j.weather_blocked = !jobWeatherOk(w.wx, j, w.t) && (j.progress > 0 || j.status === 'pending');
    }
  }
  /** Emit `weather` when the current conditions or spray permissions change (scripted hours, events). */
  function flushWeather(force = false, silent = false) {
    const out = weatherOut(w.wx, w.t);
    const sig = JSON.stringify([out.current, out.spray_allowed_now, out.spray_blocked_reason, out.forecast]);
    if (!force && sig === w.wx.sig) return;
    w.wx.sig = sig; if (!silent) emit('weather', out);
  }

  function updateEstimates() {
    const byId = new Map(w.jobs.map((j) => [j.id, j]));
    for (const tr of w.tractors) {
      if (!schedulable(tr)) continue;
      const seen = new Set();
      for (const e of tractorSchedule(tr, byId, tr.queue, w.t, w.blocked, true, wxP()).entries) {
        if (e.kind !== 'work') continue;
        const j = byId.get(e.job); if (!seen.has(j.id)) { seen.add(j.id); j.start_t = e.start_t; } j.end_t = e.end_t; j.eta_t = e.end_t;
      }
    }
    for (const j of w.jobs) if (j.status === 'done') { j.start_t = j._s; j.end_t = j._e; j.eta_t = j._e; }
  }
  function buildEntries(includeAll = false) {
    const byId = new Map(w.jobs.map((j) => [j.id, j]));
    const out = [];
    for (const j of w.jobs) if (j.status === 'done' && j.tractor) out.push({ tractor: j.tractor, job: j.id, kind: 'work', start_t: r1(j._s), end_t: r1(j._e), route: [] });
    for (const tr of w.tractors) {
      if (!includeAll && !schedulable(tr)) continue;
      for (const e of tractorSchedule(tr, byId, tr.queue, w.t, w.blocked, true, wxP()).entries) out.push({ ...e, start_t: r1(e.start_t), end_t: r1(e.end_t) });
    }
    return out;
  }
  function planStats(entries) {
    const travel = entries.filter((e) => e.kind === 'travel').reduce((s, e) => s + Math.max(0, e.end_t - Math.max(e.start_t, w.t)), 0);
    const ends = new Map();
    for (const e of entries) ends.set(e.tractor, Math.max(ends.get(e.tractor) ?? w.t, e.end_t));
    for (const tr of w.tractors) if (schedulable(tr) && !ends.has(tr.id)) ends.set(tr.id, w.t);
    const horizon = Math.max(w.t, ...ends.values());
    let idle = 0; for (const [id, end] of ends) if (trById(id) && schedulable(trById(id))) idle += horizon - end;
    return { travel, idle, makespan: horizon };
  }

  /**
   * Rolling re-plan. Emits log -> plan -> explanation -> jobs (always). Caller
   * emits pending/fleet/metrics afterwards. Returns {version, unassigned, explanation}.
   */
  function replan(trigger, ctx = {}) {
    const t0 = (globalThis.performance ?? Date).now();
    const before = new Map(w.jobs.map((j) => [j.id, { tractor: j.tractor, start: j.start_t }]));
    // "before" = fresh estimate of the current commitments (not the stale timings of the last plan)
    const oldStats = planStats(buildEntries(true).filter((e) => !(e.kind === 'work' && jobById(e.job)?.status === 'done')));
    // release work held by tractors that cannot work
    for (const tr of w.tractors) {
      if (schedulable(tr)) continue;
      if (tr.current_job) { const j = jobById(tr.current_job); if (j && unfinished(j)) j.status = 'paused'; tr.current_job = null; }
      tr.queue = []; tr.path = []; tr.pi = 0;
    }
    // Weather Agent live guard: a held job that may not run now is released (progress kept) so the
    // planner can give its tractor other work and put the job back into a later window.
    const released = [];
    for (const tr of w.tractors) {
      if (!schedulable(tr) || !tr.current_job) continue;
      const j = jobById(tr.current_job);
      if (!j || !unfinished(j) || jobWeatherOk(w.wx, j, w.t)) continue;
      released.push({ job: j.id, tractor: tr.id, progress: r2(j.progress), was: tr.status });
      j.status = j.progress > 0 ? 'paused' : 'pending'; j.weather_blocked = j.progress > 0; j.tractor = null;
      tr.current_job = null; tr.status = 'idle'; tr.path = []; tr.pi = 0;
    }
    const res = planAssign({ tractors: w.tractors, jobs: w.jobs, blocked: w.blocked, t: w.t, wx: wxP() });
    for (const tr of w.tractors) {
      if (!schedulable(tr)) continue;
      tr.queue = res.assign.get(tr.id) || [];
      for (const id of tr.queue) { const j = jobById(id); j.tractor = tr.id; j.status = j.weather_blocked && j.progress > 0 ? 'paused' : 'assigned'; j.unassigned_reason = null; }
      if (tr.current_job) jobById(tr.current_job).unassigned_reason = null;
    }
    for (const [id, reason] of res.unassigned) Object.assign(jobById(id), { status: 'pending', tractor: null, start_t: null, end_t: null, eta_t: null, unassigned_reason: reason });
    ctx.released = released;
    refreshWeatherFlags();
    updateEstimates();
    const v = safetyViolations(w.tractors, w.jobs);
    if (v) { w.acc.violations += v; addLog({ kind: 'violation', rule: 'plan_invariants', tractor: null, detail: { count: v } }); }
    const entries = buildEntries();
    const ms = Math.max(1, Math.round((globalThis.performance ?? Date).now() - t0));
    const moved = [], retimed = [];
    for (const j of w.jobs) {
      if (!unfinished(j)) continue;
      const b = before.get(j.id);
      if (j.tractor && b?.tractor !== j.tractor) moved.push({ job: j.id, from: b?.tractor ?? null, to: j.tractor, progress_kept: r2(j.progress) });
      else if (j.tractor && b?.start != null && j.start_t != null && Math.abs(j.start_t - b.start) >= 5) retimed.push({ job: j.id, old_start_t: r1(b.start), new_start_t: r1(j.start_t) });
    }
    const version = ++w.planVersion;
    w.plan = { version, entries, solver: 'greedy', solve_ms: ms, solver_status: 'feasible', diff: { moved, retimed, dropped: [], added: ctx.added || [] } };
    w.acc.replanMs = ms; w.acc.rejected = res.rejected;
    const newStats = planStats(entries);
    const late = w.jobs.filter((j) => unfinished(j) && j.end_t != null && j.end_t > j.deadline_t + 1e-9);
    const facts = {
      event: ctx.event ?? null, moved,
      deadlines_missed: late.map((j) => j.id),
      travel_delta_min: Math.round(newStats.travel - oldStats.travel),
      idle_delta_min: Math.round(newStats.idle - oldStats.idle),
      unassigned: [...res.unassigned].map(([job, reason]) => ({ job, reason })),
      context: { makespan_old_t: r1(oldStats.makespan), makespan_new_t: r1(newStats.makespan), ...(ctx.facts || {}) },
    };
    if (ctx.released && ctx.released.length) {
      // what each paused tractor does now, and when the paused work is planned to resume (numbers for the text)
      facts.context.paused = ctx.released.map((p) => {
        const tr = trById(p.tractor), j = jobById(p.job), next = tr && (tr.current_job || tr.queue[0]);
        let nj = next ? jobById(next) : null;
        if (nj && !jobWeatherOk(w.wx, nj, w.t)) nj = null; // its next job also waits for weather: it did not switch
        return { ...p, block: j.block, rule: (sprayBlock(w.wx, j.block, w.t) || {}).rule ?? null, resume_t: r1(j.start_t), resume_tractor: j.tractor, deadline_t: j.deadline_t, switched_to: nj && nj.id !== j.id ? nj.id : null };
      });
    }
    if (trigger === 'weather_change') {
      const R = WEATHER_RULES.spray;
      facts.context.weather = { ...ctx.cur, prev_wind_mph: ctx.prev.wind_mph, until_t: r1(ctx.until), spray_min_wind_mph: R.min_wind_mph, spray_max_wind_mph: R.max_wind_mph, max_temp_f: R.max_temp_f,
        blocked_now: Object.fromEntries(Object.entries(ctx.blockedNow).filter(([, v]) => v).map(([b, v]) => [b, v.rule])) };
    }
    const expl = { id: 'X' + ++ctr.X, t: r2(w.t), trigger, text: explainText(trigger, ctx, facts, late), facts, plan_version: version };
    w.explanations.push(expl);
    if (trigger === 'initial_plan') addLog({ kind: 'plan', plan_version: version, solver: 'greedy', solve_ms: ms, assigned: w.jobs.filter((j) => j.tractor && unfinished(j)).length });
    else addLog({ kind: 'replan', trigger, plan_version: version, replan_ms: ms, changes: moved, safety: v ? 'fail' : 'pass', explanation_id: expl.id });
    emit('plan', w.plan);
    emit('explanation', expl);
    flushJobs({ force: true, always: true });
    return { version, unassigned: [...res.unassigned.keys()], explanation: expl };
  }

  // ---------------- explanation text (numbers only from facts / plan)
  const nameOf = (id) => trById(id)?.name ?? id;
  let lateCtxUnassigned = 0;
  function lateText(late, suffix) {
    if (!late.length) return lateCtxUnassigned ? ' Every assigned job still meets its deadline.' : ' All deadlines are still met.';
    const j = late[0];
    return ` ${j.label} will now miss its ${fmtClock(j.deadline_t)} deadline by about ${Math.round(j.end_t - j.deadline_t)} min.${suffix || ''}`;
  }
  function explainText(trigger, ctx, facts, late) {
    lateCtxUnassigned = facts.unassigned.length;
    const mv = facts.moved;
    const movedLabels = (list) => list.map((m) => jobById(m.job).label);
    switch (trigger) {
      case 'initial_plan': {
        const first = w.jobs.filter((j) => j.tractor).sort((a, b) => b.priority - a.priority || a.deadline_t - b.deadline_t)[0];
        const ntr = w.tractors.filter(schedulable).length;
        let s = `Morning plan ready. ${plural(w.jobs.length, 'job')} across ${plural(ntr, 'tractor')}.`;
        if (first) s += ` ${first.label} goes first on ${nameOf(first.tractor)} because it has the earliest high-priority deadline (${fmtClock(first.deadline_t)}).`;
        s += facts.unassigned.length ? ` ${plural(facts.unassigned.length, 'job')} cannot be assigned yet: ${facts.unassigned[0].reason}` : ' Safety check passed: every job has a compatible tractor.';
        return s;
      }
      case 'breakdown': {
        const tn = nameOf(ctx.tractor); const cj = ctx.job ? jobById(ctx.job) : null;
        let s;
        if (cj) {
          const m = mv.find((x) => x.job === cj.id), pct = Math.round((m ? m.progress_kept : cj.progress) * 100);
          if (m) {
            const to = trById(m.to);
            const others = w.tractors.filter((t) => t.id !== ctx.tractor && t.implements.includes(cj.implement));
            s = `${tn} broke down ${pct}% of the way through ${IMPL_VERB[cj.implement]} Block ${cj.block}. ${to.name} ${others.length === 1 ? 'has the only other ' : 'has a '}${IMPL_NAME[cj.implement]} and ${Math.round(to.fuel)}% fuel, so it finishes the remaining ${100 - pct}% starting at ${fmtClock(cj.start_t)}.`;
          } else s = `${tn} broke down ${pct}% of the way through ${IMPL_VERB[cj.implement]} Block ${cj.block}. ${jobById(cj.id).unassigned_reason ?? ''} It waits until a tractor is available.`;
        } else s = `${tn} broke down between jobs.`;
        const rest = mv.filter((m) => m.job !== ctx.job && m.from === ctx.tractor);
        if (rest.length) s += ` ${plural(rest.length, 'more job')} (${listText(movedLabels(rest))}) ${rest.length === 1 ? 'moves' : 'move'} to ${listText([...new Set(rest.map((m) => nameOf(m.to)))])} until ${tn} is repaired.`;
        const stuck = facts.unassigned.length; if (stuck) s += ` ${plural(stuck, 'job')} cannot be reassigned: ${facts.unassigned[0].reason}`;
        return s + lateText(late, ' Booking a mechanic can recover it.');
      }
      case 'block_route': {
        const c = ctx.facts || {};
        const s = c.rerouted ? `Farm road blocked ahead of ${nameOf(c.rerouted)}. The Navigation Agent rerouted it around the barrier, ${c.extra_min > 0 ? `adding about ${c.extra_min} min of travel` : 'with no extra travel time'}.` : 'Farm road blocked. No tractor was using it, and all future routes now avoid it.';
        return s + (late.length ? ` ${late[0].label} is now at risk of missing its deadline.` : ' No deadlines affected.');
      }
      case 'unblock_route': return `Farm road reopened (${plural(ctx.facts.cells.length, 'cell')}). Routes recomputed; ${plural(mv.length, 'job')} moved.` + lateText(late);
      case 'heat_alert': {
        const c = ctx.facts;
        return `Heat alert from the Agronomy Agent: ${c.temp_f}°F expected by ${fmtClock(c.at_t)}. Kaolin spraying for Blocks ${listText(HEAT_BLOCKS)} moves up to high priority and ahead in the queue, so the trees are coated before peak heat. ` +
          (c.raised.length ? `${plural(c.raised.length, 'job')} reordered.` : 'Those jobs were already underway or done.');
      }
      case 'priority_change': {
        const c = ctx.facts; const j = jobById(c.job);
        let s = `${j.label}: `;
        const parts = [];
        if (c.old_priority !== c.new_priority) parts.push(`priority ${c.old_priority} → ${c.new_priority}`);
        if (c.old_deadline_t !== c.new_deadline_t) parts.push(`deadline ${fmtClock(c.old_deadline_t)} → ${fmtClock(c.new_deadline_t)}`);
        if (c.old_pinned_to !== c.new_pinned_to) parts.push(c.new_pinned_to ? `pinned to ${nameOf(c.new_pinned_to)}` : 'unpinned');
        s += (parts.join(', ') || 'no change') + '.';
        s += j.tractor ? ` It now starts at ${fmtClock(j.start_t)} on ${nameOf(j.tractor)}.` : ` It is unassigned: ${j.unassigned_reason}`;
        if (mv.length) s += ` ${plural(mv.length, 'job')} moved between tractors.`;
        return s + lateText(late);
      }
      case 'tractor_added': {
        const tr = trById(ctx.tractor); const taken = mv.filter((m) => m.to === ctx.tractor);
        let s = `${tr.name} is ready at the depot with ${listText(tr.implements.map((i) => IMPL_NAME[i]))}.`;
        if (taken.length) {
          const from = [...new Set(taken.map((m) => m.from).filter(Boolean).map(nameOf))];
          s += ` It takes ${listText(movedLabels(taken))}${from.length ? ' from ' + listText(from) : ''}, because it can finish ${taken.length === 1 ? 'that job' : 'them'} sooner.`;
          const d = Math.round(facts.context.makespan_old_t - facts.context.makespan_new_t);
          if (d > 0) s += ` All work now finishes by ${fmtClock(facts.context.makespan_new_t)}, ${d} min earlier than before (${fmtClock(facts.context.makespan_old_t)}).`;
          else if (d < 0) s += ` The day's last job now ends at ${fmtClock(facts.context.makespan_new_t)}, ${-d} min later than before, but the moved jobs finish sooner.`;
          else s += ` The day's last job still ends at ${fmtClock(facts.context.makespan_new_t)}.`;
        } else s += ' No unstarted compatible work finishes sooner with it, so it stays on standby.';
        return s + lateText(late);
      }
      case 'tractor_removed': {
        const back = mv.filter((m) => m.from === ctx.tractor);
        return `${nameOf(ctx.tractor)} is leaving the fleet. ` + (back.length ? `${plural(back.length, 'job')} (${listText(movedLabels(back))}) ${back.length === 1 ? 'is' : 'are'} handed to ${listText([...new Set(back.map((m) => nameOf(m.to)))])}, keeping progress.` : 'It had no remaining work.') +
          (facts.unassigned.length ? ` ${plural(facts.unassigned.length, 'job')} wait: ${facts.unassigned[0].reason}` : '') + lateText(late);
      }
      case 'tractor_repaired': {
        const tn = nameOf(ctx.tractor); const back = mv.filter((m) => m.to === ctx.tractor);
        return `${tn} repaired at ${fmtClock(w.t)}. ` + (back.length ? `${plural(back.length, 'job')} (${listText(movedLabels(back))}) ${back.length === 1 ? 'moves' : 'move'} back to it, so work runs in parallel again.` : `No remaining work finishes sooner on ${tn}, so it stays on standby.`) + lateText(late);
      }
      case 'weather_change': return weatherText(ctx, facts, late);
      default: return `Plan updated (${trigger}). ${plural(mv.length, 'job')} moved.` + lateText(late);
    }
  }

  /** "Wind rose to 14 mph at 1:00 PM, above the 10 mph spray limit. Tractor 3 paused spraying Block G at 55% and
   *  switched to hauling bins in Block B. Spraying Block G resumes at 3:00 PM, still before its 4:40 PM deadline." */
  function weatherText(ctx, facts, late) {
    const c = ctx.cur, R = WEATHER_RULES.spray, at = fmtClock(w.t);
    const blocked = Object.entries(ctx.blockedNow).filter(([, v]) => v);
    const sens = blocked.find(([, v]) => v.rule === 'sensitive_area');
    let s;
    if (c.wind_mph > R.max_wind_mph) s = `Wind ${c.wind_mph > ctx.prev.wind_mph ? 'rose' : 'is'} to ${c.wind_mph} mph at ${at}, above the ${R.max_wind_mph} mph spray limit.`;
    else if (c.wind_mph < R.min_wind_mph) s = `Wind dropped to ${c.wind_mph} mph at ${at}, under the ${R.min_wind_mph} mph minimum (inversion risk), so no spraying.`;
    else if (c.temp_f > R.max_temp_f) s = `It is ${c.temp_f}°F at ${at}, above the ${R.max_temp_f}°F spray product limit.`;
    else if (sens) s = `Wind is now ${c.wind_mph} mph from the ${compassName(c.wind_from_deg)}, blowing toward the ${ctx.blockedNow[sens[0]].what} by Block ${sens[0]}. Spraying there is off; other blocks stay inside the ${R.min_wind_mph} to ${R.max_wind_mph} mph range.`;
    else s = `Wind eased to ${c.wind_mph} mph from the ${compassName(c.wind_from_deg)} at ${at}, inside the ${R.min_wind_mph} to ${R.max_wind_mph} mph spray range.${blocked.length ? '' : ' Spraying is allowed on every block.'}`;
    const paused = facts.context.paused || [];
    for (const p of paused) {
      const tr = nameOf(p.tractor), j = jobById(p.job);
      const nj = p.switched_to ? jobById(p.switched_to) : null;
      const pct = Math.min(99, Math.round(p.progress * 100));
      s += ` ${tr} ${p.was === 'working' ? `paused spraying Block ${p.block} at ${pct}%` : p.was === 'waiting_weather' ? `stopped waiting at Block ${p.block}` : `stopped heading to spray Block ${p.block}`}`;
      s += nj ? ` and switched to ${IMPL_VERB[nj.implement]} ${nj.implement === 'bin_trailer' ? 'bins ' : ''}in Block ${nj.block}.` : ' and waits for the wind.';
      if (p.resume_t != null && j.tractor) s += ` Spraying Block ${p.block} resumes at ${fmtClock(p.resume_t)}${j.tractor !== p.tractor ? ' on ' + nameOf(j.tractor) : ''}${j.end_t != null && j.end_t <= j.deadline_t + 1e-9 ? `, still before its ${fmtClock(j.deadline_t)} deadline` : ''}.`;
      else if (j.unassigned_reason) s += ' ' + j.unassigned_reason;
    }
    const resumed = w.tractors.filter((tr) => tr.status === 'waiting_weather' && tr.current_job && jobWeatherOk(w.wx, jobById(tr.current_job), w.t));
    for (const tr of resumed) { const j = jobById(tr.current_job); s += ` ${tr.name} resumes spraying Block ${j.block}${j.progress > 0 ? ` at ${Math.min(99, Math.round(j.progress * 100))}%` : ''}.`; }
    const back = facts.moved.filter((m) => jobById(m.job).implement === 'sprayer' && m.progress_kept > 0 && !paused.some((p) => p.job === m.job));
    for (const m of back) { const j = jobById(m.job); s += ` ${j.label} (${Math.round(m.progress_kept * 100)}% done) moves to ${nameOf(m.to)}, restarting at ${fmtClock(j.start_t)}.`; }
    if (!paused.length && !resumed.length && !back.length) {
      s += facts.moved.length || w.plan?.diff?.retimed?.length ? ' Spray jobs were re-timed around the new conditions.' : ' No spraying was underway, so nothing had to stop.';
    }
    return s + lateText(late);
  }

  // ---------------- operations (§13)
  function setOp(op, patch) { Object.assign(op, patch, { updated_t: r2(w.t) }); emit('operation', op); }
  /** §13.3 idempotency: same key + same endpoint/body -> the ORIGINAL operation (current status), regardless of
   *  what state has changed since; same key + different endpoint/body -> CONFLICT. Null when the key is new.
   *  Mutations call this BEFORE validating state, so a retry after success never turns into a 4xx. */
  function replay(meta) {
    if (!meta || !meta.key) return null;
    const prev = idem.get(meta.key);
    if (!prev) return null;
    if (prev.sig === meta.sig) return clone(prev.op);
    throw apiError('CONFLICT', 'This idempotency key was already used for a different request.', { idempotency_key: meta.key });
  }
  function enqueue(kind, source, message, exec, meta = {}) {
    const again = replay(meta); if (again) return again;
    if (meta.supersede) {
      for (let i = queue.length - 1; i >= 0; i--) if (meta.supersede(queue[i].meta)) { setOp(queue[i].op, { status: 'superseded', message: 'Replaced by a newer request.' }); queue.splice(i, 1); }
    }
    const op = { id: 'O' + ++ctr.O, kind, status: 'queued', source, created_t: r2(w.t), updated_t: r2(w.t), message, plan_version: null, solver_status: null, result: null, error: null };
    ops.push(op); queue.push({ op, exec, meta });
    if (meta.key) idem.set(meta.key, { sig: meta.sig, op });
    emit('operation', op);
    return clone(op);
  }
  function processQueue() {
    while (queue.length) {
      const { op, exec } = queue.shift();
      setOp(op, { status: 'running' });
      try {
        if (failNext && (op.kind === 'run' || op.kind === 'replan')) { failNext = false; throw { ...apiError('SAFETY_REJECTED', 'No validated recovery plan could be applied.', { rule: 'plan_validation' }), solver_status: 'no_feasible_plan' }; }
        const r = exec(op) || {};
        setOp(op, { status: 'succeeded', plan_version: r.plan_version ?? null, solver_status: r.solver_status ?? null, result: r.result, message: r.message || op.message, error: null });
      } catch (e) {
        const err = e && e.code ? apiError(e.code, e.message, e.details || {}) : apiError('INTERNAL', String(e?.message || e), {});
        if (!(e && e.code)) console.error('[mock] op failed', e);
        setOp(op, { status: 'failed', result: null, plan_version: null, solver_status: e?.solver_status ?? null, error: err, message: err.message });
      }
    }
  }
  const planResult = (r, message) => ({ plan_version: r.version, solver_status: 'feasible', result: { applied_plan_version: r.version, unassigned_job_ids: r.unassigned }, message });
  const afterReplan = () => { flushFleet(); emitMetrics(); };

  // ---------------- simulation step (port of the UI mock's step())
  function stepSim(dt) {
    w.t = Math.min(DAY_MIN, w.t + dt);
    const open = w.jobs.filter(unfinished);
    for (const tr of w.tractors) {
      if (!schedulable(tr)) continue;
      if (!tr.current_job) {
        if (tr.queue.length) {
          const j = jobById(tr.queue.shift());
          tr.current_job = j.id; j.status = 'traveling'; j.tractor = tr.id;
          tr.path = routeTo(tr.x, tr.y, entryPoint(j), w.blocked); tr.pi = 1; tr.status = 'traveling';
        } else {
          tr.status = 'idle';
          if (open.some((j) => tr.implements.includes(j.implement))) w.acc.idle += dt;
          continue;
        }
      }
      const j = jobById(tr.current_job);
      if (tr.status === 'traveling' || tr.status === 'ready' || tr.status === 'idle') {
        if (tr.status !== 'traveling') { tr.status = 'traveling'; if (!tr.path.length) { tr.path = routeTo(tr.x, tr.y, entryPoint(j), w.blocked); tr.pi = 1; } }
        let d = dt * 0.5 * tr.speed; w.acc.travel += dt; tr.fuel = Math.max(5, tr.fuel - dt * 0.05);
        while (d > 0 && tr.pi < tr.path.length) {
          const [cx, cy] = tr.path[tr.pi], dx = cx - tr.x, dy = cy - tr.y, L = Math.hypot(dx, dy);
          if (L < 1e-6) { tr.pi++; continue; }
          tr.hd = headingDeg(dx, dy);
          if (L <= d) { tr.x = cx; tr.y = cy; tr.pi++; d -= L; } else { tr.x += (dx / L) * d; tr.y += (dy / L) * d; d = 0; }
        }
        if (tr.pi >= tr.path.length) {
          tr.path = []; tr.pi = 0;
          if (jobWeatherOk(w.wx, j, w.t)) startWork(tr, j); else holdForWeather(tr, j);
        }
      } else if (tr.status === 'waiting_weather') {
        if (jobWeatherOk(w.wx, j, w.t)) startWork(tr, j);
      } else if (tr.status === 'working' && !jobWeatherOk(w.wx, j, w.t)) {
        holdForWeather(tr, j); // live guard: sections off, tractor holds, progress kept
      } else if (tr.status === 'working') {
        const inc = Math.min(dt / j.duration_min, 1 - j.progress);
        j.progress += inc; w.acc.productive += inc * j.duration_min; tr.fuel = Math.max(5, tr.fuel - dt * 0.07);
        const [nx, ny] = sweepPos(j.block, j.progress);
        if (Math.hypot(nx - tr.x, ny - tr.y) > 1e-4) tr.hd = headingDeg(nx - tr.x, ny - tr.y);
        tr.x = nx; tr.y = ny;
        if (j.progress >= 1 - 1e-9) {
          j.progress = 1; j.status = 'done'; j._e = w.t; j._priAtDone = j.priority;
          j.start_t = j._s; j.end_t = j._e; j.eta_t = j._e; j.unassigned_reason = null;
          tr.current_job = null; tr.status = 'idle';
          addLog({ kind: 'job_done', job: j.id, tractor: tr.id, on_time: w.t <= j.deadline_t + 1e-9 });
          jobDoneFlag = true;
        }
      }
    }
  }

  function startWork(tr, j) {
    tr.status = 'working'; j.status = 'working'; j.weather_blocked = false;
    if (j._s == null) { j._s = w.t; addLog({ kind: 'job_started', job: j.id, tractor: tr.id }); }
  }
  function holdForWeather(tr, j) {
    tr.status = 'waiting_weather'; j.status = j.progress > 0 ? 'paused' : 'assigned'; j.weather_blocked = true;
  }

  function endDay() {
    w.ended = true; w.playing = false;
    for (const tr of w.tractors) {
      if (tr.current_job) { const j = jobById(tr.current_job); if (j && unfinished(j)) j.status = 'paused'; }
      if (tr.status === 'traveling' || tr.status === 'working' || tr.status === 'waiting_weather') tr.status = 'idle';
    }
    const m = metricsOut().ours; const left = w.jobs.filter(unfinished);
    const text = `Day complete. ${m.completed} of ${m.jobs_total} jobs finished, ${m.on_time} on time, with ${plural(m.violations, 'constraint violation')}.` +
      (left.length ? ` ${plural(left.length, 'job')} (${listText(left.map((j) => j.label))}) carry over to tomorrow.` : '');
    const expl = { id: 'X' + ++ctr.X, t: r2(w.t), trigger: 'end_of_day', text, facts: { event: null, moved: [], deadlines_missed: [], travel_delta_min: 0, idle_delta_min: 0, unassigned: [], context: { completed: m.completed, on_time: m.on_time, unfinished: left.map((j) => j.id) } }, plan_version: w.planVersion };
    w.explanations.push(expl);
    emit('explanation', expl);
    flushJobs({ force: true }); flushFleet(); emitMetrics(); emitClock();
  }

  // ---------------- tick
  function tick() {
    tickN++; realMs += TICK_MS;
    processQueue();
    for (const tr of [...w.tractors]) {
      if (tr.status === 'starting' && realMs >= tr.readyAt) {
        tr.status = 'ready'; addLog({ kind: 'tractor_ready', tractor: tr.id }); flushFleet();
        replan('tractor_added', { tractor: tr.id, event: { type: 'tractor_added', tractor: tr.id } }); afterReplan();
      } else if (tr.status === 'removing' && realMs >= tr.removeAt) {
        w.tractors = w.tractors.filter((x) => x !== tr); tracked.poses.delete(tr.id);
        addLog({ kind: 'tractor_removed', tractor: tr.id }); flushFleet(); emit('capacity', capacityOut());
      }
    }
    if (w.playing && !w.ended) {
      let dt = (pace * w.speed * TICK_MS) / 1000;
      while (dt > 1e-9 && w.t < DAY_MIN) { const s = Math.min(1, dt); stepSim(s); dt -= s; }
    }
    for (const tr of w.tractors) {
      const b = tr.booking; if (!b) continue;
      if (tr.status === 'repair_scheduled' && w.t >= b.arrival_t) tr.status = 'repairing';
      if (autoRepair && !b.autoSent && w.t >= b.estimated_return_t) { b.autoSent = true; api.postEvent({ type: 'tractor_repaired', tractor: tr.id }).catch(() => {}); }
    }
    if (w.t >= DAY_MIN && !w.ended) endDay();
    if (tickN % 10 === 0) updateEstimates();
    refreshWeatherFlags();
    flushJobs(); flushFleet(); flushWeather();
    if (jobDoneFlag || tickN % 20 === 0) { jobDoneFlag = false; emitMetrics(); }
    if (tickN % 2 === 0) flushPoses();
    if (tickN % 10 === 0) emitClock();
  }

  // ---------------- event executors
  function doBooking(tr, mech) {
    const arrival = r1(w.t + mech.eta_min), ret = r1(arrival + mech.repair_min_estimate);
    tr.status = 'repair_scheduled'; tr.available_from_t = ret;
    tr.booking = { mechanic: mech.id, arrival_t: arrival, estimated_return_t: ret, autoSent: false };
    const before = w.pending.length; w.pending = w.pending.filter((p) => !(p.kind === 'mechanic' && p.tractor === tr.id));
    addLog({ kind: 'mechanic_booked', tractor: tr.id, mechanic: mech.id, name: mech.name, arrival_t: arrival, estimated_return_t: ret, from: { ...VAN_FROM } });
    if (w.pending.length !== before) emitPending();
    flushFleet();
    return { tractor: tr.id, mechanic: mech.id, arrival_t: arrival, estimated_return_t: ret };
  }
  function applyJobPatch(j, patch, event) {
    if (patch.pinned_to) {
      const p = trById(patch.pinned_to);
      if (!p.implements.includes(j.implement)) throw { ...apiError('SAFETY_REJECTED', `Can't pin ${j.label} to ${p.name}: it has no ${IMPL_NAME[j.implement]}.`, { rule: 'implement_match' }), solver_status: 'no_feasible_plan' };
    }
    const facts = { job: j.id, old_priority: j.priority, old_deadline_t: j.deadline_t, old_pinned_to: j.pinned_to };
    if (patch.priority !== undefined) j.priority = patch.priority;
    if (patch.deadline_t !== undefined) j.deadline_t = patch.deadline_t;
    if (patch.pinned_to !== undefined) j.pinned_to = patch.pinned_to;
    Object.assign(facts, { new_priority: j.priority, new_deadline_t: j.deadline_t, new_pinned_to: j.pinned_to, original_deadline_t: j._origDeadline, reason: patch.reason ?? null });
    addLog({ kind: 'event', type: 'priority_change', job: j.id, priority: j.priority, deadline_t: j.deadline_t, old_priority: facts.old_priority, old_deadline_t: facts.old_deadline_t, original_deadline_t: j._origDeadline, pinned_to: j.pinned_to, reason: patch.reason ?? null });
    const r = replan('priority_change', { event: { type: 'priority_change', job: j.id, ...event }, facts });
    afterReplan();
    return planResult(r, `${j.label} updated; plan v${r.version} applied.`);
  }
  function validateJobPatch(id, patch) {
    const j = jobById(id);
    if (!j) throw apiError('NOT_FOUND', `Job ${id} does not exist.`, { job: id });
    if (!patch || typeof patch !== 'object') throw apiError('INVALID_INPUT', 'Body must be an object.', {});
    if (!unfinished(j)) throw apiError('CONFLICT', `${j.label} is already ${j.status}.`, { job: id, status: j.status });
    if (patch.priority !== undefined && !(Number.isInteger(patch.priority) && patch.priority >= 1 && patch.priority <= 3)) throw apiError('INVALID_INPUT', 'Priority must be 1, 2 or 3.', { field: 'priority' });
    if (patch.deadline_t !== undefined && !(typeof patch.deadline_t === 'number' && patch.deadline_t >= 0)) throw apiError('INVALID_INPUT', 'Deadline must be a farm time in minutes (0 or more).', { field: 'deadline_t' });
    if (patch.pinned_to !== undefined && patch.pinned_to !== null && !trById(patch.pinned_to)) throw apiError('NOT_FOUND', `Tractor ${patch.pinned_to} does not exist.`, { field: 'pinned_to' });
    return j;
  }
  const validCell = (c) => Array.isArray(c) && c.length === 2 && Number.isInteger(c[0]) && Number.isInteger(c[1]) && c[0] >= 0 && c[0] < GW && c[1] >= 0 && c[1] < GH;
  function rerouteTraveling() {
    const out = new Map();
    for (const x of w.tractors) {
      if (x.status !== 'traveling' || x.pi >= x.path.length) continue;
      const old = polyLen([[x.x, x.y], ...x.path.slice(x.pi)]), tg = x.path[x.path.length - 1];
      x.path = routeTo(x.x, x.y, tg, w.blocked); x.pi = 1;
      out.set(x.id, travelMinutes(polyLen([[x.x, x.y], ...x.path.slice(1)]) - old, x.speed));
    }
    return out;
  }

  // ---------------- API (contract §5 + §13), all async (errors reject)
  const sigOf = (endpoint, body) => endpoint + ':' + JSON.stringify(body ?? null);
  const api = {
    async run(mode = 'ours', o = {}) {
      if (!['ours', 'baseline', 'both'].includes(mode)) throw apiError('INVALID_INPUT', 'Mode must be ours, baseline or both.', { field: 'mode' });
      return enqueue('run', 'run', `Run reset requested (mode ${mode}).`, () => {
        resetWorld(mode);
        emit('snapshot', snapshotOut()); primeTrackers();
        const r = replan('initial_plan', {}); afterReplan(); emitClock();
        return planResult(r, `New run started; plan v${r.version} applied.`);
      }, { key: o.idempotencyKey, sig: sigOf('run', { mode }), supersede: () => true });
    },
    async setClock(body = {}) {
      if (body.speed !== undefined && !(typeof body.speed === 'number' && body.speed > 0 && body.speed <= 100)) throw apiError('INVALID_INPUT', 'Speed must be a number between 0 and 100.', { field: 'speed' });
      if (body.playing !== undefined && typeof body.playing !== 'boolean') throw apiError('INVALID_INPUT', 'playing must be true or false.', { field: 'playing' });
      if (body.speed !== undefined) w.speed = body.speed;
      if (body.playing !== undefined) w.playing = body.playing && !w.ended;
      emitClock();
      return clockOut();
    },
    async postEvent(body, o = {}) {
      if (!body || typeof body.type !== 'string') throw apiError('INVALID_INPUT', 'Event needs a type.', { field: 'type' });
      const meta = { key: o.idempotencyKey, sig: sigOf('events', body) };
      const again = replay(meta); if (again) return again;
      const ev = body;
      switch (ev.type) {
        case 'breakdown': {
          const tr = trById(ev.tractor);
          if (!tr) throw apiError('NOT_FOUND', `Tractor ${ev.tractor} does not exist.`, { tractor: ev.tractor });
          if (!schedulable(tr)) throw apiError('CONFLICT', `${tr.name} is not running (${tr.status}).`, { status: tr.status });
          const issue = ev.issue || 'hydraulic leak';
          // §13.2: stop immediately on accept
          const cj = tr.current_job;
          tr.status = 'broken'; tr.path = []; tr.pi = 0;
          if (cj) jobById(cj).status = 'paused';
          addLog({ kind: 'event', type: 'breakdown', tractor: tr.id, issue });
          flushFleet(); flushJobs({ force: true });
          return enqueue('replan', 'events', `Breakdown recorded for ${tr.name}. Replanning unfinished work.`, () => {
            const r = replan('breakdown', { tractor: tr.id, job: cj, event: { type: 'breakdown', tractor: tr.id, issue } });
            w.pending.push({ id: 'P' + ++ctr.P, kind: 'mechanic', title: `Book a mechanic for ${tr.name}?`, text: `${tr.name} is down with a ${issue}. Sample listings, ranked by arrival time, rating and ag experience. Nothing is booked for real.`, plan_version: null, tractor: tr.id, issue, options: clone(MECHANICS) });
            emitPending(); afterReplan();
            return planResult(r, `Work reassigned after ${tr.name} breakdown; plan v${r.version} applied.`);
          }, meta);
        }
        case 'block_route': case 'unblock_route': {
          if (ev.cells !== undefined && ev.cells !== null && !(Array.isArray(ev.cells) && ev.cells.every(validCell))) throw apiError('INVALID_INPUT', 'cells must be a list of [x, y] grid cells.', { field: 'cells' });
          const blocking = ev.type === 'block_route';
          if (!blocking && !(ev.cells || []).length) throw apiError('INVALID_INPUT', 'unblock_route needs cells.', { field: 'cells' });
          return enqueue('replan', 'events', blocking ? 'Road block recorded. Rerouting.' : 'Road reopened. Rerouting.', () => {
            let cells = (ev.cells || []).map((c) => [c[0], c[1]]); let who = null;
            if (blocking && !cells.length) {
              const tr = w.tractors.find((x) => x.status === 'traveling' && x.path.length - x.pi > 5);
              if (tr) {
                const rem = tr.path.slice(tr.pi + 1, tr.path.length - 2).filter(([x, y]) => Number.isInteger(x) && Number.isInteger(y) && isRoad(x, y) && !w.blocked.has(x + ',' + y));
                const m = Math.floor(rem.length / 2); cells = rem.slice(m, m + 2); if (cells.length) who = tr.id;
              }
              if (!cells.length) cells = [[7, 6], [8, 6]].filter((c) => !w.blocked.has(c[0] + ',' + c[1]));
              if (!cells.length) throw apiError('CONFLICT', 'No suitable road cell is left to block.', {});
            }
            cells.forEach((c) => (blocking ? w.blocked.add(c[0] + ',' + c[1]) : w.blocked.delete(c[0] + ',' + c[1])));
            addLog({ kind: 'event', type: ev.type, cells });
            const deltas = rerouteTraveling();
            if (blocking && !who) for (const [id, d] of deltas) if (d > 0.01) { who = id; break; }
            const extra = who ? Math.max(0, Math.round(deltas.get(who) ?? 0)) : 0;
            const r = replan(ev.type, { event: { type: ev.type, cells }, facts: { cells, rerouted: who, extra_min: extra } });
            afterReplan();
            return planResult(r, blocking ? `Road blocked; ${who ? nameOf(who) + ' rerouted (+' + extra + ' min)' : 'no tractor affected'}.` : 'Road reopened; routes recomputed.');
          }, meta);
        }
        case 'heat_alert': {
          const temp_f = ev.temp_f ?? 112, at_t = ev.at_t ?? 480;
          if (typeof temp_f !== 'number' || typeof at_t !== 'number') throw apiError('INVALID_INPUT', 'temp_f and at_t must be numbers.', {});
          return enqueue('replan', 'events', `Heat alert (${temp_f}°F) recorded. Reprioritising.`, () => {
            w.heat = true;
            const raised = w.jobs.filter((j) => HEAT_BLOCKS.includes(j.block) && j.implement === 'sprayer' && (j.status === 'assigned' || j.status === 'pending') && j.progress === 0 && j.priority < 3);
            raised.forEach((j) => { j.priority = 3; });
            addLog({ kind: 'event', type: 'heat_alert', temp_f, at_t, jobs: raised.map((j) => j.id) });
            w.wx.script = w.wx.script.map((p) => (p.t >= at_t - 60 && p.t <= at_t + 60 ? { ...p, temp_f } : p)); w.wx.wins = null;
            addLog({ kind: 'weather', temp_f, at_t });
            const r = replan('heat_alert', { event: { type: 'heat_alert', temp_f, at_t }, facts: { temp_f, at_t, raised: raised.map((j) => j.id) } });
            flushWeather(true); afterReplan();
            return planResult(r, `${plural(raised.length, 'job')} raised to high priority.`);
          }, meta);
        }
        case 'priority_change': {
          const j = validateJobPatch(ev.job, { priority: ev.priority, deadline_t: ev.deadline_t });
          const patch = {}; if (ev.priority !== undefined) patch.priority = ev.priority; if (ev.deadline_t !== undefined) patch.deadline_t = ev.deadline_t; if (ev.reason) patch.reason = ev.reason;
          return enqueue('replan', 'events', `${j.label} change recorded. Replanning.`, () => applyJobPatch(j, patch, { reason: ev.reason ?? null }), { ...meta, job: j.id, supersede: (m) => m.job === j.id });
        }
        case 'tractor_repaired': {
          const tr = trById(ev.tractor);
          if (!tr) throw apiError('NOT_FOUND', `Tractor ${ev.tractor} does not exist.`, { tractor: ev.tractor });
          if (!['broken', 'awaiting_mechanic', 'repair_scheduled', 'repairing'].includes(tr.status)) throw apiError('CONFLICT', `${tr.name} is not down (${tr.status}).`, { status: tr.status });
          return enqueue('replan', 'events', `${tr.name} returned to service. Replanning.`, () => {
            tr.status = 'idle'; tr.available_from_t = null; tr.booking = null;
            const n = w.pending.length; w.pending = w.pending.filter((p) => !(p.kind === 'mechanic' && p.tractor === tr.id));
            addLog({ kind: 'tractor_repaired', tractor: tr.id });
            const r = replan('tractor_repaired', { tractor: tr.id, event: { type: 'tractor_repaired', tractor: tr.id } });
            if (n !== w.pending.length) emitPending();
            afterReplan();
            return planResult(r, `${tr.name} back in service; plan v${r.version} applied.`);
          }, meta);
        }
        case 'weather_change': {
          const keys = ['wind_mph', 'wind_from_deg', 'temp_f', 'rain_prob'];
          if (keys.some((k) => ev[k] !== undefined && typeof ev[k] !== 'number')) throw apiError('INVALID_INPUT', 'Weather values must be numbers.', {});
          if (ev.wind_mph !== undefined && (ev.wind_mph < 0 || ev.wind_mph > 150)) throw apiError('INVALID_INPUT', 'wind_mph must be 0 to 150.', { field: 'wind_mph' });
          if (ev.rain_prob !== undefined && (ev.rain_prob < 0 || ev.rain_prob > 100)) throw apiError('INVALID_INPUT', 'rain_prob must be 0 to 100.', { field: 'rain_prob' });
          return enqueue('replan', 'events', 'Weather change recorded. Rechecking spray windows.', () => {
            const prev = wxAt(w.wx, w.t);
            const cur = Object.fromEntries(keys.map((k) => [k, ev[k] !== undefined ? ev[k] : prev[k]]));
            cur.wind_from_deg = ((cur.wind_from_deg % 360) + 360) % 360;
            // the new reading holds for override_hold_min (or until the next weather_change), then the script resumes
            for (const o of w.wx.overrides) o.to = Math.min(o.to, w.t);
            w.wx.overrides = w.wx.overrides.filter((o) => o.to > o.from + 1e-9);
            const until = Math.min(DAY_MIN, w.t + WEATHER_RULES.override_hold_min);
            w.wx.overrides.push({ from: w.t, to: until, v: { t: r2(w.t), ...cur } }); w.wx.wins = null;
            addLog({ kind: 'event', type: 'weather_change', ...cur });
            addLog({ kind: 'weather', ...cur, until_t: r1(until) });
            const blockedNow = Object.fromEntries(BLOCKS.map((b) => [b.id, sprayBlock(w.wx, b.id, w.t)]));
            const r = replan('weather_change', { event: { type: 'weather_change', ...cur }, prev: { ...prev }, cur, until, blockedNow });
            flushWeather(true); afterReplan();
            const paused = r.explanation.facts.context.paused || [];
            return planResult(r, paused.length ? `Spraying paused on ${listText(paused.map((p) => nameOf(p.tractor)))}; plan v${r.version} applied.` : `Spray windows rechecked; plan v${r.version} applied.`);
          }, meta);
        }
        default:
          throw apiError('INVALID_INPUT', `The mock does not support event type "${ev.type}". Use POST /fleet for tractors.`, { field: 'type' });
      }
    },
    async patchJob(id, patch, o = {}) {
      const pick = (src) => { const c = {}; ['priority', 'deadline_t', 'pinned_to'].forEach((k) => { if (src && src[k] !== undefined) c[k] = src[k]; }); return c; };
      const again = replay({ key: o.idempotencyKey, sig: sigOf('job_patch:' + id, pick(patch)) }); if (again) return again;
      const j = validateJobPatch(id, patch);
      const clean = pick(patch);
      return enqueue('replan', 'job_patch', `${j.label} edit received. Replanning unfinished work.`, () => applyJobPatch(j, clean, {}),
        { key: o.idempotencyKey, sig: sigOf('job_patch:' + id, clean), job: j.id, supersede: (m) => m.job === j.id });
    },
    async addTractor(entry = {}) {
      const impls = entry.implements;
      if (!Array.isArray(impls) || !impls.length || !impls.every((i) => IMPLEMENTS.includes(i))) throw apiError('INVALID_INPUT', `Implements must be a non-empty list of ${IMPLEMENTS.join(', ')}.`, { field: 'implements' });
      if (entry.id != null && (typeof entry.id !== 'string' || !/^T\d+$/.test(entry.id))) throw apiError('INVALID_INPUT', 'Tractor id must look like T4.', { field: 'id' });
      if (entry.id && trById(entry.id)) throw apiError('CONFLICT', `Tractor ${entry.id} already exists.`, { tractor: entry.id });
      if (entry.start && !(typeof entry.start.x === 'number' && typeof entry.start.y === 'number' && entry.start.x >= 0 && entry.start.x <= GW - 1 && entry.start.y >= 0 && entry.start.y <= GH - 1)) throw apiError('INVALID_INPUT', 'start must be a grid point inside the farm.', { field: 'start' });
      if (entry.fuel_pct !== undefined && !(typeof entry.fuel_pct === 'number' && entry.fuel_pct >= 0 && entry.fuel_pct <= 100)) throw apiError('INVALID_INPUT', 'fuel_pct must be 0 to 100.', { field: 'fuel_pct' });
      if (w.tractors.length >= POOL_MAX) throw apiError('AT_CAPACITY', `The compute pool is full (${POOL_MAX} tractors).`, { max: POOL_MAX });
      let id = entry.id; if (!id) { let n = 1; while (trById('T' + n)) n++; id = 'T' + n; }
      const tr = newTractor({ ...entry, id, name: entry.name || 'Tractor ' + idNum(id), status: 'starting' }, w.created++);
      tr.readyAt = realMs + 3000;
      w.tractors.push(tr);
      addLog({ kind: 'tractor_added', tractor: id, host: 'mock', endpoint: entry.endpoint ?? 'auto' });
      flushFleet(); emit('capacity', capacityOut());
      return { tractor: tractorOut(tr) };
    },
    async removeTractor(id) {
      const tr = trById(id);
      if (!tr) throw apiError('NOT_FOUND', `Tractor ${id} does not exist.`, { tractor: id });
      if (tr.status === 'removing') return { ok: true };
      const wasStarting = tr.status === 'starting';
      if (tr.current_job) jobById(tr.current_job).status = 'paused';
      tr.status = 'removing'; tr.removeAt = realMs + 1500; tr.path = []; tr.pi = 0;
      flushFleet(); flushJobs({ force: true });
      if (!wasStarting) { replan('tractor_removed', { tractor: id, event: { type: 'tractor_removed', tractor: id } }); afterReplan(); }
      return { ok: true };
    },
    async why(jobId) {
      const j = jobById(jobId);
      if (!j) throw apiError('NOT_FOUND', `Job ${jobId} does not exist.`, { job: jobId });
      if (!unfinished(j)) return { job: j.id, chosen: j.tractor, options: j.tractor ? [{ tractor: j.tractor, feasible: true, reason: null, finish_t: r1(j._e ?? j.end_t), travel_delta_min: 0, idle_delta_min: 0, deadlines_missed: [] }] : [], method: 'counterfactual' };
      const base = counterfactual(null, null);
      const options = w.tractors.map((tr) => {
        const no = (reason) => ({ tractor: tr.id, feasible: false, reason, finish_t: null, travel_delta_min: null, idle_delta_min: null, deadlines_missed: [] });
        if (!tr.implements.includes(j.implement)) return no('No ' + IMPL_NAME[j.implement]);
        if (!schedulable(tr)) return no(statusReason(tr));
        if (tr.id === j.tractor) return { tractor: tr.id, feasible: true, reason: null, finish_t: r1(j.end_t), travel_delta_min: 0, idle_delta_min: 0, deadlines_missed: base.late };
        const cf = counterfactual(j.id, tr.id);
        if (cf.finish == null) return no('Cannot fit this job');
        return { tractor: tr.id, feasible: true, reason: null, finish_t: r1(cf.finish), travel_delta_min: Math.round(cf.travel - base.travel), idle_delta_min: Math.round(cf.idle - base.idle), deadlines_missed: cf.late };
      });
      return { job: j.id, chosen: j.tractor, options, method: 'counterfactual' };
    },
    async mechanics(tractorId) {
      const tr = trById(tractorId);
      if (!tr) throw apiError('NOT_FOUND', `Tractor ${tractorId} does not exist.`, { tractor: tractorId });
      addLog({ kind: 'mechanic_search', tractor: tr.id, results: MECHANICS.length });
      return { options: clone(MECHANICS) };
    },
    async bookMechanic(tractorId, mechanicId, o = {}) {
      const meta = { key: o.idempotencyKey, sig: sigOf('book', { tractorId, mechanicId }) };
      const again = replay(meta); if (again) return again;
      const tr = trById(tractorId);
      if (!tr) throw apiError('NOT_FOUND', `Tractor ${tractorId} does not exist.`, { tractor: tractorId });
      const mech = MECHANICS.find((m) => m.id === mechanicId);
      if (!mech) throw apiError('NOT_FOUND', `Mechanic ${mechanicId} does not exist.`, { mechanic: mechanicId });
      if (!['broken', 'awaiting_mechanic'].includes(tr.status)) throw apiError('CONFLICT', `${tr.name} does not need a mechanic (${tr.status}).`, { status: tr.status });
      return enqueue('repair_booking', 'mechanics_book', `Booking ${mech.name} for ${tr.name}.`, () => {
        if (!['broken', 'awaiting_mechanic'].includes(tr.status)) throw apiError('CONFLICT', `${tr.name} no longer needs a mechanic.`, { status: tr.status });
        const result = doBooking(tr, mech);
        return { result, message: `${mech.name} booked for ${tr.name}, arriving ${fmtClock(result.arrival_t)}.` };
      }, meta);
    },
    async approve(id, decision, o = {}) {
      const meta = { key: o.idempotencyKey, sig: sigOf('approve', { id, decision }) };
      const again = replay(meta); if (again) return again;
      const p = w.pending.find((x) => x.id === id);
      if (!p) throw apiError('NOT_FOUND', `Nothing pending with id ${id}.`, { id });
      if (!['approve', 'override'].includes(decision)) throw apiError('INVALID_INPUT', 'Decision must be approve or override.', { field: 'decision' });
      return enqueue('approval', 'approve', `Decision ${decision} on ${id}.`, () => {
        if (!w.pending.includes(p)) throw apiError('CONFLICT', `${id} was already resolved.`, { id });
        let message;
        if (p.kind === 'mechanic' && decision === 'approve') {
          const tr = trById(p.tractor), mech = p.options.find((m) => m.recommended) || p.options[0];
          if (tr && ['broken', 'awaiting_mechanic'].includes(tr.status)) { doBooking(tr, mech); message = `${mech.name} booked for ${tr.name}.`; }
        }
        if (w.pending.includes(p)) { w.pending = w.pending.filter((x) => x !== p); emitPending(); }
        addLog({ kind: 'operator_action', pending: id, decision, tractor: p.tractor ?? null });
        return { result: { pending_id: id, decision, applied_plan_version: null }, message: message || (decision === 'approve' ? `${id} approved.` : `${id} overridden; proposal not applied.`) };
      }, meta);
    },
    async scaleTest(body = {}) {
      const nt = body.tractors ?? 5, nj = body.jobs ?? 20;
      if (!Number.isInteger(nt) || nt < 1 || nt > 200 || !Number.isInteger(nj) || nj < 1 || nj > 1000) throw apiError('INVALID_INPUT', 'tractors must be 1 to 200 and jobs 1 to 1000.', {});
      return scaleTest(nt, nj);
    },
    async getLog() { return w.log.map((l) => JSON.stringify(l)).join('\n') + (w.log.length ? '\n' : ''); },
    async getOperation(id) {
      const op = ops.find((x) => x.id === id);
      if (!op) throw apiError('NOT_FOUND', `Operation ${id} does not exist.`, { id });
      return clone(op);
    },
  };

  /** Counterfactual: re-run planner on a copy with `jobId` pinned to `trId`. */
  function counterfactual(jobId, trId) {
    const jobs = w.jobs.map((j) => ({ ...j, pinned_to: j.id === jobId ? trId : j.pinned_to }));
    const tractors = w.tractors.map((tr) => ({ ...tr, queue: [] }));
    const res = planAssign({ tractors, jobs, blocked: w.blocked, t: w.t, wx: wxP() });
    const byId = new Map(jobs.map((j) => [j.id, j]));
    let travel = 0, finish = null; const ends = [];
    const late = [];
    for (const tr of tractors.filter(schedulable)) {
      const s = tractorSchedule(tr, byId, res.assign.get(tr.id), w.t, w.blocked, true, wxP());
      for (const e of s.entries) {
        if (e.kind === 'travel') travel += e.end_t - e.start_t;
        if (e.kind === 'work') { const j = byId.get(e.job); if (e.end_t > j.deadline_t + 1e-9 && !late.includes(j.id)) late.push(j.id); if (e.job === jobId) finish = e.end_t; }
      }
      ends.push(s.end_t);
    }
    const horizon = Math.max(w.t, ...ends);
    return { travel, idle: ends.reduce((s, e) => s + horizon - e, 0), finish, late };
  }

  function scaleTest(nt, nj) {
    const rand = rng(1234 + nt * 7919 + nj);
    const kits = [['sprayer'], ['mower', 'hedger'], ['sprayer', 'bin_trailer'], ['mower'], ['sprayer', 'mower']];
    const tractors = Array.from({ length: nt }, (_, i) => ({ id: 'T' + (i + 1), name: 'Tractor ' + (i + 1), implements: kits[i % kits.length], status: 'idle', manual: false, x: 2 + (i % 6), y: DEPOT.y, current_job: null, queue: [], path: [], pi: 0, speed: 1 }));
    const jobs = Array.from({ length: nj }, (_, i) => {
      const impl = IMPLEMENTS[Math.floor(rand() * IMPLEMENTS.length)], b = BLOCKS[Math.floor(rand() * BLOCKS.length)];
      return makeJob('J' + (i + 1), `${IMPL_TYPE[impl]} ${b.id}`, b.id, impl, 40 + Math.floor(rand() * 9) * 10, 1 + Math.floor(rand() * 3), 180 + Math.floor(rand() * 540));
    });
    const t0 = (globalThis.performance ?? Date).now();
    const res = planAssign({ tractors, jobs, blocked: new Set(), t: 0 });
    const byId = new Map(jobs.map((j) => [j.id, j]));
    let assigned = 0, violations = 0;
    for (const tr of tractors) {
      for (const e of tractorSchedule(tr, byId, res.assign.get(tr.id), 0, new Set()).entries) {
        if (e.kind !== 'work') continue;
        if (!tr.implements.includes(byId.get(e.job).implement)) violations++;
        if (e.end_t <= DAY_MIN) assigned++;
      }
    }
    const solve_ms = Math.max(1, Math.round((globalThis.performance ?? Date).now() - t0));
    return { tractors: nt, jobs: nj, assigned, dropped: nj - assigned, violations, solve_ms, solver: 'greedy' };
  }

  // ---------------- boot: world + initial plan (op O1), nothing emitted yet
  resetWorld('ours');
  {
    const op = { id: 'O' + ++ctr.O, kind: 'run', status: 'succeeded', source: 'run', created_t: 0, updated_t: 0, message: '', plan_version: null, solver_status: null, result: null, error: null };
    const r = replan('initial_plan', {});
    Object.assign(op, planResult(r, `Initial plan v${r.version} applied.`), { status: 'succeeded' });
    ops.push(op);
  }

  return {
    kind: 'mock',
    api,
    /** Start streaming: snapshot first, then ticks (interval if realtime). */
    connect({ onMessage, onConnected: oc } = {}) {
      handler = onMessage; onConnected = oc || null; seq = 0;
      emit('snapshot', snapshotOut()); primeTrackers();
      onConnected?.(true);
      if (realtime && !timer) timer = setInterval(tick, TICK_MS);
    },
    stop() { if (timer) clearInterval(timer); timer = null; onConnected?.(false); },
    resync() { /* in-process: no gaps possible */ },
    tick,
    debug: {
      /** Next run/replan operation fails with SAFETY_REJECTED + no_feasible_plan; previous plan kept. */
      failNext() { failNext = true; },
      world: () => w,
      snapshot: () => clone(snapshotOut()),
    },
  };
}

// Pure derivations from data-layer State. No DOM, no three.js, safe to import in Node.
import { clock, esc, tractorColor, priColor, PALETTE, plural, listText, priorityWord } from './format.js';

// Fallbacks used ONLY when the scenario lacks a field (logged once by main.js).
export const FALLBACK = {
  grid: { width: 20, height: 14 },
  depot: { x: 1, y: 6 },
  roads: { rows: [0, 6, 13], cols: [0, 5, 10, 15] },
  blocks: [
    { id: 'A', x: 1, y: 2, w: 4, h: 3, ripeness: 0.4 }, { id: 'B', x: 6, y: 2, w: 4, h: 3, ripeness: 0.5 },
    { id: 'C', x: 11, y: 2, w: 4, h: 3, ripeness: 0.9 }, { id: 'D', x: 16, y: 2, w: 4, h: 3, ripeness: 0.4 },
    { id: 'E', x: 1, y: 8, w: 4, h: 4, ripeness: 0.3 }, { id: 'F', x: 6, y: 8, w: 4, h: 4, ripeness: 0.5 },
    { id: 'G', x: 11, y: 8, w: 4, h: 4, ripeness: 0.4 }, { id: 'H', x: 16, y: 8, w: 4, h: 4, ripeness: 0.3 },
  ],
};

export function missingScenarioFields(sc) {
  const out = [];
  if (!sc) return ['scenario'];
  if (!sc.grid || !(sc.grid.width > 0) || !(sc.grid.height > 0)) out.push('grid');
  if (!sc.depot || sc.depot.x == null) out.push('depot');
  if (!sc.roads || !Array.isArray(sc.roads.rows) || !Array.isArray(sc.roads.cols)) out.push('roads');
  if (!Array.isArray(sc.blocks) || !sc.blocks.length) out.push('blocks');
  return out;
}

/** Normalized grid description from scenario (with fallbacks). */
export function makeGrid(sc) {
  sc = sc || {};
  const g = (sc.grid && sc.grid.width > 0 && sc.grid.height > 0) ? sc.grid : FALLBACK.grid;
  const w = g.width, h = g.height;
  const roads = (sc.roads && Array.isArray(sc.roads.rows) && Array.isArray(sc.roads.cols)) ? sc.roads : FALLBACK.roads;
  const depot = (sc.depot && sc.depot.x != null) ? sc.depot : FALLBACK.depot;
  const blocks = (Array.isArray(sc.blocks) && sc.blocks.length ? sc.blocks : FALLBACK.blocks).map((b) => ({
    id: String(b.id), x: +b.x || 0, y: +b.y || 0, w: +b.w || 4, h: +b.h || 3,
    ripeness: b.ripeness == null ? 0 : +b.ripeness, variety: b.variety || null,
  }));
  const rows = roads.rows.slice(), cols = roads.cols.slice();
  const ox = (w - 1) / 2, oy = (h - 1) / 2;
  return {
    w, h, rows, cols, depot, blocks,
    blockById: Object.fromEntries(blocks.map((b) => [b.id, b])),
    span: Math.max(w, h),
    isRoad: (x, y) => cols.includes(x) || rows.includes(y),
    /** grid (x east, y south) -> world (x, z) */
    toWorld: (x, y) => ({ x: x - ox, z: y - oy }),
    blockCenter: (b) => ({ x: b.x + (b.w - 1) / 2, y: b.y + (b.h - 1) / 2 }),
  };
}

/** heading_deg (0 = north, clockwise) -> three.js rotation.y for a model whose front faces +z (south). */
export const headingToRotY = (deg) => Math.PI - ((+deg || 0) * Math.PI) / 180;

export const cellKey = (x, y) => x + ',' + y;

/**
 * Blocked road cells. Sources (all merged): scenario.blocked_cells, state.blocked_cells if the
 * data layer keeps a live list, and block_route / unblock_route events in the log (oldest first).
 */
export function blockedCells(state) {
  const set = new Map();
  const add = (c) => { if (Array.isArray(c) && c.length >= 2) set.set(cellKey(Math.round(c[0]), Math.round(c[1])), [Math.round(c[0]), Math.round(c[1])]); };
  const del = (c) => { if (Array.isArray(c) && c.length >= 2) set.delete(cellKey(Math.round(c[0]), Math.round(c[1]))); };
  const sc = state && state.scenario;
  (sc && Array.isArray(sc.blocked_cells) ? sc.blocked_cells : []).forEach(add);
  (state && Array.isArray(state.blocked_cells) ? state.blocked_cells : []).forEach(add);
  const log = state && Array.isArray(state.log) ? state.log : [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (!e || e.kind !== 'event') continue;
    if (e.type === 'block_route' && Array.isArray(e.cells)) e.cells.forEach(add);
    if (e.type === 'unblock_route' && Array.isArray(e.cells)) e.cells.forEach(del);
  }
  return [...set.values()];
}

export const jobsById = (state) => Object.fromEntries(((state && state.jobs) || []).map((j) => [j.id, j]));

/** Timeline layout: lanes from fleet order, pills from plan work entries (done jobs keep actual times). */
export function timelineLayout(state) {
  const fleet = (state && state.fleet) || [];
  const jobs = (state && state.jobs) || [];
  const entries = (state && state.plan && Array.isArray(state.plan.entries)) ? state.plan.entries : [];
  const lanes = fleet.map((tr, i) => ({ id: tr.id, name: tr.id, color: tractorColor(tr, i), status: tr.status, manual: !!tr.manual }));
  const laneIdx = Object.fromEntries(lanes.map((l, i) => [l.id, i]));
  // Merge work entries per job: first start .. last end (handles split work entries).
  const work = {};
  for (const e of entries) {
    if (!e || e.kind !== 'work' || !e.job) continue;
    const w = work[e.job];
    if (!w) work[e.job] = { tractor: e.tractor, start: e.start_t, end: e.end_t };
    else { w.start = Math.min(w.start, e.start_t); w.end = Math.max(w.end, e.end_t); }
  }
  const pills = [], unassigned = [];
  for (const j of jobs) {
    if (!j || j.status === 'dropped') continue;
    let tractor, start, end;
    if (j.status === 'done') { tractor = j.tractor; start = j.start_t; end = j.end_t; }
    else if (work[j.id]) { tractor = work[j.id].tractor; start = work[j.id].start; end = work[j.id].end; }
    else { tractor = j.tractor; start = j.start_t; end = j.end_t; }
    if (tractor == null || start == null || end == null || laneIdx[tractor] == null) {
      if (j.status !== 'done') unassigned.push(j);
      continue;
    }
    pills.push({
      id: j.id, job: j, lane: laneIdx[tractor], tractor, start, end,
      fill: priColor(j.priority), edge: lanes[laneIdx[tractor]].color,
      done: j.status === 'done', progress: Math.max(0, Math.min(1, +j.progress || 0)), label: j.label || j.id,
    });
  }
  return { lanes, pills, unassigned };
}

/** The travel route a tractor is currently on (or about to start), trimmed to what's ahead of its pose. */
export function activeRoute(state, tr) {
  if (!tr || !tr.pose || !(tr.status === 'traveling')) return null;
  const t = state && state.clock ? state.clock.t : 0;
  const entries = (state && state.plan && Array.isArray(state.plan.entries)) ? state.plan.entries : [];
  let best = null;
  for (const e of entries) {
    if (!e || e.tractor !== tr.id || e.kind !== 'travel' || !Array.isArray(e.route) || e.route.length < 2) continue;
    if (e.end_t < t - 1) continue;
    if (!best || e.start_t < best.start_t) best = e;
  }
  if (!best) return null;
  const r = best.route;
  let ni = 0, nd = Infinity;
  for (let i = 0; i < r.length; i++) {
    const d = Math.hypot(r[i][0] - tr.pose.x, r[i][1] - tr.pose.y);
    if (d < nd) { nd = d; ni = i; }
  }
  if (nd > 3) return null; // pose isn't on this route (stale entry)
  const ahead = r.slice(ni + 1);
  if (!ahead.length) return null;
  return [[tr.pose.x, tr.pose.y], ...ahead];
}

/** Grid Dijkstra (roads cheap) for the client-side mechanic van animation only. */
export function gridPath(grid, blocked, sx, sy, tx, ty) {
  const W = grid.w, H = grid.h, clampX = (v) => Math.max(0, Math.min(W - 1, Math.round(v))), clampY = (v) => Math.max(0, Math.min(H - 1, Math.round(v)));
  sx = clampX(sx); sy = clampY(sy); tx = clampX(tx); ty = clampY(ty);
  const N = W * H, dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N), id = (x, y) => y * W + x;
  const bl = new Set((blocked || []).map((c) => cellKey(c[0], c[1])));
  dist[id(sx, sy)] = 0;
  for (let it = 0; it < N; it++) {
    let u = -1, b = Infinity;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i] < b) { b = dist[i]; u = i; }
    if (u < 0) break;
    done[u] = 1;
    const ux = u % W, uy = (u / W) | 0;
    if (ux === tx && uy === ty) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = ux + dx, ny = uy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || bl.has(cellKey(nx, ny))) continue;
      const v = id(nx, ny), c = grid.isRoad(nx, ny) ? 1 : 3.5;
      if (dist[u] + c < dist[v]) { dist[v] = dist[u] + c; prev[v] = u; }
    }
  }
  let c = id(tx, ty);
  if (dist[c] === Infinity) return [[sx, sy], [tx, ty]];
  const out = [];
  while (c !== -1) { out.unshift([c % W, (c / W) | 0]); c = prev[c]; }
  return out.length > 1 ? out : [[sx, sy], [tx, ty]];
}

/** Point at fraction f (0..1) along a polyline of [x,y]. */
export function alongPath(path, f) {
  if (!path || !path.length) return null;
  if (path.length === 1) return { x: path[0][0], y: path[0][1], hd: null };
  let L = 0; const seg = [];
  for (let i = 1; i < path.length; i++) { const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]); seg.push(d); L += d; }
  let target = Math.max(0, Math.min(1, f)) * L;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const a = path[i], b = path[i + 1], k = seg[i] ? Math.min(1, target / seg[i]) : 1;
      return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, hd: Math.atan2(b[0] - a[0], b[1] - a[1]) };
    }
    target -= seg[i];
  }
  const z = path[path.length - 1];
  return { x: z[0], y: z[1], hd: null };
}

// ---------- text for feed / island ----------
const tname = (state, id) => {
  const tr = ((state && state.fleet) || []).find((x) => x.id === id);
  return tr ? (tr.name || tr.id) : (id || 'A tractor');
};
const jlabel = (state, id) => {
  const j = ((state && state.jobs) || []).find((x) => x.id === id);
  return j ? (j.label || j.id) : (id || 'a job');
};
const B = (s) => '<b style="font-weight:500">' + esc(s) + '</b>';

/** Job ids a replan log entry changed: reassigned (`changes`, §7) plus re-timed (`retimed`, when the backend
 *  sends it). The explanation names the same jobs, so feed and explanation always agree. */
export function replanChanges(e) {
  const ids = [];
  for (const c of [].concat(Array.isArray(e && e.changes) ? e.changes : [], Array.isArray(e && e.retimed) ? e.retimed : [])) {
    const id = c && (c.job || (typeof c === 'string' ? c : null));
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** One activity-feed line (HTML) for an event-log entry, or null to skip. */
export function logLine(e, state) {
  if (!e || !e.kind) return null;
  switch (e.kind) {
    case 'plan': return B('Plan v' + (e.plan_version ?? '?')) + (e.assigned != null ? ': ' + e.assigned + ' jobs assigned' : '') + (e.solver ? ' (' + esc(e.solver) + ')' : '');
    case 'replan': {
      const ch = replanChanges(e);
      const what = ch.length ? ': ' + plural(ch.length, 'job') + ' changed (' + esc(listText(ch.map((id) => jlabel(state, id)))) + ')' : '';
      return B('Replan') + (e.trigger ? ' after ' + esc(String(e.trigger).replace(/_/g, ' ')) : '') + what + (e.safety === 'pass' ? '. Safety check passed.' : e.safety ? '. Safety: ' + esc(e.safety) : '.');
    }
    case 'event': {
      const ty = e.type;
      if (ty === 'breakdown') return B(tname(state, e.tractor) + ' broke down') + (e.issue ? ' (' + esc(e.issue) + ')' : '');
      if (ty === 'block_route') return B('Road blocked') + (Array.isArray(e.cells) ? ' at ' + plural(e.cells.length, 'cell') : '');
      if (ty === 'unblock_route') return B('Road reopened');
      if (ty === 'heat_alert') return B('Heat alert') + (e.temp_f != null ? ': ' + e.temp_f + '°F' : '') + (e.at_t != null ? ' by ' + clock(e.at_t) : '');
      if (ty === 'priority_change') return B('Priority changed') + ' on ' + esc(jlabel(state, e.job)) + (e.priority != null ? ' to ' + priorityWord(e.priority).toLowerCase() : '');
      if (ty === 'tractor_repaired') return B(tname(state, e.tractor) + ' marked repaired');
      if (ty === 'weather_change') return B('Wind ' + (e.wind_mph ?? '?') + ' mph') + (e.wind_from_deg != null ? ' from the ' + compassName(e.wind_from_deg) : '') + (e.wind_mph > 10 ? ', above the spray limit' : '');
      return B('Event') + ': ' + esc(String(ty || '').replace(/_/g, ' '));
    }
    case 'job_started': return B(jlabel(state, e.job)) + ' started by ' + esc(tname(state, e.tractor));
    case 'job_done': return B(jlabel(state, e.job)) + ' done by ' + esc(tname(state, e.tractor)) + (e.on_time === true ? ', on time' : e.on_time === false ? ', late' : '');
    case 'job_dropped': return B(jlabel(state, e.job)) + ' dropped';
    case 'operator_action': return B('Operator') + ' changed ' + esc(e.control || 'a setting') + ' on ' + esc(tname(state, e.tractor));
    case 'tractor_added': return B(tname(state, e.tractor) + ' added to the fleet'); // host names are infrastructure detail
    case 'tractor_ready': return B(tname(state, e.tractor) + ' ready');
    case 'tractor_removed': return B((e.tractor || 'Tractor') + ' removed');
    case 'mechanic_search': return 'Searching mechanics for ' + esc(tname(state, e.tractor));
    case 'mechanic_booked': return B('Booked') + ' ' + esc(e.name || e.mechanic_name || e.mechanic || 'a mechanic') + (e.arrival_t != null ? ', arriving ' + clock(e.arrival_t) : '') + (e.estimated_return_t != null ? ', estimated back ' + clock(e.estimated_return_t) : '');
    case 'tractor_repaired': return B(tname(state, e.tractor) + ' repaired');
    case 'weather': return e.wind_mph != null ? null : B('Weather') + ' update' + (e.temp_f != null ? ': ' + e.temp_f + '°F' : '');
    case 'safety_reject': return B('Safety') + ' rejected a candidate plan' + (e.rule ? ' (' + esc(e.rule) + ')' : '');
    case 'violation': return '<b style="font-weight:500;color:#FF453A">Violation</b> ' + esc(e.rule || '') + (e.tractor ? ' on ' + esc(e.tractor) : '');
    case 'agopenweb': return null;
    default: return B(String(e.kind).replace(/_/g, ' '));
  }
}

/** Dynamic Island moment for a log entry: { text, dot, ms } or null. */
export function islandMoment(e, state) {
  if (!e || !e.kind) return null;
  const n = (id) => tname(state, id);
  if (e.kind === 'event') {
    if (e.type === 'breakdown') return { text: n(e.tractor) + ' down · Replanning…', dot: '#FF453A', ms: 1800 };
    if (e.type === 'block_route') return { text: 'Road blocked · rerouting', dot: '#FF9F0A', ms: 2200 };
    if (e.type === 'heat_alert') return { text: 'Heat alert' + (e.temp_f != null ? ' · ' + e.temp_f + '°F' : '') + (e.at_t != null ? ' by ' + clock(e.at_t) : ''), dot: '#FF9F0A', ms: 2600 };
    if (e.type === 'unblock_route') return { text: 'Road reopened', dot: '#30D158', ms: 1800 };
    if (e.type === 'weather_change') return e.wind_mph > 10
      ? { text: 'Wind ' + e.wind_mph + ' mph · spraying paused', dot: '#FF9F0A', ms: 2600 }
      : { text: 'Wind ' + e.wind_mph + ' mph · rechecking spray windows', dot: '#64D2FF', ms: 2200 };
    return null;
  }
  if (e.kind === 'replan') {
    const k = replanChanges(e).length;
    return { text: 'New plan' + (k ? ' · ' + plural(k, 'job') + ' changed' : ' · order updated'), dot: '#30D158', ms: 2200 };
  }
  if (e.kind === 'tractor_added') return { text: n(e.tractor) + ' joining the fleet…', dot: '#0A84FF', ms: 2200 };
  if (e.kind === 'tractor_ready') return { text: n(e.tractor) + ' ready · picking up work', dot: '#30D158', ms: 2200 };
  if (e.kind === 'tractor_removed') return { text: (e.tractor || 'Tractor') + ' left the fleet', dot: '#8e8e93', ms: 2000 };
  if (e.kind === 'mechanic_booked') return { text: 'Mechanic booked' + (e.arrival_t != null ? ' · arrives ' + clock(e.arrival_t) : ''), dot: '#0A84FF', ms: 2500 };
  if (e.kind === 'tractor_repaired') return { text: n(e.tractor) + ' back in service', dot: '#30D158', ms: 2400 };
  if (e.kind === 'violation') return { text: 'Constraint violation · ' + (e.rule || ''), dot: '#FF453A', ms: 2400 };
  return null;
}

/** Plain-language outcome for a terminal Operation. */
export function opOutcome(op) {
  if (!op) return null;
  if (op.status === 'succeeded') return { kind: 'ok', text: op.message || 'Done' };
  if (op.status === 'superseded') return { kind: 'warn', text: 'Replaced by a newer request' };
  if (op.status === 'failed') {
    if (op.solver_status === 'no_feasible_plan') return { kind: 'err', text: 'No safe plan found — previous plan kept' + (op.error && op.error.message ? '. ' + op.error.message : '') };
    return { kind: 'err', text: (op.error && op.error.message) || op.message || 'Request failed' };
  }
  return null;
}
/** Toast kind for a rejected api call: outcome-unknown is a warning, not a failure. */
export const errKind = (err) => (err && err.code === 'UNCONFIRMED' ? 'warn' : 'err');
export const isTerminal = (op) => !!op && (op.status === 'succeeded' || op.status === 'failed' || op.status === 'superseded');

/** Friendly text for a rejected api call ({code,message,details}). Client codes (status 0): NETWORK, CLIENT_TIMEOUT, UNCONFIRMED. */
export function errText(err) {
  if (!err) return 'Something went wrong';
  switch (err.code) {
    case 'TIMEOUT': return 'That took too long to compute. Try again in a moment.'; // server 503: compute budget
    case 'CLIENT_TIMEOUT': return 'The backend did not answer in time. Check the connection and try again.';
    case 'NETWORK': return "Can't reach the backend. Check that it is running; the dashboard reconnects on its own.";
    case 'UNCONFIRMED': return 'No confirmation from the backend yet. It may still apply; watch the plan.';
    case 'AT_CAPACITY': { const m = err.details && err.details.max; return `The fleet is full${m ? ` (${m} tractors)` : ''}. Remove a tractor before adding another.`; }
    default: return err.message || String(err);
  }
}

export const SOLVER_LABEL = { feasible: 'Feasible', optimal: 'Optimal', fallback: 'Fallback', no_feasible_plan: 'No feasible plan' };

export { PALETTE };

// ---------- weather (PROJECT.md Change 6 Part B) ----------
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export const compassName = (deg) => COMPASS[Math.round((((+deg || 0) % 360 + 360) % 360) / 45) % 8];
export const compassShort = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((+deg || 0) % 360 + 360) % 360) / 45) % 8];
export const angDiff = (a, b) => { const d = Math.abs((((a - b) % 360) + 360) % 360); return d > 180 ? 360 - d : d; };
/** Unit vector, in world x/z, of where a wind FROM `fromDeg` blows (meteorological; grid y = south = +z). */
export const windToward = (fromDeg) => { const r = ((+fromDeg || 0) * Math.PI) / 180; return { x: -Math.sin(r), z: Math.cos(r) }; };
/** Unit vector (world x/z) from a block toward compass bearing `deg` (0 = north = -z). */
export const bearingVec = (deg) => { const r = ((+deg || 0) * Math.PI) / 180; return { x: Math.sin(r), z: -Math.cos(r) }; };

/** Allowed spray windows of a block -> blocked (no-spray) ranges over [0, D]. */
export function blockedRanges(windows, D = 720) {
  const out = []; let at = 0;
  for (const [s, e] of (windows || []).slice().sort((a, b) => a[0] - b[0])) { if (s > at + 0.01) out.push([at, s]); at = Math.max(at, e); }
  if (at < D - 0.01) out.push([at, D]);
  return out;
}
const isect = (a, b) => { const out = []; for (const [s1, e1] of a) for (const [s2, e2] of b) { const s = Math.max(s1, s2), e = Math.min(e1, e2); if (e > s + 0.01) out.push([s, e]); } return out; };
const subtract = (a, cut) => { let out = a.map((r) => r.slice()); for (const [cs, ce] of cut) out = out.flatMap(([s, e]) => (ce <= s || cs >= e ? [[s, e]] : [...(cs > s + 0.01 ? [[s, cs]] : []), ...(ce < e - 0.01 ? [[ce, e]] : [])])); return out; };
const union = (list) => { const out = []; for (const [s, e] of list.slice().sort((a, b) => a[0] - b[0])) { const l = out[out.length - 1]; if (l && s <= l[1] + 0.01) l[1] = Math.max(l[1], e); else out.push([s, e]); } return out; };

/**
 * Hatched no-spray bands per timeline lane: for each sprayer lane, times when none of the blocks it still has to spray
 * may be sprayed, plus the blocked stretches inside each of its spray pills (the pill visibly waits for wind there).
 * Lane-wide bands skip the lane's non-spray and finished pills, so they never cover hauling or mowing.
 * @returns {Map<string, Array<[number, number]>>} tractor id -> merged [start_t, end_t] ranges
 */
export function noSprayBands(state, layout) {
  const out = new Map();
  const wx = state && state.weather; if (!wx || !wx.spray_windows) return out;
  const D = (state.clock && state.clock.day_minutes) || 720;
  const fleet = state.fleet || [], jobs = state.jobs || [];
  const blockedOf = (b) => (wx.spray_windows[b] ? blockedRanges(wx.spray_windows[b], D) : []);
  const openSprayBlocks = [...new Set(jobs.filter((j) => j.implement === 'sprayer' && j.status !== 'done' && j.status !== 'dropped').map((j) => j.block))];
  for (const tr of fleet) {
    if (!(tr.implements || []).includes('sprayer')) continue;
    const pills = (layout ? layout.pills : []).filter((p) => p.tractor === tr.id && p.job.implement === 'sprayer' && !p.done);
    const mine = [...new Set(pills.map((p) => p.job.block))];
    const blocks = mine.length ? mine : openSprayBlocks;
    let all = blocks.length ? blockedOf(blocks[0]) : [];
    for (const b of blocks.slice(1)) all = isect(all, blockedOf(b));
    const inPills = pills.flatMap((p) => isect(blockedOf(p.job.block), [[p.start, p.end]]));
    // lane-wide bands never cover other work (hauling during a no-spray period is the point) or finished pills
    const busy = (layout ? layout.pills : []).filter((p) => p.tractor === tr.id && (p.done || p.job.implement !== 'sprayer')).map((p) => [p.start, p.end]);
    const merged = union([...subtract(union(all), union(busy)), ...inPills]);
    if (merged.length) out.set(tr.id, merged);
  }
  return out;
}

/**
 * Sensitive areas with their downwind state. `toward`: the wind blows toward it (within 45°);
 * `active`: a sprayer is working/heading/waiting in that block or the backend says spraying there is blocked for it.
 */
export function sensitiveState(state) {
  const sc = state && state.scenario, wx = state && state.weather;
  const list = (sc && Array.isArray(sc.sensitive)) ? sc.sensitive : [];
  if (!list.length) return [];
  const cur = wx && wx.current;
  const towardDeg = cur ? ((+cur.wind_from_deg || 0) + 180) % 360 : null;
  const jobs = state.jobs || [];
  const busy = new Set();
  for (const tr of state.fleet || []) {
    const j = tr.current_job && jobs.find((x) => x.id === tr.current_job);
    if (j && j.implement === 'sprayer' && ['working', 'traveling', 'waiting_weather'].includes(tr.status)) busy.add(j.block);
  }
  return list.map((a) => {
    const toward = towardDeg != null && cur.wind_mph >= 1 && angDiff(towardDeg, a.dir_deg) <= 45;
    const reason = wx && wx.spray_blocked_reason ? wx.spray_blocked_reason[a.block] : null;
    const said = !!(reason && /toward/i.test(reason) && reason.toLowerCase().includes(String(a.what || '').toLowerCase()));
    return { ...a, toward: toward || said, active: (toward || said) && (busy.has(a.block) || said), sprayer: busy.has(a.block) };
  });
}

// ---------- plan health: overtime + late work (client-side, from plan entries and jobs) ----------
/**
 * What the plan badge must not hide. `overtimeMin`: how far planned work (entries.end_t) runs past
 * clock.day_minutes; `late`: unfinished jobs planned to end after their deadline; `afterDay`: unfinished jobs
 * planned to end after the day. Nothing is reported once the day has ended (the keynote covers carry-over).
 */
export function planHealth(state) {
  const D = (state && state.clock && state.clock.day_minutes) || 720;
  const out = { day: D, overtimeMin: 0, endT: null, late: [], afterDay: [], lateBy: {} };
  if (!state || (state.clock && state.clock.ended)) return out;
  const jobs = state.jobs || [], open = new Map(jobs.filter((j) => j && j.status !== 'done' && j.status !== 'dropped').map((j) => [j.id, j]));
  const entries = (state.plan && Array.isArray(state.plan.entries)) ? state.plan.entries : [];
  const end = new Map();
  let maxEnd = null;
  for (const e of entries) {
    if (!e || e.end_t == null || !isFinite(e.end_t)) continue;
    if (e.job && !open.has(e.job)) continue; // finished work
    if (e.kind === 'work' && e.job) end.set(e.job, Math.max(end.get(e.job) ?? -Infinity, e.end_t));
    if (e.kind === 'work' || e.kind === 'travel') maxEnd = maxEnd == null ? e.end_t : Math.max(maxEnd, e.end_t);
  }
  for (const j of open.values()) {
    const fin = end.has(j.id) ? end.get(j.id) : j.end_t;
    if (fin == null || !isFinite(fin)) continue;
    if (j.deadline_t != null && fin > j.deadline_t + 0.5) { out.late.push(j.id); out.lateBy[j.id] = Math.round(fin - j.deadline_t); }
    if (fin > D + 0.5) out.afterDay.push(j.id);
  }
  if (maxEnd != null && maxEnd > D + 0.5) { out.overtimeMin = Math.round(maxEnd - D); out.endT = maxEnd; }
  return out;
}

// ---------- why sheet: explain ties and near-ties from the why data ----------
/**
 * Plain reason the chosen tractor beat option `o` when their finish times are within a minute, or when `o`
 * finishes sooner (the planner optimises the whole day, not one job). Uses only data present: the option's
 * travel/idle/deadline deltas (vs the current plan), fuel and distance from the fleet. Null if `o` is clearly worse.
 */
export function whyTieBreak(o, cho, state, job) {
  if (!o || !cho || o.finish_t == null || cho.finish_t == null) return null;
  const diff = o.finish_t - cho.finish_t;
  if (diff >= 1) return null;
  const fleet = (state && state.fleet) || [];
  const tn = (id) => { const t = fleet.find((x) => x.id === id); return t ? (t.name || t.id) : id; };
  const lead = diff <= -1 ? 'Finishes ' + Math.round(-diff) + ' min sooner, but ' : 'Same finish time, but ';
  const reasons = [];
  if (o.travel_delta_min > 0) reasons.push('adds ' + Math.round(o.travel_delta_min) + ' min of driving to the day');
  if (o.idle_delta_min > 0) reasons.push('adds ' + Math.round(o.idle_delta_min) + ' min of idle time');
  const dm = (x) => (Array.isArray(x.deadlines_missed) ? x.deadlines_missed.length : 0);
  if (dm(o) > dm(cho)) reasons.push('misses ' + plural(dm(o) - dm(cho), 'more deadline'));
  if (reasons.length) return lead + reasons.join(' and ');
  const a = fleet.find((x) => x.id === cho.tractor), b = fleet.find((x) => x.id === o.tractor);
  if (a && b && a.fuel_pct != null && b.fuel_pct != null && a.fuel_pct - b.fuel_pct >= 5) return lead + tn(cho.tractor) + ' has more fuel (' + Math.round(a.fuel_pct) + '% vs ' + Math.round(b.fuel_pct) + '%)';
  const blk = job && state && state.scenario && Array.isArray(state.scenario.blocks) ? state.scenario.blocks.find((x) => x.id === job.block) : null;
  if (blk && a && b && a.pose && b.pose) {
    const cx = blk.x + (blk.w - 1) / 2, cy = blk.y + (blk.h - 1) / 2;
    const da = Math.hypot(a.pose.x - cx, a.pose.y - cy), db = Math.hypot(b.pose.x - cx, b.pose.y - cy);
    if (db - da >= 1) return lead + tn(cho.tractor) + ' is already closer to Block ' + job.block;
  }
  return diff <= -1 ? 'Finishes ' + Math.round(-diff) + ' min sooner; the planner kept the current assignment' : 'Tie on every measure; the plan keeps the current assignment';
}

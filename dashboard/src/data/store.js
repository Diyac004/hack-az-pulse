// Client-side state store. Applies WS envelopes {type,t,seq,data} with the merge
// rules from ARCHITECTURE.md §6 + §13.3. DOM-free; plain ES module.
//
// Every applied message produces a NEW top-level state object; slices that the
// message touched are new arrays/objects, untouched slices keep their identity.

/** @typedef {{type:string,t:number,seq:number,data:any}} Envelope */

const EXPLANATIONS_CAP = 50;
const LOG_CAP = 100;
const TERMINAL_OPS_CAP = 20;
const TERMINAL = new Set(['succeeded', 'failed', 'superseded']);

export function emptyState(source = 'mock') {
  return {
    source,
    connected: false,
    seq: null,
    scenario: null,
    clock: null,
    fleet: [],
    jobs: [],
    plan: null,
    explanations: [],
    metrics: null,
    weather: null,
    pending: [],
    capacity: null,
    log: [],
    operations: [],
    link: null, // live only: {url, connected, everConnected, failures} from liveSource
  };
}

const opNum = (op) => parseInt(String(op.id).replace(/\D/g, ''), 10) || 0;

/** active ops + newest 20 terminal ops, newest first (by numeric id). */
export function normalizeOperations(list) {
  const sorted = [...list].sort((a, b) => opNum(b) - opNum(a));
  let terminal = 0;
  return sorted.filter((op) => !TERMINAL.has(op.status) || ++terminal <= TERMINAL_OPS_CAP);
}

function mergeById(list, items) {
  const out = list.slice();
  const idx = new Map(out.map((x, i) => [x.id, i]));
  for (const it of items) {
    const i = idx.get(it.id);
    if (i === undefined) { idx.set(it.id, out.length); out.push(it); } else out[i] = it;
  }
  return out;
}

// Blocked cells only arrive in Scenario (snapshot). Keep scenario.blocked_cells
// current from block_route / unblock_route event-log lines (contract gap, see report).
function applyBlockedFromLog(scenario, entry) {
  if (!scenario || entry.kind !== 'event' || !Array.isArray(entry.cells)) return scenario;
  const key = (c) => c[0] + ',' + c[1];
  const cur = new Map((scenario.blocked_cells || []).map((c) => [key(c), c]));
  if (entry.type === 'block_route') entry.cells.forEach((c) => cur.set(key(c), [c[0], c[1]]));
  else if (entry.type === 'unblock_route') entry.cells.forEach((c) => cur.delete(key(c)));
  else return scenario;
  return { ...scenario, blocked_cells: [...cur.values()] };
}

// A resync snapshot (GET /api/state after a seq gap, same connection) can be older than operation
// messages that arrived while it was in flight; never move a known op back from terminal to active.
function mergeResyncOps(prevOps, snapOps) {
  const prevById = new Map(prevOps.map((o) => [o.id, o]));
  const merged = snapOps.map((o) => { const p = prevById.get(o.id); return p && TERMINAL.has(p.status) && !TERMINAL.has(o.status) ? p : o; });
  const ids = new Set(merged.map((o) => o.id));
  return [...merged, ...prevOps.filter((o) => !ids.has(o.id) && TERMINAL.has(o.status))];
}

/** Full reset from a Snapshot: every slice (incl. operations) is replaced, nothing from the previous run survives.
 *  `resync` (same connection, GET /api/state) only protects operations from going backwards. */
function fromSnapshot(prev, data, seq, resync = false) {
  return {
    ...prev,
    seq,
    scenario: data.scenario ?? null,
    clock: data.clock ?? null,
    fleet: data.fleet ?? [],
    jobs: data.jobs ?? [],
    plan: data.plan ?? null,
    explanations: dedupeById(data.explanations ?? []).slice(0, EXPLANATIONS_CAP),
    metrics: data.metrics ?? null,
    weather: data.weather ?? null,
    pending: data.pending ?? [],
    capacity: data.capacity ?? null,
    log: (data.log_tail ?? []).slice(0, LOG_CAP),
    operations: normalizeOperations(resync ? mergeResyncOps(prev.operations, data.operations ?? []) : (data.operations ?? [])),
  };
}

function dedupeById(list) {
  const seen = new Set();
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/** Pure reducer: (state, envelope) -> new state. Unknown types only advance seq. */
export function reduce(s, msg) {
  const d = msg.data;
  switch (msg.type) {
    case 'snapshot': return fromSnapshot(s, d, msg.seq, !!msg.resync);
    case 'poses': {
      const byId = new Map((d.tractors || []).map((p) => [p.id, p]));
      return { ...s, fleet: s.fleet.map((tr) => (byId.has(tr.id) ? { ...tr, ...byId.get(tr.id) } : tr)) };
    }
    case 'fleet': return { ...s, fleet: d.tractors || [] };
    case 'jobs': return { ...s, jobs: mergeById(s.jobs, d.jobs || []) };
    case 'plan': return { ...s, plan: d };
    case 'metrics': return { ...s, metrics: d };
    case 'weather': return { ...s, weather: d };
    case 'capacity': return { ...s, capacity: d };
    case 'clock': return { ...s, clock: d };
    case 'pending': return { ...s, pending: d.pending || [] };
    case 'explanation':
      return { ...s, explanations: [d, ...s.explanations.filter((x) => x.id !== d.id)].slice(0, EXPLANATIONS_CAP) };
    case 'log':
      return { ...s, log: [d, ...s.log].slice(0, LOG_CAP), scenario: applyBlockedFromLog(s.scenario, d) };
    case 'operation':
      return { ...s, operations: normalizeOperations([d, ...s.operations.filter((o) => o.id !== d.id)]) };
    default: return s; // e.g. `coverage`: no State slot; passed through to subscribers only.
  }
}

/**
 * @param {{source?: 'mock'|'live'}} [opts]
 */
export function createStore(opts = {}) {
  let state = emptyState(opts.source || 'mock');
  const subs = new Set();
  let resyncFn = null;
  let resyncing = false;

  const notify = (msg) => { for (const fn of [...subs]) { try { fn(state, msg); } catch (e) { console.error('[store] subscriber error', e); } } };

  async function resync() {
    if (!resyncFn || resyncing) return;
    resyncing = true;
    try { await resyncFn(); } catch (e) { console.warn('[store] resync failed', e); } finally { resyncing = false; }
  }

  return {
    get: () => state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** Apply one WS envelope. */
    apply(msg) {
      if (!msg || typeof msg.type !== 'string') return;
      const gap = msg.type !== 'snapshot' && state.seq != null && typeof msg.seq === 'number' && msg.seq !== state.seq + 1;
      state = reduce(state, msg);
      if (msg.type !== 'snapshot' && typeof msg.seq === 'number') state = { ...state, seq: msg.seq };
      notify(msg);
      if (gap) resync();
    },
    /** Replace state from GET /api/state (Snapshot body) without touching seq. */
    applySnapshotData(data) {
      const seq = state.seq;
      state = fromSnapshot(state, data, seq, true);
      notify({ type: 'snapshot', t: data?.clock?.t ?? 0, seq, data });
    },
    setConnected(connected) {
      if (state.connected === connected) return;
      state = { ...state, connected };
      // Local change, not a server message: synthetic envelope so subscribers can always read msg.type.
      notify({ type: 'connection', t: state.clock?.t ?? 0, seq: state.seq, data: { connected } });
    },
    /** Live connection detail (not a server message); notifies like setConnected. */
    setLink(link) {
      state = { ...state, link };
      notify({ type: 'connection', t: state.clock?.t ?? 0, seq: state.seq, data: { connected: state.connected, link } });
    },
    setResync(fn) { resyncFn = fn; },
  };
}

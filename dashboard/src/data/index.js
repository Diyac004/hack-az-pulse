// Data layer entry point. Components talk ONLY to this module (PROJECT.md Change 10).
//   ?source=mock (default)  |  ?source=live&api=http://localhost:8000
//   ?pace=N (mock only): farm minutes per real second at 1x (default 1.2 = 10-minute day). Live: PACE= on the backend.
// Nothing starts at import time; call start().
import { createStore } from './store.js';
import { createMockSource, parsePace } from './mockSource.js';
import { createLiveSource, newIdempotencyKey } from './liveSource.js';

const MUTATION_RETRY_MS = 45000; // how long an unanswered async mutation is re-sent (same key) before UNCONFIRMED

function parseSource() {
  const loc = globalThis.location;
  if (!loc || typeof loc.search !== 'string') return { kind: 'mock', api: null, error: null };
  const p = new URLSearchParams(loc.search);
  if (p.get('source') !== 'live') return { kind: 'mock', api: null, error: null };
  const api = (p.get('api') || 'http://localhost:8000').trim().replace(/\/+$/, '');
  let error = null;
  try { const u = new URL(api); if (u.protocol !== 'http:' && u.protocol !== 'https:') error = `api= must start with http:// or https:// (got "${api}")`; }
  catch { error = `api= is not a valid URL (got "${api}")`; }
  return { kind: 'live', api, error };
}

/** @type {{kind: 'mock'|'live', api: string|null, error: string|null}} error: unusable api= URL (live only) */
export const sourceInfo = Object.freeze(parseSource());

const _store = createStore({ source: sourceInfo.kind });

/** Live adapter: maps the api surface onto liveSource.request() (ARCHITECTURE.md §5 + §13.2). */
function liveAdapter() {
  if (sourceInfo.error) {
    const bad = () => Promise.reject({ code: 'INVALID_INPUT', message: sourceInfo.error, details: { api: sourceInfo.api }, status: 0 });
    return { start: bad, resync: bad, api: new Proxy({}, { get: () => bad }) };
  }
  const src = createLiveSource({ api: sourceInfo.api, onMessage: (env) => _store.apply(env), onStatus: (c) => _store.setConnected(c), onLink: (l) => _store.setLink(l) });
  const req = src.request;
  const enc = encodeURIComponent;
  // §13 async mutations: one Idempotency-Key per user action (caller may pass {idempotencyKey} to reuse it on retry).
  const key = (o) => ({ idempotencyKey: (o && o.idempotencyKey) || newIdempotencyKey() });
  // §13.3 "clients must not infer failure merely because their REST connection timed out": when a mutation's
  // REST call dies without a reply (CLIENT_TIMEOUT, or NETWORK while the socket is up), re-send it with the SAME
  // Idempotency-Key. The server returns the original Operation if it had accepted it, so the caller can track it
  // over WS/getOperation as usual. NETWORK while offline fails fast (nothing reached the server). If no reply
  // ever comes, reject with UNCONFIRMED (shown as a warning, not a failure).
  const mutate = (method, path, body, o, budgetMs = MUTATION_RETRY_MS) => {
    const k = key(o);
    const until = Date.now() + budgetMs;
    const attempt = (i) => req(method, path, body, k).catch((e) => {
      const lost = e && (e.code === 'CLIENT_TIMEOUT' || e.code === 'NETWORK');
      if (!lost) throw e;
      if (e.code === 'NETWORK' && i === 0 && !src.connected) throw e;
      if (Date.now() >= until) {
        throw { code: 'UNCONFIRMED', message: 'The backend has not confirmed this yet. It may still apply; watch the plan.', details: { method, path, idempotency_key: k.idempotencyKey, last: e.code }, status: 0 };
      }
      return new Promise((r) => setTimeout(r, Math.min(4000, 500 * 2 ** i))).then(() => attempt(i + 1));
    });
    return attempt(0);
  };
  return {
    start: () => src.start(),
    resync: () => src.resync(),
    api: {
      run: (mode = 'ours', o) => mutate('POST', '/run', { mode }, o),
      setClock: (body) => req('POST', '/clock', body),
      postEvent: (body, o) => mutate('POST', '/events', body, o),
      patchJob: (id, patch, o) => mutate('PATCH', '/jobs/' + enc(id), patch, o),
      submitJobs: (jobs, o) => mutate('POST', '/jobs', { jobs }, o),
      addTractor: (entry) => req('POST', '/fleet', entry),
      removeTractor: (id) => req('DELETE', '/fleet/' + enc(id)),
      why: (jobId) => req('GET', '/why/' + enc(jobId)),
      mechanics: (tractorId) => req('GET', '/mechanics?tractor=' + enc(tractorId)),
      bookMechanic: (tractorId, mechanicId, o) => mutate('POST', '/mechanics/book', { tractor: tractorId, mechanic: mechanicId }, o),
      approve: (id, decision, o) => mutate('POST', '/approve', { id, decision }, o),
      scaleTest: ({ tractors = 5, jobs = 20 } = {}) => req('POST', '/scale-test', { tractors, jobs }),
      getLog: () => req('GET', '/log'),
      getOperation: (id) => req('GET', '/operations/' + enc(id)),
      // Tractor Control Panel (§5 rows 13-16). control: 200 {ok,value,explanation} for replans:false, 202 Operation
      // for replans:true (§13.2); the caller tells them apart by the body shape. Not auto-retried: a repeated
      // speed_up / nudge must not be sent twice; replanning controls still carry an Idempotency-Key.
      getControls: (id) => req('GET', '/tractors/' + enc(id) + '/controls'),
      control: (id, body, o) => req('POST', '/tractors/' + enc(id) + '/control', body, key(o)),
      preview: (id, body) => req('POST', '/tractors/' + enc(id) + '/preview', body),
      manual: (id, on, o) => mutate('POST', '/tractors/' + enc(id) + '/manual', { on: !!on }, o),
    },
  };
}

/** Mock adapter: in-process simulation; start() resolves after its snapshot is applied. */
function mockAdapter() {
  // ?pace=<farm min per real second> overrides the 10-minute day (e.g. ?pace=9.6 for the old 75 s day).
  const loc = globalThis.location;
  const pace = loc && typeof loc.search === 'string' ? parsePace(new URLSearchParams(loc.search).get('pace')) : null;
  const src = createMockSource({ realtime: true, pace });
  return {
    start: () => { src.connect({ onMessage: (env) => _store.apply(env), onConnected: (c) => _store.setConnected(c) }); return Promise.resolve(); },
    resync: () => Promise.resolve(),
    api: src.api,
  };
}

let source = null;
let started = null;
function ensureSource() {
  if (!source) { source = sourceInfo.kind === 'live' ? liveAdapter() : mockAdapter(); _store.setResync(() => source.resync()); }
  return source;
}

/** Connect the chosen source. Resolves after the first snapshot has been applied. */
export function start() {
  if (!started) started = ensureSource().start();
  return started;
}

export const store = {
  /** @returns current State (read-only). */
  get: () => _store.get(),
  /** fn(state, msg) after every applied message; msg is the raw envelope; local connected-flag changes arrive as a synthetic {type:'connection', t, seq, data:{connected}} (not applied to seq). */
  subscribe: (fn) => _store.subscribe(fn),
};

const call = (name) => (...args) => {
  const src = ensureSource();
  if (sourceInfo.kind === 'mock') start(); // mock ops execute on sim ticks
  return src.api[name](...args);
};

/**
 * REST actions. Each returns a Promise of the response body (ARCHITECTURE.md §5/§13) or rejects with
 * {code,message,details} (live adds `status`). run/postEvent/patchJob/submitJobs/bookMechanic/approve resolve to an
 * Operation (HTTP 202, §13.2) and accept an optional trailing `{ idempotencyKey }` to reuse on retry.
 * Live-only client codes (status 0): NETWORK (no reply), CLIENT_TIMEOUT (our abort), UNCONFIRMED (async mutation
 * re-sent with its key but never answered; outcome unknown, may still apply). Server TIMEOUT = HTTP 503.
 */
export const api = {
  run: call('run'),
  setClock: call('setClock'),
  postEvent: call('postEvent'),
  patchJob: call('patchJob'),
  /** POST /jobs {jobs: JobInput[]} -> Operation (source "jobs"). Rejects INVALID_INPUT (400; details.errors[].loc =
   *  ["body","jobs",i,field] when the backend knows the row) or CONFLICT (409, job id exists). See jobInput.js. */
  submitJobs: call('submitJobs'),
  addTractor: call('addTractor'),
  removeTractor: call('removeTractor'),
  why: call('why'),
  mechanics: call('mechanics'),
  bookMechanic: call('bookMechanic'),
  approve: call('approve'),
  scaleTest: call('scaleTest'),
  getLog: call('getLog'),
  getOperation: call('getOperation'),
  /** GET /tractors/{id}/controls -> { controls: Control[], values } */
  getControls: call('getControls'),
  /** POST /tractors/{id}/control {control, value} -> {ok,value,explanation} (replans:false) or Operation (replans:true) */
  control: call('control'),
  /** POST /tractors/{id}/preview {control, value} -> Preview (applies nothing; may reject TIMEOUT) */
  preview: call('preview'),
  /** POST /tractors/{id}/manual {on} -> Operation */
  manual: call('manual'),
};

// Data layer entry point. Components talk ONLY to this module (PROJECT.md Change 10).
//   ?source=mock (default)  |  ?source=live&api=http://localhost:8000
// Nothing starts at import time; call start().
import { createStore } from './store.js';
import { createMockSource } from './mockSource.js';
import { createLiveSource, newIdempotencyKey } from './liveSource.js';

function parseSource() {
  const loc = globalThis.location;
  if (!loc || typeof loc.search !== 'string') return { kind: 'mock', api: null };
  const p = new URLSearchParams(loc.search);
  if (p.get('source') !== 'live') return { kind: 'mock', api: null };
  return { kind: 'live', api: (p.get('api') || 'http://localhost:8000').replace(/\/+$/, '') };
}

/** @type {{kind: 'mock'|'live', api: string|null}} */
export const sourceInfo = Object.freeze(parseSource());

const _store = createStore({ source: sourceInfo.kind });

/** Live adapter: maps the api surface onto liveSource.request() (ARCHITECTURE.md §5 + §13.2). */
function liveAdapter() {
  const src = createLiveSource({ api: sourceInfo.api, onMessage: (env) => _store.apply(env), onStatus: (c) => _store.setConnected(c) });
  const req = src.request;
  const enc = encodeURIComponent;
  // §13 async mutations: one Idempotency-Key per user action (caller may pass {idempotencyKey} to reuse it on retry).
  const key = (o) => ({ idempotencyKey: (o && o.idempotencyKey) || newIdempotencyKey() });
  return {
    start: () => src.start(),
    resync: () => src.resync(),
    api: {
      run: (mode = 'ours', o) => req('POST', '/run', { mode }, key(o)),
      setClock: (body) => req('POST', '/clock', body),
      postEvent: (body, o) => req('POST', '/events', body, key(o)),
      patchJob: (id, patch, o) => req('PATCH', '/jobs/' + enc(id), patch, key(o)),
      addTractor: (entry) => req('POST', '/fleet', entry),
      removeTractor: (id) => req('DELETE', '/fleet/' + enc(id)),
      why: (jobId) => req('GET', '/why/' + enc(jobId)),
      mechanics: (tractorId) => req('GET', '/mechanics?tractor=' + enc(tractorId)),
      bookMechanic: (tractorId, mechanicId, o) => req('POST', '/mechanics/book', { tractor: tractorId, mechanic: mechanicId }, key(o)),
      approve: (id, decision, o) => req('POST', '/approve', { id, decision }, key(o)),
      scaleTest: ({ tractors = 5, jobs = 20 } = {}) => req('POST', '/scale-test', { tractors, jobs }),
      getLog: () => req('GET', '/log'),
      getOperation: (id) => req('GET', '/operations/' + enc(id)),
    },
  };
}

/** Mock adapter: in-process simulation; start() resolves after its snapshot is applied. */
function mockAdapter() {
  const src = createMockSource({ realtime: true });
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
 * {code,message,details} (live adds `status`). run/postEvent/patchJob/bookMechanic/approve resolve to an
 * Operation (HTTP 202, §13.2) and accept an optional trailing `{ idempotencyKey }` to reuse on retry.
 */
export const api = {
  run: call('run'),
  setClock: call('setClock'),
  postEvent: call('postEvent'),
  patchJob: call('patchJob'),
  addTractor: call('addTractor'),
  removeTractor: call('removeTractor'),
  why: call('why'),
  mechanics: call('mechanics'),
  bookMechanic: call('bookMechanic'),
  approve: call('approve'),
  scaleTest: call('scaleTest'),
  getLog: call('getLog'),
  getOperation: call('getOperation'),
};

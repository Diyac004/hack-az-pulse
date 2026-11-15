// LiveSource: REST against `${api}/api/...` and WS `${api→ws}/ws` (ARCHITECTURE.md §5, §6, §13).
// Plain ES module, no dependencies; uses only fetch / WebSocket / AbortController / setTimeout.

const PING_MS = 15000;
const REQUEST_TIMEOUT_MS = 10000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

/** Fresh idempotency key for one user action; reuse it when retrying that same action. */
export function newIdempotencyKey() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`;
}

/**
 * @param {{api: string, onMessage: (env: object) => void, onStatus?: (connected: boolean) => void}} opts
 */
export function createLiveSource({ api, onMessage, onStatus }) {
  const root = String(api || 'http://localhost:8000').replace(/\/+$/, '');
  const wsUrl = root.replace(/^http/, 'ws') + '/ws';
  const status = (v) => { try { onStatus && onStatus(v); } catch (e) { console.error('[live] onStatus error', e); } };
  const emit = (env) => { try { onMessage(env); } catch (e) { console.error('[live] onMessage error', e); } };

  let ws = null;
  let closed = false;
  let connected = false;
  let attempt = 0;
  let pingTimer = null;
  let retryTimer = null;
  let lastSeq = 0;
  let firstSnapshot = null; // {resolve, reject} until the first snapshot arrives

  function setConnected(v) {
    if (connected === v) return;
    connected = v;
    status(v);
  }

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function scheduleReconnect() {
    if (closed || retryTimer) return;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5)); // +-25% jitter
    attempt++;
    retryTimer = setTimeout(() => { retryTimer = null; open(); }, delay);
  }

  function open() {
    if (closed) return;
    let sock;
    try { sock = new globalThis.WebSocket(wsUrl); } catch (e) {
      console.warn('[live] WebSocket construct failed', e);
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      attempt = 0;
      setConnected(true);
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        try { if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'ping' })); } catch { /* close handler will follow */ }
      }, PING_MS);
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      let env;
      try { env = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) {
        console.warn('[live] malformed frame skipped', e);
        return;
      }
      if (!env || typeof env.type !== 'string') { console.warn('[live] frame without type skipped'); return; }
      if (env.type === 'pong') return;
      if (typeof env.seq === 'number') lastSeq = env.seq;
      emit(env);
      if (env.type === 'snapshot' && firstSnapshot) {
        const f = firstSnapshot; firstSnapshot = null; f.resolve();
      }
    };
    sock.onerror = () => { /* onclose follows */ };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      setConnected(false);
      scheduleReconnect();
    };
  }

  /** Open the socket; resolves once the first snapshot has been handed to onMessage. Reconnects keep running. */
  function start() {
    if (closed) return Promise.reject({ code: 'NETWORK', message: 'source closed', details: {} });
    if (firstSnapshot || ws || retryTimer) {
      return firstSnapshot ? firstSnapshot.promise : Promise.resolve();
    }
    const p = new Promise((resolve, reject) => { firstSnapshot = { resolve, reject }; });
    firstSnapshot.promise = p;
    open();
    return p;
  }

  /**
   * One REST call to `${api}/api${path}`. Resolves the parsed body for 2xx (incl. 202 Operation);
   * rejects with {code, message, details, status}.
   */
  async function request(method, path, body, { idempotencyKey, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const url = `${root}/api${path}`;
    const headers = { Accept: 'application/json' };
    const init = { method: String(method || 'GET').toUpperCase(), headers };
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const ctrl = new AbortController();
    init.signal = ctrl.signal;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    let res;
    let raw;
    try {
      res = await fetch(url, init);
      raw = await res.text(); // body read stays under the same timeout
    } catch (e) {
      if (timedOut) throw { code: 'TIMEOUT', message: `Request timed out after ${timeoutMs} ms`, details: { method: init.method, path }, status: 0 };
      throw { code: 'NETWORK', message: (e && e.message) || 'Network error', details: { method: init.method, path }, status: 0 };
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let err = null;
      try { err = JSON.parse(raw).error; } catch { /* non-JSON error body */ }
      throw {
        code: (err && err.code) || `HTTP_${res.status}`,
        message: (err && err.message) || res.statusText || `HTTP ${res.status}`,
        details: (err && err.details) || {},
        status: res.status,
      };
    }
    if (path.split('?')[0] === '/log') return raw; // JSON Lines text
    if (raw === '') return null;
    try { return JSON.parse(raw); } catch {
      throw { code: 'INTERNAL', message: 'Invalid JSON in response', details: { path }, status: res.status };
    }
  }

  /** GET /api/state, delivered as a synthetic snapshot (flagged `resync: true`; seq left at the current value). */
  async function resync() {
    const state = await request('GET', '/state');
    emit({ type: 'snapshot', t: (state && state.clock && state.clock.t) ?? 0, seq: lastSeq, data: state, resync: true });
    return state;
  }

  function close() {
    closed = true;
    clearTimers();
    const s = ws; ws = null;
    if (s) { try { s.close(); } catch { /* ignore */ } }
    setConnected(false);
    if (firstSnapshot) { const f = firstSnapshot; firstSnapshot = null; f.reject({ code: 'NETWORK', message: 'source closed', details: {}, status: 0 }); }
  }

  return { start, resync, request, close };
}

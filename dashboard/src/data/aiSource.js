// AI Supervisor source for the data layer. Two modes, same `state.ai` shape (ai-supervisor GET /ai/state):
//   ?ai=http://localhost:8060  -> the ai-supervisor service (LLM reviewers): WS /ai/ws + REST /ai/*
//   (absent)                   -> in-browser "rules" supervisor: rule-based reviewer on the current store state,
//                                 approvals go through this data layer's own api (mock or live backend).
// Either way the reviewer only PROPOSES; the operator approves; the backend's optimizer + Safety Agent decide.
import { createAiCore } from './aiCore.js';
import { rulesReview } from './aiRules.js';
import { aiCapsFrom } from './aiActions.js';

const BACKOFF_MAX_MS = 8000;

export function parseAiUrl() {
  const loc = globalThis.location;
  if (!loc || typeof loc.search !== 'string') return null;
  const raw = new URLSearchParams(loc.search).get('ai');
  if (!raw) return null;
  const u = raw.trim().replace(/\/+$/, '');
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? u : null; } catch { return null; }
}

/** ai-supervisor service client. */
function remoteAi({ url, setAi }) {
  let ws = null, attempt = 0, closed = false, timer = null, last = null;
  const offline = (why) => ({ ...(last || {}), service: 'ai-supervisor', label: (last && last.label) || 'AI Supervisor', status: 'offline', error: why, findings: (last && last.findings) || [], history: (last && last.history) || [], remote: true, url });
  const publish = (s) => { last = s; setAi({ ...s, remote: true, url }); };
  function open() {
    if (closed) return;
    let sock;
    try { sock = new globalThis.WebSocket(url.replace(/^http/, 'ws') + '/ai/ws'); } catch { return retry(); }
    ws = sock;
    sock.onopen = () => { attempt = 0; };
    sock.onmessage = (ev) => { try { const m = JSON.parse(String(ev.data)); if (m && m.type === 'ai_state' && m.data) publish(m.data); } catch { /* skip */ } };
    sock.onclose = () => { if (ws !== sock) return; ws = null; setAi(offline(`Can't reach the AI Supervisor at ${url}. Retrying…`)); retry(); };
    sock.onerror = () => {};
  }
  function retry() { if (closed || timer) return; const d = Math.min(BACKOFF_MAX_MS, 500 * 2 ** attempt++); timer = setTimeout(() => { timer = null; open(); }, d); }
  async function req(method, path) {
    let res, body = null;
    try { res = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json' } }); body = await res.json().catch(() => null); }
    catch (e) { throw { code: 'NETWORK', message: `Can't reach the AI Supervisor (${(e && e.message) || 'network error'}).`, details: {}, status: 0 }; }
    if (!res.ok) { const er = (body && body.error) || {}; throw { code: er.code || `HTTP_${res.status}`, message: er.message || `HTTP ${res.status}`, details: er.details || {}, status: res.status }; }
    return body;
  }
  return {
    start() { setAi(offline('Connecting to the AI Supervisor…')); open(); },
    api: {
      aiReview: () => req('POST', '/ai/review'),
      /** -> Operation (202) when the backend accepted the change, else the finding body */
      aiApprove: (id) => req('POST', `/ai/findings/${encodeURIComponent(id)}/approve`).then((b) => (b && b.operation) || b),
      aiDismiss: (id) => req('POST', `/ai/findings/${encodeURIComponent(id)}/dismiss`),
    },
  };
}

/** In-browser rules supervisor (no model). */
function localAi({ store, api, sourceInfo, capabilities, setAi }) {
  // what the connected backend supports (data/capabilities.js); unsupported actions are shown as advice only
  const caps = aiCapsFrom(capabilities ? capabilities.get() : null);
  let capsSource = caps.source;
  const run = { status: 'idle', last_run_at: null, last_run_t: null, latency_ms: null, trigger: null, reviews: {} };
  const core = createAiCore({
    getState: () => store.get(), caps, idPrefix: 'R',
    call: {
      preview: (trId, body) => api.preview(trId, body),
      mutate: (method, path, body, key) => {
        const o = { idempotencyKey: key };
        let m;
        if (method === 'PATCH' && (m = /^\/jobs\/([^/]+)$/.exec(path))) return api.patchJob(decodeURIComponent(m[1]), body, o);
        if (method === 'POST' && (m = /^\/tractors\/([^/]+)\/control$/.exec(path))) return api.control(decodeURIComponent(m[1]), body, o);
        if (method === 'POST' && path === '/events') return api.postEvent(body, o);
        return Promise.reject({ code: 'NOT_IMPLEMENTED', message: `No data-layer call for ${method} ${path}.`, status: 501 });
      },
    },
    onChange: () => publish(),
  });
  function publish() {
    const s = store.get() || {};
    setAi({
      service: 'rules', provider: 'rules', model: 'rules', label: 'rules', remote: false,
      status: run.status, backend: sourceInfo.kind === 'live' ? sourceInfo.api : 'in-browser mock', backend_connected: !!s.connected,
      last_run_at: run.last_run_at, last_run_t: run.last_run_t, latency_ms: run.latency_ms, trigger: run.trigger, error: null,
      plan_version: s.plan ? s.plan.version : null, reviews: run.reviews,
      capabilities: { patch_job: caps.patch_job, controls: caps.controls, preview: caps.preview, block_disabled: caps.block_disabled, source: capsSource },
      findings: core.findings(), history: core.history(),
    });
  }
  let timer = null, planV = null, busy = false, lastT = null;
  async function review(trigger) {
    if (busy) return; busy = true;
    const t0 = (globalThis.performance ?? Date).now();
    run.status = 'reviewing'; run.trigger = trigger; publish();
    const s = store.get() || {};
    const r = rulesReview(s);
    const at = new Date().toISOString();
    core.ingest('plan', r.plan); core.ingest('implements', r.implements); core.ingest('plots', []);
    run.reviews = { plan: { at, latency_ms: 0, error: null, count: r.plan.length }, implements: { at, latency_ms: 0, error: null, count: r.implements.length },
      plots: { at, latency_ms: 0, error: null, count: 0, note: 'Plot review needs a vision model: connect the AI Supervisor service (?ai=).' } };
    await core.refreshPreviews().catch(() => {});
    run.latency_ms = Math.round((globalThis.performance ?? Date).now() - t0); run.last_run_at = at; run.last_run_t = s.clock ? s.clock.t : null;
    run.status = 'idle'; busy = false; publish();
  }
  const later = (trigger, ms = 1500) => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; review(trigger); }, ms); };
  return {
    start() {
      if (capabilities) capabilities.subscribe((c) => { const n = aiCapsFrom(c); capsSource = n.source; delete n.source; Object.assign(caps, n); core.revalidate(); publish(); });
      store.subscribe((s, msg) => {
        if (!msg || msg.type === 'ai') return;
        if (msg.type === 'operation' && msg.data) core.onOperation(msg.data);
        if (msg.type === 'clock' && s.clock) lastT = s.clock.t;
        if (msg.type === 'snapshot') {
          const t = s.clock ? s.clock.t : 0;
          if (!msg.resync && lastT != null && t + 0.5 < lastT) core.reset(); // new farm day
          lastT = t;
          planV = s.plan ? s.plan.version : null; for (const op of s.operations || []) core.onOperation(op); later('snapshot', 800); }
        if (msg.type === 'plan' && s.plan && s.plan.version !== planV) { planV = s.plan.version; core.revalidate(); later('plan v' + planV); }
      });
      publish();
    },
    api: {
      aiReview: () => { review('manual'); return Promise.resolve({ queued: true }); },
      aiApprove: (id) => core.approve(id).then((o) => o.operation || o.finding),
      aiDismiss: (id) => Promise.resolve().then(() => ({ finding: core.dismiss(id) })),
    },
  };
}

/** @returns {{start: () => void, api: {aiReview, aiApprove, aiDismiss}, info: {kind: 'remote'|'rules', url: string|null}}} */
export function createAiSource({ store, api, sourceInfo, capabilities, setAi }) {
  const url = parseAiUrl();
  const impl = url ? remoteAi({ url, setAi }) : localAi({ store, api, sourceInfo, capabilities, setAi });
  return { ...impl, info: { kind: url ? 'remote' : 'rules', url } };
}

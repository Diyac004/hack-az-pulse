// AI Supervisor service: an LLM in the loop that REVIEWS fleet plans, tractor implements and plot validity and
// PROPOSES fixes. The operator approves; the backend's optimizer + Safety Agent decide (PROJECT.md Change 6: the
// LLM never bypasses Safety, it only proposes). Works against any contract backend (ARCHITECTURE.md §5/§6/§13).
//
//   API=http://localhost:8000 AI_PROVIDER=agy node ai-supervisor/server.mjs      PORT=8060 (default)
//
// Endpoints (CORS open):
//   GET  /ai/state                    AiState (status, provider/model, last run, latency, findings, history, capabilities)
//   POST /ai/review                   run a review now (202 {queued:true}; results arrive on /ai/ws and /ai/state)
//   POST /ai/findings/{id}/approve    re-validate, /preview for re-planning actions, apply with an Idempotency-Key
//                                     -> 202 {finding, operation} | 409/422/501 {error}
//   POST /ai/findings/{id}/dismiss    -> 200 {finding}
//   WS   /ai/ws                       {type:'ai_state', data: AiState} on every change
//
// Env: PORT, API, AI_PROVIDER (agy|openai|anthropic|rules), AGY_MODEL, OPENAI_API_KEY/OPENAI_MODEL,
//      ANTHROPIC_API_KEY/ANTHROPIC_MODEL, MIN_GAP_S (20), DEBOUNCE_S (4), AUTO_REVIEW (1), QUIET.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import { createLiveSource } from '../dashboard/src/data/liveSource.js';
import { createStore } from '../dashboard/src/data/store.js';
import { createAiCore } from '../dashboard/src/data/aiCore.js';
import { aiCapsFrom } from '../dashboard/src/data/aiActions.js';
import { detectCapabilities } from '../dashboard/src/data/capabilities.js';
import { rulesReview } from '../dashboard/src/data/aiRules.js';
import { createLLM } from './llm.mjs';
import { compactFacts, planPrompt, implementsPrompt, plotPrompt, plotFindings } from './reviewers.mjs';
import { loadBasemap, cropPlots } from './crop.mjs';

if (!globalThis.WebSocket) globalThis.WebSocket = WsWebSocket; // Node 18-21: liveSource needs a WebSocket global

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8060;
const API = String(process.env.API || 'http://localhost:8000').replace(/\/+$/, '');
const PROVIDER = String(process.env.AI_PROVIDER || 'agy').toLowerCase();
const MIN_GAP_MS = (Number(process.env.MIN_GAP_S) || 20) * 1000;
const DEBOUNCE_MS = (Number(process.env.DEBOUNCE_S) || 4) * 1000;
const AUTO = !/^(0|false|no)$/i.test(process.env.AUTO_REVIEW || '1');
const QUIET = /^(1|true|yes)$/i.test(process.env.QUIET || '');
const NAIP_PNG = process.env.NAIP_PNG || path.join(HERE, '../dashboard/public/static/naip.png');
const NAIP_JSON = process.env.NAIP_JSON || path.join(HERE, '../dashboard/public/static/naip.json');
const log = (...a) => { if (!QUIET) console.log(`[ai-supervisor ${new Date().toISOString().slice(11, 19)}]`, ...a); };

// ---------------------------------------------------------------- model
const llm = PROVIDER === 'rules' ? { provider: 'rules', model: 'rules', complete: null } : createLLM({ provider: PROVIDER });
log(`provider ${llm.provider}, model ${llm.model}, backend ${API}`);

// ---------------------------------------------------------------- backend link (same client + reducer as the dashboard)
const store = createStore({ source: 'live' });
const src = createLiveSource({ api: API, onMessage: (env) => store.apply(env), onStatus: (c) => store.setConnected(c) });
store.setResync(() => src.resync());
const state = () => store.get();

// capabilities of the connected backend (only offer what it supports; the rest is advice)
const caps = { patch_job: false, controls: false, preview: false, events: false, block_disabled: false, probed: false, source: null };
// Same detection as the dashboard (data/capabilities.js): openapi / bridge profile / side-effect-free GET probes.
async function probeCaps() {
  const c = await detectCapabilities({ root: API, request: src.request, state: state() });
  const n = aiCapsFrom(c);
  Object.assign(caps, n, { probed: true });
  log('capabilities:', JSON.stringify(caps));
}

// ---------------------------------------------------------------- core (findings lifecycle)
const core = createAiCore({
  getState: state, caps,
  call: {
    preview: (trId, body) => src.request('POST', `/tractors/${encodeURIComponent(trId)}/preview`, body, { timeoutMs: 8000 }),
    mutate: (method, p, body, key) => src.request(method, p, body, { idempotencyKey: key, timeoutMs: 10000 }),
  },
  onChange: () => pushState(),
});

// ---------------------------------------------------------------- review scheduling
const run = { status: 'idle', running: false, last_run_at: null, last_run_t: null, latency_ms: null, error: null, trigger: null, reviews: {}, summary: {}, next_at: null, pending: false };
let lastStart = 0, debounce = null, plotCache = { sig: null, plots: null, latency_ms: null };
let basemap = null;

function schedule(trigger, delay = DEBOUNCE_MS) {
  if (!AUTO && trigger !== 'manual') return;
  const keepManual = run.pending && run.trigger === 'manual';
  run.pending = true; if (!keepManual) run.trigger = trigger;
  if (debounce) clearTimeout(debounce);
  const wait = Math.max(delay, lastStart + MIN_GAP_MS - Date.now());
  run.next_at = new Date(Date.now() + wait).toISOString();
  debounce = setTimeout(() => { debounce = null; maybeRun(); }, wait);
  pushState();
}
function maybeRun() {
  if (run.running) return; // the finished run re-checks `pending`
  if (!state().scenario) { schedule(run.trigger || 'waiting', 1000); return; }
  const gap = lastStart + MIN_GAP_MS - Date.now();
  if (gap > 0) { schedule(run.trigger, gap); return; }
  run.pending = false; run.next_at = null;
  reviewAll(run.trigger || 'auto').catch((e) => log('review crashed', e));
}

async function timed(name, fn) {
  const t0 = Date.now();
  try { const v = await fn(); run.reviews[name] = { at: new Date().toISOString(), latency_ms: Date.now() - t0, error: null, ...(v && v.meta ? v.meta : {}) }; return v; }
  catch (e) { run.reviews[name] = { at: new Date().toISOString(), latency_ms: Date.now() - t0, error: e.message || String(e) }; log(`${name} review failed:`, e.message, e.details ? JSON.stringify(e.details).slice(0, 300) : ''); return null; }
}

async function reviewAll(trigger) {
  run.running = true; run.status = 'reviewing'; run.error = null; run.trigger = trigger;
  lastStart = Date.now(); const t0 = Date.now();
  const s0 = state();
  run.plan_version = s0.plan ? s0.plan.version : null;
  pushState();
  if (!caps.probed) await probeCaps();
  const facts = compactFacts(s0, caps);
  log(`review started (${trigger}) plan v${run.plan_version} with ${llm.provider}/${llm.model}`);
  const jobs = [];
  if (llm.provider === 'rules') {
    const r = rulesReview(s0);
    jobs.push(timed('plan', async () => ({ findings: r.plan, meta: { count: r.plan.length, summary: null } })));
    jobs.push(timed('implements', async () => ({ findings: r.implements, meta: { count: r.implements.length, summary: null } })));
    run.reviews.plots = { at: new Date().toISOString(), latency_ms: 0, error: null, count: 0, note: 'Plot review needs a vision model (AI_PROVIDER=agy|openai|anthropic).' };
  } else {
    const llmReview = (name, prompt, reviewer) => timed(name, async () => {
      const out = await llm.complete(prompt);
      const findings = (out.findings || []).map((f) => ({ ...f, reviewer }));
      return { findings, meta: { count: findings.length, summary: out.summary || null } };
    });
    jobs.push(llmReview('plan', planPrompt(facts, capsForPrompt()), 'plan'));
    jobs.push(llmReview('implements', implementsPrompt(facts, capsForPrompt()), 'implements'));
    jobs.push(timed('plots', async () => {
      const sc = s0.scenario;
      if (!sc || !sc.geo) throw new Error('scenario.geo missing: cannot place blocks on the image');
      const sig = JSON.stringify({ b: sc.blocks, d: sc.depot, g: sc.geo });
      let plots = plotCache.sig === sig ? plotCache.plots : null, cached = !!plots;
      if (!plots) {
        basemap = basemap || loadBasemap(NAIP_PNG, NAIP_JSON);
        const crops = cropPlots(basemap, sc);
        const out = await llm.complete({ ...plotPrompt(crops), images: crops.map((c) => ({ name: `${c.id}.png`, data: c.png, mime: 'image/png', label: c.kind === 'depot' ? 'Depot' : `Block ${c.id}` })) });
        plots = out.plots || []; plotCache = { sig, plots };
      }
      const disabled = new Set((state().scenario?.disabled_blocks || []).map((d) => d.block));
      const findings = plotFindings(plots, sc).filter((f) => !(f.action.block && disabled.has(f.action.block)));
      return { findings, meta: { count: findings.length, cached, plots } };
    }));
  }
  const [plan, impl, plots] = await Promise.all(jobs);
  if (plan) core.ingest('plan', plan.findings);
  if (impl) core.ingest('implements', impl.findings);
  if (plots) core.ingest('plots', plots.findings);
  run.latency_ms = Date.now() - t0; run.last_run_at = new Date().toISOString(); run.last_run_t = s0.clock ? s0.clock.t : null;
  const errs = Object.entries(run.reviews).filter(([, v]) => v && v.error).map(([k, v]) => `${k}: ${v.error}`);
  run.error = errs.length ? errs.join(' · ') : null;
  run.status = errs.length === 3 ? 'error' : 'previewing'; pushState();
  await core.refreshPreviews().catch((e) => log('previews failed', e.message));
  run.running = false; run.status = run.error && errs.length === 3 ? 'error' : 'idle';
  log(`review done in ${run.latency_ms} ms: ${core.findings().length} open findings${run.error ? ' (errors: ' + run.error + ')' : ''}`);
  pushState();
  if (run.pending) maybeRun();
}
const capsForPrompt = () => ({ patch_priority: caps.patch_job, pin_job: caps.patch_job, ban_type: caps.controls, off_duty: caps.controls, set_implements: caps.controls });

// triggers: new plan version, fleet change (status/implements/manual), weather change, new run
let sig = { plan: null, fleet: null, weather: null };
let lastT = null;
store.subscribe((s, msg) => {
  if (!msg) return;
  if (msg.type === 'operation' && msg.data) core.onOperation(msg.data);
  if (msg.type === 'snapshot') {
    // a new farm day (clock went backwards: POST /run or a restarted backend) starts the review memory over
    const t = s.clock ? s.clock.t : 0;
    if (!msg.resync && lastT != null && t + 0.5 < lastT) { core.reset(); log('new farm day: findings reset'); }
    lastT = t;
    if (!msg.resync) caps.probed = false;
    for (const op of s.operations || []) core.onOperation(op);
    sig.plan = s.plan ? s.plan.version : null; schedule('snapshot', 1500); return;
  }
  if (msg.type === 'plan' && s.plan && s.plan.version !== sig.plan) { sig.plan = s.plan.version; core.revalidate(); schedule('plan v' + s.plan.version); }
  if (msg.type === 'fleet') {
    // only changes that matter for planning: membership, up/down, implements, manual (not traveling <-> working)
    const DOWN = ['broken', 'awaiting_mechanic', 'repair_scheduled', 'repairing', 'offline', 'removing', 'starting'];
    const f = JSON.stringify((s.fleet || []).map((t) => [t.id, DOWN.includes(t.status) ? t.status : 'up', t.implements, t.manual]));
    if (f !== sig.fleet) { const first = sig.fleet === null; sig.fleet = f; if (!first) schedule('fleet change'); }
  }
  if (msg.type === 'weather') {
    const w = JSON.stringify(s.weather && s.weather.spray_allowed_now); // spray permissions changed = plan-relevant weather
    if (w !== sig.weather) { const first = sig.weather === null; sig.weather = w; if (!first) schedule('weather change'); }
  }
  if (msg.type === 'connection') pushState();
  if (msg.type === 'clock' && s.clock) lastT = s.clock.t;
});

// ---------------------------------------------------------------- state out
function aiState() {
  const s = state();
  return {
    service: 'ai-supervisor', provider: llm.provider, model: llm.model,
    label: llm.provider === 'rules' ? 'rules' : `${llm.model} via ${llm.provider}`,
    status: !s.connected ? 'offline' : run.status, backend: API, backend_connected: !!s.connected,
    last_run_at: run.last_run_at, last_run_t: run.last_run_t, latency_ms: run.latency_ms, trigger: run.trigger,
    next_review_at: run.next_at, error: run.error, plan_version: run.plan_version ?? null,
    reviews: run.reviews,
    capabilities: { patch_job: caps.patch_job, controls: caps.controls, preview: caps.preview, block_disabled: caps.block_disabled, source: caps.source },
    findings: core.findings(), history: core.history(),
  };
}
const wss = new WebSocketServer({ noServer: true });
let pushTimer = null;
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const msg = JSON.stringify({ type: 'ai_state', data: aiState() });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  }, 80);
}

// ---------------------------------------------------------------- HTTP
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' };
function reply(res, status, body) { res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
const errBody = (e) => ({ error: { code: e.code || 'INTERNAL', message: e.message || String(e), details: e.details || {} } });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  try {
    if (req.method === 'GET' && (p === '/' || p === '/ai')) return reply(res, 200, { ok: true, service: 'ai-supervisor', state: '/ai/state', ws: '/ai/ws' });
    if (req.method === 'GET' && p === '/ai/state') return reply(res, 200, aiState());
    if (req.method === 'POST' && p === '/ai/review') {
      lastStart = run.running ? lastStart : 0; // a manual review skips the 20 s gap (still one at a time)
      if (run.running) { run.pending = true; run.trigger = 'manual'; pushState(); return reply(res, 202, { queued: true, running: true }); }
      schedule('manual', 0);
      return reply(res, 202, { queued: true, running: false });
    }
    let m = /^\/ai\/findings\/([^/]+)\/(approve|dismiss)$/.exec(p);
    if (req.method === 'POST' && m) {
      const id = decodeURIComponent(m[1]);
      if (m[2] === 'dismiss') return reply(res, 200, { finding: core.dismiss(id) });
      const out = await core.approve(id);
      log(`approved ${id}: ${out.finding.label} -> ${out.operation ? out.operation.id + ' ' + out.operation.status : 'applied'}`);
      return reply(res, 202, out);
    }
    return reply(res, 404, errBody({ code: 'NOT_FOUND', message: `No endpoint ${req.method} ${p}.` }));
  } catch (e) {
    const status = e && e.status && e.status >= 400 ? e.status : e && e.code === 'NOT_FOUND' ? 404 : 500;
    if (status >= 500 && !(e && e.code)) console.error('[ai-supervisor]', e);
    return reply(res, status, { ...errBody(e), finding: e && e.finding ? e.finding : undefined });
  }
});
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url || '/', 'http://localhost');
  if (pathname !== '/ai/ws') { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => { ws.send(JSON.stringify({ type: 'ai_state', data: aiState() })); });
});

server.listen(PORT, () => {
  log(`listening on http://localhost:${PORT}  (GET /ai/state, POST /ai/review, WS /ai/ws)`);
  log(`dashboard: ?source=live&api=${API}&ai=http://localhost:${PORT}`);
  src.start().catch((e) => log('backend not reachable yet:', e.message || e.code));
});
function shutdown() { src.close(); for (const c of wss.clients) { try { c.close(1001); } catch { /* */ } } server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

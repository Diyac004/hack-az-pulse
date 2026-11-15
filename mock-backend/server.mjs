// Simulated backend for the dashboard's live mode (ARCHITECTURE.md §5 REST, §6 WS, §13 Operations).
// It wraps the in-browser simulation (dashboard/src/data/mockSource.js) unchanged, so live mode behaves
// exactly like ?source=mock, but over real HTTP + WebSocket.
//
//   node server.mjs [--auto-repair] [--pace=N]   PORT=8000 (default)   AUTO_REPAIR=1, PACE=N also work
//   pace = farm minutes per real second at 1x; default 1.2 (the 720-min day takes 10 real minutes).
//
// One shared simulation. Every WS client gets an immediate `snapshot` with seq 1, then every envelope the
// simulation emits, re-stamped with that connection's own seq counter (§6: seq is per connection).
// The farm day lasts 10 real minutes at speed 1 (PACE / --pace to change), so the simulation clock starts on the first
// WS connection or /api request, not at server boot. POST /api/run resets the day.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createMockSource, parsePace, FARM_MIN_PER_REAL_S } from '../dashboard/src/data/mockSource.js';

const PORT = Number(process.env.PORT) || 8000;
const AUTO_REPAIR = process.argv.includes('--auto-repair') || /^(1|true|yes)$/i.test(process.env.AUTO_REPAIR || '');
const paceArg = (process.argv.find((a) => a.startsWith('--pace=')) || '').slice(7);
const PACE_RAW = paceArg || process.env.PACE || '';
const PACE = parsePace(PACE_RAW) ?? FARM_MIN_PER_REAL_S;
if (PACE_RAW && parsePace(PACE_RAW) === null) console.warn(`[mock-backend] ignoring invalid pace "${PACE_RAW}" (want a number 0-120); using ${FARM_MIN_PER_REAL_S}`);
const QUIET = /^(1|true|yes)$/i.test(process.env.QUIET || '');

// ---------------------------------------------------------------- simulation + fan-out
const sim = createMockSource({ realtime: true, autoRepair: AUTO_REPAIR, pace: PACE });
/** @type {Set<{ws: import('ws').WebSocket, seq: number}>} */
const clients = new Set();
let simStarted = false;

function send(client, type, t, data) {
  if (client.ws.readyState !== 1) return;
  client.seq += 1;
  client.ws.send(JSON.stringify({ type, t, seq: client.seq, data }));
}

function broadcast(env) {
  // The sim's own seq is ignored; each socket has its own counter. Node is single-threaded and every
  // send happens synchronously here, so per-socket order equals emission order (§13.3 single writer).
  for (const c of clients) send(c, env.type, env.t, env.data);
}

function ensureSim() {
  if (simStarted) return;
  simStarted = true;
  // connect() emits one snapshot through the handler; nobody is subscribed yet, so it goes nowhere.
  sim.connect({ onMessage: broadcast });
  log(`simulation started (pace ${PACE} farm min/s at 1x: day = ${(720 / PACE / 60).toFixed(1)} real min)${AUTO_REPAIR ? ' (auto-repair on)' : ''}`);
}

const snapshot = () => { ensureSim(); return sim.debug.snapshot(); };

function log(...a) { if (!QUIET) console.log(`[mock-backend ${new Date().toISOString().slice(11, 19)}]`, ...a); }

// ---------------------------------------------------------------- HTTP helpers
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Mock-Fail',
  'Access-Control-Max-Age': '600',
};

// Contract pins CONFLICT=409 (§13.2 control, §13.3 idempotency) and TIMEOUT=503; the rest are our choice.
const STATUS_BY_CODE = {
  INVALID_INPUT: 400, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, CONFLICT: 409, AT_CAPACITY: 409,
  NEEDS_MANUAL: 409, SAFETY_REJECTED: 422, WEATHER_BLOCKED: 422, NOT_IMPLEMENTED: 501,
  GATEWAY_UNAVAILABLE: 503, TIMEOUT: 503, INTERNAL: 500,
};

class HttpError extends Error {
  constructor(status, code, message, details = {}) { super(message); Object.assign(this, { status, code, details }); }
}
const isOperation = (x) => !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.status === 'string' && 'kind' in x;
const FAIL_TEXT = {
  GATEWAY_UNAVAILABLE: "Can't reach this tractor's AgOpenWeb container right now.",
  TIMEOUT: 'The re-plan preview took longer than 2 seconds.',
};
function failIf(code) {
  if (!code) return;
  throw new HttpError(STATUS_BY_CODE[code] || 500, code, FAIL_TEXT[code] || 'Forced failure (X-Mock-Fail).', { forced: true });
}
const notImplemented = (what) => new HttpError(501, 'NOT_IMPLEMENTED', `${what} is not supported by the simulated backend.`, { simulated: true });

function reply(res, status, body, contentType = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(payload);
}

function replyError(res, e) {
  if (e && typeof e.code === 'string' && typeof e.message === 'string') {
    const status = e.status || STATUS_BY_CODE[e.code] || 500;
    return reply(res, status, { error: { code: e.code, message: e.message, details: e.details || {} } });
  }
  console.error('[mock-backend] internal error', e);
  return reply(res, 500, { error: { code: 'INTERNAL', message: 'Something went wrong in the simulated backend.', details: { reason: String(e?.message || e) } } });
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {
    throw new HttpError(400, 'INVALID_INPUT', 'The request body is not valid JSON.', { field: 'body' });
  }
}
function requireObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'INVALID_INPUT', 'The request body must be a JSON object.', { field: 'body' });
  return body;
}

// ---------------------------------------------------------------- routes
// Each handler: ({params, query, body, key}) -> {status, body, contentType?}
const ok = (body, status = 200) => ({ status, body });
const accepted = (body) => ({ status: 202, body }); // §13.2 async mutations + POST /fleet

/** @type {Array<[string, string, (ctx: any) => Promise<any> | any, string]>} method, pattern, handler, note */
const ROUTES = [
  ['GET', '/api/state', () => ok(snapshot()), 'Snapshot'],
  ['GET', '/api/scenario', () => ok(snapshot().scenario), 'Scenario'],
  ['POST', '/api/run', async ({ body, key }) => accepted(await sim.api.run(requireObject(body).mode ?? 'ours', { idempotencyKey: key })), '202 Operation; WS snapshot follows'],
  ['POST', '/api/clock', async ({ body }) => ok(await sim.api.setClock(requireObject(body))), 'Clock'],
  ['GET', '/api/jobs', () => ok(snapshot().jobs), 'Job[]'],
  ['POST', '/api/jobs', async ({ body, key }) => accepted(await sim.api.submitJobs(requireObject(body).jobs, { idempotencyKey: key })), '202 Operation (source jobs); 400/409 with details.errors[].loc'],
  ['PATCH', '/api/jobs/:id', async ({ params, body, key }) => accepted(await sim.api.patchJob(params.id, requireObject(body), { idempotencyKey: key })), '202 Operation'],
  ['POST', '/api/events', async ({ body, key }) => accepted(await sim.api.postEvent(requireObject(body), { idempotencyKey: key })), '202 Operation'],
  ['GET', '/api/fleet', () => ok(snapshot().fleet), 'Tractor[]'],
  ['POST', '/api/fleet', async ({ body }) => accepted(await sim.api.addTractor(requireObject(body))), '202 {tractor} status starting'],
  ['DELETE', '/api/fleet/:id', async ({ params }) => ok(await sim.api.removeTractor(params.id)), '{ok:true}'],
  ['GET', '/api/hosts', () => ok(snapshot().capacity), 'Capacity'],
  // Tractor Control Panel (§5 rows 13-16, §13.2). Debug: header `X-Mock-Fail: <CODE>` makes any of these four
  // fail with that error code (e.g. GATEWAY_UNAVAILABLE, TIMEOUT) so the dashboard's error copy can be checked.
  ['GET', '/api/tractors/:id/controls', async ({ params, fail }) => { failIf(fail); return ok(await sim.api.getControls(params.id)); }, '{controls, values}'],
  ['POST', '/api/tractors/:id/control', async ({ params, body, fail }) => {
    failIf(fail);
    const r = await sim.api.control(params.id, requireObject(body));
    return isOperation(r) ? accepted(r) : ok(r); // replans:true -> 202 Operation, else 200 {ok,value,explanation}
  }, '200 {ok,value,explanation} | 202 Operation | 409'],
  ['POST', '/api/tractors/:id/preview', async ({ params, body, fail }) => { failIf(fail); return ok(await sim.api.preview(params.id, requireObject(body))); }, 'Preview'],
  ['POST', '/api/tractors/:id/manual', async ({ params, body, key, fail }) => {
    failIf(fail);
    const b = requireObject(body);
    if (typeof b.on !== 'boolean') throw new HttpError(400, 'INVALID_INPUT', 'Body must be {"on": true} or {"on": false}.', { field: 'on' });
    return accepted(await sim.api.manual(params.id, b.on, { idempotencyKey: key }));
  }, '202 Operation'],
  ['GET', '/api/why/:id', async ({ params }) => ok(await sim.api.why(params.id)), 'Why'],
  ['GET', '/api/mechanics', async ({ query }) => {
    const t = query.get('tractor');
    if (!t) throw new HttpError(400, 'INVALID_INPUT', 'Say which tractor needs a mechanic (?tractor=T1).', { field: 'tractor' });
    return ok(await sim.api.mechanics(t));
  }, '{options}'],
  ['POST', '/api/mechanics/book', async ({ body, key }) => {
    const b = requireObject(body);
    return accepted(await sim.api.bookMechanic(b.tractor, b.mechanic, { idempotencyKey: key }));
  }, '202 Operation'],
  ['POST', '/api/approve', async ({ body, key }) => {
    const b = requireObject(body);
    return accepted(await sim.api.approve(b.id, b.decision, { idempotencyKey: key }));
  }, '202 Operation'],
  ['GET', '/api/weather', () => ok(snapshot().weather), 'Weather'],
  ['GET', '/api/metrics', () => ok(snapshot().metrics), 'Metrics'],
  ['GET', '/api/log', async () => { ensureSim(); return { status: 200, body: await sim.api.getLog(), contentType: 'text/plain; charset=utf-8' }; }, 'JSON Lines text'],
  ['POST', '/api/scale-test', async ({ body }) => ok(await sim.api.scaleTest(requireObject(body))), 'scale result'],
  ['GET', '/api/operations/:id', async ({ params }) => ok(await sim.api.getOperation(params.id)), 'Operation or 404'],
  ['GET', '/openapi.json', () => ok(openapi()), 'this route list'],
];

const compiled = ROUTES.map(([method, pattern, handler, note]) => {
  const names = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '/?$');
  return { method, pattern, handler, note, re, names };
});

function openapi() {
  return {
    note: 'Simulated backend (mock-backend/server.mjs). FastAPI would serve a full OpenAPI document here; this is a static route list.',
    contract: 'ARCHITECTURE.md §5, §6, §13',
    websocket: '/ws',
    routes: compiled.map((r) => ({ method: r.method, path: r.pattern.replace(/:(\w+)/g, '{$1}'), returns: r.note })),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  try {
    const matches = compiled.map((r) => ({ r, m: r.re.exec(path) })).filter((x) => x.m);
    if (!matches.length) {
      if (path === '/' || path === '') return reply(res, 200, { ok: true, service: 'harvest-fleet mock backend', api: '/api', ws: '/ws', routes: '/openapi.json' });
      throw new HttpError(404, 'NOT_FOUND', `There is no endpoint at ${path}.`, { path });
    }
    const hit = matches.find((x) => x.r.method === req.method);
    if (!hit) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed on ${path}.`, { allowed: matches.map((x) => x.r.method) });
    if (path.startsWith('/api')) ensureSim();
    const params = Object.fromEntries(hit.r.names.map((n, i) => [n, decodeURIComponent(hit.m[i + 1])]));
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : undefined;
    const key = req.headers['idempotency-key'] || undefined;
    const fail = req.headers['x-mock-fail'] ? String(req.headers['x-mock-fail']).toUpperCase() : undefined;
    const out = await hit.r.handler({ params, query: url.searchParams, body, key, fail });
    reply(res, out.status, out.body, out.contentType);
    if (req.method !== 'GET') log(req.method, path, '->', out.status, out.body && out.body.id ? `${out.body.id} ${out.body.status}` : '');
  } catch (e) {
    replyError(res, e);
    if (e && e.code) log(req.method, path, '->', e.status || STATUS_BY_CODE[e.code] || 500, e.code);
  }
});

// ---------------------------------------------------------------- WebSocket /ws
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url || '/', 'http://localhost');
  if (pathname !== '/ws') { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ensureSim();
  const client = { ws, seq: 0 };
  // Snapshot + subscribe in one synchronous block: nothing can be emitted in between.
  const snap = sim.debug.snapshot();
  send(client, 'snapshot', snap.clock.t, snap);
  clients.add(client);
  log(`ws connected (${clients.size} client${clients.size === 1 ? '' : 's'})`);
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
    // Pong carries no seq: liveSource drops it before reading seq, so a numbered pong would look like a gap.
    if (msg && msg.type === 'ping' && ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong' }));
  });
  ws.on('close', () => { clients.delete(client); log(`ws closed (${clients.size} left)`); });
  ws.on('error', () => { clients.delete(client); });
});

server.listen(PORT, () => {
  log(`listening on http://localhost:${PORT}  (REST /api/*, WS /ws, routes /openapi.json)`);
  log(`open the dashboard with ?source=live&api=http://localhost:${PORT}`);
});

function shutdown() {
  sim.stop();
  for (const c of clients) { try { c.ws.close(1001, 'server shutting down'); } catch { /* ignore */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

#!/usr/bin/env node
// Cold-start end-to-end check against a FRESH Anay FastAPI backend (MockGateway build).
//
//   API=http://localhost:8000 node scripts/coldstart-e2e.mjs [--dashboard-capabilities]
//
// The backend must have just booted (paused, plan.version 0, no run yet): the script drives
// the whole lifecycle once, so re-run it against a restarted server, not a used one.
// Node >= 18. Uses built-in fetch + WebSocket (falls back to `ws` from mock-backend/node_modules).
// Exit 0 = every check passed, 1 = any failure.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const API = (process.env.API || 'http://localhost:8000').replace(/\/+$/, '');
const WS_URL = API.replace(/^http/, 'ws') + '/ws';
const WANT_CAPS = process.argv.includes('--dashboard-capabilities');

let passes = 0, fails = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, detail) {
  if (cond) { passes++; console.log(`PASS  ${name}`); }
  else { fails++; console.log(`FAIL  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 300) : ''}`); }
  return !!cond;
}
function note(msg) { console.log(`NOTE  ${msg}`); }
function fatal(name, detail) { check(name, false, detail); finish(); }

async function http(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(API + path, init);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const state = async () => (await http('GET', '/api/state')).json;

// ---------------------------------------------------------------- websocket
async function openWs() {
  let WSImpl = globalThis.WebSocket;
  if (!WSImpl) {
    const req = createRequire(join(REPO, 'mock-backend', 'package.json'));
    WSImpl = req('ws');
    note('global WebSocket missing; using ws from mock-backend/node_modules');
  }
  const msgs = [];
  const sock = new WSImpl(WS_URL);
  const onMsg = (ev) => {
    const raw = ev && ev.data !== undefined ? ev.data : ev;
    try { const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); m._at = Date.now(); msgs.push(m); } catch { /* ignore */ }
  };
  if (sock.addEventListener) sock.addEventListener('message', onMsg); else sock.on('message', onMsg);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), 8000);
    const ok = () => { clearTimeout(t); resolve(); };
    if (sock.addEventListener) { sock.addEventListener('open', ok); sock.addEventListener('error', () => reject(new Error('ws error'))); }
    else { sock.on('open', ok); sock.on('error', reject); }
  });
  return { msgs, close: () => { try { sock.close(); } catch { /* ignore */ } } };
}

async function waitFor(fn, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(stepMs);
  }
}
const opMsg = (msgs, id, status, from = 0) =>
  msgs.slice(from).find((m) => m.type === 'operation' && m.data && m.data.id === id && m.data.status === status);

let ws;
function finish() {
  if (ws) ws.close();
  console.log(`\n${fails === 0 ? 'OVERALL: PASS' : 'OVERALL: FAIL'}  (${passes} passed, ${fails} failed)`);
  process.exit(fails === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- main
console.log(`cold-start e2e against ${API}`);
try {
  ws = await openWs();
} catch (e) { fatal('websocket connects', String(e)); }

// 1. fresh: paused, plan v0
let s = await state();
check('GET /api/state: boots paused', s && s.clock && s.clock.playing === false, s && s.clock);
check('GET /api/state: plan.version is 0 (fresh server)', s && s.plan && s.plan.version === 0, s && s.plan && s.plan.version);
await waitFor(() => ws.msgs.length, 2000);
check('WS: snapshot arrives first', ws.msgs[0] && ws.msgs[0].type === 'snapshot', ws.msgs[0] && ws.msgs[0].type);
if (!s || !s.plan || s.plan.version !== 0) note('server is not fresh; the remaining checks may fail. Restart the backend and re-run.');
const jobsBefore = (s && s.jobs ? s.jobs.length : 0);

// 2. clock before a run: 409
let r = await http('POST', '/api/clock', { playing: true });
check('POST /api/clock {playing:true} before a run -> 409', r.status === 409, { status: r.status, body: r.json });

// 3. run
const mark = ws.msgs.length;
r = await http('POST', '/api/run', { mode: 'ours' });
check('POST /api/run {mode:"ours"} -> 202 Operation', r.status === 202 && r.json && r.json.id && r.json.kind === 'run', { status: r.status, body: r.json });
const runId = r.json && r.json.id;
if (!runId) fatal('run operation id present', r.json);

check('WS: operation running', !!(await waitFor(() => opMsg(ws.msgs, runId, 'running', mark), 10000)));
const planMsg = await waitFor(() => ws.msgs.slice(mark).find((m) => m.type === 'plan'), 15000);
check('WS: plan message with version >= 1', !!(planMsg && planMsg.data.version >= 1), planMsg && planMsg.data.version);
check('WS: operation succeeded', !!(await waitFor(() => opMsg(ws.msgs, runId, 'succeeded', mark), 15000)),
  (await http('GET', '/api/operations/' + runId)).json);
// order: running before plan before succeeded
{
  const idx = (pred) => ws.msgs.findIndex(pred);
  const iRun = idx((m) => m.type === 'operation' && m.data.id === runId && m.data.status === 'running');
  const iPlan = idx((m) => m.type === 'plan');
  const iOk = idx((m) => m.type === 'operation' && m.data.id === runId && m.data.status === 'succeeded');
  check('WS order: running < plan < succeeded', iRun >= 0 && iRun < iPlan && iPlan < iOk, { iRun, iPlan, iOk });
}
s = await state();
check('REST: plan.version >= 1 after the run', s.plan.version >= 1, s.plan.version);
const v1 = s.plan.version;

// 4. clock playing
if (!s.clock.playing) {
  note('clock not auto-playing after the run; sending {playing:true}');
  r = await http('POST', '/api/clock', { playing: true });
  check('POST /api/clock {playing:true} after run -> 200', r.status === 200, r.status);
}
const t0 = (await state()).clock.t;
const advanced = await waitFor(async () => (await state()).clock.t > t0, 4000, 200);
check('clock is playing (t advances)', (await state()).clock.playing === true && !!advanced, (await state()).clock);

// 5. pause: t frozen for 1.5 s
r = await http('POST', '/api/clock', { playing: false });
check('POST /api/clock {playing:false} -> 200 and paused', r.status === 200 && r.json && r.json.playing === false, r.json);
await sleep(300); // let any in-flight tick land
const tp = (await state()).clock.t;
await sleep(1500);
const tp2 = (await state()).clock.t;
check('pause: t frozen over 1.5 s', tp === tp2, { before: tp, after: tp2 });

// 6. resume
r = await http('POST', '/api/clock', { playing: true });
check('POST /api/clock {playing:true} (resume) -> 200', r.status === 200 && r.json && r.json.playing === true, r.json);
const tr = (await state()).clock.t;
check('resume: t advances', !!(await waitFor(async () => (await state()).clock.t > tr + 0.3, 4000, 200)), { t0: tr });

// 7. submit a job
s = await state();
const beforeIds = new Set(s.jobs.map((j) => j.id));
const vBeforeJob = s.plan.version;
const jobBody = { jobs: [{ type: 'mow', implement: 'mower', block: 'E', duration_min: 40, priority: 3, deadline_t: 700 }] };
r = await http('POST', '/api/jobs', jobBody);
check('POST /api/jobs -> 202', r.status === 202 && r.json && r.json.id, { status: r.status, body: r.json });
const jobOp = r.json && r.json.id;
if (jobOp) {
  const done = await waitFor(async () => { const o = (await http('GET', '/api/operations/' + jobOp)).json; return o && o.status !== 'queued' && o.status !== 'running' ? o : null; }, 20000);
  check('jobs operation succeeded', done && done.status === 'succeeded', done);
}
s = await state();
const added = s.jobs.filter((j) => !beforeIds.has(j.id));
check('new job appears in state.jobs', added.length === 1 && s.jobs.length === beforeIds.size + 1, { added: added.map((j) => j.id), total: s.jobs.length });
check('plan.version increments after the job', s.plan.version > vBeforeJob, { before: vBeforeJob, after: s.plan.version });
void jobsBefore; void v1;

// 8. breakdown of a working tractor
const working = await waitFor(async () => {
  const st = await state();
  return st.fleet.find((t) => t.status === 'working' && t.current_job) || null;
}, 30000, 250);
if (!check('a tractor is working (needed for breakdown)', !!working, null)) fatal('cannot test breakdown without a working tractor', null);
s = await state();
const bt = working.id;
const mine = s.jobs.filter((j) => j.tractor === bt && j.status !== 'done' && j.status !== 'completed');
const progBefore = Object.fromEntries(s.jobs.map((j) => [j.id, j.progress]));
const vBeforeBd = s.plan.version;
const bmark = ws.msgs.length;
r = await http('POST', '/api/events', { type: 'breakdown', tractor: bt, issue: 'e2e flat tyre' });
check(`POST /api/events breakdown ${bt} -> 202`, r.status === 202 && r.json && r.json.id, { status: r.status, body: r.json });
const bdOp = r.json && r.json.id;
if (bdOp) {
  const okMsg = await waitFor(() => opMsg(ws.msgs, bdOp, 'succeeded', bmark), 20000);
  check('breakdown operation succeeded', !!okMsg, (await http('GET', '/api/operations/' + bdOp)).json);
}
s = await state();
const broken = s.fleet.find((t) => t.id === bt);
check(`${bt} is no longer operational`, broken && broken.status !== 'working' && broken.status !== 'idle', broken && broken.status);
const stillOnBroken = mine.filter((j0) => { const j = s.jobs.find((x) => x.id === j0.id); return j && j.tractor === bt; });
check(`${bt}'s jobs moved to other tractors (or are unassigned)`, mine.length > 0 && stillOnBroken.length === 0,
  { had: mine.map((j) => j.id), still: stillOnBroken.map((j) => j.id) });
const lost = mine.filter((j0) => { const j = s.jobs.find((x) => x.id === j0.id); return !j || j.progress + 1e-6 < (progBefore[j0.id] || 0); });
check('progress kept on the moved jobs (never decreases)', mine.length > 0 && lost.length === 0, lost.map((j) => j.id));
check('plan.version increments after the breakdown', s.plan.version > vBeforeBd, { before: vBeforeBd, after: s.plan.version });

// 9. not-implemented routes -> 501 with details.not_implemented
const routes = [
  ['GET', '/api/mechanics'], ['POST', '/api/mechanics/book'], ['POST', '/api/approve'], ['POST', '/api/scale-test'],
  ['GET', '/api/why/J1'], ['GET', '/api/tractors/T1/controls'],
];
for (const [method, path] of routes) {
  const rr = await http(method, path, method === 'POST' ? {} : undefined);
  check(`${method} ${path} -> 501 not_implemented`, rr.status === 501 && rr.json && rr.json.error && rr.json.error.details && rr.json.error.details.not_implemented === true, { status: rr.status, body: rr.json });
}

// 10. weather_change -> 400
r = await http('POST', '/api/events', { type: 'weather_change', kind: 'rain', start_t: 100, end_t: 200 });
check('POST /api/events weather_change -> 400 INVALID_INPUT', r.status === 400 && r.json && r.json.error && r.json.error.code === 'INVALID_INPUT', { status: r.status, body: r.json });

// pause so the server is not left running a day in the background
await http('POST', '/api/clock', { playing: false });

// ---------------------------------------------------------------- dashboard capabilities (optional)
if (WANT_CAPS) {
  console.log('\n-- dashboard capability detection');
  const capPath = join(REPO, 'dashboard', 'src', 'data', 'capabilities.js');
  if (!existsSync(capPath)) {
    note(`SKIP: ${capPath} not in this checkout`);
  } else {
    try {
      const mod = await import(pathToFileURL(capPath).href);
      const fn = mod.detectCapabilities || mod.detect || mod.probeCapabilities || mod.default;
      const unsupportedKeys = ['why', 'controls', 'mechanics', 'approve', 'scale-test', 'weather'];
      let caps = null;
      if (typeof fn === 'function') {
        // The detector's signature is not fixed; try an api string first, then an options object.
        for (const arg of [API, { api: API }, { apiBase: API }, { baseUrl: API }]) {
          try { caps = await fn(arg); if (caps && typeof caps === 'object') break; } catch { /* try next */ }
        }
      } else if (mod.capabilities && typeof mod.capabilities === 'object') caps = mod.capabilities;
      if (!caps) { note('SKIP: capabilities.js exports no recognised detector (detectCapabilities/detect/probeCapabilities/default); update scripts/coldstart-e2e.mjs'); }
      else {
        const norm = (k) => k.toLowerCase().replace(/[^a-z]/g, '');
        const flat = {};
        for (const [k, v] of Object.entries(caps.features || caps)) flat[norm(k)] = v;
        const isOff = (v) => v === false || v === 'unsupported' || (v && typeof v === 'object' && (v.supported === false || v.available === false || v.enabled === false));
        for (const k of unsupportedKeys) {
          const key = norm(k);
          const val = flat[key] !== undefined ? flat[key] : flat[key + 's'] !== undefined ? flat[key + 's'] : flat[key.replace(/s$/, '')];
          check(`capabilities: ${k} marked unsupported`, val !== undefined && isOff(val), { value: val });
        }
      }
    } catch (e) { check('capabilities.js loads', false, String(e && e.message || e)); }
  }
}

finish();

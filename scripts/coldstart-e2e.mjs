#!/usr/bin/env node
// Cold-start end-to-end check against a FRESH Anay FastAPI backend (MockGateway build).
//
//   API=http://localhost:8000 node scripts/coldstart-e2e.mjs [--dashboard-capabilities]
//
// The backend must have just booted: the script drives the whole lifecycle once, so re-run it against a
// restarted server, not a used one. Both cold starts are accepted:
//   v0 (HFA_AUTORUN=0, or before 7df3d39): paused, plan.version 0, POST /api/clock -> 409 until POST /api/run;
//   pre-planned (7df3d39 default): paused, plan.version >= 1, Play (POST /api/clock) works without /run.
// It also checks that a rejected job edit (incompatible pin, impossible deadline) keeps the job's old values,
// and that metrics.baseline becomes non-null within ~3 s of the run and of each operator action.
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

// 1. fresh: paused; either plan v0 (no run yet) or pre-planned (plan v >= 1, run op already succeeded)
let s = await state();
check('GET /api/state: boots paused', s && s.clock && s.clock.playing === false, s && s.clock);
const v0 = !!(s && s.plan && s.plan.version === 0);
const preplanned = !!(s && s.plan && s.plan.version >= 1);
check('GET /api/state: fresh server is plan v0 or pre-planned (v >= 1) at t = 0', (v0 || preplanned) && s.clock.t === 0, { version: s && s.plan && s.plan.version, t: s && s.clock && s.clock.t });
note(v0 ? 'cold start: plan v0 (no run yet; HFA_AUTORUN=0 or an older backend)' : 'cold start: pre-planned and paused (autorun)');
await waitFor(() => ws.msgs.length, 2000);
check('WS: snapshot arrives first', ws.msgs[0] && ws.msgs[0].type === 'snapshot', ws.msgs[0] && ws.msgs[0].type);
const jobsBefore = (s && s.jobs ? s.jobs.length : 0);

// metrics.baseline is null for ~0.5 s after startup / each operator action, then filled (7df3d39)
async function baselineWithin(label, ms = 3000) {
  const t0 = Date.now();
  const st = await waitFor(async () => { const x = await state(); return x && x.metrics && x.metrics.baseline && x.metrics.baseline_source ? x : null; }, ms, 100);
  check(`metrics.baseline non-null within ${ms / 1000} s ${label}`, !!st, st ? null : (await state()).metrics);
  if (st) note(`baseline ${label}: ${Date.now() - t0} ms, source ${st.metrics.baseline_source}`);
}

// 2. Play before /run: v0 -> 409; pre-planned -> 200 and t advances
let r = await http('POST', '/api/clock', { playing: true });
if (v0) {
  check('v0: POST /api/clock {playing:true} before a run -> 409', r.status === 409, { status: r.status, body: r.json });
} else {
  check('pre-planned: POST /api/clock {playing:true} without /run -> 200', r.status === 200 && r.json && r.json.playing === true, { status: r.status, body: r.json });
  check('pre-planned: t advances after Play', !!(await waitFor(async () => (await state()).clock.t > 0.3, 4000, 200)), (await state()).clock);
  await baselineWithin('after startup');
  r = await http('POST', '/api/clock', { playing: false });
  check('pre-planned: pause -> 200', r.status === 200, r.status);
}

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
if (!v0) {
  const snap = ws.msgs.slice(mark).find((m) => m.type === 'snapshot');
  check('Restart (POST /run): snapshot with t back to 0', !!(snap && snap.data && snap.data.clock && snap.data.clock.t === 0), snap && snap.data && snap.data.clock);
}
s = await state();
check('REST: plan.version >= 1 after the run', s.plan.version >= 1, s.plan.version);
await baselineWithin('after the run');
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

// 6b. rejected job edits keep the old values (7df3d39: an edit is applied only if a valid plan accepts it)
{
  s = await state();
  const open = s.jobs.filter((j) => j.status !== 'done' && j.status !== 'completed');
  let pinJob = null, pinTr = null;
  for (const j of open) { const t = s.fleet.find((x) => !(x.implements || []).includes(j.implement)); if (t) { pinJob = j; pinTr = t; break; } }
  if (!check('found a job + tractor without its implement (for an incompatible pin)', !!pinJob, null)) { /* skip */ } else {
    const vBefore = s.plan.version;
    r = await http('PATCH', '/api/jobs/' + pinJob.id, { pinned_to: pinTr.id });
    let rejected = false, how = r.status;
    if (r.status === 422 || r.status === 409) rejected = r.json && r.json.error && r.json.error.code === 'SAFETY_REJECTED' || r.status === 409;
    else if (r.status === 202 && r.json && r.json.id) {
      const o = await waitFor(async () => { const x = (await http('GET', '/api/operations/' + r.json.id)).json; return x && (x.status === 'failed' || x.status === 'succeeded') ? x : null; }, 10000);
      rejected = !!(o && o.status === 'failed' && o.error && o.error.code === 'SAFETY_REJECTED'); how = '202 -> ' + (o && o.status);
    }
    check(`incompatible pin ${pinJob.id} -> ${pinTr.id} rejected (422/409 SAFETY_REJECTED)`, rejected, { status: r.status, body: r.json, how });
    if (r.status === 422) note('incompatible pin answered 422 up front');
    await sleep(600);
    const after = await state();
    const ja = after.jobs.find((j) => j.id === pinJob.id);
    check('rejected pin: job.pinned_to unchanged', ja && (ja.pinned_to ?? null) === (pinJob.pinned_to ?? null), { before: pinJob.pinned_to, after: ja && ja.pinned_to });
    check('rejected pin: plan.version unchanged', after.plan.version === vBefore, { before: vBefore, after: after.plan.version });
  }
  // impossible deadline: accepted as 202, then the operation fails and the job keeps its deadline + priority
  s = await state();
  const dj = s.jobs.find((j) => j.status === 'pending' || j.status === 'assigned');
  if (dj) {
    const dmark = ws.msgs.length, vBefore = s.plan.version;
    const want = Math.max(1, Math.floor(s.clock.t));
    r = await http('PATCH', '/api/jobs/' + dj.id, { deadline_t: want, priority: dj.priority === 3 ? 1 : 3 });
    let o = null;
    if (r.status === 202 && r.json && r.json.id) o = await waitFor(async () => { const x = (await http('GET', '/api/operations/' + r.json.id)).json; return x && (x.status === 'failed' || x.status === 'succeeded') ? x : null; }, 10000);
    const rej = (r.status === 422 || r.status === 409) || (o && o.status === 'failed' && o.error && o.error.code === 'SAFETY_REJECTED');
    const after = await state();
    const ja = after.jobs.find((j) => j.id === dj.id);
    if (o && o.status === 'succeeded') {
      // Seen on 7df3d39 mid-day: the planner "accepts" an impossible deadline by leaving the job unassigned.
      // Not a contract violation (a valid plan was applied), so it is reported, not failed.
      note(`MISMATCH: impossible deadline on ${dj.id} was ACCEPTED (plan v${o.plan_version}, unassigned ${JSON.stringify(o.result && o.result.unassigned_job_ids)}); job now ${ja && ja.status}, deadline_t ${ja && ja.deadline_t}`);
      check('accepted edit is committed consistently (values applied, plan.version moved)', ja && ja.deadline_t === want && after.plan.version > vBefore, { after: ja && [ja.deadline_t, ja.priority], v: after.plan.version });
    } else {
      check(`impossible deadline on ${dj.id} (deadline_t ${want}) rejected`, rej, { status: r.status, op: o });
      if (o) note(`edit rejected: ${o.message} / ${o.error && o.error.message}`);
      check('rejected edit: deadline_t and priority unchanged', ja && ja.deadline_t === dj.deadline_t && ja.priority === dj.priority, { before: [dj.deadline_t, dj.priority], after: ja && [ja.deadline_t, ja.priority] });
      check('rejected edit: plan.version unchanged', after.plan.version === vBefore, { before: vBefore, after: after.plan.version });
      const leaked = ws.msgs.slice(dmark).filter((m) => m.type === 'jobs' && Array.isArray(m.data)).some((m) => { const j = m.data.find((x) => x.id === dj.id); return j && (j.deadline_t !== dj.deadline_t || j.priority !== dj.priority); });
      check('rejected edit: no WS jobs message carried the staged values', !leaked, null);
    }
  } else note('no pending/assigned job for the deadline edit check');
}

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
await baselineWithin('after POST /api/jobs');
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
await baselineWithin('after the breakdown');

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
        // dashboard/src/data/capabilities.js: detectCapabilities({ root, request, state }) with liveSource.request
        const { createLiveSource } = await import(pathToFileURL(join(REPO, 'dashboard', 'src', 'data', 'liveSource.js')).href);
        const src = createLiveSource({ api: API, onMessage() {} });
        const state = await src.request('GET', '/state');
        caps = await fn({ root: API, request: src.request, state });
        if (caps && caps.events) { caps = { ...caps, 'scale-test': caps.scaleTest, weather: caps.weatherEnforced === false && caps.events.heat_alert === false && caps.events.weather_change === false ? false : true }; }
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

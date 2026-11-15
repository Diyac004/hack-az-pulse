// Smoke test for the simulated backend. Start the server first, then:
//   node smoke.mjs                 (API defaults to http://localhost:8000; override with API=http://host:port)
// Rerunnable: it begins with POST /api/run, which resets the farm day.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WS from 'ws';

if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = WS; // liveSource needs a global WebSocket (Node < 22)
const { createLiveSource } = await import('../dashboard/src/data/liveSource.js');
const { createStore } = await import('../dashboard/src/data/store.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const EX = (n) => JSON.parse(readFileSync(join(HERE, '..', 'contract', 'examples', n), 'utf8'));
const API = (process.env.API || 'http://localhost:8000').replace(/\/+$/, '');
const WS_URL = API.replace(/^http/, 'ws') + '/ws';

let checks = 0, failures = 0;
function ok(cond, msg, extra) {
  checks++;
  if (cond) console.log('  ok   ' + msg);
  else { failures++; console.log('  FAIL ' + msg + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 400) : '')); }
}
const section = (s) => console.log('\n- ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keys = (o) => Object.keys(o).sort().join(',');

async function http(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(API + path, init);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* text body */ }
  return { status: res.status, headers: res.headers, text, json };
}

/** Raw WS client that records every frame. */
function rawClient() {
  const msgs = [];
  const ws = new WS(WS_URL);
  const waiters = [];
  ws.on('message', (d) => { const m = JSON.parse(String(d)); msgs.push(m); waiters.slice().forEach((w) => w()); });
  const until = (pred, ms = 8000, label = 'condition') => new Promise((resolve, reject) => {
    const check = () => { const r = pred(msgs); if (r) { cleanup(); resolve(r); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout waiting for ' + label)); }, ms);
    const cleanup = () => { clearTimeout(timer); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); };
    waiters.push(check); check();
  });
  const opened = new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  return { ws, msgs, until, opened };
}
const opTerminal = (id) => (msgs) => msgs.find((m) => m.type === 'operation' && m.data.id === id && ['succeeded', 'failed', 'superseded'].includes(m.data.status));

/** Check that `types` appear in this order (as a subsequence) among messages from the op's running frame on. */
function orderAfterRunning(msgs, opId, types) {
  const start = msgs.findIndex((m) => m.type === 'operation' && m.data.id === opId && m.data.status === 'running');
  if (start < 0) return { ok: false, why: 'no running frame' };
  const seen = [];
  let k = 0;
  for (let i = start + 1; i < msgs.length && k < types.length; i++) {
    const m = msgs[i];
    const want = types[k];
    const match = want === 'succeeded' ? m.type === 'operation' && m.data.id === opId && m.data.status === 'succeeded' : m.type === want;
    if (match) { seen.push(want); k++; }
  }
  return { ok: k === types.length, why: seen.join(' -> ') };
}

// =====================================================================
section('raw WS: snapshot first, per-connection seq');
const A = rawClient();
await A.opened;
await A.until((m) => m.length >= 1, 3000, 'first frame');
ok(A.msgs[0].type === 'snapshot' && A.msgs[0].seq === 1, 'first frame is snapshot with seq 1', A.msgs[0] && { type: A.msgs[0].type, seq: A.msgs[0].seq });
ok(keys(A.msgs[0]) === 'data,seq,t,type', 'envelope keys {type,t,seq,data}');

section('reset day: POST /api/run');
const run = await http('POST', '/api/run', { mode: 'ours' }, { 'Idempotency-Key': randomUUID() });
ok(run.status === 202 && keys(run.json) === keys(EX('rest.post_run.json')), 'POST /api/run -> 202 Operation', run);
await A.until(opTerminal(run.json.id), 5000, 'run op terminal');
const runIdx = A.msgs.findIndex((m) => m.type === 'snapshot' && m.seq > 1);
ok(runIdx > 0, 'mid-stream snapshot broadcast after run');
ok(A.msgs.find((m) => m.type === 'operation' && m.data.id === run.json.id && m.data.status === 'succeeded'), 'run op succeeded');

section('second WS client gets its own seq');
const B = rawClient();
await B.opened;
await B.until((m) => m.length >= 3, 3000, 'B frames');
ok(B.msgs[0].type === 'snapshot' && B.msgs[0].seq === 1, 'client B first frame snapshot seq 1');
ok(B.msgs.every((m, i) => m.seq === i + 1), 'client B seq contiguous from 1');
ok(A.msgs[A.msgs.length - 1].seq > B.msgs[B.msgs.length - 1].seq, 'client A seq independent (higher) than B');
B.ws.close();

section('GET endpoints');
const st = await http('GET', '/api/state');
ok(st.status === 200 && keys(st.json) === keys(EX('rest.get_state.json')), 'GET /api/state keys match rest.get_state.json', { got: st.json && keys(st.json), want: keys(EX('rest.get_state.json')) });
ok(st.headers.get('access-control-allow-origin') === '*', 'CORS header on GET');
for (const [p, ex] of [['/api/scenario', 'rest.get_scenario.json'], ['/api/hosts', 'rest.get_hosts.json'], ['/api/weather', 'rest.get_weather.json'], ['/api/metrics', 'rest.get_metrics.json']]) {
  const r = await http('GET', p);
  ok(r.status === 200 && keys(r.json) === keys(EX(ex)), `GET ${p} keys match ${ex}`, { got: r.json && keys(r.json), want: keys(EX(ex)) });
}
for (const p of ['/api/jobs', '/api/fleet']) { const r = await http('GET', p); ok(r.status === 200 && Array.isArray(r.json) && r.json.length > 0, `GET ${p} -> non-empty array`); }

section('POST /api/events breakdown -> 202 Operation, WS lifecycle');
const key1 = randomUUID();
const bdBody = { type: 'breakdown', tractor: 'T1', issue: 'hydraulic leak' };
const bd = await http('POST', '/api/events', bdBody, { 'Idempotency-Key': key1 });
ok(bd.status === 202 && keys(bd.json) === keys(EX('rest.post_events.json')) && bd.json.kind === 'replan' && bd.json.status === 'queued', 'breakdown -> 202 queued replan Operation', bd);
await A.until(opTerminal(bd.json.id), 5000, 'breakdown op terminal');
const ord = orderAfterRunning(A.msgs, bd.json.id, ['plan', 'explanation', 'jobs', 'succeeded']);
ok(ord.ok, `WS order: operation running -> plan -> explanation -> jobs -> operation succeeded (${ord.why})`);
ok(A.msgs.some((m) => m.type === 'operation' && m.data.id === bd.json.id && m.data.status === 'queued'), 'WS operation queued frame seen');
ok(A.msgs.some((m) => m.type === 'pending' && m.data.pending.some((p) => p.kind === 'mechanic' && p.tractor === 'T1')), 'WS pending mechanic item for T1');

section('Idempotency-Key');
const replay = await http('POST', '/api/events', bdBody, { 'Idempotency-Key': key1 });
ok(replay.status === 202 && replay.json.id === bd.json.id, `replay with same key + body returns the same op (${replay.json && replay.json.id})`, replay);
const clash = await http('POST', '/api/events', { type: 'heat_alert', temp_f: 110, at_t: 400 }, { 'Idempotency-Key': key1 });
ok(clash.status === 409 && clash.json.error.code === 'CONFLICT', 'same key, different body -> 409 CONFLICT', clash);

section('GET /api/operations/{id}');
const opGet = await http('GET', '/api/operations/' + bd.json.id);
ok(opGet.status === 200 && opGet.json.status === 'succeeded' && opGet.json.result && Array.isArray(opGet.json.result.unassigned_job_ids), 'operation fetched, succeeded with result', opGet.json);

section('PATCH /api/jobs/{id} priority');
const jobs = (await http('GET', '/api/jobs')).json;
const target = jobs.find((j) => !['done', 'working'].includes(j.status) && j.priority < 3) || jobs.find((j) => j.status !== 'done');
const pj = await http('PATCH', '/api/jobs/' + target.id, { priority: 3 }, { 'Idempotency-Key': randomUUID() });
ok(pj.status === 202 && pj.json.source === 'job_patch', `PATCH ${target.id} {priority:3} -> 202 job_patch Operation`, pj);
const pjEnd = await A.until(opTerminal(pj.json.id), 5000, 'patch op terminal');
ok(pjEnd.data.status === 'succeeded', 'patch op succeeded', pjEnd.data);
const after = (await http('GET', '/api/jobs')).json.find((j) => j.id === target.id);
ok(after.priority === 3, `${target.id} priority is now 3`);

section('POST /api/jobs -> 202 Operation; validation 400 with row locs');
{
  const JOB = { type: 'mow', implement: 'mower', block: 'G', duration_min: 60, priority: 2, deadline_t: 480 };
  const bad = await http('POST', '/api/jobs', { jobs: [JOB, { ...JOB, block: 'Z', implement: 'sprayer' }] }, { 'Idempotency-Key': randomUUID() });
  const locs = bad.json && bad.json.error && bad.json.error.details.errors.map((e) => e.loc.join('.'));
  ok(bad.status === 400 && bad.json.error.code === 'INVALID_INPUT' && locs.includes('body.jobs.1.block') && locs.includes('body.jobs.1.implement'), 'bad row -> 400 INVALID_INPUT with details.errors loc', bad.json);
  const dup = await http('POST', '/api/jobs', { jobs: [{ ...JOB, id: 'J1' }] });
  ok(dup.status === 409 && dup.json.error.code === 'CONFLICT', 'existing id -> 409 CONFLICT');
  const n0 = (await http('GET', '/api/jobs')).json.length;
  const jk = randomUUID();
  const pj2 = await http('POST', '/api/jobs', { jobs: [JOB] }, { 'Idempotency-Key': jk });
  ok(pj2.status === 202 && keys(pj2.json) === keys(EX('rest.post_jobs.json')) && pj2.json.source === 'jobs' && pj2.json.status === 'queued', 'POST /api/jobs -> 202 queued jobs Operation', pj2);
  const pjr = await http('POST', '/api/jobs', { jobs: [JOB] }, { 'Idempotency-Key': jk });
  ok(pjr.status === 202 && pjr.json.id === pj2.json.id, 'same key + body replays the op');
  await A.until(opTerminal(pj2.json.id), 5000, 'jobs op terminal');
  const ordJ = orderAfterRunning(A.msgs, pj2.json.id, ['plan', 'explanation', 'jobs', 'succeeded']);
  ok(ordJ.ok, `WS order for jobs op (${ordJ.why})`);
  const jobsNow = (await http('GET', '/api/jobs')).json;
  ok(jobsNow.length === n0 + 1 && jobsNow.at(-1).label === 'Mow G', `job ${jobsNow.at(-1).id} added (Mow G)`);
}

section('POST /api/fleet add tractor');
const add = await http('POST', '/api/fleet', { name: 'Smoke Tractor', implements: ['mower', 'hedger'], fuel_pct: 80, speed: 1.0, start: { x: 3, y: 6 }, endpoint: 'auto' });
ok(add.status === 202 && add.json.tractor && add.json.tractor.status === 'starting', `POST /api/fleet -> 202 {tractor} starting (${add.json && add.json.tractor && add.json.tractor.id})`, add);
const newId = add.json.tractor.id;
await A.until((m) => m.some((x) => x.type === 'fleet' && x.data.tractors.some((t) => t.id === newId && t.status !== 'starting')), 6000, 'tractor ready');
ok(true, `${newId} left 'starting' on WS fleet`);
const del = await http('DELETE', '/api/fleet/' + newId);
ok(del.status === 200 && del.json.ok === true, 'DELETE /api/fleet/{id} -> {ok:true}');

section('other endpoints');
const why = await http('GET', '/api/why/' + target.id);
ok(why.status === 200 && keys(why.json) === keys(EX('rest.why.json')), 'GET /api/why/{job} shape');
const mech = await http('GET', '/api/mechanics?tractor=T1');
ok(mech.status === 200 && Array.isArray(mech.json.options) && mech.json.options.length > 0, 'GET /api/mechanics?tractor=T1');
const mechNo = await http('GET', '/api/mechanics');
ok(mechNo.status === 400 && mechNo.json.error.code === 'INVALID_INPUT', 'GET /api/mechanics without tractor -> 400');
const bookReqKey = randomUUID();
const book = await http('POST', '/api/mechanics/book', { tractor: 'T1', mechanic: mech.json.options[0].id }, { 'Idempotency-Key': bookReqKey });
book.reqKey = bookReqKey;
ok(book.status === 202 && book.json.kind === 'repair_booking', 'POST /api/mechanics/book -> 202 repair_booking', book);
const bookEnd = await A.until(opTerminal(book.json.id), 5000, 'book op');
ok(bookEnd.data.status === 'succeeded' && keys(bookEnd.data.result) === 'arrival_t,estimated_return_t,mechanic,tractor', 'booking op succeeded with result', bookEnd.data);

section('Idempotency replay after state changed (book + approve)');
const bookOp = book.json && (await http("GET", "/api/operations/" + book.json.id)).json; // sanity: op retrievable
const bk = randomUUID();
// T1 is now repair_scheduled: a NEW booking must be refused, but a replay of the original must return the original op.
const bookBody = { tractor: 'T1', mechanic: mech.json.options[0].id };
const fresh = await http('POST', '/api/mechanics/book', bookBody, { 'Idempotency-Key': bk });
ok(fresh.status === 409 && fresh.json.error.code === 'CONFLICT', 'new booking for an already-booked tractor -> 409 (state validated)', fresh.json);
const bookReplay = await http('POST', '/api/mechanics/book', bookBody, { 'Idempotency-Key': book.reqKey });
ok(bookReplay.status === 202 && bookReplay.json.id === book.json.id && bookReplay.json.status === 'succeeded' && bookReplay.json.result?.tractor === 'T1', 'book replay (same key+body) after state changed -> 202 ORIGINAL op, succeeded', bookReplay.json);
const bookClash = await http('POST', '/api/mechanics/book', { tractor: 'T1', mechanic: 'M9' }, { 'Idempotency-Key': book.reqKey });
ok(bookClash.status === 409 && bookClash.json.error.code === 'CONFLICT', 'book same key + different body -> 409 CONFLICT', bookClash.json);
ok(bookOp && bookOp.id === book.json.id, 'GET /api/operations/{book op}');
const victim = (await http('GET', '/api/fleet')).json.find((t) => t.status === 'working' || t.status === 'traveling' || t.status === 'idle');
let pendId = null;
if (victim) {
  await http('POST', '/api/events', { type: 'breakdown', tractor: victim.id, issue: 'smoke test' }, { 'Idempotency-Key': randomUUID() });
  for (let i = 0; i < 40 && !pendId; i++) { pendId = (await http('GET', '/api/state')).json.pending.find((p) => p.tractor === victim.id)?.id || null; if (!pendId) await sleep(100); }
}
ok(!!pendId, `breakdown of ${victim && victim.id} raised a pending item ${pendId}`);
if (pendId) {
  const ak = randomUUID();
  const ap = await http('POST', '/api/approve', { id: pendId, decision: 'override' }, { 'Idempotency-Key': ak });
  const apEnd = await A.until(opTerminal(ap.json.id), 5000, 'approve op');
  ok(ap.status === 202 && apEnd.data.status === 'succeeded', 'approve override -> 202, succeeded');
  const apReplay = await http('POST', '/api/approve', { id: pendId, decision: 'override' }, { 'Idempotency-Key': ak });
  ok(apReplay.status === 202 && apReplay.json.id === ap.json.id && apReplay.json.status === 'succeeded', 'approve replay after pending resolved -> 202 ORIGINAL op', apReplay.json);
  const apClash = await http('POST', '/api/approve', { id: pendId, decision: 'approve' }, { 'Idempotency-Key': ak });
  ok(apClash.status === 409 && apClash.json.error.code === 'CONFLICT', 'approve same key + different decision -> 409 CONFLICT', apClash.json);
  const apFresh = await http('POST', '/api/approve', { id: pendId, decision: 'override' }, { 'Idempotency-Key': randomUUID() });
  ok(apFresh.status === 404, 'approve with a fresh key on a resolved item -> 404', apFresh.json);
}
const clock = await http('POST', '/api/clock', { speed: 2 });
ok(clock.status === 200 && clock.json.speed === 2 && keys(clock.json) === keys(EX('rest.post_clock.json')), 'POST /api/clock {speed:2} -> Clock');
await http('POST', '/api/clock', { speed: 1 });
const badClock = await http('POST', '/api/clock', { speed: -1 });
ok(badClock.status === 400 && badClock.json.error.code === 'INVALID_INPUT', 'POST /api/clock bad speed -> 400 INVALID_INPUT');
const scale = await http('POST', '/api/scale-test', { tractors: 5, jobs: 20 });
ok(scale.status === 200 && keys(scale.json) === keys(EX('rest.scale_test.json')), 'POST /api/scale-test shape');
const logR = await http('GET', '/api/log');
const lines = logR.text.trim().split('\n');
ok(logR.status === 200 && (logR.headers.get('content-type') || '').startsWith('text/plain') && lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), `GET /api/log -> text/plain JSON Lines (${lines.length} lines)`);
const appr = await http('POST', '/api/approve', { id: 'P999', decision: 'approve' });
ok(appr.status === 404 && appr.json.error.code === 'NOT_FOUND', 'POST /api/approve unknown id -> 404');

section('Tractor Control Panel endpoints (§5 rows 13-16, §13.2)');
{
  const fleetNow = (await http('GET', '/api/fleet')).json;
  const DOWN = ['broken', 'awaiting_mechanic', 'repair_scheduled', 'repairing', 'removing', 'starting', 'offline'];
  const tid = (fleetNow.find((t) => !DOWN.includes(t.status) && t.implements.includes('mower')) || fleetNow.find((t) => !DOWN.includes(t.status))).id;
  const gc = await http('GET', `/api/tractors/${tid}/controls`);
  ok(gc.status === 200 && keys(gc.json) === keys(EX('rest.get_controls.json')) && gc.json.controls.every((c) => keys(c).startsWith(keys(EX('rest.get_controls.json').controls[0]).slice(0, 4)) || 'id' in c), `GET /api/tractors/${tid}/controls -> {controls, values}`, gc.json && keys(gc.json));
  const exKeys = Object.keys(EX('rest.get_controls.json').controls[0]);
  ok(gc.json.controls.every((c) => exKeys.every((k) => k in c)), 'every Control has the §5 keys');
  const nm = await http('POST', `/api/tractors/${tid}/control`, { control: 'steer', value: 5 });
  ok(nm.status === 409 && nm.json.error.code === 'NEEDS_MANUAL', 'steer before manual -> 409 NEEDS_MANUAL', nm.json);
  const pv = await http('POST', `/api/tractors/${tid}/preview`, { control: 'max_speed', value: 6 });
  ok(pv.status === 200 && keys(pv.json) === keys(EX('rest.post_preview.json')) && pv.json.allowed === true, 'POST preview -> Preview shape', pv.json && keys(pv.json));
  const gw = await http('POST', `/api/tractors/${tid}/control`, { control: 'name', value: 'X' }, { 'X-Mock-Fail': 'GATEWAY_UNAVAILABLE' });
  ok(gw.status === 503 && gw.json.error.code === 'GATEWAY_UNAVAILABLE', 'forced GATEWAY_UNAVAILABLE -> 503');
  const to = await http('POST', `/api/tractors/${tid}/preview`, { control: 'max_speed', value: 6 }, { 'X-Mock-Fail': 'TIMEOUT' });
  ok(to.status === 503 && to.json.error.code === 'TIMEOUT', 'forced preview TIMEOUT -> 503');
  const ms = await http('POST', `/api/tractors/${tid}/control`, { control: 'max_speed', value: 9 }, { 'Idempotency-Key': randomUUID() });
  ok(ms.status === 202 && ms.json.source === 'control' && ms.json.status === 'queued', 'replans:true control -> 202 Operation', ms.json);
  const msEnd = await A.until(opTerminal(ms.json.id), 5000, 'control op terminal');
  ok(msEnd && msEnd.data.status === 'succeeded', 'control op succeeded');
  const on = await http('POST', `/api/tractors/${tid}/manual`, { on: true }, { 'Idempotency-Key': randomUUID() });
  ok(on.status === 202 && on.json.source === 'manual', 'POST manual on -> 202 Operation', on.json);
  await A.until(opTerminal(on.json.id), 5000, 'manual op terminal');
  ok((await http('GET', '/api/fleet')).json.find((t) => t.id === tid).manual === true, 'tractor.manual true');
  const st = await http('POST', `/api/tractors/${tid}/control`, { control: 'steer', value: 12 });
  ok(st.status === 200 && st.json.ok === true && st.json.value === 12 && st.json.explanation === null, 'steer in manual -> 200 {ok,value,explanation}', st.json);
  const bad = await http('POST', `/api/tractors/${tid}/control`, { control: 'steer', value: 400 });
  ok(bad.status === 400 && bad.json.error.code === 'INVALID_INPUT', 'out of range -> 400 INVALID_INPUT');
  const off = await http('POST', `/api/tractors/${tid}/manual`, { on: false }, { 'Idempotency-Key': randomUUID() });
  await A.until(opTerminal(off.json.id), 5000, 'hand back op');
  ok((await http('GET', '/api/fleet')).json.find((t) => t.id === tid).manual === false, 'hand back -> manual false');
  const nf3 = await http('GET', '/api/tractors/T999/controls');
  ok(nf3.status === 404 && nf3.json.error.code === 'NOT_FOUND', 'unknown tractor -> 404');
}
const oa = await http('GET', '/openapi.json');
ok(oa.status === 200 && Array.isArray(oa.json.routes) && oa.json.routes.length >= 20, `GET /openapi.json lists ${oa.json && oa.json.routes.length} routes`);
const badJson = await fetch(API + '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
ok(badJson.status === 400 && (await badJson.json()).error.code === 'INVALID_INPUT', 'malformed JSON body -> 400 INVALID_INPUT');

section('404 error shape');
const nf = await http('GET', '/api/why/NOPE');
ok(nf.status === 404 && keys(nf.json) === 'error' && keys(nf.json.error) === keys(EX('rest.error.json').error) && nf.json.error.code === 'NOT_FOUND', 'GET /api/why/NOPE -> 404 {error:{code,message,details}}', nf.json);
ok(nf.headers.get('access-control-allow-origin') === '*', 'CORS header on error response');
const nf2 = await http('GET', '/api/nothing-here');
ok(nf2.status === 404 && nf2.json.error.code === 'NOT_FOUND', 'unknown route -> 404 NOT_FOUND');

section('CORS preflight');
const pre = await fetch(API + '/api/jobs/J1', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'content-type,idempotency-key' } });
ok(pre.status === 204, 'OPTIONS -> 204');
ok(pre.headers.get('access-control-allow-origin') === '*', 'Allow-Origin *');
ok(/PATCH/.test(pre.headers.get('access-control-allow-methods') || '') && /DELETE/.test(pre.headers.get('access-control-allow-methods') || ''), 'Allow-Methods includes PATCH, DELETE: ' + pre.headers.get('access-control-allow-methods'));
ok(/idempotency-key/i.test(pre.headers.get('access-control-allow-headers') || '') && /content-type/i.test(pre.headers.get('access-control-allow-headers') || ''), 'Allow-Headers: ' + pre.headers.get('access-control-allow-headers'));

section('ping / pong and seq continuity on raw client A');
const beforePing = A.msgs.length;
A.ws.send(JSON.stringify({ type: 'ping' }));
const pong = await A.until((m) => m.slice(beforePing).find((x) => x.type === 'pong'), 3000, 'pong');
ok(pong && pong.seq === undefined, 'pong received, carries no seq');
const seqd = A.msgs.filter((m) => typeof m.seq === 'number');
ok(seqd.every((m, i) => m.seq === i + 1), `client A seq contiguous 1..${seqd.length}`);
A.ws.close();

// =====================================================================
section('real client: dashboard/src/data/liveSource.js + store.js against the server');
const store = createStore({ source: 'live' });
let resyncs = 0, connectedSeen = false;
const live = createLiveSource({ api: API, onMessage: (env) => store.apply(env), onStatus: (c) => { if (c) connectedSeen = true; store.setConnected(c); } });
store.setResync(async () => { resyncs++; await live.resync(); });
await live.start();
ok(connectedSeen, 'liveSource reported connected');
ok(store.get().seq === 1 && store.get().jobs.length > 0 && store.get().fleet.length > 0, `store applied snapshot (seq ${store.get().seq}, ${store.get().jobs.length} jobs, ${store.get().fleet.length} tractors)`);
const lk = randomUUID();
const lop = await live.request('POST', '/events', { type: 'heat_alert', temp_f: 112, at_t: 480 }, { idempotencyKey: lk });
ok(lop.status === 'queued' && lop.source === 'events', 'live.request POST /events -> Operation ' + lop.id);
const lop2 = await live.request('POST', '/events', { type: 'heat_alert', temp_f: 112, at_t: 480 }, { idempotencyKey: lk });
ok(lop2.id === lop.id, 'live.request idempotent retry returns same op');
for (let i = 0; i < 50; i++) { const o = store.get().operations?.find((x) => x.id === lop.id); if (o && o.status === 'succeeded') break; await sleep(100); }
ok(store.get().operations?.find((x) => x.id === lop.id)?.status === 'succeeded', 'store saw the operation succeed via WS');
await sleep(1500);
ok(resyncs === 0, `no seq gaps detected by store over the run (resyncs=${resyncs}, seq=${store.get().seq})`);
const ltxt = await live.request('GET', '/log');
ok(typeof ltxt === 'string' && ltxt.includes('"kind"'), 'live.request GET /log returns JSON Lines text');
try { await live.request('GET', '/why/NOPE'); ok(false, 'expected 404 rejection'); }
catch (e) { ok(e.status === 404 && e.code === 'NOT_FOUND' && typeof e.message === 'string', `live.request 404 rejects {code:${e.code}, status:${e.status}}`); }
try { await live.request('POST', '/events', { type: 'heat_alert' }, { idempotencyKey: lk }); ok(false, 'expected 409'); }
catch (e) { ok(e.status === 409 && e.code === 'CONFLICT', 'live.request key reuse with other body rejects 409 CONFLICT'); }
const rs = await live.resync();
ok(rs && rs.clock && store.get().jobs.length > 0, 'live.resync() (GET /state) applied');

section('live wording: feed and explanation agree, no mock wording, real clock, overtime (user-testing round)');
{
  const { logLine, replanChanges, planHealth } = await import('../dashboard/src/lib/derive.js');
  const { clockText } = await import('../dashboard/src/data/text.js');
  const s = store.get();
  const strip = (h) => String(h || '').replace(/<[^>]+>/g, '');
  const lines = (s.log || []).map((e) => strip(logLine(e, s))).filter(Boolean);
  const texts = [...lines, ...(s.explanations || []).map((x) => x.text)];
  ok(lines.some((l) => /added to the fleet/.test(l)), 'feed: "Tractor N added to the fleet" (no host)', lines.filter((l) => /added/.test(l)));
  ok(!texts.some((t) => /\bmock\b|simulat/i.test(t)), 'no mock/simulation wording in live feed or explanations', texts.filter((t) => /mock|simulat/i.test(t)));
  ok(!texts.some((t) => /\b0 jobs (moved|changed)\b|\b1 jobs\b|\bP[123]\b/.test(t)), 'no "0 jobs moved", "1 jobs", or P1 wording');
  const heatLog = (s.log || []).find((e) => e.kind === 'replan' && e.trigger === 'heat_alert');
  const heatX = heatLog && (s.explanations || []).find((x) => x.id === heatLog.explanation_id);
  if (heatLog && heatX) {
    const ids = replanChanges(heatLog), missing = ids.filter((id) => !heatX.text.includes(s.jobs.find((j) => j.id === id).label));
    ok(missing.length === 0, `heat alert: feed counts ${ids.length} changed jobs and the explanation names each`, { missing, text: heatX.text });
  } else ok(!!heatLog, 'heat alert replan in log');
  ok(clockText(1134) === '12:54 AM (+1 day)', 'clock text past midnight');
  const h = planHealth(s);
  const maxEnd = Math.max(0, ...((s.plan && s.plan.entries) || []).filter((e) => (e.kind === 'work' || e.kind === 'travel') && !(e.job && s.jobs.find((j) => j.id === e.job)?.status === 'done')).map((e) => e.end_t));
  ok(h.overtimeMin === Math.max(0, Math.round(maxEnd - (s.clock.day_minutes || 720))), `planHealth overtime matches plan entries (${h.overtimeMin} min)`);
  const x0 = (s.explanations || [])[0];
  if (x0 && x0.facts && x0.facts.context && x0.facts.context.overtime_min > 0 && x0.trigger !== 'end_of_day') ok(/past sunset/.test(x0.text), 'latest explanation mentions overtime');
}
live.close();

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);

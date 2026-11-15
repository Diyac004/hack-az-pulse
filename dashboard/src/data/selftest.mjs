// Headless self-test for the data layer.  Run:  node dashboard/src/data/selftest.mjs
// Drives MockSource tick-by-tick (no timers), feeds a store, and checks every
// message against contract/examples plus the ARCHITECTURE.md §8 / §13 rules.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMockSource, DAY_MIN } from './mockSource.js';
import { createStore } from './store.js';
import * as index from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EX_DIR = join(HERE, '..', '..', '..', 'contract', 'examples');
const EX = Object.fromEntries(readdirSync(EX_DIR).filter((f) => f.endsWith('.json')).map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(EX_DIR, f), 'utf8'))]));

let failures = 0, checks = 0;
function ok(cond, msg) { checks++; if (!cond) { failures++; console.error('  FAIL:', msg); } }
function section(name) { console.log('- ' + name); }

// ---------------- shape checking against examples
const FREE = [/\.facts$/, /\.details$/, /spray_allowed_now$/, /spray_blocked_reason$/, /spray_windows$/, /live_conditions$/, /\.values$/, /\.metrics_delta$/, /log_tail\[\]$/, /\.result$/, /^log\.data$/];
function shape(actual, example, path, errs) {
  if (actual === null || example === null || actual === undefined && example === undefined) return;
  if (FREE.some((r) => r.test(path))) return;
  if (Array.isArray(example)) {
    if (!Array.isArray(actual)) { errs.push(`${path}: expected array`); return; }
    const ex0 = example[0];
    if (ex0 && typeof ex0 === 'object' && !Array.isArray(ex0)) actual.forEach((a) => shape(a, ex0, path + '[]', errs));
    return;
  }
  if (typeof example === 'object') {
    if (typeof actual !== 'object' || Array.isArray(actual)) { errs.push(`${path}: expected object`); return; }
    const ek = Object.keys(example).sort().join(','), ak = Object.keys(actual).sort().join(',');
    if (ek !== ak) errs.push(`${path}: keys [${ak}] != example [${ek}]`);
    for (const k of Object.keys(example)) if (k in actual) shape(actual[k], example[k], path + '.' + k, errs);
    return;
  }
  if (typeof actual !== typeof example) errs.push(`${path}: ${typeof actual} != ${typeof example}`);
}
function shapeOk(actual, exName, label) {
  const errs = []; shape(actual, EX[exName], label, errs);
  ok(errs.length === 0, `${label} vs ${exName}: ${errs.slice(0, 4).join(' | ')}`);
}
const RESULT_KEYS = { run: 'applied_plan_version,unassigned_job_ids', replan: 'applied_plan_version,unassigned_job_ids', repair_booking: 'arrival_t,estimated_return_t,mechanic,tractor', approval: 'applied_plan_version,decision,pending_id' };
function opOk(op, label) {
  shapeOk(op, 'rest.get_operation', label);
  if (op.status === 'succeeded') { ok(op.error === null && op.result && Object.keys(op.result).sort().join(',') === RESULT_KEYS[op.kind], `${label}: succeeded op needs ${op.kind} result, null error (${JSON.stringify(op)})`); }
  else if (op.status === 'failed') ok(op.result === null && op.error && typeof op.error.code === 'string', `${label}: failed op needs error, null result`);
  else ok(op.result === null, `${label}: ${op.status} op must have null result`);
}
const LOG_KINDS = new Set(['plan', 'event', 'replan', 'job_started', 'job_done', 'job_dropped', 'operator_action', 'tractor_added', 'tractor_removed', 'tractor_ready', 'mechanic_search', 'mechanic_booked', 'tractor_repaired', 'weather', 'agopenweb', 'safety_reject', 'violation']);

// ---------------- harness
function harness(opts) {
  const src = createMockSource({ realtime: false, pace: 9.6, ...opts }); // fast headless pace (8x the 10-min demo day)
  const store = createStore({ source: 'mock' });
  const msgs = [];
  let gaps = 0;
  store.setResync(() => { gaps++; });
  src.connect({ onMessage: (m) => { msgs.push(m); store.apply(m); }, onConnected: (c) => store.setConnected(c) });
  const h = {
    src, store, msgs, api: src.api, get gaps() { return gaps; },
    w: () => src.debug.world(),
    tick(n = 1) { for (let i = 0; i < n; i++) { src.tick(); h.invariants(); } },
    until(pred, max = 20000) { for (let i = 0; i < max; i++) { if (pred()) return true; h.tick(); } return pred(); },
    progress: new Map(), jobIds: null,
    invariants() {
      const s = store.get();
      const ids = s.jobs.map((j) => j.id).sort().join(',');
      if (h.jobIds === null) h.jobIds = ids;
      ok(ids === h.jobIds, 'job id set constant (no job lost/added)');
      for (const j of s.jobs) {
        const prev = h.progress.get(j.id) ?? 0;
        ok(j.progress >= prev - 1e-9, `progress never decreases (${j.id} ${prev} -> ${j.progress})`);
        h.progress.set(j.id, j.progress);
        const holders = s.fleet.filter((t) => t.current_job === j.id || t.queue.includes(j.id));
        if (['assigned', 'traveling', 'working'].includes(j.status)) ok(holders.length === 1 && holders[0].id === j.tractor, `${j.id} (${j.status}) held by exactly its tractor ${j.tractor}, got [${holders.map((t) => t.id)}]`);
        if (j.status === 'pending') ok(holders.length === 0 && j.tractor === null && j.unassigned_reason && j.start_t === null && j.end_t === null && j.eta_t === null, `${j.id} pending => unheld, tractor/start/end/eta null, reason set`);
        if (j.status === 'done') ok(holders.length === 0, `${j.id} done => not held`);
        ok(j.status !== 'dropped', `${j.id} never dropped by the mock`);
      }
      const seen = new Set();
      for (const t of s.fleet) for (const id of [t.current_job, ...t.queue].filter(Boolean)) { ok(!seen.has(id) || s.jobs.find((j) => j.id === id)?.status === 'paused', `job ${id} held by two tractors`); seen.add(id); }
    },
  };
  return h;
}
const opMsgs = (msgs, id) => msgs.filter((m) => m.type === 'operation' && m.data.id === id);
const idxOf = (msgs, m) => msgs.indexOf(m);

// ===================================================================
section('index.js exports');
ok(Object.keys(index).sort().join(',') === 'api,sourceInfo,start,store', 'index exports exactly api, sourceInfo, start, store');
ok(index.sourceInfo.kind === 'mock' && index.sourceInfo.api === null, 'no location => mock');
ok(typeof index.store.get === 'function' && typeof index.store.subscribe === 'function', 'store.get/subscribe');
for (const k of ['run', 'setClock', 'postEvent', 'patchJob', 'addTractor', 'removeTractor', 'why', 'mechanics', 'bookMechanic', 'approve', 'scaleTest', 'getLog', 'getOperation']) ok(typeof index.api[k] === 'function', 'api.' + k);

// ===================================================================
section('scenario run with events');
const A = harness();
const { api } = A;
ok(A.msgs[0].type === 'snapshot' && A.msgs[0].seq === 1, 'first message is snapshot seq 1');
ok(A.store.get().plan.version === 1 && A.store.get().operations[0].kind === 'run', 'boot snapshot has plan v1 and run op');

A.until(() => A.w().t >= 20);
// --- add tractor
const added = await api.addTractor({ name: 'Tractor 4', implements: ['mower', 'hedger'], fuel_pct: 75, speed: 1.0, start: { x: 3, y: 6 }, endpoint: 'auto' });
shapeOk(added, 'rest.post_fleet', 'addTractor body');
ok(added.tractor.status === 'starting' && added.tractor.id === 'T4' && added.tractor.color === '#30D158', 'new tractor T4 starting, 4th palette color');
A.tick(29);
ok(A.store.get().fleet.find((t) => t.id === 'T4').status === 'starting', 'still starting before 3 s');
A.tick(2);
const t4Expl = A.store.get().explanations.find((x) => x.trigger === 'tractor_added');
ok(!!t4Expl, 'tractor_added explanation after ready');
const t4Jobs = () => A.store.get().jobs.filter((j) => j.tractor === 'T4').map((j) => j.id);
ok(t4Jobs().length > 0, `T4 took jobs: [${t4Jobs()}] — "${t4Expl?.text}"`);
console.log('    T4:', t4Expl?.text);
{ const c = t4Expl.facts.context; const m = /finishes by .*?, (\d+) mins? earlier/.exec(t4Expl.text);
  ok(!/instead of/.test(t4Expl.text) && (!m || c.makespan_new_t < c.makespan_old_t), 'add-tractor text only claims a true improvement'); }

// --- block_route while a tractor is mid-travel
ok(A.until(() => A.w().tractors.some((x) => x.status === 'traveling' && x.path.length - x.pi > 5), 3000), 'some tractor travelling a long route');
const opBlock = await api.postEvent({ type: 'block_route' });
opOk(opBlock, 'block_route 202');
ok(opBlock.status === 'queued' && opBlock.source === 'events', 'block_route returns queued events op');
A.tick();
const blockExpl = A.store.get().explanations[0];
ok(blockExpl.trigger === 'block_route', 'block_route explanation');
console.log('    block:', blockExpl.text);
ok(A.store.get().scenario.blocked_cells.length >= 1, 'store scenario.blocked_cells updated from log');

// --- heat alert
const opHeat = await api.postEvent({ type: 'heat_alert', temp_f: 112, at_t: 480 });
A.tick();
console.log('    heat:', A.store.get().explanations[0].text);
ok(A.store.get().explanations[0].trigger === 'heat_alert', 'heat_alert explanation');

// --- patch priority
const opPatch = await api.patchJob('J10', { priority: 3 });
shapeOk(opPatch, 'rest.patch_job', 'patchJob 202');
A.tick();
ok(A.store.get().jobs.find((j) => j.id === 'J10').priority === 3, 'J10 priority 3 after op');
console.log('    patch:', A.store.get().explanations[0].text);

// --- superseded: two patches on the same job in one tick
const s1 = await api.patchJob('J5', { priority: 2 });
const s2 = await api.patchJob('J5', { priority: 3 });
A.tick();
ok(opMsgs(A.msgs, s1.id).map((m) => m.data.status).join('>') === 'queued>superseded', 'first patch superseded');
ok(opMsgs(A.msgs, s2.id).at(-1).data.status === 'succeeded', 'second patch succeeded');

// --- failed: pin a mowing job to a sprayer-only tractor
const planBefore = A.store.get().plan.version;
const opFail = await api.patchJob('J2', { pinned_to: 'T1' }).catch((e) => e);
A.tick();
const failMsg = opMsgs(A.msgs, opFail.id).at(-1).data;
ok(failMsg.status === 'failed' && failMsg.error.code === 'SAFETY_REJECTED' && failMsg.solver_status === 'no_feasible_plan', 'incompatible pin => failed SAFETY_REJECTED no_feasible_plan');
shapeOk({ type: 'operation', t: 0, seq: 0, data: failMsg }, 'ws.operation_failed', 'failed op');
ok(A.store.get().plan.version === planBefore, 'failed op keeps previous plan');
A.src.debug.failNext();
const opFail2 = await api.postEvent({ type: 'heat_alert' });
A.tick();
ok(opMsgs(A.msgs, opFail2.id).at(-1).data.status === 'failed', 'debug.failNext() fails the next replan');

// --- errors reject asynchronously with {code,message,details}
const e1 = await api.patchJob('J99', { priority: 3 }).then(() => null, (e) => e);
ok(e1 && e1.code === 'NOT_FOUND' && typeof e1.message === 'string' && typeof e1.details === 'object', 'unknown job rejects NOT_FOUND');
shapeOk({ error: e1 }, 'rest.error', 'error body');
const e2 = await api.patchJob('J4', { priority: 7 }).then(() => null, (e) => e);
ok(e2?.code === 'INVALID_INPUT', 'bad priority rejects INVALID_INPUT');

// --- idempotency
const k1 = await api.postEvent({ type: 'heat_alert', temp_f: 110 }, { idempotencyKey: 'abc' });
const k2 = await api.postEvent({ type: 'heat_alert', temp_f: 110 }, { idempotencyKey: 'abc' });
ok(k1.id === k2.id, 'same Idempotency-Key + body returns the same operation');
const k3 = await api.postEvent({ type: 'heat_alert', temp_f: 111 }, { idempotencyKey: 'abc' }).then(() => null, (e) => e);
ok(k3?.code === 'CONFLICT', 'reused key with different body => CONFLICT');
A.tick();

// --- breakdown of T1 mid-job, mechanic, repair
ok(A.until(() => { const t1 = A.w().tractors.find((x) => x.id === 'T1'); return t1.status === 'working' && A.w().jobs.some((j) => j.implement === 'sprayer' && j.status === 'assigned'); }, 4000), 'T1 working with sprayer work still queued');
const opBreak = await api.postEvent({ type: 'breakdown', tractor: 'T1', issue: 'hydraulic leak' });
ok(A.store.get().fleet.find((t) => t.id === 'T1').status === 'broken', 'breakdown applied immediately on accept');
A.tick();
const brk = A.store.get().explanations[0];
ok(brk.trigger === 'breakdown' && /broke down/.test(brk.text), 'breakdown explanation');
console.log('    breakdown:', brk.text);
const pend = A.store.get().pending.find((p) => p.kind === 'mechanic' && p.tractor === 'T1');
ok(!!pend && pend.options.length === 4, 'mechanic pending with 4 options');
ok(A.store.get().jobs.filter((j) => j.tractor === 'T1' && j.status !== 'done').length === 0, 'T1 holds no unfinished work after breakdown');
const mech = await api.mechanics('T1');
shapeOk(mech, 'rest.mechanics', 'mechanics body');
const opBook = await api.bookMechanic('T1', 'M1');
shapeOk(opBook, 'rest.mechanics_book', 'bookMechanic 202');
A.tick();
const booked = opMsgs(A.msgs, opBook.id).at(-1).data;
opOk(booked, 'booking op');
ok(booked.status === 'succeeded' && booked.result.estimated_return_t > booked.result.arrival_t, 'booking result has arrival_t < estimated_return_t');
ok(A.store.get().fleet.find((t) => t.id === 'T1').status === 'repair_scheduled', 'T1 repair_scheduled');
ok(A.until(() => A.w().t >= booked.result.arrival_t + 1), 'reach mechanic arrival');
ok(A.store.get().fleet.find((t) => t.id === 'T1').status === 'repairing', 'T1 repairing after arrival');
A.until(() => A.w().t >= booked.result.estimated_return_t + 2);
ok(A.store.get().fleet.find((t) => t.id === 'T1').status === 'repairing', 'T1 NOT schedulable after ETA without tractor_repaired (§13.2)');
const opRep = await api.postEvent({ type: 'tractor_repaired', tractor: 'T1' });
A.tick();
const rep = A.store.get().explanations[0];
ok(rep.trigger === 'tractor_repaired', 'tractor_repaired explanation');
console.log('    repaired:', rep.text);
ok(A.store.get().log.some((l) => l.kind === 'tractor_repaired'), 'tractor_repaired log');

// --- why + scale test + clock
const why = await api.why('J11');
shapeOk(why, 'rest.why', 'why body');
ok(why.options.length === A.store.get().fleet.length && why.options.some((o) => o.feasible), 'why has one option per tractor');
const st = await api.scaleTest();
shapeOk(st, 'rest.scale_test', 'scaleTest body');
ok(st.tractors === 5 && st.violations === 0, 'scale test defaults to 5 tractors, 0 violations');
console.log('    scale:', JSON.stringify(st));
const clk = await api.setClock({ speed: 4 });
shapeOk(clk, 'rest.post_clock', 'setClock body');

// --- remove T4 (hand-back)
const t4Before = t4Jobs().filter((id) => A.store.get().jobs.find((j) => j.id === id).status !== 'done');
const del = await api.removeTractor('T4');
shapeOk(del, 'rest.delete_fleet', 'removeTractor body');
A.tick(16);
ok(!A.store.get().fleet.some((t) => t.id === 'T4'), 'T4 removed from fleet');
ok(t4Before.every((id) => A.store.get().jobs.find((j) => j.id === id).tractor !== 'T4'), 'T4 work handed back');

// --- run to end of day
A.until(() => A.store.get().clock.ended);
const endS = A.store.get();
ok(endS.clock.ended && endS.clock.t === DAY_MIN, 'day ended at 720');
console.log('    end:', endS.explanations[0].text);
ok(endS.jobs.every((j) => j.status === 'done' || ['pending', 'assigned', 'paused'].includes(j.status)), 'all jobs done or carried over (never dropped)');
ok(endS.metrics.ours.completed >= 9, `most jobs completed (${endS.metrics.ours.completed}/11)`);
ok(JSON.stringify(endS.jobs) === JSON.stringify(A.src.debug.snapshot().jobs), 'store jobs equal sim jobs after end-of-day flush');
ok(JSON.stringify(endS.fleet.map((t) => [t.id, t.status, t.queue, t.current_job])) === JSON.stringify(A.src.debug.snapshot().fleet.map((t) => [t.id, t.status, t.queue, t.current_job])), 'store fleet equals sim fleet');
const logText = await api.getLog();
const lines = logText.trim().split('\n').map((l) => JSON.parse(l));
ok(lines.every((l) => typeof l.t === 'number' && LOG_KINDS.has(l.kind)), 'every log line has t and a §7 kind');
const opGet = await api.getOperation(opBook.id);
opOk(opGet, 'getOperation');

// --- run(): reset (same-key retry returns the same op, which still runs)
const opRun = await api.run('ours', { idempotencyKey: 'run-1' });
ok((await api.run('ours', { idempotencyKey: 'run-1' })).id === opRun.id, 'run retry with same key returns same op');
shapeOk(opRun, 'rest.post_run', 'run 202');
A.progress.clear(); A.src.tick();
const runIds = opMsgs(A.msgs, opRun.id);
const snapIdx = A.msgs.findIndex((m, i) => i > idxOf(A.msgs, runIds[1]) && m.type === 'snapshot');
ok(runIds.map((m) => m.data.status).join('>') === 'queued>running>succeeded', 'run op lifecycle');
ok(snapIdx > idxOf(A.msgs, runIds[1]) && snapIdx < idxOf(A.msgs, runIds[2]), 'run: snapshot after reset, before terminal op');
ok(A.msgs[snapIdx].data.plan.version === 0 && A.msgs[snapIdx].data.plan.solver_status === 'feasible', 'reset plan is v0 feasible');
ok(A.store.get().clock.t < 2 && A.store.get().jobs.every((j) => j.progress === 0), 'store reset by snapshot');
A.progress.clear();
A.tick(5);

// ===================================================================
section('message stream checks (instance A)');
ok(A.msgs.every((m, i) => Object.keys(m).sort().join(',') === 'data,seq,t,type' && typeof m.t === 'number' && m.seq === i + 1), 'envelopes {type,t,seq,data}, seq +1 per message');
ok(A.gaps === 0, 'no seq gaps seen by store');
const seen = new Set();
for (const m of A.msgs) {
  seen.add(m.type);
  if (m.type === 'log') { ok(typeof m.data.t === 'number' && LOG_KINDS.has(m.data.kind), `log line kind ${m.data.kind}`); continue; }
  const ex = m.type === 'operation' ? 'ws.operation' : 'ws.' + m.type;
  const errs = []; shape(m, EX[ex], m.type, errs);
  if (errs.length) { ok(false, `${m.type}#${m.seq}: ${errs.slice(0, 3).join(' | ')}`); break; }
  if (m.type === 'operation') opOk(m.data, 'op#' + m.seq);
  if (m.type === 'explanation') ok(['event', 'moved', 'deadlines_missed', 'travel_delta_min', 'idle_delta_min'].every((k) => k in m.data.facts), 'explanation facts keys');
}
for (const t of ['snapshot', 'clock', 'poses', 'fleet', 'jobs', 'plan', 'explanation', 'metrics', 'weather', 'pending', 'capacity', 'log', 'operation']) ok(seen.has(t), `saw at least one ${t} message`);
// re-plan ordering
for (let i = 0; i < A.msgs.length; i++) {
  if (A.msgs[i].type !== 'plan') continue;
  ok(A.msgs[i + 1]?.type === 'explanation' && A.msgs[i + 2]?.type === 'jobs', `plan#${A.msgs[i].seq} followed by explanation, jobs`);
  ok(A.msgs[i + 1]?.data.plan_version === A.msgs[i].data.version, 'explanation.plan_version = plan.version');
}
// operation ordering (§13.3)
const allOps = [...new Set(A.msgs.filter((m) => m.type === 'operation').map((m) => m.data.id))];
for (const id of allOps) {
  const ms = opMsgs(A.msgs, id); const st = ms.map((m) => m.data.status);
  if (st[1] === 'superseded') continue;
  ok(st.join('>') === 'queued>running>' + st[2] && ['succeeded', 'failed'].includes(st[2]) && st.length === 3, `op ${id} lifecycle ${st.join('>')}`);
  const [, run, end] = ms; const between = A.msgs.slice(idxOf(A.msgs, run) + 1, idxOf(A.msgs, end));
  const plans = between.filter((m) => m.type === 'plan');
  if (end.data.status === 'failed') ok(plans.length === 0, `failed op ${id} broadcast no plan`);
  else if (end.data.kind === 'replan' || end.data.kind === 'run') {
    ok(plans.length === 1 && plans[0].data.version === end.data.plan_version && end.data.result.applied_plan_version === end.data.plan_version, `op ${id} applied exactly its plan v${end.data.plan_version}`);
  }
}
// cadence
const ticksPerSec = 10;
const poses = A.msgs.filter((m) => m.type === 'poses').length, clocks = A.msgs.filter((m) => m.type === 'clock').length;
console.log(`    messages: ${A.msgs.length}, poses ${poses}, clock ${clocks}`);
ok(A.msgs.filter((m) => m.type === 'poses').every((m) => m.data.tractors.length >= 1), 'poses batched, never empty');

// ===================================================================
section('clean day (instance B, no events) + determinism');
function cleanDay() {
  const B = harness();
  B.until(() => B.store.get().clock.ended, 20000);
  return B;
}
const B = cleanDay(), B2 = cleanDay();
const bs = B.store.get();
ok(bs.jobs.every((j) => j.status === 'done'), `clean day: all 11 jobs done (${bs.jobs.filter((j) => j.status === 'done').length})`);
ok(bs.metrics.ours.on_time === 11, `clean day: all on time (${bs.metrics.ours.on_time})`);
console.log('    clean metrics:', JSON.stringify(bs.metrics.ours));
const strip = (h) => JSON.stringify(h.msgs.map((m) => m.type === 'plan' ? { ...m, data: { ...m.data, solve_ms: 0 } } : m.type === 'metrics' ? { ...m, data: { ...m.data, ours: { ...m.data.ours, replan_ms_last: 0 } } } : m.type === 'log' && m.data.replan_ms ? { ...m, data: { ...m.data, replan_ms: 0 } } : m.type === 'log' && m.data.solve_ms ? { ...m, data: { ...m.data, solve_ms: 0 } } : m.type === 'snapshot' ? null : m));
ok(strip(B) === strip(B2), 'two clean runs produce identical streams (deterministic)');

// ===================================================================
section('LiveSource adapter (index.js live path) with stub fetch/WebSocket');
{
  const { createLiveSource, newIdempotencyKey } = await import('./liveSource.js');
  const calls = [];
  const snap = A.src.debug.snapshot();
  const realFetch = globalThis.fetch, realWS = globalThis.WebSocket;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/state')) return new Response(JSON.stringify(snap), { status: 200 });
    if (url.includes('/api/jobs/')) return new Response(JSON.stringify({ error: { code: 'CONFLICT', message: 'Busy', details: {} } }), { status: 409 });
    return new Response(JSON.stringify(EX['rest.post_events']), { status: 202 });
  };
  const sockets = [];
  globalThis.WebSocket = class { constructor(u) { this.url = u; this.readyState = 1; sockets.push(this); } send() {} close() { this.onclose?.(); } };
  const store = createStore({ source: 'live' });
  const live = createLiveSource({ api: 'http://host:8000', onMessage: (m) => store.apply(m), onStatus: (c) => store.setConnected(c) });
  store.setResync(() => live.resync());
  const started = live.start();
  ok(sockets[0].url === 'ws://host:8000/ws', 'ws url derived from api base');
  sockets[0].onopen(); ok(store.get().connected, 'connected on open');
  sockets[0].onmessage({ data: JSON.stringify({ type: 'snapshot', t: 0, seq: 1, data: snap }) });
  await started;
  ok(store.get().operations.length > 0 && store.get().plan, 'snapshot applied incl. operations');
  sockets[0].onmessage({ data: JSON.stringify({ type: 'clock', t: 1, seq: 2, data: { ...snap.clock, t: 1 } }) });
  ok(!calls.some((c) => c.url.endsWith('/api/state')), 'no resync without gap');
  sockets[0].onmessage({ data: JSON.stringify({ type: 'clock', t: 2, seq: 7, data: { ...snap.clock, t: 2 } }) });
  await new Promise((r) => setTimeout(r, 20));
  ok(calls.some((c) => c.url === 'http://host:8000/api/state'), 'seq gap triggers GET /api/state');
  ok(store.get().seq === 7, 'seq continues after resync snapshot');
  const k = newIdempotencyKey();
  const op = await live.request('POST', '/events', { type: 'heat_alert' }, { idempotencyKey: k });
  ok(op.id === 'O17' && calls.at(-1).init.headers['Idempotency-Key'] === k, 'Idempotency-Key header sent; 202 Operation body returned');
  const err = await live.request('PATCH', '/jobs/J1', { priority: 3 }).then(() => null, (e) => e);
  ok(err?.code === 'CONFLICT' && err.message === 'Busy' && err.status === 409, 'error body unwrapped to {code,message,details,status}');
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const to = await live.request('GET', '/why/J1', undefined, { timeoutMs: 20 }).then(() => null, (e) => e);
  ok(to?.code === 'CLIENT_TIMEOUT' && to.status === 0, 'client-side abort => CLIENT_TIMEOUT status 0 (not server TIMEOUT)');
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'TIMEOUT', message: 'budget', details: {} } }), { status: 503 });
  const st503 = await live.request('GET', '/why/J1').then(() => null, (e) => e);
  ok(st503?.code === 'TIMEOUT' && st503.status === 503, 'server 503 TIMEOUT kept as TIMEOUT');
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const net = await live.request('GET', '/state').then(() => null, (e) => e);
  ok(net?.code === 'NETWORK' && net.status === 0, 'no response => NETWORK');
  globalThis.fetch = realFetch2;
  sockets[0].close(); ok(!store.get().connected, 'disconnected on close');
  live.close();
  globalThis.fetch = realFetch; globalThis.WebSocket = realWS;
}

section('idempotency replay after state changed (book + approve, §13.3)');
{
  const C = harness();
  C.until(() => C.store.get().fleet.find((t) => t.id === 'T2')?.status === 'working', 4000);
  await C.api.postEvent({ type: 'breakdown', tractor: 'T2', issue: 'flat tyre' });
  C.tick();
  const b1 = await C.api.bookMechanic('T2', 'M2', { idempotencyKey: 'book-k' });
  C.tick();
  ok(C.store.get().fleet.find((t) => t.id === 'T2').status === 'repair_scheduled', 'T2 booked (state changed)');
  const b2 = await C.api.bookMechanic('T2', 'M2', { idempotencyKey: 'book-k' }).then((x) => x, (e) => e);
  ok(b2 && b2.id === b1.id && b2.status === 'succeeded' && b2.result && b2.result.mechanic === 'M2', `book replay after state change returns ORIGINAL op (got ${JSON.stringify(b2).slice(0, 120)})`);
  const b3 = await C.api.bookMechanic('T2', 'M1', { idempotencyKey: 'book-k' }).then(() => null, (e) => e);
  ok(b3?.code === 'CONFLICT', 'book: same key + different body => CONFLICT');
  const b4 = await C.api.approve('P99', 'approve', { idempotencyKey: 'book-k' }).then(() => null, (e) => e);
  ok(b4?.code === 'CONFLICT', 'same key on another endpoint => CONFLICT (checked before NOT_FOUND)');
  const b5 = await C.api.bookMechanic('T2', 'M2').then(() => null, (e) => e);
  ok(b5?.code === 'CONFLICT', 'fresh key on a no-longer-broken tractor still validates state => CONFLICT');

  C.until(() => C.store.get().fleet.find((t) => t.id === 'T3')?.status === 'working', 4000);
  await C.api.postEvent({ type: 'breakdown', tractor: 'T3', issue: 'hydraulic leak' });
  C.tick();
  const pend = C.store.get().pending.find((p) => p.tractor === 'T3');
  ok(!!pend, 'T3 mechanic pending');
  const a1 = await C.api.approve(pend.id, 'override', { idempotencyKey: 'ap-k' });
  C.tick();
  ok(!C.store.get().pending.some((p) => p.id === pend.id), 'pending resolved (state changed)');
  const a2 = await C.api.approve(pend.id, 'override', { idempotencyKey: 'ap-k' }).then((x) => x, (e) => e);
  ok(a2 && a2.id === a1.id && a2.status === 'succeeded' && a2.result?.pending_id === pend.id, `approve replay after resolve returns ORIGINAL op (got ${JSON.stringify(a2).slice(0, 120)})`);
  const a3 = await C.api.approve(pend.id, 'approve', { idempotencyKey: 'ap-k' }).then(() => null, (e) => e);
  ok(a3?.code === 'CONFLICT', 'approve: same key + different decision => CONFLICT');
  const a4 = await C.api.approve(pend.id, 'override').then(() => null, (e) => e);
  ok(a4?.code === 'NOT_FOUND', 'fresh key on resolved pending => NOT_FOUND');
  const opsBefore = C.src.debug.snapshot().operations.length;
  await C.api.bookMechanic('T2', 'M2', { idempotencyKey: 'book-k' });
  ok(C.src.debug.snapshot().operations.length === opsBefore, 'replay creates no new operation');
}

section('store: reconnect vs resync snapshot');
{
  const st = createStore({ source: 'live' });
  const snap = A.src.debug.snapshot();
  const op = (id, status) => ({ id, kind: 'replan', status, source: 'events', created_t: 1, updated_t: 1, message: '', plan_version: null, solver_status: null, result: null, error: null });
  st.apply({ type: 'snapshot', t: 0, seq: 1, data: { ...snap, operations: [op('O50', 'running'), op('O49', 'succeeded')] } });
  st.apply({ type: 'operation', t: 1, seq: 2, data: op('O50', 'failed') });
  st.applySnapshotData({ ...snap, operations: [op('O50', 'running')] });
  ok(st.get().operations.find((o) => o.id === 'O50').status === 'failed', 'resync snapshot never moves an op back from terminal to running');
  st.apply({ type: 'snapshot', t: 0, seq: 1, data: { ...snap, operations: [op('O2', 'running')] } });
  ok(st.get().operations.map((o) => o.id).join() === 'O2' && st.get().seq === 1, 'reconnect snapshot fully replaces operations (server restart)');
  st.setLink({ url: 'ws://x/ws', connected: false, everConnected: false, failures: 2 });
  ok(st.get().link.failures === 2, 'setLink stores link detail');
}

section('index.js live adapter mapping');
{
  const calls = [];
  const realFetch = globalThis.fetch, realWS = globalThis.WebSocket;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(url.endsWith('/log') ? '' : '{}', { status: 200 }); };
  globalThis.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
  globalThis.location = { search: '?source=live&api=http://host:8000/' };
  const L = await import('./index.js?live');
  ok(L.sourceInfo.kind === 'live' && L.sourceInfo.api === 'http://host:8000', 'sourceInfo live + api parsed');
  const expect = [
    ['run', ['ours'], 'POST', '/api/run', { mode: 'ours' }, true],
    ['setClock', [{ playing: false }], 'POST', '/api/clock', { playing: false }, false],
    ['postEvent', [{ type: 'heat_alert' }], 'POST', '/api/events', { type: 'heat_alert' }, true],
    ['patchJob', ['J1', { priority: 3 }], 'PATCH', '/api/jobs/J1', { priority: 3 }, true],
    ['addTractor', [{ implements: ['mower'] }], 'POST', '/api/fleet', { implements: ['mower'] }, false],
    ['removeTractor', ['T4'], 'DELETE', '/api/fleet/T4', undefined, false],
    ['why', ['J1'], 'GET', '/api/why/J1', undefined, false],
    ['mechanics', ['T1'], 'GET', '/api/mechanics?tractor=T1', undefined, false],
    ['bookMechanic', ['T1', 'M1'], 'POST', '/api/mechanics/book', { tractor: 'T1', mechanic: 'M1' }, true],
    ['approve', ['P1', 'approve'], 'POST', '/api/approve', { id: 'P1', decision: 'approve' }, true],
    ['scaleTest', [{}], 'POST', '/api/scale-test', { tractors: 5, jobs: 20 }, false],
    ['getLog', [], 'GET', '/api/log', undefined, false],
    ['getOperation', ['O3'], 'GET', '/api/operations/O3', undefined, false],
  ];
  for (const [name, args, method, path, body, idem] of expect) {
    calls.length = 0;
    await L.api[name](...args);
    const c = calls[0];
    ok(c && c.url === 'http://host:8000' + path && c.init.method === method && JSON.stringify(c.init.body ? JSON.parse(c.init.body) : undefined) === JSON.stringify(body) && !!c.init.headers['Idempotency-Key'] === idem, `live api.${name} -> ${method} ${path}${idem ? ' +Idempotency-Key' : ''}`);
  }
  // lost reply on an async mutation: re-sent with the SAME key, resolves to the op instead of failing
  {
    const keys = []; let n = 0;
    globalThis.fetch = async (url, init) => {
      keys.push(init.headers['Idempotency-Key']);
      if (n++ === 0) throw new TypeError('Failed to fetch'); // socket "up" is irrelevant here: first try NETWORK while offline fails fast
      return new Response(JSON.stringify(EX['rest.post_events']), { status: 202 });
    };
    const fast = await L.api.postEvent({ type: 'heat_alert' }).then(() => null, (e) => e);
    ok(fast?.code === 'NETWORK', 'NETWORK on first try while offline fails fast (nothing reached the server)');
    // CLIENT_TIMEOUT path: first call hangs past the abort, retry answers
    keys.length = 0; n = 0;
    globalThis.fetch = (url, init) => {
      keys.push(init.headers['Idempotency-Key']);
      if (n++ === 0) return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
      return Promise.resolve(new Response(JSON.stringify(EX['rest.post_events']), { status: 202 }));
    };
    const realST = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => realST(fn, Math.min(ms, 5), ...a); // squash the 10 s abort + backoff
    const op = await L.api.postEvent({ type: 'heat_alert' }, { idempotencyKey: 'retry-k' }).then((x) => x, (e) => e);
    globalThis.setTimeout = realST;
    ok(op?.id === EX['rest.post_events'].id && keys.length === 2 && keys.every((k) => k === 'retry-k'), `CLIENT_TIMEOUT on mutation re-sent with same key, resolves to the op (${JSON.stringify(keys)})`);
  }
  delete globalThis.location; globalThis.fetch = realFetch; globalThis.WebSocket = realWS;
}

console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);

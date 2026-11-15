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
const LOG_KINDS = new Set(['plan', 'event', 'replan', 'job_started', 'job_done', 'job_dropped', 'operator_action', 'tractor_added', 'tractor_removed', 'tractor_ready', 'mechanic_search', 'mechanic_booked', 'tractor_repaired', 'weather', 'agopenweb', 'safety_reject', 'violation',
  // Tractor Control Panel (contract gap: kinds not in §7): operator depot stops + manual drive-to arrival
  'refueled', 'implement_swapped', 'manual_arrived']);

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
      // Weather Agent: spraying only ever happens while spraying is allowed on that block
      for (const j of s.jobs) if (j.status === 'working' && j.implement === 'sprayer') ok(!s.weather || s.weather.spray_allowed_now[j.block] === true, `${j.id} sprays Block ${j.block} only while allowed`);
      const seen = new Set();
      for (const t of s.fleet) for (const id of [t.current_job, ...t.queue].filter(Boolean)) { ok(!seen.has(id) || s.jobs.find((j) => j.id === id)?.status === 'paused', `job ${id} held by two tractors`); seen.add(id); }
    },
  };
  return h;
}
const opMsgs = (msgs, id) => msgs.filter((m) => m.type === 'operation' && m.data.id === id);
const idxOf = (msgs, m) => msgs.indexOf(m);

// ===================================================================
section('Tractor Control Panel traffic through the contract checker (instance C)');
{
  const C = harness();
  C.tick(150);
  const run = async (p) => { const op = await p; C.tick(3); return op; };
  const pv = await C.api.preview('T3', { control: 'implements', value: ['sprayer'] });
  shapeOk(pv, 'rest.post_preview', 'preview');
  const gc = await C.api.getControls('T2');
  // `group` is a proposed optional Control key (section header); the contract example has no such key yet
  shapeOk({ controls: gc.controls.slice(0, 1).map(({ group, ...c }) => c), values: gc.values }, 'rest.get_controls', 'get_controls');
  ok(gc.controls.every((c) => Object.keys(c).filter((k) => k !== 'group').sort().join() === Object.keys(EX['rest.get_controls'].controls[0]).sort().join()), 'every Control has exactly the §5 keys (+ optional group)');
  const opM = await run(C.api.manual('T2', true));
  shapeOk(opM, 'rest.post_manual', 'manual 202');
  const st = await C.api.control('T2', { control: 'steer', value: 10 });
  shapeOk(st, 'rest.post_control', 'control 200');
  await C.api.control('T2', { control: 'speed_up', value: null }); C.tick(40);
  await C.api.control('T2', { control: 'drive_to', value: { x: 5, y: 6 } }); C.tick(300);
  await C.api.control('T2', { control: 'ab_line', value: [{ x: 6, y: 7 }, { x: 9, y: 7 }] });
  const opI = await run(C.api.control('T3', { control: 'implements', value: ['sprayer'] }));
  const opR = await run(C.api.control('T1', { control: 'refuel', value: null }));
  const opB = await run(C.api.manual('T2', false));
  C.tick(400);
  const kinds = new Set(C.msgs.filter((m) => m.type === 'log').map((m) => m.data.kind));
  for (const k of ['operator_action', 'agopenweb', 'implement_swapped', 'refueled', 'manual_arrived']) ok(kinds.has(k), 'control traffic logs ' + k);
  for (const m of C.msgs) {
    if (m.type === 'log') { ok(LOG_KINDS.has(m.data.kind), `log line kind ${m.data.kind}`); continue; }
    const errs = []; shape(m, EX[m.type === 'operation' ? 'ws.operation' : 'ws.' + m.type], m.type, errs);
    if (errs.length) { ok(false, `C ${m.type}#${m.seq}: ${errs.slice(0, 3).join(' | ')}`); break; }
    if (m.type === 'operation') opOk(m.data, 'C op#' + m.seq);
  }
  for (const op of [opM, opI, opR, opB]) {
    const ms = opMsgs(C.msgs, op.id), stt = ms.map((m) => m.data.status).join('>');
    ok(stt === 'queued>running>succeeded', `control/manual op ${op.id} (${op.source}) lifecycle ${stt}`);
    const end = ms[2], between = C.msgs.slice(idxOf(C.msgs, ms[1]) + 1, idxOf(C.msgs, end));
    const pl = between.filter((m) => m.type === 'plan');
    ok(pl.length === 1 && pl[0].data.version === end.data.plan_version, `op ${op.id} applied exactly its plan`);
    const i = idxOf(C.msgs, pl[0]);
    ok(C.msgs[i + 1].type === 'explanation' && C.msgs[i + 1].data.trigger === 'operator_action' && C.msgs[i + 2].type === 'jobs', `op ${op.id}: plan -> operator_action explanation -> jobs`);
  }
  ok(C.msgs.some((m) => m.type === 'plan' && m.data.entries.some((e) => e.kind === 'swap_implement')) && C.msgs.some((m) => m.type === 'plan' && m.data.entries.some((e) => e.kind === 'refuel')), 'plans show swap_implement and refuel entries (PlanKind)');
  ok(C.store.get().fleet.every((t) => t.manual === false), 'every tractor back with the AI');
  ok(C.gaps === 0, 'no seq gaps');
}

// ===================================================================
section('index.js exports');
ok(Object.keys(index).sort().join(',') === 'api,capabilities,sourceInfo,start,store', 'index exports exactly api, capabilities, sourceInfo, start, store');
ok(index.capabilities.get().why === true && index.capabilities.get().events.heat_alert === true, 'mock source: every capability on');
ok(index.sourceInfo.kind === 'mock' && index.sourceInfo.api === null, 'no location => mock');
ok(typeof index.store.get === 'function' && typeof index.store.subscribe === 'function', 'store.get/subscribe');
for (const k of ['run', 'setClock', 'postEvent', 'patchJob', 'submitJobs', 'addTractor', 'removeTractor', 'why', 'mechanics', 'bookMechanic', 'approve', 'scaleTest', 'getLog', 'getOperation', 'getControls', 'control', 'preview', 'manual']) ok(typeof index.api[k] === 'function', 'api.' + k);

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
section('submitJobs: POST /jobs validation, 202 Operation, §13.3 order (instance J2)');
{
  const J = harness();
  J.until(() => J.w().t >= 30);
  const n0 = J.store.get().jobs.length;
  const JOB = { type: 'mow', implement: 'mower', block: 'G', duration_min: 60, priority: 2, deadline_t: 480 };
  // validation: whole list rejected, every row's problems listed with Pydantic-style loc
  const bad = await J.api.submitJobs([JOB, { ...JOB, type: 'spray', block: 'Z', duration_min: 0, priority: 5, deadline_t: -10 }]).then(() => null, (e) => e);
  ok(bad && bad.code === 'INVALID_INPUT' && Array.isArray(bad.details.errors), 'bad row -> INVALID_INPUT with details.errors');
  const locs = (bad?.details.errors || []).map((e) => e.loc.join('.'));
  for (const f of ['implement', 'block', 'duration_min', 'priority', 'deadline_t']) ok(locs.includes('body.jobs.1.' + f), `error loc body.jobs.1.${f} (${locs})`);
  ok(!locs.some((l) => l.startsWith('body.jobs.0')), 'valid row 0 has no errors');
  shapeOk({ error: bad }, 'rest.error', 'submitJobs error body');
  ok((await J.api.submitJobs([]).then(() => null, (e) => e))?.code === 'INVALID_INPUT', 'empty list -> INVALID_INPUT');
  ok((await J.api.submitJobs([{ ...JOB, id: 'J1' }]).then(() => null, (e) => e))?.code === 'CONFLICT', 'existing id -> CONFLICT');
  ok((await J.api.submitJobs([{ ...JOB, id: 'J50' }, { ...JOB, id: 'J50' }]).then(() => null, (e) => e))?.code === 'INVALID_INPUT', 'duplicate id in one request -> INVALID_INPUT');
  ok(J.store.get().jobs.length === n0, 'rejected submissions add nothing');
  // accepted: jobs appear at once (pending), op queued -> running -> plan -> explanation -> jobs -> succeeded
  const op = await J.api.submitJobs([JOB, { type: 'haul_bins', implement: 'bin_trailer', block: 'A', duration_min: 45, priority: 3, deadline_t: 400 }], { idempotencyKey: 'jobs-k' });
  opOk(op, 'submitJobs 202');
  shapeOk(op, 'rest.post_jobs', 'submitJobs 202 vs example');
  ok(op.status === 'queued' && op.kind === 'replan' && op.source === 'jobs', 'submitJobs -> queued replan op, source jobs');
  const ids = J.store.get().jobs.slice(n0).map((j) => j.id);
  ok(ids.join(',') === `J${n0 + 1},J${n0 + 2}` && J.store.get().jobs.slice(n0).every((j) => j.status === 'pending' && j.label), `new jobs added pending with labels: ${ids}`);
  ok(J.store.get().jobs.find((j) => j.id === ids[1]).label === 'Haul bins A', 'label from type + block');
  const again = await J.api.submitJobs([JOB, { type: 'haul_bins', implement: 'bin_trailer', block: 'A', duration_min: 45, priority: 3, deadline_t: 400 }], { idempotencyKey: 'jobs-k' });
  ok(again.id === op.id && J.store.get().jobs.length === n0 + 2, 'same key + body replays the op, adds nothing');
  J.jobIds = null; J.tick();
  const life = opMsgs(J.msgs, op.id);
  const end = life.at(-1).data;
  ok(life.map((m) => m.data.status).join('>') === 'queued>running>succeeded', 'op lifecycle queued>running>succeeded');
  const from = idxOf(J.msgs, life[1]), to = idxOf(J.msgs, life[2]);
  const between = J.msgs.slice(from + 1, to).map((m) => m.type);
  ok(between.indexOf('plan') >= 0 && between.indexOf('plan') < between.indexOf('explanation') && between.indexOf('explanation') < between.indexOf('jobs'), `§13.3 order running>plan>explanation>jobs>succeeded (${between})`);
  opOk(end, 'submitJobs succeeded op');
  ok(end.result.applied_plan_version === J.store.get().plan.version && J.store.get().plan.diff.added.join(',') === ids.join(','), 'plan.diff.added = new ids');
  ok(!J.store.get().plan.diff.moved.some((m) => ids.includes(m.job)), 'new jobs are not reported as moved');
  const ex = J.store.get().explanations[0];
  ok(ex.trigger === 'jobs_submitted' && /2 new jobs added \(Mow G and Haul bins A\)/.test(ex.text), 'jobs_submitted explanation: ' + ex.text);
  console.log('    jobs:', ex.text);
  ok(J.store.get().jobs.slice(n0).every((j) => j.tractor || j.unassigned_reason), 'new jobs planned or have an unassigned reason');
  ok(J.store.get().log.some((l) => l.kind === 'event' && l.type === 'jobs_submitted'), 'log event jobs_submitted');
  // error mapping back onto rows: Pydantic loc (FastAPI 400) and Anay's row-less World errors (matched by message)
  const JI = await import('./jobInput.js');
  const rows2 = [JOB, { ...JOB, block: 'Q' }];
  const pyd = JI.mapJobErrors({ code: 'INVALID_INPUT', message: 'Invalid request: jobs.1.duration_min Input should be greater than 0', details: { errors: [{ loc: ['body', 'jobs', 1, 'duration_min'], msg: 'Input should be greater than 0' }, { loc: ['body', 'jobs'], msg: 'List should have at least 1 item' }] } }, rows2);
  ok(pyd.rows.get(1)?.duration_min === 'Duration: input should be greater than 0.' && pyd.general.length === 1, 'pydantic loc -> row 1 duration_min + general');
  const world = JI.mapJobErrors({ code: 'INVALID_INPUT', message: 'There is no block Q on this farm.', details: {} }, rows2);
  ok(world.rows.get(1)?.block && !world.rows.has(0) && !world.general.length, 'Anay "no block Q" -> row 1 block');
  const impl = JI.mapJobErrors({ message: 'A mow job needs a mower, not a sprayer.', details: {} }, [JOB, { ...JOB, implement: 'sprayer' }]);
  ok(impl.rows.get(1)?.implement && !impl.rows.has(0), 'Anay implement mismatch -> that row');
  ok(JI.mapJobErrors({ message: 'Something else', details: {} }, rows2).general[0] === 'Something else', 'unknown error -> general');
  ok(JI.parseJobsJson('{"jobs": [1]}').jobs.length === 1 && JI.parseJobsJson('[]').jobs && /line 2/.test(JI.parseJobsJson('{\n  nope}').error), 'parseJobsJson: object, list, error with line');
}

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
section('weather: windows, live guard, gust + calm (Change 6 Part B)');
{
  ok([B.msgs[0].data.plan, ...B.msgs.filter((m) => m.type === 'plan').map((m) => m.data)].some((pl) => pl.entries.some((e) => e.kind === 'wait' && e.job === null && Array.isArray(e.route))), 'clean day plan has wait entries (job null) around no-spray periods');
  ok(B.msgs.some((m) => m.type === 'fleet' && m.data.tractors.some((t) => t.status === 'waiting_weather')), 'a sprayer waits for wind at dawn (waiting_weather)');
  ok(B.msgs.filter((m) => m.type === 'weather').length >= 5, 'scripted weather changes stream as weather messages');
  const W0 = B.msgs[0].data.weather;
  ok(W0.spray_allowed_now.E === false && /under the 3 mph minimum/.test(W0.spray_blocked_reason.E), 'dawn 2 mph: spraying blocked, reason cites the 3 mph minimum');
  ok(W0.spray_windows.H.length >= 2 && W0.spray_windows.E.every(([s, e]) => s < e), 'per-block spray windows are ranges; H has gaps (houses downwind)');
  ok(W0.forecast.every((p) => Object.keys(p).sort().join() === 'rain_prob,t,temp_f,wind_from_deg,wind_mph'), 'forecast points are WeatherPoint');

  const G = harness();
  const bad = await G.api.postEvent({ type: 'weather_change', wind_mph: 'strong' }).then(() => null, (e) => e);
  ok(bad?.code === 'INVALID_INPUT', 'weather_change with non-number => INVALID_INPUT');
  ok(G.until(() => { const t3 = G.w().tractors.find((x) => x.id === 'T3'); const j = t3.current_job && G.w().jobs.find((x) => x.id === t3.current_job);
    return t3.status === 'working' && j.implement === 'sprayer' && j.progress > 0.1 && G.w().jobs.some((x) => x.implement === 'bin_trailer' && x.progress === 0 && x.status !== 'done'); }, 6000), 'T3 spraying with hauling still open');
  const sprJob = G.w().tractors.find((x) => x.id === 'T3').current_job;
  const pBefore = G.w().jobs.find((x) => x.id === sprJob).progress;
  const opG = await G.api.postEvent({ type: 'weather_change', wind_mph: 14, wind_from_deg: 270 });
  opOk(opG, 'weather_change 202');
  ok(opG.status === 'queued' && opG.kind === 'replan' && opG.source === 'events', 'weather_change -> queued replan Operation');
  G.tick();
  const ms = opMsgs(G.msgs, opG.id), iRun = idxOf(G.msgs, ms[1]), iEnd = idxOf(G.msgs, ms[2]);
  const order = G.msgs.slice(iRun + 1, iEnd).map((m) => m.type).filter((t) => t !== 'log');
  ok(order[0] === 'plan' && order[1] === 'explanation' && order[2] === 'jobs' && order.includes('weather') && order.indexOf('weather') > 2 && ms[2].data.status === 'succeeded', `§13 order running>plan>explanation>jobs>weather..>succeeded (${order.join('>')})`);
  const gs = G.store.get(), gx = gs.explanations[0];
  console.log('    gust:', gx.text);
  ok(gx.trigger === 'weather_change' && /14 mph/.test(gx.text) && /10 mph spray limit/.test(gx.text), 'explanation cites the 10 mph limit');
  ok(/Tractor 3 paused spraying Block \w at \d+% and switched to hauling bins/.test(gx.text), 'explanation says T3 switched to hauling');
  ok(gx.facts.context.weather.spray_max_wind_mph === 10 && gx.facts.context.paused.some((p) => p.job === sprJob), 'numbers in the text come from facts.context');
  const pj = gs.jobs.find((j) => j.id === sprJob);
  ok(pj.weather_blocked === true && pj.status === 'paused' && pj.progress >= pBefore - 1e-9, `paused spray job keeps progress, weather_blocked (${pj.status} ${pj.progress})`);
  const t3 = gs.fleet.find((t) => t.id === 'T3'), t3job = gs.jobs.find((j) => j.id === (t3.current_job || t3.queue[0]));
  ok(t3job && t3job.implement === 'bin_trailer', 'T3 now hauls bins');
  ok(Object.values(gs.weather.spray_allowed_now).every((v) => v === false) && gs.weather.current.wind_mph === 14, 'weather: 14 mph, no block may spray');
  ok(!gs.jobs.some((j) => j.status === 'working' && j.implement === 'sprayer'), 'no spray job working during the gust');
  ok(gs.plan.entries.filter((e) => e.job === sprJob && e.kind === 'work').every((e) => e.start_t >= G.w().wx.overrides[0].to - 0.1), 'paused job re-planned after the gust window');
  G.tick(30);
  ok(!G.store.get().jobs.some((j) => j.status === 'working' && j.implement === 'sprayer'), 'still no spraying 30 ticks into the gust');
  const opC = await G.api.postEvent({ type: 'weather_change', wind_mph: 6, wind_from_deg: 0 });
  G.tick();
  console.log('    calm:', G.store.get().explanations[0].text);
  ok(opMsgs(G.msgs, opC.id).at(-1).data.status === 'succeeded' && G.store.get().weather.current.wind_mph === 6, 'calm applied');
  ok(Object.values(G.store.get().weather.spray_allowed_now).some((v) => v), 'calm: spraying allowed again');
  ok(G.until(() => G.w().jobs.find((j) => j.id === sprJob).status === 'done', 8000), 'paused spray job completes after calm');
  ok(G.store.get().log.some((l) => l.kind === 'event' && l.type === 'weather_change'), 'weather_change event logged');
}

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
    ['submitJobs', [[{ type: 'mow', implement: 'mower', block: 'G', duration_min: 60, priority: 2, deadline_t: 480 }]], 'POST', '/api/jobs', { jobs: [{ type: 'mow', implement: 'mower', block: 'G', duration_min: 60, priority: 2, deadline_t: 480 }] }, true],
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

// ===================================================================
section('wording: clock wrap, plurals, feed = explanation, overtime, priority words (user-testing round)');
{
  const T = await import('./text.js');
  const D2 = await import('../lib/derive.js');
  ok(T.clockText(0) === '6:00 AM' && T.clockText(720) === '6:00 PM' && T.clockText(748) === '6:28 PM', 'clock: day times');
  ok(T.clockText(1080) === '12:00 AM (+1 day)' && T.clockText(1134) === '12:54 AM (+1 day)' && T.clockText(1079) === '11:59 PM', `clock: past midnight says +1 day (${T.clockText(1134)})`);
  ok(T.clockText(2520) === '12:00 AM (+2 days)', 'clock: two days');
  ok(T.plural(1, 'job') === '1 job' && T.plural(2, 'job') === '2 jobs' && T.plural(0, 'job') === '0 jobs' && T.verb(1, 'carries', 'carry') === 'carries' && T.verb(3, 'carries', 'carry') === 'carry', 'plural + verb helpers');
  // the judge's sequence: breakdown -> block road -> heat alert -> add tractor -> sunset
  const J = harness();
  J.until(() => J.w().t >= 95);
  await J.api.postEvent({ type: 'breakdown', tractor: 'T1' }); J.tick();
  J.until(() => J.w().t >= 110);
  await J.api.postEvent({ type: 'block_route' }); J.tick();
  J.until(() => J.w().t >= 125);
  await J.api.postEvent({ type: 'heat_alert', temp_f: 112, at_t: 480 }); J.tick();
  await J.api.addTractor({ name: 'Tractor 4', implements: ['sprayer', 'mower', 'hedger', 'bin_trailer'], fuel_pct: 80, speed: 1, start: { x: 1, y: 6 }, endpoint: 'auto' });
  J.tick(40);
  await J.api.patchJob('J10', { priority: 1 }); J.tick();
  J.until(() => J.w().ended);
  const st = J.store.get();
  const expls = J.msgs.filter((m) => m.type === 'explanation').map((m) => m.data);
  const logs = J.msgs.filter((m) => m.type === 'log').map((m) => m.data);
  const strip = (h) => String(h || '').replace(/<[^>]+>/g, '');
  const feed = logs.map((e) => strip(D2.logLine(e, st))).filter(Boolean);
  const all = [...expls.map((x) => x.text), ...feed];
  ok(!all.some((t) => /\bmock\b|simulat/i.test(t)), `no mock/simulation wording in explanations or feed: ${all.filter((t) => /\bmock\b|simulat/i.test(t)).slice(0, 2).join(' | ')}`);
  ok(!all.some((t) => /\b0 jobs (moved|changed)\b/.test(t)), 'never "0 jobs moved/changed"');
  ok(!all.some((t) => /\b1 (job|tractor|cell|deadline)s\b/.test(t) || /\b([2-9]|\d\d+) (job|tractor|cell|deadline)\b(?!s)/.test(t)), `count/noun agreement: ${all.filter((t) => /\b1 (job|tractor)s\b/.test(t) || /\b([2-9]|\d\d+) (job|tractor)\b(?!s)/.test(t)).slice(0, 2).join(' | ')}`);
  ok(!all.some((t) => /\b1 job(?: \([^)]*\))? (carry|move|are|wait)\b/.test(t) || /\b([2-9]|\d\d+) jobs(?: \([^)]*\))? (carries|moves|is|waits)\b/.test(t)), 'verb agreement after job counts');
  ok(!all.some((t) => /\bP[123]\b|priority [123]\b/.test(t)), 'priority shown as High/Medium/Low, never P1 or numbers');
  // "X min earlier than before (Y)" must be true on raw t: the earlier time really is earlier
  const add = expls.find((x) => x.trigger === 'tractor_added');
  ok(add && !/earlier than the previous/.test(add.text) || add.facts.context.makespan_new_t < add.facts.context.makespan_old_t, 'add-tractor "earlier" claim true on raw t');
  ok(!expls.some((x) => /(1[3-9]|2\d):\d\d (AM|PM)/.test(x.text)), 'no impossible clock hours');
  // feed and explanation agree: the replan line counts exactly the jobs the explanation names
  for (const e of logs.filter((l) => l.kind === 'replan')) {
    const x = expls.find((y) => y.id === e.explanation_id);
    const ids = D2.replanChanges(e);
    const missing = ids.filter((id) => !x.text.includes(st.jobs.find((j) => j.id === id).label));
    ok(x && missing.length === 0, `${e.trigger}: explanation names all ${ids.length} changed jobs the feed counts (missing ${missing})`);
    const ln = strip(D2.logLine(e, st));
    ok(ids.length ? ln.includes(T.plural(ids.length, 'job') + ' changed') : !/jobs? (moved|changed)/.test(ln), `${e.trigger}: feed count = ${ids.length} (${ln})`);
  }
  const heatLog = logs.find((l) => l.kind === 'replan' && l.trigger === 'heat_alert');
  const heatPlan = J.msgs.filter((m) => m.type === 'plan').map((m) => m.data).find((p) => p.version === heatLog.plan_version);
  ok(heatPlan.diff.moved.length + heatPlan.diff.retimed.length === D2.replanChanges(heatLog).length, 'heat replan feed count == plan.diff moved + retimed');
  // heat explanation is true to the plan: "done before the peak" only when its work really ends by at_t
  const hx = expls.find((x) => x.trigger === 'heat_alert');
  for (const id of hx.facts.context.raised || []) {
    const lab = st.jobs.find((j) => j.id === id).label;
    const end = Math.max(...heatPlan.entries.filter((e) => e.kind === 'work' && e.job === id).map((e) => e.end_t));
    const claimsBefore = new RegExp(lab + ' on [^.]*done before the').test(hx.text);
    ok(claimsBefore === (end <= 480 + 1e-9), `heat: ${lab} ends ${T.clockText(end)}; "done before peak" claim ${claimsBefore}`);
  }
  // overtime: explanation says so whenever the plan runs past day end, and planHealth agrees with entries
  for (const x of expls.filter((y) => y.trigger !== 'end_of_day' && y.facts.context.overtime_min > 0)) ok(/past sunset/.test(x.text), `${x.trigger}: overtime ${x.facts.context.overtime_min} min is mentioned`);
  const heatState = { clock: { t: 130, day_minutes: 720, ended: false }, plan: heatPlan, jobs: st.jobs.map((j) => ({ ...j, status: 'assigned', end_t: null })) };
  const H = D2.planHealth(heatState);
  const maxEnd = Math.max(...heatPlan.entries.filter((e) => e.kind === 'work' || e.kind === 'travel').map((e) => e.end_t));
  ok(H.overtimeMin === Math.max(0, Math.round(maxEnd - 720)) && H.overtimeMin > 0 && H.afterDay.length > 0 && H.late.length > 0, `planHealth overtime ${H.overtimeMin} min, ${H.late.length} late, ${H.afterDay.length} after day`);
  ok(D2.planHealth({ ...heatState, clock: { ...heatState.clock, ended: true } }).overtimeMin === 0, 'planHealth quiet once the day ended');
  // why tie-break
  const fl = { fleet: [{ id: 'T1', name: 'Tractor 1', fuel_pct: 80, pose: { x: 2, y: 2 } }, { id: 'T3', name: 'Tractor 3', fuel_pct: 40, pose: { x: 2, y: 2 } }] };
  ok(/more fuel \(80% vs 40%\)/.test(D2.whyTieBreak({ tractor: 'T3', finish_t: 100.2, travel_delta_min: 0, idle_delta_min: 0, deadlines_missed: [] }, { tractor: 'T1', finish_t: 100, deadlines_missed: [] }, fl, { block: 'A' })), 'why tie: fuel');
  ok(/12 min of driving/.test(D2.whyTieBreak({ tractor: 'T3', finish_t: 100, travel_delta_min: 12, idle_delta_min: 0, deadlines_missed: [] }, { tractor: 'T1', finish_t: 100, deadlines_missed: [] }, fl, null)), 'why tie: travel');
  ok(D2.whyTieBreak({ tractor: 'T3', finish_t: 130, travel_delta_min: 0 }, { tractor: 'T1', finish_t: 100 }, fl, null) === null, 'why: clear loser gets no tie text');
}

section('rejected job edit keeps old values + plain-words message (Anay 7df3d39: staged edits, 422 pin)');
{
  const D3 = await import('../lib/derive.js');
  const R = harness();
  R.tick(3);
  const before = R.store.get().jobs.find((j) => j.id === 'J10');
  const vBefore = R.store.get().plan.version;
  R.src.debug.failNext();
  const op = await R.api.patchJob('J10', { priority: before.priority === 3 ? 1 : 3 });
  R.tick();
  const fin = opMsgs(R.msgs, op.id).at(-1).data;
  ok(fin.status === 'failed' && fin.error.code === 'SAFETY_REJECTED' && fin.solver_status === 'no_feasible_plan', 'mock: rejected priority edit => failed SAFETY_REJECTED');
  const after = R.store.get().jobs.find((j) => j.id === 'J10');
  ok(after.priority === before.priority && after.deadline_t === before.deadline_t && R.store.get().plan.version === vBefore, 'mock: rejected edit keeps priority, deadline and plan version');
  const { priName } = await import('../lib/format.js');
  const txt = D3.editFailText('priority', priName(before.priority), fin);
  ok(txt === "Couldn't change priority: no valid plan accepts it — kept " + priName(before.priority), `failed op message: ${txt}`);
  // incompatible pin (mock: failed op) keeps pinned_to
  const pin = await R.api.patchJob('J2', { pinned_to: 'T1' }); R.tick();
  ok(opMsgs(R.msgs, pin.id).at(-1).data.status === 'failed' && (R.store.get().jobs.find((j) => j.id === 'J2').pinned_to ?? null) === null, 'mock: incompatible pin fails, pinned_to unchanged');
  // up-front rejections (live 409 / 422) read the same way; outcome-unknown errors are not called rejections
  const e422 = { code: 'SAFETY_REJECTED', message: "Can't pin Hedge D to Tractor 1: it has no hedger.", details: { rule: 'implement_match' }, status: 422 };
  ok(D3.editFailText('priority', 'High', e422) === "Couldn't change priority: can't pin Hedge D to Tractor 1: it has no hedger — kept High", '422 SAFETY_REJECTED message: ' + D3.editFailText('priority', 'High', e422));
  ok(D3.editFailText('priority', 'Low', { code: 'CONFLICT', message: 'Mow G is already done.', status: 409 }) === "Couldn't change priority: mow G is already done — kept Low", '409 CONFLICT message');
  ok(D3.editFailText('priority', 'High', { code: 'SAFETY_REJECTED', message: '', status: 422 }) === "Couldn't change priority: no valid plan accepts it — kept High", '422 without message');
  ok(D3.editFailText('priority', 'High', { code: 'UNCONFIRMED', message: 'x', status: 0 }) === null && D3.editFailText('priority', 'High', { ...fin, status: 'succeeded' }) === null, 'no rejection text for UNCONFIRMED / succeeded');
  // liveSource maps a 422 body exactly like 409: rejects {code, message, details, status}
  const { createLiveSource } = await import('./liveSource.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: e422 }), { status: 422 });
  const live = createLiveSource({ api: 'http://host:8000', onMessage() {} });
  const got = await live.request('PATCH', '/jobs/J5', { pinned_to: 'T1' }).then(() => null, (e) => e);
  ok(got && got.code === 'SAFETY_REJECTED' && got.status === 422 && got.message === e422.message && got.details.rule === 'implement_match', 'live: 422 SAFETY_REJECTED rejects {code,message,details,status}');
  globalThis.fetch = realFetch;
}

section('capabilities: explicit GET /api/capabilities (20d266e, §14) wins, no probes');
{
  const { detectCapabilities } = await import('./capabilities.js');
  const DOC = { backend: 'fastapi', events: { breakdown: true, block_route: true, unblock_route: true, tractor_repaired: true, priority_change: true, heat_alert: false, weather_change: false, ripening_change: false }, why: false, controls: false, mechanics: false, approve: false, scaleTest: false, submitJobs: true, patchJob: true, weatherEnforced: false, metricsMeasured: true };
  const seen = [];
  const caps = await detectCapabilities({ root: 'http://x', request: async (m, p) => { seen.push(p); if (p === '/capabilities') return DOC; throw { status: 501 }; }, fetchJson: async () => { seen.push('openapi'); return { paths: {} }; }, state: { jobs: [{ id: 'J1' }], fleet: [{ id: 'T1' }] } });
  ok(seen.length === 1 && seen[0] === '/capabilities', 'only /capabilities requested: ' + seen.join(','));
  ok(caps.backend === 'fastapi' && caps.why === false && caps.controls === false && caps.mechanics === false && caps.approve === false && caps.scaleTest === false && caps.submitJobs && caps.patchJob && caps.weatherEnforced === false && caps.metricsMeasured === true, 'doc flags taken exactly');
  ok(caps.events.breakdown && caps.events.priority_change && caps.events.heat_alert === false && caps.events.weather_change === false && caps.events.ripening_change === false, 'doc events taken exactly');
  const inferred = await detectCapabilities({ root: 'http://x', request: async (m, p) => { if (p === '/capabilities') throw { status: 404, code: 'NOT_FOUND' }; throw { status: 501, details: { not_implemented: true } }; }, fetchJson: async () => ({ paths: {} }), state: { jobs: [{ id: 'J1' }], fleet: [{ id: 'T1' }] } });
  ok(inferred.backend === 'fastapi' && inferred.why === false && inferred.controls === false && inferred.events.heat_alert === false, 'no doc => probing fallback still works');
}

section('baseline hold: transient null keeps last values (Anay 7df3d39 twin recompute)');
{
  const P = await import('../ui/panel.js');
  const h = P.createBaselineHold();
  const ours = { completed: 1, on_time: 1, travel_min: 10, idle_min: 2, violations: 0 };
  const base = { completed: 1, on_time: 1, travel_min: 20, idle_min: 5, violations: 0 };
  let r = h.apply({ ours, baseline: null, baseline_source: null });
  ok(!r.updating && P.scoreRows(r.metrics).hasBase === false && P.baselineLabel(r.metrics) === 'Baseline not run yet.', 'no baseline seen yet => not measured');
  r = h.apply({ ours, baseline: base, baseline_source: 'simulated' });
  ok(!r.updating && P.scoreRows(r.metrics).hasBase, 'baseline arrives');
  r = h.apply({ ours: { ...ours, completed: 2 }, baseline: null, baseline_source: null });
  ok(r.updating && P.scoreRows(r.metrics).hasBase && r.metrics.baseline.travel_min === 20 && r.metrics.ours.completed === 2, 'transient null => last baseline held, marked updating, ours stays live');
  r = h.apply({ ours, baseline: { ...base, travel_min: 21 }, baseline_source: 'simulated' });
  ok(!r.updating && r.metrics.baseline.travel_min === 21, 'fresh baseline replaces the held one');
  h.reset();
  r = h.apply({ ours, baseline: null, baseline_source: null });
  ok(!r.updating && !P.scoreRows(r.metrics).hasBase, 'reset on a new run => not measured again');
  ok(h.apply({ ours, baseline: null, baseline_source: 'simulated' }).updating, 'source without numbers => updating, not "not measured"');
  ok(P.isBridge({ backend: 'bridge' }) && !P.isBridge({ backend: 'fastapi' }) && P.jobsDone({ jobs: [{ status: 'done' }, { status: 'working' }] }) === 1, 'bridge helpers');
}

console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);

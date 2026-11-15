// Unit test for the "Play AI demo" script runner (data/demoScript.js).  Run:  node dashboard/src/data/demoScript.test.mjs
// 1. Runner logic with fake steps: order, capability skip caption, dependent skip, failing step, pause/resume, stop.
// 2. The real DEMO_STEPS gates against each backend's capabilities.
// 3. The real DEMO_STEPS end to end against the in-process MockSource + rules AI Supervisor (no DOM, no timers:
//    the injected sleep advances the simulation), printing the captions a presenter would see.
import { createDemoRunner, DEMO_STEPS, DemoSkip, SKIP_UNSUPPORTED, SKIP_DAY_OVER, msText } from './demoScript.js';
import { ALL_ON, mergeCaps } from './capabilities.js';
import { createMockSource } from './mockSource.js';
import { createStore } from './store.js';
import { createAiSource } from './aiSource.js';

let checks = 0, failures = 0;
const ok = (c, m) => { checks++; if (!c) { failures++; console.error('  FAIL:', m); } };
const section = (s) => console.log('- ' + s);
const tick0 = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- 1. runner
section('runner: order, skip, dependent skip, failure');
{
  const ran = [];
  const steps = [
    { id: 'a', title: 'Alpha', async run(d) { ran.push('a'); d.caption('A says hi'); await d.wait(300); } },
    { id: 'b', title: 'Bravo', needs: (caps) => (caps.events.weather_change === false ? SKIP_UNSUPPORTED : null), async run() { ran.push('b'); } },
    { id: 'c', title: 'Charlie', after: ['b'], async run() { ran.push('c'); } },
    { id: 'd', title: 'Delta', async run() { ran.push('d'); throw new Error('boom'); } },
    { id: 'e', title: 'Echo', async run(d) { ran.push('e'); throw new DemoSkip('skipped: nothing to do'); } },
    { id: 'f', title: 'Foxtrot', async run(d) { ran.push('f'); d.caption('the end'); } },
  ];
  const caps = mergeCaps(ALL_ON, { events: { weather_change: false } });
  const captions = [];
  let finished = 0;
  const r = createDemoRunner({ steps, ctx: { caps: () => caps, state: () => ({}), onFinish: () => finished++ }, sleep: tick0, tickMs: 100, skipHoldMs: 100,
    onUpdate: (v) => { const c = v.caption.text; if (c && captions[captions.length - 1] !== c) captions.push(c); } });
  await r.play();
  ok(ran.join('') === 'adef', 'ran a, d, e, f in order (b skipped by capability, c by dependency): ' + ran.join(''));
  const v = r.view;
  ok(v.status === 'done' && finished === 1, 'status done, onFinish once');
  ok(v.steps.map((s) => s.state).join(',') === 'done,skipped,skipped,failed,skipped,done', 'step states: ' + v.steps.map((s) => s.state).join(','));
  ok(captions.includes('Bravo: skipped: not supported by this backend'), 'capability skip caption is exact');
  ok(captions.includes('Charlie: skipped: needs bravo first'), 'dependent skip caption');
  ok(captions.some((c) => /^Delta: could not run \(boom\)$/.test(c)), 'failed step captioned, run continued');
  ok(captions.includes('Echo: skipped: nothing to do'), 'DemoSkip thrown inside run is a skip');
  ok(captions[captions.length - 1] === 'the end', 'last caption from the last step');
}

section('runner: pause / resume / stop / restart');
{
  let clock = 0, paused = 0, resumed = 0, stopped = 0;
  const sleep = async (ms) => { clock += ms; await tick0(); };
  const seen = [];
  const steps = [
    { id: 'a', title: 'A', async run(d) { seen.push('a0'); await d.wait(1000); seen.push('a1'); } },
    { id: 'b', title: 'B', async run(d) { seen.push('b0'); await d.wait(1000); seen.push('b1'); } },
  ];
  const r = createDemoRunner({ steps, ctx: { caps: () => ALL_ON, state: () => ({}), onPause: () => paused++, onResume: () => resumed++, onStop: () => stopped++ }, sleep, tickMs: 100 });
  const p = r.play();
  for (let i = 0; i < 3; i++) await tick0();
  r.pause();
  ok(r.status === 'paused' && paused === 1, 'pause: status paused, onPause called');
  const c0 = clock;
  for (let i = 0; i < 30; i++) await tick0();
  ok(clock - c0 <= 100 && !seen.includes('a1'), 'paused: no time passes for the script and the step does not advance');
  r.play();
  ok(resumed === 1 && r.status === 'playing', 'resume: onResume called');
  for (let i = 0; i < 40 && !seen.includes('b0'); i++) await tick0();
  ok(seen.join(',') === 'a0,a1,b0', 'resumed: step A finished, step B started: ' + seen.join(','));
  r.stop();
  await p;
  ok(r.status === 'stopped' && stopped === 1, 'stop: status stopped, onStop called once');
  for (let i = 0; i < 30; i++) await tick0();
  ok(!seen.includes('b1'), 'stopped: the running step never continues');
  ok(r.view.steps.map((s) => s.state).join(',') === 'done,pending', 'stop leaves done steps done, the running one pending');
  r.stop(); ok(stopped === 1, 'stop twice: onStop not repeated');
  seen.length = 0;
  await r.play();
  ok(seen.join(',') === 'a0,a1,b0,b1' && r.status === 'done', 'play after stop restarts from the first step');
}

section('runner: stop while paused');
{
  let stopped = 0;
  const steps = [{ id: 'a', title: 'A', async run(d) { await d.wait(1000); } }];
  const r = createDemoRunner({ steps, ctx: { caps: () => ALL_ON, state: () => ({}), onStop: () => stopped++ }, sleep: tick0, tickMs: 100 });
  const p = r.play(); await tick0(); r.pause(); r.stop(); await p;
  ok(r.status === 'stopped' && stopped === 1, 'stop from paused ends the run');
}

// ---------------------------------------------------------------- 2. DEMO_STEPS gates per backend
section('DEMO_STEPS: capability gates');
{
  const profiles = {
    mock: ALL_ON,
    'mock-backend': mergeCaps(ALL_ON, { backend: 'mock-backend' }),
    fastapi: mergeCaps(ALL_ON, { backend: 'fastapi', events: { heat_alert: false, weather_change: false }, approve: false }),
    bridge: mergeCaps(ALL_ON, { backend: 'bridge', events: { heat_alert: false, weather_change: false, block_route: false } }),
    nomech: mergeCaps(ALL_ON, { mechanics: false }),
  };
  const state = { clock: { t: 100, day_minutes: 720 }, ai: { label: 'rules' } };
  const gates = (caps, s = state) => Object.fromEntries(DEMO_STEPS.map((st) => [st.id, st.needs ? st.needs(caps, s) : null]));
  for (const k of ['mock', 'mock-backend']) ok(Object.values(gates(profiles[k])).every((x) => x === null), `${k}: every step runs`);
  const fa = gates(profiles.fastapi);
  ok(fa.wind === SKIP_UNSUPPORTED && fa.heat === SKIP_UNSUPPORTED && fa.breakdown === null, 'fastapi: wind + heat skipped as unsupported, breakdown runs');
  const br = gates(profiles.bridge);
  ok(br.wind === SKIP_UNSUPPORTED && br.heat === SKIP_UNSUPPORTED && br.repair === null, 'bridge: wind + heat skipped, repair runs');
  ok(gates(profiles.nomech).mechanic === SKIP_UNSUPPORTED, 'no mechanics: mechanic step skipped');
  const late = gates(ALL_ON, { clock: { t: 719, day_minutes: 720 }, ai: {} });
  ok(late.breakdown === SKIP_DAY_OVER && late.wind === SKIP_DAY_OVER && late.heat === SKIP_DAY_OVER, 'after the workday: event steps skip with the day-over caption');
  ok(gates(ALL_ON, { clock: { t: 0 } }).supervisor === 'skipped: AI Supervisor not connected', 'no state.ai: supervisor skipped');
  ok(DEMO_STEPS.map((s) => s.id).join(',') === 'plan,breakdown,mechanic,wind,heat,supervisor,repair,end', 'script order');
  ok(msText(0) === 'under 1 ms' && msText(3.4) === '3 ms' && msText(null) === null, 'msText');
}

// ---------------------------------------------------------------- 3. end to end on the mock
section('DEMO_STEPS end to end on MockSource + rules AI Supervisor');
{
  const src = createMockSource({ realtime: false, pace: 1.2 });
  const store = createStore({ source: 'mock' });
  src.connect({ onMessage: (m) => store.apply(m), onConnected: (c) => store.setConnected(c) });
  const caps = { get: () => ALL_ON, subscribe: (fn) => { fn(ALL_ON); return () => {}; } };
  const ai = createAiSource({ store: { get: () => store.get(), subscribe: (fn) => store.subscribe(fn) }, api: src.api, sourceInfo: { kind: 'mock', api: null }, capabilities: caps, setAi: (x) => store.setAi(x) });
  ai.start();
  const api = { ...src.api, aiReview: ai.api.aiReview, aiApprove: ai.api.aiApprove, aiDismiss: ai.api.aiDismiss };
  const S = () => store.get() || {};
  // fake time: every 100 ms of script time is one 100 ms simulation tick
  const sleep = async (ms) => { for (let i = 0; i < Math.max(1, Math.round(ms / 100)); i++) src.tick(); await tick0(); };
  const terminal = (o) => o && ['succeeded', 'failed', 'superseded'].includes(o.status);
  const track = async (p) => {
    let op; try { op = await p; } catch (e) { return null; }
    if (!op || typeof op.id !== 'string' || !('kind' in op)) return op;
    for (let i = 0; i < 200; i++) { const o = (S().operations || []).find((x) => x.id === op.id); if (terminal(o)) return o; src.tick(); await tick0(); }
    return op;
  };
  // DOM stand-ins: the mechanic "sheet" lists the pending item's options; the AI sheet approves through the api
  let mechOpen = false, booked = false, view = 'sim', speed = 1;
  const views = [], hl = [];
  const ctx = {
    api, state: S, caps: () => ALL_ON, track,
    setSpeed: (n) => { speed = n; src.api.setClock({ playing: true, speed: n }); },
    view: () => view, setView: (v) => { view = v; views.push(v); },
    mech: {
      isOpen: () => mechOpen || (S().pending || []).some((p) => p.kind === 'mechanic'),
      open: () => { mechOpen = true; },
      options: () => { const p = (S().pending || []).find((x) => x.kind === 'mechanic'); return p ? p.options : null; },
      select: () => true,
      book: () => { const p = (S().pending || []).find((x) => x.kind === 'mechanic'); const m = p.options.find((o) => o.recommended); src.api.bookMechanic(p.tractor, m.id).then(() => { booked = true; }); return true; },
    },
    ai: { openSheet() {}, closeSheet() {}, highlight: (id) => hl.push(id), approve: () => false, flashPlots() {} },
  };
  const captions = [];
  const r = createDemoRunner({ steps: DEMO_STEPS, ctx, sleep, tickMs: 100, skipHoldMs: 500,
    onUpdate: (v) => { const c = v.caption; const line = c.text + (c.detail ? '  —  ' + c.detail : ''); if (c.text && captions[captions.length - 1] !== line) captions.push(line); } });
  await r.play();
  const v = r.view;
  console.log('    captions:'); captions.forEach((c) => console.log('      ' + c));
  ok(v.status === 'done', 'demo finished');
  ok(v.steps.every((s) => s.state === 'done'), 'every step done on the mock: ' + v.steps.map((s) => s.id + ':' + s.state).join(' '));
  ok(captions.some((c) => /^Morning plan: the Fleet planner assigned 11 jobs to 3 tractors/.test(c)), 'morning plan caption with counts from state');
  ok(captions.some((c) => /^AI re-planned in (under 1 ms|\d+ ms), progress kept/.test(c)), 're-plan caption with time');
  ok(captions.some((c) => /^Mechanic agent ranked 4 options/.test(c)) && booked, 'mechanic ranked 4 options, recommended booked');
  ok(captions.some((c) => /^Weather agent /.test(c)), 'weather caption');
  ok(captions.some((c) => /^Agronomy agent moved G and H spraying up/.test(c)), 'agronomy caption names the raised blocks');
  ok(captions.some((c) => /^AI Supervisor \(rules\) (proposes: |: nothing to approve)/.test(c)), 'AI Supervisor caption names the reviewer');
  ok(captions.some((c) => /^Operator approved, Safety check passed/.test(c)), 'AI proposal approved and applied');
  ok(captions.some((c) => /^T1 back; planner rebalanced/.test(c)), 'repair caption');
  ok(/^All decisions made by the planner and agents; AI Supervisor proposals approved by the operator/.test(captions[captions.length - 1]), 'end caption');
  ok(views.join(',') === 'live,sim', 'Map for a moment, then back to 3D');
  ok(speed === 1, 'normal speed at the end');
  const s = S();
  ok(s.clock.t < s.clock.day_minutes, `finished inside the workday (t=${Math.round(s.clock.t)})`);
  ok(((s.ai && s.ai.history) || []).some((h) => h.status === 'applied'), 'AI Supervisor history has the applied proposal');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);

// Standalone test for the Tractor Control Panel mock (mockControls.js + its mockSource wiring).
// Run:  node dashboard/src/data/mockControls.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { controlSchema, controlValues, newControlState, checkControl, applyControl, previewChange, stepManual, normalizePoints, TABS } from './mockControls.js';
import { createMockSource } from './mockSource.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { failures++; console.error('  FAIL:', m); } };
const section = (n) => console.log('- ' + n);
const code = (fn) => { try { fn(); return null; } catch (e) { return e && e.code ? e : { code: 'THROWN', message: String(e) }; } };
const acode = async (p) => { try { await p; return null; } catch (e) { return e; } };

// ---------------------------------------------------------------- pure module
section('schema shape (ARCHITECTURE §5 Control)');
const KEYS = ['id', 'tab', 'label', 'type', 'min', 'max', 'step', 'unit', 'options', 'needs_manual', 'replans', 'help'];
const TYPES = ['button', 'toggle', 'slider', 'number', 'select', 'map_pick', 'text'];
const T1 = { id: 'T1', name: 'Tractor 1', color: '#0A84FF', implements: ['sprayer'], status: 'working', manual: false, fuel_pct: 80, pose: { x: 2, y: 5, lat: 33.21, lon: -111.61, heading_deg: 90, speed_mph: 4.5 }, tool: { width_m: 6 }, current_job: 'J1', queue: ['J4'], agopenweb: null };
const JOBS = [
  { id: 'J1', type: 'spray', label: 'Spray E', implement: 'sprayer', block: 'E', duration_min: 150, progress: 0.2, priority: 3, deadline_t: 330, status: 'working', tractor: 'T1', pinned_to: null },
  { id: 'J2', type: 'mow', label: 'Mow C', implement: 'mower', block: 'C', duration_min: 100, progress: 0, priority: 2, deadline_t: 300, status: 'assigned', tractor: 'T2', pinned_to: null },
  { id: 'J9', type: 'spray', label: 'Spray Z', implement: 'sprayer', block: 'A', duration_min: 50, progress: 1, priority: 1, deadline_t: 300, status: 'done', tractor: 'T1', pinned_to: null },
];
const cs = newControlState(T1);
const schema = controlSchema(T1, cs, JOBS);
const vals = controlValues(T1, cs, JOBS);
ok(schema.length > 60, 'schema lists many controls (' + schema.length + ')');
ok(new Set(schema.map((c) => c.id)).size === schema.length, 'control ids unique');
for (const c of schema) {
  const missing = KEYS.filter((k) => !(k in c));
  if (missing.length) ok(false, c.id + ' missing ' + missing.join(','));
  if (!TYPES.includes(c.type)) ok(false, c.id + ' bad type ' + c.type);
  if (!TABS.includes(c.tab)) ok(false, c.id + ' bad tab ' + c.tab);
  if (c.type === 'select' && !(Array.isArray(c.options) && c.options.every((o) => 'value' in o && typeof o.label === 'string'))) ok(false, c.id + ' select needs options');
  if (!(c.id in vals)) ok(false, 'values missing ' + c.id);
}
for (const tab of TABS) ok(schema.some((c) => c.tab === tab), 'tab has controls: ' + tab);
ok(Array.isArray(vals.implements) && vals.implements[0] === 'sprayer', 'implements value is an array (contract example)');
ok(schema.find((c) => c.id === 'implements').replans === true, 'implements replans');
ok(schema.find((c) => c.id === 'steer').needs_manual === true, 'steer needs manual');
ok(schema.find((c) => c.id === 'ab_line').min === 2, 'AB line map_pick asks for 2 points');
ok(!schema.find((c) => c.id === 'pin_job').options.some((o) => o.value === 'J9'), 'done jobs are not pin options');

section('validation errors in plain words');
const ctx = (over = {}) => ({ tractor: T1, cs: newControlState(T1), jobs: JOBS, scenario: null, weather: { current: { wind_mph: 5 } }, busy: false, t: 100, ...over });
let e = code(() => checkControl(ctx(), 'steer', 10));
ok(e && e.code === 'NEEDS_MANUAL' && /manual control of Tractor 1/.test(e.message), 'steer without manual -> NEEDS_MANUAL (' + (e && e.message) + ')');
e = code(() => checkControl(ctx({ tractor: { ...T1, manual: true } }), 'steer', 99));
ok(e && e.code === 'INVALID_INPUT' && /between -40 and 40 deg/.test(e.message), 'steer 99 -> INVALID_INPUT');
e = code(() => checkControl(ctx(), 'warp_drive', 1));
ok(e && e.code === 'NOT_FOUND', 'unknown control -> NOT_FOUND');
e = code(() => checkControl(ctx({ busy: true }), 'implements', ['mower']));
ok(e && e.code === 'CONFLICT', 'replans while a re-plan runs -> CONFLICT');
e = code(() => checkControl(ctx({ busy: true }), 'name', 'Big Red'));
ok(!e, 'non-replanning control while busy is fine');
e = code(() => checkControl(ctx(), 'pin_job', 'J2'));
ok(e && e.code === 'SAFETY_REJECTED' && e.message === "Can't pin Mow C to Tractor 1: it has no mower.", 'pin incompatible -> SAFETY_REJECTED with reason (' + (e && e.message) + ')');
e = code(() => checkControl(ctx({ tractor: { ...T1, manual: true }, weather: { current: { wind_mph: 14 } } }), 'section_1', true));
ok(e && e.code === 'SAFETY_REJECTED' && e.message === "Can't spray now: wind 14 mph, limit 10 mph.", 'section on in wind -> SAFETY_REJECTED');
e = code(() => checkControl(ctx({ tractor: { ...T1, manual: true, status: 'broken' } }), 'steer', 1));
ok(e && e.code === 'SAFETY_REJECTED', 'driving a broken tractor -> SAFETY_REJECTED');
e = code(() => checkControl(ctx(), 'implements', []));
ok(e && e.code === 'INVALID_INPUT', 'empty implements -> INVALID_INPUT');
e = code(() => checkControl(ctx({ t: 400 }), 'off_duty_t', 300));
ok(e && e.code === 'INVALID_INPUT' && /already passed/.test(e.message), 'off duty in the past -> INVALID_INPUT');
e = code(() => checkControl(ctx({ jobs: JOBS.map((j) => (j.id === 'J1' ? { ...j, pinned_to: 'T1' } : j)) }), 'implements', ['mower']));
ok(e && e.code === 'SAFETY_REJECTED' && /pinned/.test(e.message), 'removing an implement a pinned job needs -> SAFETY_REJECTED');

section('map_pick value shape');
const SC = { grid: { width: 20, height: 14 }, geo: { origin_lat: 33.212, origin_lon: -111.62, cell_m: 40 }, blocks: [], depot: { x: 1, y: 6 }, blocked_cells: [[5, 6]] };
const one = normalizePoints({ x: 3, y: 4 }, 1, SC)[0];
ok(one.x === 3 && one.y === 4 && Math.abs(one.lat - (33.212 - 160 / 111320)) < 1e-6 && one.lon < -111.6, 'grid point gets lat/lon');
const back = normalizePoints({ lat: one.lat, lon: one.lon }, 1, SC)[0];
ok(Math.abs(back.x - 3) < 0.01 && Math.abs(back.y - 4) < 0.01, 'lat/lon point gets grid x/y');
ok(code(() => normalizePoints({ x: 50, y: 4 }, 1, SC))?.code === 'INVALID_INPUT', 'off-farm point -> INVALID_INPUT');
ok(code(() => normalizePoints([{ x: 1, y: 1 }], 2, SC))?.code === 'INVALID_INPUT', 'AB needs 2 points');
e = code(() => checkControl(ctx({ tractor: { ...T1, manual: true }, scenario: SC }), 'drive_to', { x: 5, y: 6 }));
ok(e && e.code === 'SAFETY_REJECTED' && /blocked/.test(e.message), 'drive to a blocked road -> SAFETY_REJECTED');

section('applyControl: state + effect, never the world');
{
  const s = newControlState(T1); const tr = { ...T1, manual: true };
  const before = JSON.stringify(tr);
  let r = applyControl(s, tr, JOBS, schema.find((c) => c.id === 'speed_up'), null);
  ok(s.speed_mph === 0.5 && r.effect.kind === 'drive', 'speed up +0.5 mph');
  r = applyControl(s, tr, JOBS, schema.find((c) => c.id === 'steer'), 12);
  ok(r.old === 0 && r.new === 12 && r.replans === false, 'steer old/new for operator_action log');
  const ab = checkControl(ctx({ tractor: tr, scenario: SC }), 'ab_line', [{ x: 2, y: 2 }, { x: 8, y: 2 }]);
  r = applyControl(s, tr, JOBS, ab.control, ab.value);
  ok(r.effect.kind === 'ab' && r.effect.points.length === 2 && s.ab_select === 'AB1', 'AB line saved and selected');
  r = applyControl(s, tr, JOBS, schema.find((c) => c.id === 'ab_swap'), null);
  ok(s.lines[0].a.x === 8, 'swap A/B');
  r = applyControl(s, tr, JOBS, schema.find((c) => c.id === 'implements'), ['mower']);
  ok(r.effect.kind === 'tractor' && r.effect.patch.implements[0] === 'mower' && r.replans, 'implements effect, replans');
  ok(JSON.stringify(tr) === before, 'applyControl never mutates the tractor');
  const nsec = schema.find((c) => c.id === 'num_sections');
  applyControl(s, tr, JOBS, nsec, 8);
  ok(controlSchema(tr, s, JOBS).filter((c) => /^section_\d+$/.test(c.id)).length === 8, 'section toggles follow num_sections');
}

section('manual kinematics');
{
  const s = newControlState(T1); s.speed_mph = 8; s.steer = 0;
  const p = stepManual({ x: 5, y: 5, heading_deg: 90 }, s, 2);
  ok(Math.abs(p.x - 6) < 1e-6 && Math.abs(p.y - 5) < 1e-6, 'straight east 1 cell in 2 min at 8 mph');
  s.steer = 20; const q = stepManual({ x: 5, y: 5, heading_deg: 90 }, s, 1);
  ok(q.heading_deg > 90, 'steer right turns clockwise');
  s.steer = 0; s.dir = -1; const rv = stepManual({ x: 5, y: 5, heading_deg: 90 }, s, 2);
  ok(rv.x < 5, 'reverse backs up');
}

// ---------------------------------------------------------------- wired into mockSource
section('mockSource endpoints (§5 rows 13-16, §13.2)');
const src = createMockSource({ realtime: false });
const msgs = [];
src.connect({ onMessage: (m) => msgs.push(m) });
const tick = (n = 1) => { for (let i = 0; i < n; i++) src.tick(); };
const api = src.api;
const isOp = (x) => x && typeof x.id === 'string' && /^O\d+$/.test(x.id) && 'kind' in x;
const opDone = (op) => { tick(2); return src.debug.snapshot().operations.find((o) => o.id === op.id); };
const EX = JSON.parse(readFileSync(join(HERE, '..', '..', '..', 'contract', 'examples', 'rest.get_controls.json'), 'utf8'));

for (const id of ['T1', 'T2', 'T3']) {
  const g = await api.getControls(id);
  ok(Array.isArray(g.controls) && g.values && typeof g.values === 'object', id + ': GET controls body');
  const ex = EX.controls[0]; const steer = g.controls.find((c) => c.id === 'steer');
  ok(Object.keys(ex).every((k) => k in steer), id + ': steer has every example key');
}
ok((await acode(api.getControls('T99')))?.code === 'NOT_FOUND', 'unknown tractor -> NOT_FOUND');
ok((await acode(api.control('T1', { control: 'steer', value: 5 })))?.code === 'NEEDS_MANUAL', 'steer before manual -> NEEDS_MANUAL');

// preview never applies
{
  const w0 = JSON.stringify(src.debug.snapshot().fleet) + JSON.stringify(src.debug.snapshot().jobs) + JSON.stringify(src.debug.snapshot().plan);
  const pv = await api.preview('T2', { control: 'implements', value: ['hedger'] });
  ok(pv.allowed === true && pv.plan && pv.explanation && typeof pv.metrics_delta.travel_min === 'number' && 'late_jobs' in pv.metrics_delta, 'preview: allowed + plan + explanation + metrics_delta');
  ok(/Switching Tractor 2 to a hedger/.test(pv.explanation.text), 'preview text: ' + pv.explanation.text);
  ok(pv.explanation.facts.unassigned.some((u) => u.job === 'J2') && /Mow C/.test(pv.explanation.text), 'preview: dropping the only mower leaves Mow C without a tractor');
  const w1 = JSON.stringify(src.debug.snapshot().fleet) + JSON.stringify(src.debug.snapshot().jobs) + JSON.stringify(src.debug.snapshot().plan);
  ok(w0 === w1, 'preview applies nothing (fleet/jobs/plan unchanged)');
  const bad = await api.preview('T1', { control: 'pin_job', value: 'J2' });
  ok(bad.allowed === false && /no mower/.test(bad.refused_reason) && bad.plan === null, 'preview refusal -> allowed:false with reason');
  ok((await acode(api.preview('T1', { control: 'max_speed', value: 99 })))?.code === 'INVALID_INPUT', 'preview bad value -> INVALID_INPUT');
}

// replans:true -> 202 Operation; applies atomically with the re-plan
{
  const v0 = src.debug.snapshot().plan.version;
  const pv = await api.preview('T2', { control: 'implements', value: ['mower', 'hedger', 'bin_trailer'] });
  const op = await api.control('T2', { control: 'implements', value: ['mower', 'hedger', 'bin_trailer'] });
  ok(isOp(op) && op.status === 'queued' && op.source === 'control', 'implements -> 202 Operation (queued, source control)');
  ok((await acode(api.control('T1', { control: 'max_speed', value: 10 })))?.code === 'CONFLICT', 'second replanning control while queued -> CONFLICT');
  const ok2 = await api.control('T1', { control: 'name', value: 'Big Blue' });
  ok(ok2 && ok2.ok === true && ok2.value === 'Big Blue' && ok2.explanation === null, 'non-replanning control while busy -> 200 {ok,value,explanation}');
  const done = opDone(op);
  const s = src.debug.snapshot();
  ok(done && done.status === 'succeeded' && done.result.applied_plan_version === s.plan.version && s.plan.version === v0 + 1, 'operation succeeded with the applied plan version');
  ok(s.fleet.find((t) => t.id === 'T2').implements.includes('bin_trailer'), 'implements applied');
  ok(s.fleet.find((t) => t.id === 'T1').name === 'Big Blue', 'name applied');
  ok(s.log_tail.some((l) => l.kind === 'operator_action' && l.control === 'implements' && l.replan === true && Array.isArray(l.new)), 'operator_action logged with old/new/replan');
  ok(s.explanations[0].trigger === 'operator_action' && /depot visit/.test(s.explanations[0].text), 'explanation: ' + s.explanations[0].text);
  ok(s.plan.entries.some((e) => e.tractor === 'T2' && e.kind === 'swap_implement'), 'plan shows the depot swap');
  // parity: preview's assignment == applied assignment (same planner)
  const pvAssign = new Map(); for (const e of pv.plan.entries) if (e.kind === 'work' && e.job) pvAssign.set(e.job, e.tractor);
  const real = new Map(); for (const j of s.jobs) if (j.tractor && j.status !== 'done') real.set(j.id, j.tractor);
  const diffs = [...real].filter(([j, t]) => pvAssign.has(j) && pvAssign.get(j) !== t);
  ok(diffs.length === 0, 'preview vs applied assignment parity (' + JSON.stringify(diffs) + ')');
}

// pin safety refusal at apply time
ok((await acode(api.control('T1', { control: 'pin_job', value: 'J2' })))?.message === "Can't pin Mow C to Big Blue: it has no mower.", 'apply pin incompatible -> SAFETY_REJECTED');

// manual mode
{
  const m = await api.manual('T1', true);
  ok(isOp(m) && m.source === 'manual', 'manual on -> 202 Operation');
  opDone(m);
  let s = src.debug.snapshot();
  const t1 = s.fleet.find((t) => t.id === 'T1');
  ok(t1.manual === true && t1.queue.length === 0 && t1.current_job === null, 'manual tractor leaves AI planning');
  ok(!s.plan.entries.some((e) => e.tractor === 'T1' && e.end_t > s.clock.t + 1), 'no future plan entries for the manual tractor');
  ok(s.explanations[0].text.includes('manual control'), 'manual explanation: ' + s.explanations[0].text);
  const r = await api.control('T1', { control: 'steer', value: 15 });
  ok(r.ok === true && r.value === 15, 'steer in manual -> 200');
  await api.control('T1', { control: 'speed_up', value: null });
  const x0 = t1.pose.x, y0 = t1.pose.y;
  tick(30); s = src.debug.snapshot();
  const t1b = s.fleet.find((t) => t.id === 'T1');
  ok(Math.hypot(t1b.pose.x - x0, t1b.pose.y - y0) > 0.01 && t1b.pose.speed_mph === 0.5, 'manual tractor drives (speed ' + t1b.pose.speed_mph + ')');
  await api.control('T1', { control: 'stop', value: null });
  const dt = await api.control('T1', { control: 'drive_to', value: { x: 10, y: 6 } });
  ok(dt.ok && dt.value && dt.value.x === 10 && typeof dt.value.lat === 'number', 'drive_to returns the normalised point');
  tick(400); s = src.debug.snapshot();
  const t1c = s.fleet.find((t) => t.id === 'T1');
  ok(Math.hypot(t1c.pose.x - 10, t1c.pose.y - 6) < 0.05, 'drive_to arrives (' + t1c.pose.x + ',' + t1c.pose.y + ')');
  const ab = await api.control('T1', { control: 'ab_line', value: [{ x: 6, y: 7 }, { x: 9, y: 7 }] });
  ok(ab.ok && Array.isArray(ab.value) && ab.value.length === 2, 'AB line via two map picks');
  s = src.debug.snapshot();
  ok(s.log_tail.some((l) => l.kind === 'agopenweb' && l.tractor === 'T1' && Array.isArray(l.detail.ab) && l.detail.ab.length === 4), 'AB line announced for both views (log agopenweb detail.ab)');
  const g = await api.getControls('T1');
  ok(g.values.steer === 0 || g.values.steer === 15, 'values read back');
  ok(g.values.ab_select === 'AB1' && g.values.ab_line.length === 2, 'active AB line in values');
  // autosteer follows the AB line (y = 7 from x 6 -> 9), U-turns onto the next pass, paints coverage
  {
    const v = (await api.getControls('T1')).values;
    ok(v.autosteer === true, 'new AB line turns autosteer on');
    let tt, seenWorking = false;
    for (let i = 0; i < 400 && !seenWorking; i++) { tick(1); tt = src.debug.snapshot().fleet.find((t) => t.id === 'T1'); seenWorking = tt.status === 'working'; }
    ok(seenWorking && tt.pose.speed_mph > 0 && Math.abs(tt.pose.y - 7) < 0.45, 'guided tractor joins and drives the line or its next pass (status ' + tt.status + ', y ' + tt.pose.y + ')');
    let maxOff = 0; const ys = [];
    for (let i = 0; i < 60; i++) { tick(5); tt = src.debug.snapshot().fleet.find((t) => t.id === 'T1'); ys.push(tt.pose.y); if (tt.pose.x > 6.3 && tt.pose.x < 8.7) maxOff = Math.max(maxOff, Math.abs(tt.pose.y - 7)); }
    ok(Math.min(...ys.slice(-20)) < 7 - 0.1 || Math.max(...ys.slice(-20)) > 7 + 0.1 || maxOff < 1.2, 'stays near the line / moves to next pass (maxOff ' + maxOff.toFixed(2) + ')');
    const cs = (await api.getControls('T1')).values;
    ok(cs.ab_select === 'AB1', 'line still active');
    await api.control('T1', { control: 'autosteer', value: false });
  }
  const off = await api.manual('T1', false);
  opDone(off); s = src.debug.snapshot();
  ok(s.fleet.find((t) => t.id === 'T1').manual === false && s.explanations[0].text.includes('back under AI control'), 'hand back -> re-planned: ' + s.explanations[0].text);
}

// availability + ban + refuel go through the same planner
{
  const t = src.debug.snapshot().clock.t;
  const pv = await api.preview('T3', { control: 'off_duty_t', value: Math.ceil((t + 30) / 60) * 60 + 0 > 660 ? 660 : [300, 360, 420, 480, 540, 600, 660].find((x) => x > t + 20) });
  ok(pv.allowed && /off duty/.test(pv.explanation.text), 'off-duty preview: ' + pv.explanation.text);
  const pb = await api.preview('T3', { control: 'ban_type', value: 'haul_bins' });
  ok(pb.allowed && !pb.plan.entries.some((e) => e.tractor === 'T3' && e.kind === 'work' && /^J(3|9)$/.test(e.job) && e.start_t > t + 1), 'ban preview keeps hauling off T3');
  const rf = await api.control('T3', { control: 'refuel', value: null });
  opDone(rf);
  const s = src.debug.snapshot();
  ok(s.plan.entries.some((e) => e.tractor === 'T3' && e.kind === 'refuel'), 'refuel shows in the plan');
  tick(600);
  ok(src.debug.snapshot().fleet.find((x) => x.id === 'T3').fuel_pct >= 99 || src.debug.snapshot().log_tail.some((l) => l.kind === 'refueled'), 'refuel completes');
}


section('preview == apply mid-morning, sprayer change (same planner, routes and spray windows)');
{
  const s2 = createMockSource({ realtime: false });
  s2.connect({ onMessage: () => {} });
  for (let i = 0; i < 1000; i++) s2.tick(); // ~2 h into the day
  const t = s2.debug.snapshot().clock.t;
  for (const [tid, control, value] of [['T3', 'implements', ['sprayer']], ['T1', 'max_speed', 6], ['T3', 'refuel', null]]) {
    const pv = await s2.api.preview(tid, { control, value });
    const op = await s2.api.control(tid, { control, value });
    s2.tick(); s2.tick();
    const s = s2.debug.snapshot();
    const done = s.operations.find((o) => o.id === op.id);
    ok(done && done.status === 'succeeded', `${tid} ${control}: applied at t=${Math.round(t)}`);
    const pa = new Map(); for (const e of pv.plan.entries) if (e.kind === 'work' && e.job) pa.set(e.job, e.tractor);
    const real = new Map(); for (const j of s.jobs) if (j.tractor && j.status !== 'done') real.set(j.id, j.tractor);
    const diffs = [...real].filter(([j, tr]) => pa.get(j) !== tr).concat([...pa].filter(([j]) => !real.has(j)));
    ok(diffs.length === 0, `${tid} ${control}: preview assignment == applied (${JSON.stringify(diffs)})`);
    const late = (s.explanations[0].facts.deadlines_missed || []).slice().sort().join();
    ok(late === (pv.explanation.facts.deadlines_missed || []).slice().sort().join(), `${tid} ${control}: preview late jobs == applied (${late} vs ${pv.explanation.facts.deadlines_missed})`);
  }
  s2.stop();
}

section('manual: always 202, idempotent retry');
{
  const s3 = createMockSource({ realtime: false });
  s3.connect({ onMessage: () => {} });
  const a = await s3.api.control('T2', { control: 'implements', value: ['mower'] }); // re-plan queued -> busy
  const m1 = await s3.api.manual('T2', true, { idempotencyKey: 'k-1' });
  const m2 = await s3.api.manual('T2', true, { idempotencyKey: 'k-1' });
  ok(isOp(a) && isOp(m1) && m1.status === 'queued', 'manual while a re-plan is queued -> 202 queued (not 409)');
  ok(m2.id === m1.id, 'same Idempotency-Key -> same Operation');
  s3.tick(); s3.tick();
  ok(s3.debug.snapshot().fleet.find((t) => t.id === 'T2').manual === true, 'queued manual applied after the re-plan');
  s3.stop();
}

section('preview respects excluded blocks (block_disabled)');
{
  const s4 = createMockSource({ realtime: false });
  s4.connect({ onMessage: () => {} });
  await s4.api.postEvent({ type: 'block_disabled', block: 'C', reason: 'test' });
  s4.tick(); s4.tick();
  const snap = s4.debug.snapshot();
  ok(snap.scenario.disabled_blocks.some((d) => d.block === 'C'), 'scenario lists C as excluded');
  const pv = await s4.api.preview('T2', { control: 'implements', value: ['mower', 'hedger'] });
  const onC = (pv.plan?.entries || []).filter((e) => e.kind === 'work' && snap.jobs.find((j) => j.id === e.job)?.block === 'C');
  ok(pv.allowed && onC.length === 0, `preview plans no work on excluded Block C (${onC.map((e) => e.job)})`);
  const pin = await s4.api.preview('T2', { control: 'pin_job', value: 'J2' }); // Mow C
  ok(!(pin.plan?.entries || []).some((e) => e.kind === 'work' && e.job === 'J2'), 'pinning a job on an excluded block still leaves it unplanned');
  s4.stop();
}

src.stop();
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.error(failures + ' FAILED'); process.exit(1); }

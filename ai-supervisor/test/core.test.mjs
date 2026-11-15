// AI core against the in-process mock backend: validation, capabilities, preview, approve -> Operation -> applied,
// the block_disabled flow end to end, dismiss memory, and the rules reviewer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockSource } from '../../dashboard/src/data/mockSource.js';
import { createStore } from '../../dashboard/src/data/store.js';
import { createAiCore } from '../../dashboard/src/data/aiCore.js';
import { resolveAction, aiCapsFrom } from '../../dashboard/src/data/aiActions.js';
import { ALL_ON, detectCapabilities } from '../../dashboard/src/data/capabilities.js';
import { rulesReview } from '../../dashboard/src/data/aiRules.js';
import { compactFacts, planPrompt } from '../reviewers.mjs';

function setup(caps = { patch_job: true, controls: true, preview: true, events: true, block_disabled: true }) {
  const src = createMockSource({ realtime: false, pace: 9.6 });
  const store = createStore({ source: 'mock' });
  src.connect({ onMessage: (m) => store.apply(m) });
  const mutate = (method, path, body, key) => {
    const o = { idempotencyKey: key }; let m;
    if (method === 'PATCH' && (m = /^\/jobs\/([^/]+)$/.exec(path))) return src.api.patchJob(m[1], body, o);
    if (method === 'POST' && (m = /^\/tractors\/([^/]+)\/control$/.exec(path))) return src.api.control(m[1], body, o);
    if (method === 'POST' && path === '/events') return src.api.postEvent(body, o);
    return Promise.reject({ code: 'NOT_IMPLEMENTED', status: 501, message: 'no' });
  };
  const core = createAiCore({ getState: () => store.get(), caps, call: { preview: (t, b) => src.api.preview(t, b), mutate } });
  store.subscribe((s, msg) => { if (msg.type === 'operation') core.onOperation(msg.data); });
  const tick = (n = 3) => { for (let i = 0; i < n; i++) src.tick(); };
  return { src, store, core, tick };
}

test('resolveAction validates ids and builds contract requests', () => {
  const { store } = setup();
  const s = store.get();
  assert.deepEqual(resolveAction({ kind: 'patch_priority', job: 'J5', priority: 3 }, s).request, { method: 'PATCH', path: '/jobs/J5', body: { priority: 3 } });
  assert.equal(resolveAction({ kind: 'patch_priority', job: 'J99', priority: 3 }, s).ok, false);
  assert.equal(resolveAction({ kind: 'pin_job', job: 'J1', tractor: 'T2' }, s).ok, false, 'T2 has no sprayer');
  assert.deepEqual(resolveAction({ kind: 'pin_job', job: 'J1', tractor: 'T3' }, s).preview, { tractor: 'T3', body: { control: 'pin_job', value: 'J1' } });
  assert.deepEqual(resolveAction({ kind: 'set_implements', tractor: 'T1', implements: ['sprayer', 'mower'] }, s).request.body, { control: 'implements', value: ['sprayer', 'mower'] });
  assert.equal(resolveAction({ kind: 'off_duty', tractor: 'T1', value: 333 }, s).ok, false);
  assert.deepEqual(resolveAction({ kind: 'disable_block', block: 'A', value: 'houses' }, s).request, { method: 'POST', path: '/events', body: { type: 'block_disabled', block: 'A', reason: 'houses', proposed_by: 'ai_supervisor' } });
});

test('capabilities: unsupported actions become advice, invalid proposals are dropped', () => {
  const { core } = setup({ patch_job: true, controls: false, preview: false, events: true, block_disabled: false });
  const r = core.ingest('plots', [
    { severity: 'high', title: 'Block A is houses', why: 'roofs', action: { kind: 'disable_block', block: 'A' } },
    { severity: 'low', title: 'bogus', why: 'x', action: { kind: 'patch_priority', job: 'J404', priority: 3 } },
  ]);
  assert.equal(r.added, 1); assert.equal(r.dropped.length, 1);
  const f = core.findings()[0];
  assert.equal(f.advisory, true); assert.equal(f.advisory_reason, 'Not supported by this backend');
  return core.approve(f.id).then(() => assert.fail('should refuse'), (e) => assert.equal(e.code, 'CONFLICT'));
  // (FastAPI without /preview, controls or events -> only PATCH /api/jobs proposals are actionable)
});

test('AI capabilities follow the dashboard capability detection (FastAPI: only job edits are actionable)', async () => {
  assert.deepEqual(aiCapsFrom(ALL_ON), { patch_job: true, controls: true, preview: true, events: true, block_disabled: true, metrics_measured: true, weather_enforced: true, source: 'mock' });
  const request = async (method, path) => { if (/^\/(why|tractors|mechanics|capabilities|bridge)/.test(path)) throw { status: 501, code: 'NOT_IMPLEMENTED', details: {} }; return {}; };
  const fast = await detectCapabilities({ root: 'http://x', request, fetchJson: async () => ({ paths: { '/api/jobs/{job_id}': { patch: {} } } }), state: { jobs: [{ id: 'J1' }], fleet: [{ id: 'T1' }] } });
  assert.deepEqual(aiCapsFrom(fast), { patch_job: true, controls: false, preview: false, events: true, block_disabled: false, metrics_measured: true, weather_enforced: false, source: 'fastapi' });
  const bridge = await detectCapabilities({ root: 'http://x', request: async (m, p) => (p === '/bridge' ? { mode: 'full' } : {}), fetchJson: async () => { throw new Error('404'); }, state: {} });
  const bc = aiCapsFrom(bridge);
  assert.equal(bc.patch_job, false); assert.equal(bc.block_disabled, false); assert.equal(bc.metrics_measured, false);
});

test('new farm day: reset forgets decided proposals so they can be raised again', async () => {
  const { core, tick, src } = setup();
  const raw = { severity: 'high', title: 'Block A is houses, not orchard', why: 'roofs', action: { kind: 'disable_block', block: 'A', value: 'houses' } };
  core.ingest('plots', [raw]);
  await core.approve(core.findings()[0].id); tick();
  assert.equal(core.ingest('plots', [raw]).added, 0, 'decided: not re-raised the same day');
  await src.api.run('ours'); tick(); // new day: the mock clears excluded blocks
  core.reset();
  assert.equal(core.ingest('plots', [raw]).added, 1, 'raised again after a new day');
  assert.equal(core.history()[0].status, 'applied', 'history log kept');
});

test('facts drop placeholder metrics and unenforced weather', () => {
  const { store } = setup();
  const full = compactFacts(store.get(), {});
  assert.ok(full.metrics && full.weather);
  const bridge = compactFacts(store.get(), { metrics_measured: false, weather_enforced: false });
  assert.equal(bridge.metrics, null); assert.equal(bridge.weather, null);
});

test('block_disabled end to end: propose -> approve -> Operation -> applied, jobs pending, history says who decided', async () => {
  const { core, store, tick } = setup();
  core.ingest('plots', [{ severity: 'high', title: 'Block A is houses, not orchard', why: 'roofs and pools', action: { kind: 'disable_block', block: 'A', value: 'Aerial photo shows houses' } }]);
  await core.refreshPreviews();
  const f = core.findings()[0];
  assert.equal(f.status, 'open'); assert.equal(f.preview_status, 'unavailable', 'no preview endpoint for events: says so, invents nothing');
  const out = await core.approve(f.id);
  assert.equal(out.operation.status, 'queued'); assert.equal(core.findings()[0].status, 'applying');
  tick();
  assert.equal(core.findings().length, 0, 'applied findings leave the open list');
  const h = core.history()[0];
  assert.equal(h.status, 'applied');
  assert.match(h.outcome, /^AI Supervisor proposed, operator approved, Safety check passed · plan v\d+\.$/);
  const s = store.get();
  assert.deepEqual(s.scenario.disabled_blocks.map((d) => d.block), ['A']);
  assert.ok(s.jobs.filter((j) => j.block === 'A' && j.status !== 'done').every((j) => j.status === 'pending' && /excluded/.test(j.unassigned_reason)));
  // the same proposal is not raised again
  assert.equal(core.ingest('plots', [{ severity: 'high', title: 'Block A is houses, not orchard', why: 'again', action: { kind: 'disable_block', block: 'A', value: 'Aerial photo shows houses' } }]).added, 0);
});

test('re-planning control: preview attached before approve; refused preview blocks approval', async () => {
  const { core, tick } = setup();
  core.ingest('implements', [{ severity: 'high', title: 'Mower needed', why: 'x', action: { kind: 'set_implements', tractor: 'T1', implements: ['sprayer', 'mower'] } }]);
  await core.refreshPreviews();
  const f = core.findings()[0];
  assert.equal(f.preview_status, 'ready'); assert.equal(f.preview.allowed, true);
  assert.ok(Array.isArray(f.preview.moved) && Array.isArray(f.preview.deadlines_missed));
  const out = await core.approve(f.id);
  assert.equal(out.operation.source, 'control');
  tick();
  assert.equal(core.history()[0].status, 'applied');
});

test('failed operation (Safety rejects) is reported as such', async () => {
  const { core, src, tick } = setup();
  core.ingest('plan', [{ severity: 'medium', title: 'Raise Mow F', why: 'late', action: { kind: 'patch_priority', job: 'J5', priority: 3 } }]);
  src.debug.failNext();
  const f = core.findings()[0];
  await core.approve(f.id);
  tick();
  const g = core.findings()[0];
  assert.equal(g.status, 'failed'); assert.match(g.error, /^Safety check rejected it/);
  assert.equal(core.history()[0].status, 'failed');
});

test('dismiss remembers the proposal; stale proposals are refused at approve', async () => {
  const { core } = setup();
  core.ingest('plan', [{ severity: 'low', title: 'Raise Mow B', why: 'x', action: { kind: 'patch_priority', job: 'J10', priority: 2 } }]);
  core.dismiss(core.findings()[0].id);
  assert.equal(core.findings().length, 0); assert.equal(core.history()[0].status, 'dismissed');
  assert.equal(core.ingest('plan', [{ severity: 'low', title: 'Raise Mow B', why: 'x', action: { kind: 'patch_priority', job: 'J10', priority: 2 } }]).added, 0);
});

test('rules reviewer proposes an implement swap when no working tractor carries a mower', async () => {
  const { src, store, tick } = setup();
  tick(20);
  await src.api.postEvent({ type: 'breakdown', tractor: 'T2' }); tick();
  const r = rulesReview(store.get());
  const mow = r.implements.find((f) => /mower/.test(f.title));
  assert.ok(mow, 'mower finding'); assert.equal(mow.action.kind, 'set_implements'); assert.ok(mow.action.implements.includes('mower'));
  assert.equal(r.plots.length, 0, 'rules never invent plot findings (no imagery)');
});

test('compact facts are small and numbers-first (never a raw dump)', () => {
  const { store } = setup();
  const facts = compactFacts(store.get());
  const p = planPrompt(facts, { patch_priority: true, pin_job: true, ban_type: false, off_duty: false });
  assert.ok(JSON.stringify(facts).length < 6000, 'facts stay compact');
  assert.ok(!('entries' in facts) && facts.tractors.length === 3 && facts.open_jobs.length === 11);
  assert.deepEqual(p.schema.properties.findings.items.properties.action.properties.kind.enum, ['patch_priority', 'pin_job', 'none'], 'only supported kinds offered');
});

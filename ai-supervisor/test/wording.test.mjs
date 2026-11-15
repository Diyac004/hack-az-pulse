// Explanation wording: validator (numbers / ids / times / claims preserved, nothing added) and the queue with a
// mocked provider. No model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWording, factTokens, wordingPrompt, createWorder, unwrap, WORDING_SCHEMA } from '../wording.mjs';

const ORIG = 'Tractor 1 broke down 60% of the way through spraying Block E. Tractor 3 has the only other sprayer and 81% fuel, so it finishes the remaining 40% right after its current job. All deadlines are still met.';
const NAMES = ['Tractor 1', 'Tractor 3', 'Block E', 'Haul bins C', 'Spray E'];

test('factTokens finds names, times and numbers', () => {
  const t = factTokens('Haul bins C goes first on Tractor 3 at 10:40 AM, 2 jobs late by 12.5 min.', NAMES);
  assert.deepEqual(t.ids, ['Haul bins C', 'Tractor 3']);
  assert.deepEqual(t.times, ['10:40AM']);
  assert.deepEqual(t.nums, ['12.5', '2']);
});

test('accepts a faithful rewrite', () => {
  const r = 'Tractor 1 broke down after spraying 60% of Block E. Tractor 3, the only other sprayer with 81% fuel, will finish the remaining 40% after its current job. All deadlines are still met.';
  assert.deepEqual(validateWording(ORIG, r, { names: NAMES }), { ok: true, text: r });
});

test('rejects a changed number', () => {
  const r = 'Tractor 1 broke down 50% of the way through spraying Block E. Tractor 3 has the only other sprayer and 81% fuel, so it finishes the remaining 40% after its job. All deadlines are still met.';
  const v = validateWording(ORIG, r, { names: NAMES });
  assert.equal(v.ok, false); assert.match(v.reason, /60%/);
});

test('rejects a changed tractor or block', () => {
  const r = 'Tractor 2 broke down 60% of the way through spraying Block E. Tractor 3 has the only other sprayer and 81% fuel, so it finishes the remaining 40%. All deadlines are still met.';
  assert.equal(validateWording(ORIG, r, { names: NAMES }).ok, false);
  const r2 = ORIG.replace('Block E', 'Block F');
  assert.equal(validateWording(ORIG, r2, { names: NAMES }).ok, false);
});

test('rejects added numbers, times and names', () => {
  assert.match(validateWording(ORIG, ORIG.replace('All deadlines are still met.', 'All deadlines are still met by 4:00 PM.'), { names: NAMES }).reason, /added time/);
  assert.match(validateWording(ORIG, ORIG.replace('its current job', 'its current job in 15 min'), { names: NAMES }).reason, /added number/);
  assert.match(validateWording(ORIG, ORIG.replace('its current job', 'Spray E'), { names: NAMES }).reason, /added name/);
});

test('rejects changed claims, extra sentences, markdown and empty answers', () => {
  assert.match(validateWording(ORIG, ORIG.replace('All deadlines are still met.', 'Two jobs will be late.'), { names: NAMES }).reason, /claim "late"/);
  const late = 'Mow F finishes 521 min late. Raising its priority would help.';
  assert.match(validateWording(late, 'Mow F finishes on time with 521 min to spare. Raising its priority would help.', { names: ['Mow F'] }).reason, /claim "late"/);
  assert.match(validateWording(ORIG, 'A. B. C. D.', { names: NAMES }).reason, /3 sentences/);
  assert.match(validateWording(ORIG, '**' + ORIG + '**', { names: NAMES }).reason, /plain text/);
  assert.equal(validateWording(ORIG, '', { names: NAMES }).ok, false);
  assert.equal(validateWording(ORIG, null, { names: NAMES }).ok, false);
});

test('prompt carries only template + facts, schema is strict', () => {
  const p = wordingPrompt({ id: 'X1', text: ORIG, trigger: 'breakdown', facts: { moved: [{ job: 'J1' }] }, extra: 'state dump' });
  const body = JSON.parse(p.user.slice(p.user.indexOf('{')));
  assert.deepEqual(Object.keys(body).sort(), ['facts', 'template', 'trigger']);
  assert.equal(p.schema, WORDING_SCHEMA);
  assert.equal(WORDING_SCHEMA.additionalProperties, false);
});

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('worder: valid answer is kept, cached by id (one call per explanation)', async () => {
  let calls = 0;
  const w = createWorder({ model: 'm', provider: 'p', names: () => NAMES, debounceMs: 0,
    complete: async () => { calls++; return { text: 'Tractor 1 broke down after spraying 60% of Block E. Tractor 3, the only other sprayer with 81% fuel, finishes the remaining 40% after its current job. All deadlines are still met.' }; } });
  w.enqueue({ id: 'X1', text: ORIG }); w.enqueue({ id: 'X1', text: ORIG });
  await tick(20);
  assert.equal(calls, 1);
  const e = w.get('X1');
  assert.equal(e.status, 'ok'); assert.equal(e.original, ORIG); assert.match(e.text, /after spraying 60%/); assert.equal(e.model, 'm');
});

test('worder: invalid answer is discarded (template stays), errors too', async () => {
  const w = createWorder({ model: 'm', provider: 'p', names: () => NAMES, debounceMs: 0, complete: async () => ({ text: ORIG.replace('81%', '90%') }) });
  w.enqueue({ id: 'X2', text: ORIG }); await tick(20);
  assert.equal(w.get('X2').status, 'rejected'); assert.equal(w.get('X2').text, null);
  const w2 = createWorder({ model: 'm', provider: 'p', debounceMs: 0, complete: async () => { throw new Error('agy timed out'); } });
  w2.enqueue({ id: 'X3', text: ORIG }); await tick(20);
  assert.equal(w2.get('X3').status, 'error'); assert.equal(w2.get('X3').text, null);
});

test('worder: newest first, old backlog skipped; rules (no complete) does nothing', async () => {
  const seen = [];
  const w = createWorder({ model: 'm', provider: 'p', debounceMs: 0, backlog: 1, complete: async (req) => { seen.push(JSON.parse(req.user.slice(req.user.indexOf('{'))).template); return { text: 'x' }; } });
  w.enqueue({ id: 'A', text: 'one' }); w.enqueue({ id: 'B', text: 'two' }); w.enqueue({ id: 'C', text: 'three' });
  await tick(20);
  assert.deepEqual(seen, ['three']);
  assert.equal(w.get('A').status, 'skipped'); assert.equal(w.get('B').status, 'skipped');
  const r = createWorder({ model: 'rules', provider: 'rules', complete: null });
  r.enqueue({ id: 'X', text: ORIG });
  assert.equal(r.get('X'), null); assert.deepEqual(r.all(), {});
});

test('unwrap: a JSON answer nested in text (agy) is unwrapped once', () => {
  assert.deepEqual(unwrap({ text: '{"text": "Plan ready."}' }), { text: 'Plan ready.' });
  assert.deepEqual(unwrap({ text: 'Plan ready.' }), { text: 'Plan ready.' });
  assert.deepEqual(unwrap({ text: '{not json}' }), { text: '{not json}' });
});

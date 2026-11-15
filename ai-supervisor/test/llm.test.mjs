// LLM adapter: agy command build/parse, retry on bad JSON, OpenAI + Anthropic request shapes (mocked, no keys).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { buildAgyArgs, buildAgyPrompt, parseAgyOutput, extractJson, validate, createLLM, buildOpenAIRequest, parseOpenAIResponse, buildAnthropicRequest, parseAnthropicResponse, DEFAULTS } from '../llm.mjs';

const SCHEMA = { type: 'object', additionalProperties: false, required: ['answer', 'n'], properties: { answer: { type: 'string' }, n: { type: 'integer' } } };

test('agy argv: print mode, model, json output, schema file, skip permissions, timeout, add-dir', () => {
  const a = buildAgyArgs({ prompt: 'hi "there"', model: 'claude-sonnet-5-5-low', schemaPath: '/tmp/x/s.json', dir: '/tmp/x', timeoutS: 90 });
  assert.deepEqual(a, ['-p', 'hi "there"', '--model', 'claude-sonnet-5-5-low', '--output-format', 'json', '--json-schema', '/tmp/x/s.json', '--dangerously-skip-permissions', '--print-timeout', '90s', '--add-dir', '/tmp/x']);
  assert.ok(!a.includes('--mode'), 'no --mode (not available on this account)');
});

test('agy prompt lists image files to open', () => {
  const p = buildAgyPrompt({ system: 'SYS', user: 'USER', imagePaths: [{ path: '/tmp/a/A.png', label: 'Block A' }] });
  assert.match(p, /^SYS\n\nUSER/);
  assert.match(p, /Block A: \/tmp\/a\/A\.png/);
  assert.match(p, /JSON object/);
});

test('agy output: structured_output wins; fenced response text as fallback; failure status throws', () => {
  assert.deepEqual(parseAgyOutput(JSON.stringify({ status: 'SUCCESS', response: 'ignored', structured_output: { answer: 'Paris', n: 5 } })), { answer: 'Paris', n: 5 });
  assert.deepEqual(parseAgyOutput(JSON.stringify({ status: 'SUCCESS', response: 'Here:\n```json\n{"answer":"x","n":1}\n```' })), { answer: 'x', n: 1 });
  assert.deepEqual(parseAgyOutput('log line\n' + JSON.stringify({ status: 'SUCCESS', structured_output: { answer: 'y', n: 2 } })), { answer: 'y', n: 2 });
  assert.throws(() => parseAgyOutput(JSON.stringify({ status: 'ERROR', response: 'quota' })), /agy status ERROR/);
  assert.throws(() => parseAgyOutput('not json at all'), /no JSON|not JSON/);
});

test('extractJson finds the last balanced object; validate checks the schema', () => {
  assert.deepEqual(extractJson('blah {"a":1} more {"b":{"c":"}"}} end'), { b: { c: '}' } });
  assert.deepEqual(validate(SCHEMA, { answer: 'a', n: 1 }), []);
  assert.ok(validate(SCHEMA, { answer: 'a' }).some((e) => /n: missing/.test(e)));
  assert.ok(validate(SCHEMA, { answer: 'a', n: 1.5 }).some((e) => /expected integer/.test(e)));
  assert.ok(validate(SCHEMA, { answer: 'a', n: 1, extra: 1 }).some((e) => /not allowed/.test(e)));
  assert.deepEqual(validate({ type: ['string', 'null'], enum: ['x', null] }, null), []);
});

function fakeSpawn(outputs, calls) {
  return (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const schemaPath = args[args.indexOf('--json-schema') + 1];
    calls.at(-1).schemaOnDisk = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const imgs = [...args[1].matchAll(/: (\/\S+\.png)/g)].map((m) => m[1]);
    calls.at(-1).imagesOnDisk = imgs.map((p) => fs.existsSync(p));
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    const out = outputs.shift();
    setImmediate(() => { child.stdout.emit('data', out); child.emit('close', 0); });
    return child;
  };
}

test('agy provider: temp dir cwd, schema + images written, bad JSON retried once', async () => {
  const calls = [];
  const llm = createLLM({ provider: 'agy', model: 'm1', spawnFn: fakeSpawn([JSON.stringify({ status: 'SUCCESS', response: 'sorry, no json' }), JSON.stringify({ status: 'SUCCESS', structured_output: { answer: 'ok', n: 3 } })], calls) });
  assert.equal(llm.provider, 'agy'); assert.equal(llm.model, 'm1');
  const out = await llm.complete({ system: 's', user: 'u', schema: SCHEMA, images: [{ name: 'A.png', data: Buffer.from([1, 2, 3]), label: 'Block A' }] });
  assert.deepEqual(out, { answer: 'ok', n: 3 });
  assert.equal(calls.length, 2, 'one retry');
  assert.match(calls[1].args[1], /previous answer was not valid JSON/);
  assert.deepEqual(calls[0].schemaOnDisk, SCHEMA);
  assert.deepEqual(calls[0].imagesOnDisk, [true]);
  assert.ok(calls[0].opts.cwd.includes('ai-supervisor-'), 'runs in its private temp dir, not the repo');
  assert.ok(!fs.existsSync(calls[0].opts.cwd), 'temp dir removed afterwards');
});

test('agy provider: schema mismatch twice -> throws', async () => {
  const bad = JSON.stringify({ status: 'SUCCESS', structured_output: { answer: 1 } });
  const llm = createLLM({ provider: 'agy', model: 'm', spawnFn: fakeSpawn([bad, bad], []) });
  await assert.rejects(llm.complete({ user: 'u', schema: SCHEMA }), /does not match the schema/);
});

test('default agy model is the measured one', () => { assert.equal(DEFAULTS.agy, 'claude-sonnet-5-5-low'); });

test('OpenAI request shape: strict json_schema response_format, image data URLs, bearer key', () => {
  const r = buildOpenAIRequest({ system: 'S', user: 'U', schema: SCHEMA, name: 'plot review', model: 'gpt-5', apiKey: 'sk-test', images: [{ data: Buffer.from('png'), label: 'Block A' }] });
  assert.equal(r.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(r.headers.Authorization, 'Bearer sk-test');
  assert.equal(r.body.model, 'gpt-5');
  assert.deepEqual(r.body.messages[0], { role: 'system', content: 'S' });
  const parts = r.body.messages[1].content;
  assert.deepEqual(parts[0], { type: 'text', text: 'U' });
  assert.deepEqual(parts[1], { type: 'text', text: 'Block A' });
  assert.equal(parts[2].type, 'image_url');
  assert.equal(parts[2].image_url.url, 'data:image/png;base64,' + Buffer.from('png').toString('base64'));
  assert.deepEqual(r.body.response_format, { type: 'json_schema', json_schema: { name: 'plot_review', strict: true, schema: SCHEMA } });
  assert.deepEqual(parseOpenAIResponse({ choices: [{ message: { content: '{"answer":"a","n":2}' } }] }), { answer: 'a', n: 2 });
  assert.throws(() => parseOpenAIResponse({ choices: [{ message: { refusal: 'no' } }] }), /refused/);
});

test('OpenAI provider end-to-end with a mocked fetch (env key + model)', async () => {
  const seen = [];
  const fetchFn = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: 'z', n: 9 }) } }] }) }; };
  const llm = createLLM({ provider: 'openai', apiKey: 'sk-x', model: 'gpt-test', fetchFn });
  const out = await llm.complete({ user: 'u', schema: SCHEMA });
  assert.deepEqual(out, { answer: 'z', n: 9 });
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(JSON.parse(seen[0].init.body).model, 'gpt-test');
  const saved = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  const noKey = createLLM({ provider: 'openai', apiKey: '', fetchFn });
  await assert.rejects(noKey.complete({ user: 'u', schema: SCHEMA }), /OPENAI_API_KEY is not set/);
  if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  const err = createLLM({ provider: 'openai', apiKey: 'k', fetchFn: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) }) });
  await assert.rejects(err.complete({ user: 'u', schema: SCHEMA }), /HTTP 401: bad key/);
});

test('Anthropic request shape: output_config json_schema, base64 image blocks, version header', () => {
  const r = buildAnthropicRequest({ system: 'S', user: 'U', schema: SCHEMA, model: 'claude-opus-5-5', apiKey: 'k', images: [{ data: Buffer.from('i'), label: 'Depot' }] });
  assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(r.headers['x-api-key'], 'k'); assert.equal(r.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(r.body.output_config, { format: { type: 'json_schema', schema: SCHEMA } });
  const c = r.body.messages[0].content;
  assert.deepEqual(c[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('i').toString('base64') } });
  assert.deepEqual(c.at(-1), { type: 'text', text: 'U' });
  assert.deepEqual(parseAnthropicResponse({ content: [{ type: 'text', text: '{"answer":"b","n":4}' }] }), { answer: 'b', n: 4 });
  assert.throws(() => parseAnthropicResponse({ stop_reason: 'refusal', content: [] }), /declined/);
});

test('unknown provider is rejected', () => { assert.throws(() => createLLM({ provider: 'nope' }), /Unknown AI_PROVIDER/); });

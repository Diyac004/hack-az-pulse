// Provider-agnostic LLM adapter for the AI Supervisor.
//
//   const llm = createLLM();                       // AI_PROVIDER = agy (default) | openai | anthropic | rules
//   const out = await llm.complete({ system, user, images, schema, name });   // -> parsed, schema-checked JSON
//
// images: [{ name: 'A.png', data: Buffer, mime?: 'image/png', label?: 'Block A' }]
// schema: a JSON Schema object (strict style: every object lists `required` and additionalProperties:false).
//
// Providers
//  - agy:       shells out to the Antigravity CLI (`agy -p ... --output-format json --json-schema <file>`). Images are
//               written to a private temp dir and the prompt asks the model to open those files. AGY_MODEL, AGY_BIN.
//  - openai:    Chat Completions with response_format json_schema (strict) + image_url data URLs. OPENAI_API_KEY,
//               OPENAI_MODEL (default gpt-5), OPENAI_BASE_URL.
//  - anthropic: Messages API with output_config.format json_schema + base64 image blocks. ANTHROPIC_API_KEY,
//               ANTHROPIC_MODEL (default claude-opus-5-5), ANTHROPIC_BASE_URL.
// Keys are read from the environment only; nothing is logged or written to disk.
// Every provider: parse -> validate against the schema -> on bad JSON retry once -> else throw LLMError.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = {
  agy: 'claude-sonnet-5-5-low', // measured fastest of the vision-capable agy models we tried (see README)
  openai: 'gpt-5',
  anthropic: 'claude-opus-5-5',
};

export class LLMError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'LLMError'; this.details = details; }
}

// ---------------------------------------------------------------- JSON helpers
/** Pull a JSON value out of model text: whole string, fenced block, or the last balanced {...}. */
export function extractJson(text) {
  if (text == null) throw new LLMError('empty model response');
  if (typeof text === 'object') return text;
  const s = String(text).trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1].trim());
  for (let i = fences.length - 1; i >= 0; i--) { try { return JSON.parse(fences[i]); } catch { /* next */ } }
  // last balanced top-level object
  for (let end = s.lastIndexOf('}'); end > 0; end = s.lastIndexOf('}', end - 1)) {
    let depth = 0, inStr = false;
    for (let i = end; i >= 0; i--) {
      const c = s[i];
      if (inStr) { if (c === '"' && !(s[i - 1] === '\\')) inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '}') depth++;
      else if (c === '{' && --depth === 0) { try { return JSON.parse(s.slice(i, end + 1)); } catch { break; } }
    }
  }
  throw new LLMError('model response is not JSON', { sample: s.slice(0, 300) });
}

/** Minimal JSON-Schema check (type, required, properties, items, enum, additionalProperties:false). Returns errors[]. */
export function validate(schema, value, at = '$') {
  const errs = [];
  if (!schema || typeof schema !== 'object') return errs;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null;
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (types) {
    const t = typeOf(value);
    const ok = types.some((x) => x === t || (x === 'number' && t === 'integer'));
    if (!ok) { errs.push(`${at}: expected ${types.join('|')}, got ${t}`); return errs; }
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${at}.${k}: missing`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && schema.properties[k]) errs.push(...validate(schema.properties[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}.${k}: not allowed`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)));
  return errs;
}

function checked(schema, value) {
  const errs = validate(schema, value);
  if (errs.length) throw new LLMError('model JSON does not match the schema', { errors: errs.slice(0, 8) });
  return value;
}

// ---------------------------------------------------------------- agy
/** argv for one agy call (no shell; the prompt is a single argument). */
export function buildAgyArgs({ prompt, model, schemaPath, dir, timeoutS = 180 }) {
  const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--json-schema', schemaPath, '--dangerously-skip-permissions', '--print-timeout', `${timeoutS}s`];
  if (dir) args.push('--add-dir', dir);
  return args;
}

/** The text prompt agy gets: system + user + where the images are. */
export function buildAgyPrompt({ system, user, imagePaths = [] }) {
  let p = (system ? system.trim() + '\n\n' : '') + user.trim();
  if (imagePaths.length) {
    p += '\n\nImages: open and look at each of these image files with your file viewing tool before answering (do not modify them, do not run commands):\n';
    p += imagePaths.map((x) => `- ${x.label ? x.label + ': ' : ''}${x.path}`).join('\n');
  }
  p += '\n\nReply only with the JSON object described by the schema.';
  return p;
}

/** agy --output-format json stdout -> parsed object (structured_output first, then the response text). */
export function parseAgyOutput(stdout) {
  let env;
  try { env = JSON.parse(String(stdout).trim()); } catch {
    // some builds print log lines first: take the last JSON line
    const line = String(stdout).trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
    if (!line) throw new LLMError('agy printed no JSON', { sample: String(stdout).slice(0, 300) });
    try { env = JSON.parse(line); } catch { throw new LLMError('agy output is not JSON', { sample: line.slice(0, 300) }); }
  }
  if (env.status && env.status !== 'SUCCESS') throw new LLMError(`agy status ${env.status}`, { error: env.error ?? env.response ?? null });
  if (env.structured_output && typeof env.structured_output === 'object') return env.structured_output;
  return extractJson(env.response);
}

function runAgy({ bin, args, cwd, killMs, spawnFn = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '', err = '';
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } reject(new LLMError(`agy did not finish within ${Math.round(killMs / 1000)} s`)); }, killMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(kill); reject(new LLMError(`could not start agy (${e.code || e.message})`, { bin })); });
    child.on('close', (code) => {
      clearTimeout(kill);
      if (code !== 0 && !out.trim()) reject(new LLMError(`agy exited with code ${code}`, { stderr: err.slice(-400) }));
      else resolve(out);
    });
  });
}

function agyProvider(cfg) {
  const model = cfg.model || process.env.AGY_MODEL || DEFAULTS.agy;
  const bin = cfg.bin || process.env.AGY_BIN || 'agy';
  const timeoutS = cfg.timeoutS || 180;
  return {
    provider: 'agy', model,
    async once({ system, user, images = [], schema, name }) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-supervisor-'));
      try {
        const schemaPath = path.join(dir, `${name || 'schema'}.schema.json`);
        fs.writeFileSync(schemaPath, JSON.stringify(schema));
        const imagePaths = images.map((im, i) => {
          const p = path.join(dir, im.name || `image-${i}.png`);
          fs.writeFileSync(p, im.data);
          return { path: p, label: im.label };
        });
        const prompt = buildAgyPrompt({ system, user, imagePaths });
        // cwd = the private temp dir: the permission-skipping agent never runs inside the repo.
        const stdout = await runAgy({ bin, args: buildAgyArgs({ prompt, model, schemaPath, dir, timeoutS }), cwd: dir, killMs: (timeoutS + 20) * 1000, spawnFn: cfg.spawnFn });
        return parseAgyOutput(stdout);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

// ---------------------------------------------------------------- OpenAI
/** Chat Completions request {url, headers, body} with strict json_schema output and image inputs. */
export function buildOpenAIRequest({ system, user, images = [], schema, name = 'review', model, apiKey, baseUrl = 'https://api.openai.com/v1' }) {
  const content = [{ type: 'text', text: user }];
  for (const im of images) {
    if (im.label) content.push({ type: 'text', text: im.label });
    content.push({ type: 'image_url', image_url: { url: `data:${im.mime || 'image/png'};base64,${Buffer.from(im.data).toString('base64')}`, detail: 'high' } });
  }
  return {
    url: baseUrl.replace(/\/+$/, '') + '/chat/completions',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: {
      model,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }],
      response_format: { type: 'json_schema', json_schema: { name: String(name).replace(/[^a-zA-Z0-9_-]/g, '_'), strict: true, schema } },
    },
  };
}
export function parseOpenAIResponse(json) {
  const msg = json && json.choices && json.choices[0] && json.choices[0].message;
  if (!msg) throw new LLMError('OpenAI response has no message', { sample: JSON.stringify(json).slice(0, 300) });
  if (msg.refusal) throw new LLMError(`OpenAI refused: ${msg.refusal}`);
  return extractJson(msg.content);
}

// ---------------------------------------------------------------- Anthropic
/** Messages API request with output_config.format json_schema and base64 image blocks. */
export function buildAnthropicRequest({ system, user, images = [], schema, model, apiKey, baseUrl = 'https://api.anthropic.com' }) {
  const content = [];
  for (const im of images) {
    if (im.label) content.push({ type: 'text', text: im.label });
    content.push({ type: 'image', source: { type: 'base64', media_type: im.mime || 'image/png', data: Buffer.from(im.data).toString('base64') } });
  }
  content.push({ type: 'text', text: user });
  return {
    url: baseUrl.replace(/\/+$/, '') + '/v1/messages',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: { model, max_tokens: 16000, ...(system ? { system } : {}), messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema } } },
  };
}
export function parseAnthropicResponse(json) {
  if (json && json.stop_reason === 'refusal') throw new LLMError('Anthropic model declined the request', { stop_details: json.stop_details ?? null });
  const text = ((json && json.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return extractJson(text);
}

function httpProvider(kind, cfg) {
  const isOpenAI = kind === 'openai';
  const apiKey = cfg.apiKey || process.env[isOpenAI ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'];
  const model = cfg.model || process.env[isOpenAI ? 'OPENAI_MODEL' : 'ANTHROPIC_MODEL'] || DEFAULTS[kind];
  const baseUrl = cfg.baseUrl || process.env[isOpenAI ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL'] || undefined;
  const fetchFn = cfg.fetchFn || globalThis.fetch;
  return {
    provider: kind, model,
    async once(req) {
      if (!apiKey) throw new LLMError(`${isOpenAI ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} is not set`);
      const r = (isOpenAI ? buildOpenAIRequest : buildAnthropicRequest)({ ...req, model, apiKey, ...(baseUrl ? { baseUrl } : {}) });
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), (cfg.timeoutS || 180) * 1000);
      let res;
      try { res = await fetchFn(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body), signal: ctl.signal }); }
      catch (e) { throw new LLMError(`${kind} request failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
      finally { clearTimeout(timer); }
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new LLMError(`${kind} HTTP ${res.status}: ${(json && json.error && (json.error.message || json.error.type)) || 'error'}`, { status: res.status });
      return (isOpenAI ? parseOpenAIResponse : parseAnthropicResponse)(json);
    },
  };
}

// ---------------------------------------------------------------- factory
/**
 * @param {{provider?: string, model?: string, spawnFn?: Function, fetchFn?: Function, timeoutS?: number}} [cfg]
 * @returns {{provider: string, model: string, complete: (req: object) => Promise<any>}}
 */
export function createLLM(cfg = {}) {
  const kind = (cfg.provider || process.env.AI_PROVIDER || 'agy').toLowerCase();
  let p;
  if (kind === 'agy') p = agyProvider(cfg);
  else if (kind === 'openai' || kind === 'anthropic') p = httpProvider(kind, cfg);
  else throw new LLMError(`Unknown AI_PROVIDER "${kind}" (use agy, openai, anthropic or rules)`);
  return {
    provider: p.provider, model: p.model,
    /** One call, schema-checked; a bad/missing JSON answer is retried once. Transport errors are not retried. */
    async complete(req) {
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return checked(req.schema, await p.once(attempt ? { ...req, user: req.user + '\n\nYour previous answer was not valid JSON for the schema' + (lastErr && lastErr.details && lastErr.details.errors ? ` (${lastErr.details.errors.join('; ')})` : '') + '. Answer again with only the JSON object.' } : req)); }
        catch (e) {
          lastErr = e;
          const badJson = e instanceof LLMError && /not JSON|does not match|no JSON|empty model/.test(e.message);
          if (!badJson) throw e;
        }
      }
      throw lastErr;
    },
  };
}

// LLM explanation wording (PROJECT.md Change 6, FEATURES step 22): the model may only REWORD an explanation the
// planner already wrote. It gets the template text and the structured facts, nothing else, and its answer is
// checked here: every number, time, job, tractor and block of the template must appear unchanged, nothing new may
// appear, and the claims (late, missed, safety, ...) must stay as they were. Anything else is discarded and the
// template stays. Wording never changes a plan. DOM-free; the queue is used by server.mjs.

export const WORDING_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

const SYSTEM = [
  'You reword explanations of a farm tractor fleet plan for the operator, in plain English.',
  'You get the explanation the planner wrote (template) and its structured facts. Rewrite the template so it is easier to read.',
  'Write short, plain sentences for a farm operator. Each sentence at most 22 words. Lead with the outcome (e.g. "Tractor 3 takes over Spray E."). No hedging, no marketing words. At most 3 sentences, and not longer than the original.',
  'Rules: Keep every number, time, percentage, job name, tractor name and block exactly as written (same digits, same format, e.g. "10:40 AM", "60%", "Tractor 3", "Haul bins C").',
  'Do not add any fact, number, name, cause, promise or advice that is not in the template. Do not drop a fact. Do not change what is claimed (late stays late, missed stays missed, a safety check stays as stated).',
  'No markdown, no lists, no quotes around the answer. Answer with JSON {"text": "..."} only.',
].join(' ');

/** Prompt for one explanation: template text + facts only (no state dump). */
export function wordingPrompt(x) {
  const user = JSON.stringify({ template: String((x && x.text) || ''), trigger: (x && x.trigger) || null, facts: (x && x.facts) || {} });
  return { system: SYSTEM, user: 'Reword this explanation.\n' + user, schema: WORDING_SCHEMA, name: 'wording' };
}

// ---------------------------------------------------------------- validation
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GENERIC_IDS = /\b(?:Tractor|Block|Van|Mechanic)\s+[A-Z0-9]{1,3}\b|\b(?:Spray|Mow|Hedge|Haul bins)\s+[A-Z]\b|\b[TJXOF]\d+\b/g;
const TIME = /\b\d{1,2}:\d{2}(?:\s?[AaPp]\.?[Mm]\.?)?/g;
const NUM = /\d+(?:[.,]\d+)?\s?%?/g;
// claims that must neither appear nor disappear (stems, case-insensitive)
const CLAIMS = [
  ['late', /\blate\b|\blateness\b/i], ['missed', /\bmiss(?:ed|es|ing)?\b/i], ['safety', /\bsafety\b/i],
  ['overtime', /\bovertime\b|\bpast sunset\b/i], ['unassigned', /\bunassigned\b|\bcannot be (?:re)?assigned\b/i],
  ['broken', /\bbr(?:oke|oken)\b|\bbreakdown\b/i], ['blocked', /\bblock(?:ed)? (?:road|route)|\broad(?:s)? (?:is |are )?(?:blocked|closed)\b/i],
  ['not', /\b(?:no|not|cannot|can't|never|none)\b/i], ['manual', /\bmanual\b/i], ['excluded', /\bexclud/i],
];

/** Tokens the rewrite must keep: {ids, times, nums} as sorted arrays (ids include known names). */
export function factTokens(text, names = []) {
  let s = String(text || '');
  const ids = [];
  const known = [...new Set(names.filter((n) => typeof n === 'string' && n.trim()))].sort((a, b) => b.length - a.length);
  for (const n of known) { const re = new RegExp('(?<![A-Za-z0-9])' + esc(n) + '(?![A-Za-z0-9])', 'g'); s = s.replace(re, () => { ids.push(n); return ' '; }); }
  s = s.replace(GENERIC_IDS, (m) => { ids.push(m.replace(/\s+/g, ' ')); return ' '; });
  const times = [];
  s = s.replace(TIME, (m) => { times.push(m.toUpperCase().replace(/\./g, '').replace(/\s+/g, '')); return ' '; });
  const nums = [];
  s.replace(NUM, (m) => { nums.push(m.replace(/\s+/g, '').replace(',', '.')); return ' '; });
  return { ids: ids.sort(), times: times.sort(), nums: nums.sort() };
}

const sentenceList = (t) => (String(t).trim().match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || []).filter((x) => x.trim());
const wordCount = (t) => (String(t).trim().match(/\S+/g) || []).length;
const sentences = (t) => (String(t).trim().match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || []).filter((x) => x.trim()).length;
const missing = (need, have) => { const left = [...have]; const out = []; for (const x of need) { const i = left.indexOf(x); if (i < 0) out.push(x); else left.splice(i, 1); } return out; };

/**
 * @returns {{ok: true, text} | {ok: false, reason}}
 * names: job labels / tractor names / block ids from the current state (matched exactly, longest first).
 */
export function validateWording(original, rewrite, { names = [] } = {}) {
  const o = String(original || '').trim();
  const r = typeof rewrite === 'string' ? rewrite.trim().replace(/\s+/g, ' ') : '';
  if (!r) return { ok: false, reason: 'empty rewrite' };
  if (/[{}<>`*#|]|^\s*[-•]/.test(r)) return { ok: false, reason: 'not plain text' };
  if (sentences(r) > 3) return { ok: false, reason: `more than 3 sentences (${sentences(r)})` };
  if (r.length > Math.max(160, Math.round(o.length * 1.25))) return { ok: false, reason: 'longer than the original' };
  const a = factTokens(o, names), b = factTokens(r, names);
  for (const k of ['ids', 'times', 'nums']) {
    const lost = missing(a[k], b[k]);
    if (lost.length) return { ok: false, reason: `changed or dropped ${k === 'ids' ? 'name' : k === 'times' ? 'time' : 'number'}: ${lost.slice(0, 3).join(', ')}` };
    const added = missing(b[k], a[k]);
    if (added.length) return { ok: false, reason: `added ${k === 'ids' ? 'name' : k === 'times' ? 'time' : 'number'}: ${added.slice(0, 3).join(', ')}` };
  }
  for (const [name, re] of CLAIMS) {
    const had = re.test(o), has = re.test(r);
    if (had && !has) return { ok: false, reason: `dropped claim "${name}"` };
    if (!had && has) return { ok: false, reason: `added claim "${name}"` };
  }
  // concision (checked last so fact problems are reported first)
  if (sentenceList(r).some((x) => wordCount(x) > 26)) return { ok: false, reason: 'a sentence is longer than 26 words' };
  if (r.length > Math.round(o.length * 1.1)) return { ok: false, reason: 'longer than the original' };
  if (wordCount(r) > wordCount(o) + 5) return { ok: false, reason: 'wordier than the original' };
  return { ok: true, text: r };
}

/** Some CLIs hand back the JSON answer as a string inside `text` ({"text": "{\"text\": \"...\"}"}): unwrap once. */
export function unwrap(out) {
  const t = out && typeof out.text === 'string' ? out.text.trim() : null;
  if (t && t.startsWith('{') && t.endsWith('}')) { try { const j = JSON.parse(t); if (j && typeof j.text === 'string') return { ...out, text: j.text }; } catch { /* keep */ } }
  return out;
}

// ---------------------------------------------------------------- queue
/**
 * One wording call at a time, newest explanation first, cached by explanation id. Never blocks the caller.
 * @param {{complete: (req) => Promise<{text}>, model: string, provider: string, names?: () => string[],
 *          onChange?: () => void, onBusy?: (busy: boolean) => void, debounceMs?: number, max?: number, backlog?: number, log?: Function}} o
 */
export function createWorder({ complete, model, provider, names = () => [], onChange = () => {}, onBusy = () => {}, debounceMs = 1200, max = 40, backlog = 2, log = () => {} }) {
  const cache = new Map(); // id -> entry
  const queue = []; // explanations waiting, newest last
  let timer = null, busy = false, last = null;
  const touch = (id, patch) => { const e = { ...(cache.get(id) || {}), ...patch, updated_at: new Date().toISOString() }; cache.set(id, e); trim(); onChange(); return e; };
  function trim() { while (cache.size > max) cache.delete(cache.keys().next().value); }
  function enqueue(x) {
    if (!complete || !x || !x.id || !x.text || cache.has(x.id)) return;
    touch(x.id, { id: x.id, status: 'queued', original: x.text, text: null, model, provider, reason: null, latency_ms: null });
    queue.push(x);
    // keep only the newest few waiting: an old explanation nobody reads is not worth a model call
    while (queue.length > backlog) { const old = queue.shift(); touch(old.id, { status: 'skipped', reason: 'newer explanations came first' }); }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; pump(); }, debounceMs);
  }
  async function pump() {
    if (busy) return;
    const x = queue.pop(); // newest first
    if (!x) return;
    busy = true; onBusy(true);
    touch(x.id, { status: 'working' });
    const t0 = Date.now();
    try {
      const out = unwrap(await complete(wordingPrompt(x)));
      const v = validateWording(x.text, out && out.text, { names: names() });
      last = { at: new Date().toISOString(), latency_ms: Date.now() - t0 };
      if (v.ok) touch(x.id, { status: 'ok', text: v.text, latency_ms: last.latency_ms });
      else { touch(x.id, { status: 'rejected', reason: v.reason, latency_ms: last.latency_ms, rejected_text: out && typeof out.text === 'string' ? out.text.slice(0, 600) : null }); log(`wording ${x.id} discarded: ${v.reason}`); }
    } catch (e) {
      last = { at: new Date().toISOString(), latency_ms: Date.now() - t0 };
      touch(x.id, { status: 'error', reason: (e && e.message) || String(e), latency_ms: last.latency_ms });
      log(`wording ${x.id} failed: ${(e && e.message) || e}`);
    } finally {
      busy = false; onBusy(false);
      if (queue.length) pump();
    }
  }
  return {
    enqueue,
    get: (id) => cache.get(id) || null,
    /** {id: entry} for AiState (insertion order). */
    all: () => Object.fromEntries(cache),
    get busy() { return busy; },
    get last() { return last; },
    reset() { queue.length = 0; cache.clear(); onChange(); },
  };
}

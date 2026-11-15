// AI Supervisor core (DOM-free): findings lifecycle shared by ai-supervisor/server.mjs and the dashboard's
// in-browser rules supervisor. Reviewers PROPOSE; the operator approves; the backend's optimizer + Safety Agent
// decide through the normal contract mutation (202 Operation). Nothing is applied without an approve() call.
//
//   const core = createAiCore({ getState, call: { preview(trId, body), mutate(method, path, body, key) }, caps, onChange });
//   core.ingest('plan', rawFindings)   core.refreshPreviews()   core.approve(id)   core.dismiss(id)   core.onOperation(op)
//
// Finding (contract proposal, GET /ai/state `findings[]`):
//   { id, key, reviewer: plan|implements|plots, severity: high|medium|low, title, why, action, label,
//     request: {method, path, body} | null, advisory: bool, advisory_reason, needs,
//     status: open|applying|applied|failed|rejected|stale|dismissed,
//     preview: PreviewSummary|null, preview_status: none|loading|ready|unavailable|error, preview_note,
//     operation: Operation|null, error: string|null, outcome: string|null, plot: {...}|null,
//     created_at, updated_at }
import { resolveAction, normAction, findingKey, summarizePreview, KIND_NEEDS, AI_ATTRIBUTION } from './aiActions.js';

const NOT_SUPPORTED = 'Not supported by this backend';
const HISTORY_CAP = 30;
const isOp = (x) => !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.status === 'string' && 'kind' in x;
const TERMINAL = new Set(['succeeded', 'failed', 'superseded']);
const errMsg = (e) => (e && (e.message || (e.error && e.error.message))) || String(e);
/** 501, 405, or a 404 that is not one of our NOT_FOUND-with-details errors = the route does not exist here. */
export const isUnsupportedError = (e) => !!e && (e.code === 'NOT_IMPLEMENTED' || e.status === 501 || e.status === 405 || e.code === 'METHOD_NOT_ALLOWED' || (e.status === 404 && e.code !== 'NOT_FOUND'));

export function createAiCore({ getState, call, caps = {}, onChange = () => {}, idPrefix = 'F', keyPrefix = null, now = () => Date.now() }) {
  const findings = new Map(); // id -> finding
  const decided = new Map(); // key -> 'applied' | 'dismissed'
  const history = [];
  let n = 0;
  const session = keyPrefix || Math.random().toString(36).slice(2, 10);
  const iso = () => new Date(now()).toISOString();
  const changed = () => { try { onChange(); } catch (e) { console.error('[ai] onChange', e); } };

  function advisoryOf(f, res) {
    if (f.action.kind === 'none') return 'Advice only: no contract action fits.';
    const need = KIND_NEEDS[f.action.kind];
    if (need && !caps[need]) return NOT_SUPPORTED;
    if (!res.ok) return res.reason;
    return null;
  }

  function build(reviewer, raw) {
    const action = normAction(raw.action);
    const key = findingKey(reviewer, action, raw.title);
    const res = resolveAction(action, getState());
    const f = {
      id: null, key, reviewer, severity: ['high', 'medium', 'low'].includes(raw.severity) ? raw.severity : 'medium',
      title: String(raw.title || '').slice(0, 120), why: String(raw.why || '').slice(0, 600), action,
      label: res.ok ? res.label : null, request: res.ok ? res.request : null, needs: KIND_NEEDS[action.kind] || null,
      advisory: false, advisory_reason: null, replans: res.ok ? !!res.replans : false, preview_spec: res.ok ? res.preview : null,
      status: 'open', preview: null, preview_status: 'none', preview_note: null, operation: null, error: null, outcome: null,
      plot: raw.plot || null, created_at: iso(), updated_at: iso(), attempts: 0,
    };
    const adv = advisoryOf(f, res);
    // An invalid proposal (bad ids) is dropped, not shown: the model must not put nonsense in front of the operator.
    if (adv && action.kind !== 'none' && adv !== NOT_SUPPORTED) return { drop: adv };
    if (adv) { f.advisory = true; f.advisory_reason = adv; }
    return { f };
  }

  const core = {
    session,
    /** Replace the open findings of one reviewer with a fresh review's raw findings. Returns {added, kept, dropped}. */
    ingest(reviewer, raws) {
      const seen = new Set(); const dropped = [];
      let added = 0, kept = 0;
      for (const raw of raws || []) {
        const { f, drop } = build(reviewer, raw);
        if (drop) { dropped.push({ title: raw.title, reason: drop }); continue; }
        if (decided.has(f.key) || seen.has(f.key)) continue;
        seen.add(f.key);
        const prev = [...findings.values()].find((x) => x.key === f.key && !['dismissed', 'applied'].includes(x.status));
        if (prev) {
          if (prev.status === 'open' || prev.status === 'stale' || prev.status === 'rejected') {
            Object.assign(prev, { severity: f.severity, title: f.title, why: f.why, label: f.label, request: f.request, advisory: f.advisory, advisory_reason: f.advisory_reason, preview_spec: f.preview_spec, plot: f.plot || prev.plot, updated_at: iso() });
            if (prev.status === 'stale') prev.status = 'open';
          }
          kept++; continue;
        }
        f.id = idPrefix + ++n;
        findings.set(f.id, f); added++;
      }
      // open findings of this reviewer that the new review no longer raises go away (applying/failed stay visible)
      for (const [id, f] of findings) if (f.reviewer === reviewer && f.status === 'open' && !seen.has(f.key)) findings.delete(id);
      changed();
      return { added, kept, dropped };
    },

    /** Attach a fresh /preview to every open, re-planning finding that has one (pins, controls). */
    async refreshPreviews() {
      const todo = [...findings.values()].filter((f) => f.status === 'open' && !f.advisory && f.replans);
      for (const f of todo) {
        if (!f.preview_spec) { f.preview_status = 'unavailable'; f.preview_note = 'The contract has no preview for this change; the optimizer re-plans and the Safety Agent validates it when you approve.'; continue; }
        if (!caps.preview) { f.preview_status = 'unavailable'; f.preview_note = 'Preview: ' + NOT_SUPPORTED.toLowerCase() + '.'; continue; }
        f.preview_status = 'loading'; changed();
        try {
          const p = await call.preview(f.preview_spec.tractor, f.preview_spec.body);
          f.preview = summarizePreview(p, getState()); f.preview_status = 'ready'; f.preview_note = null;
        } catch (e) {
          if (isUnsupportedError(e)) { caps.preview = false; f.preview_status = 'unavailable'; f.preview_note = 'Preview: ' + NOT_SUPPORTED.toLowerCase() + '.'; }
          else { f.preview_status = 'error'; f.preview_note = 'Preview failed: ' + errMsg(e); }
        }
        f.updated_at = iso(); changed();
      }
    },

    /** Operator approval: re-validate, re-preview (re-planning actions), apply with an Idempotency-Key. */
    async approve(id) {
      const f = findings.get(id);
      if (!f) throw { code: 'NOT_FOUND', message: `No AI finding ${id}.`, status: 404 };
      if (!['open', 'failed', 'rejected', 'stale'].includes(f.status)) throw { code: 'CONFLICT', message: `This proposal is already ${f.status}.`, status: 409 };
      if (f.advisory) throw { code: 'CONFLICT', message: f.advisory_reason === NOT_SUPPORTED ? `${NOT_SUPPORTED}: nothing can be applied.` : 'Advice only: there is nothing to apply.', status: 409 };
      const res = resolveAction(f.action, getState());
      if (!res.ok) { Object.assign(f, { status: 'stale', error: `No longer applies: ${res.reason}`, updated_at: iso() }); changed(); throw { code: 'CONFLICT', message: f.error, status: 409 }; }
      Object.assign(f, { request: res.request, label: res.label, preview_spec: res.preview, error: null });
      if (res.preview && caps.preview) {
        try {
          const p = await call.preview(res.preview.tractor, res.preview.body);
          f.preview = summarizePreview(p, getState()); f.preview_status = 'ready';
          if (!p.allowed) {
            Object.assign(f, { status: 'rejected', error: `Safety check refused it: ${p.refused_reason || 'not allowed'}`, updated_at: iso() }); changed();
            throw { code: 'SAFETY_REJECTED', message: f.error, status: 422, finding: f };
          }
        } catch (e) {
          if (e && e.finding) throw e;
          if (isUnsupportedError(e)) { caps.preview = false; f.preview_status = 'unavailable'; f.preview_note = 'Preview: ' + NOT_SUPPORTED.toLowerCase() + '.'; }
          else if (e && e.code === 'TIMEOUT') { f.preview_status = 'error'; f.preview_note = 'Preview timed out; applying lets the Safety Agent validate the real re-plan.'; }
          else throw e;
        }
      }
      f.attempts += 1;
      const key = `ai-${session}-${f.id}-${f.attempts}`;
      f.status = 'applying'; f.updated_at = iso(); changed();
      let out;
      try { out = await call.mutate(res.request.method, res.request.path, res.request.body, key); }
      catch (e) {
        if (isUnsupportedError(e)) {
          if (f.needs) caps[f.needs] = false;
          Object.assign(f, { status: 'open', advisory: true, advisory_reason: NOT_SUPPORTED, error: null, updated_at: iso() }); changed();
          throw { code: 'NOT_IMPLEMENTED', message: `${NOT_SUPPORTED}: shown as advice only.`, status: 501 };
        }
        const busy = e && e.code === 'CONFLICT' && /re-?plan|running/i.test(errMsg(e));
        Object.assign(f, { status: busy ? 'open' : 'failed', error: busy ? 'A re-plan is already running. Try again in a moment.' : errMsg(e), updated_at: iso() }); changed();
        throw { code: (e && e.code) || 'INTERNAL', message: f.error, status: (e && e.status) || 500 };
      }
      if (isOp(out)) { f.operation = out; if (TERMINAL.has(out.status)) core.onOperation(out); }
      else core.onOperation({ id: '(sync)', kind: 'control', status: 'succeeded', plan_version: null, error: null, _sync: true }, f);
      changed();
      return { finding: f, operation: isOp(out) ? out : null };
    },

    dismiss(id) {
      const f = findings.get(id);
      if (!f) throw { code: 'NOT_FOUND', message: `No AI finding ${id}.`, status: 404 };
      if (f.status === 'applying') throw { code: 'CONFLICT', message: 'It is being applied; wait for the result.', status: 409 };
      if (f.status === 'applied' || f.status === 'dismissed') return f;
      f.status = 'dismissed'; f.updated_at = iso(); decided.set(f.key, 'dismissed');
      history.unshift({ id: f.id, reviewer: f.reviewer, title: f.title, label: f.label, status: 'dismissed', at: iso(), outcome: 'Dismissed by the operator. Nothing changed.', plan_version: null, block: f.action.block });
      history.length = Math.min(history.length, HISTORY_CAP);
      findings.delete(id); changed();
      return f;
    },

    /** Operation lifecycle (WS `operation` / GET /operations/{id}). */
    onOperation(op, direct = null) {
      const f = direct || [...findings.values()].find((x) => x.operation && x.operation.id === op.id && x.status === 'applying');
      if (!f) return false;
      if (!op._sync) f.operation = op;
      if (!TERMINAL.has(op.status)) { f.updated_at = iso(); changed(); return true; }
      if (op.status === 'succeeded') {
        f.status = 'applied'; f.error = null;
        f.outcome = `${AI_ATTRIBUTION}${op.plan_version != null ? ` · plan v${op.plan_version}` : ''}.`;
        decided.set(f.key, 'applied');
        history.unshift({ id: f.id, reviewer: f.reviewer, title: f.title, label: f.label, status: 'applied', at: iso(), outcome: f.outcome, plan_version: op.plan_version ?? null, operation: op._sync ? null : op.id, block: f.action.block });
        findings.delete(f.id);
      } else {
        const e = op.error || {};
        f.status = 'failed';
        f.error = op.status === 'superseded' ? 'Replaced by a newer request before it applied.' : e.code === 'SAFETY_REJECTED' ? `Safety check rejected it: ${e.message}` : (e.message || op.message || 'The backend could not apply it.');
        f.outcome = `AI Supervisor proposed, operator approved, ${e.code === 'SAFETY_REJECTED' ? 'Safety check rejected it' : 'not applied'}.`;
        history.unshift({ id: f.id, reviewer: f.reviewer, title: f.title, label: f.label, status: 'failed', at: iso(), outcome: f.error, plan_version: null, operation: op.id, block: f.action.block });
      }
      history.length = Math.min(history.length, HISTORY_CAP);
      f.updated_at = iso(); changed();
      return true;
    },

    /** Re-check open findings against fresh state (ids gone, job finished): mark stale. */
    revalidate() {
      let any = false;
      for (const f of findings.values()) {
        if (f.status !== 'open' || f.action.kind === 'none') continue;
        const res = resolveAction(f.action, getState());
        if (!res.ok && !f.advisory) { f.status = 'stale'; f.error = `No longer applies: ${res.reason}`; any = true; }
      }
      if (any) changed();
    },

    /** New farm day (POST /run, backend restart): forget open findings and decisions; keep the history log. */
    reset() { findings.clear(); decided.clear(); changed(); },

    findings: () => [...findings.values()].map(({ preview_spec, attempts, ...f }) => f),
    history: () => history.slice(),
    caps,
  };
  return core;
}

// Per-Operation loading state (ARCHITECTURE §13). Each tracked op owns its spinner on the element
// that started it; one op finishing never clears another's. Outcomes come from WS `operation`
// messages (or state.operations / api.getOperation as a fallback).
import { opOutcome, isTerminal, errText, errKind } from '../lib/derive.js';

const isOp = (x) => !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.status === 'string' && 'kind' in x;
// Same op? Ids restart when the backend restarts, so also compare what it was for.
const same = (w, op) => !!op && op.kind === w.kind && op.source === w.source;

export function createOps({ store, api, toast }) {
  const waiting = new Map(); // opId -> { els, resolve, since, okText, kind, source, polling }

  function busy(el, on) {
    if (!el) return;
    const n = (+el.dataset.busy || 0) + (on ? 1 : -1);
    el.dataset.busy = Math.max(0, n);
    el.classList.toggle('busy', n > 0);
  }

  function finish(op) {
    const w = waiting.get(op.id); if (!w) return;
    waiting.delete(op.id);
    w.els.forEach((el) => busy(el, false));
    const out = opOutcome(op);
    const custom = out && out.kind === 'err' && w.failText ? w.failText(op) : null;
    if (custom) toast(custom, 'err');
    else if (out && out.kind === 'err') toast(out.text, 'err');
    else if (out && out.kind === 'warn') toast(out.text, 'warn');
    else if (out && w.okText) toast(typeof w.okText === 'function' ? w.okText(op) : w.okText);
    w.resolve(op);
  }

  // The op is gone (backend restarted, or its id now names something else): stop the spinner, say so once.
  function lost(id) {
    const w = waiting.get(id); if (!w) return;
    waiting.delete(id);
    w.els.forEach((el) => busy(el, false));
    toast('The backend restarted before confirming that action. Check the plan and retry if needed.', 'warn');
    w.resolve(null);
  }

  // Ask the server about one waiting op (fallback when no terminal WS message reached us).
  function check(id) {
    const w = waiting.get(id);
    if (!w || w.polling || typeof api.getOperation !== 'function') return;
    w.polling = true;
    api.getOperation(id).then((op) => {
      w.polling = false;
      if (!isOp(op)) return;
      if (!same(w, op)) lost(id);
      else if (isTerminal(op)) finish(op);
    }, (err) => {
      w.polling = false;
      if (err && (err.code === 'NOT_FOUND' || err.status === 404)) lost(id);
    });
  }

  function lookup(id) {
    const ops = (store.get() || {}).operations;
    return Array.isArray(ops) ? ops.find((o) => o && o.id === id) : null;
  }

  store.subscribe((state, msg) => {
    if (!msg) return;
    if (msg.type === 'operation' && msg.data && waiting.has(msg.data.id) && isTerminal(msg.data)) finish(msg.data);
    // Snapshot = full reset (reconnect, resync, new run). Ops that finished while we were away toast once
    // (finish() removes them, so nothing re-toasts); ops still running keep their spinner; unknown ids are checked.
    if (msg.type === 'snapshot') {
      for (const [id, w] of [...waiting]) {
        const o = lookup(id);
        if (!o) check(id);
        else if (!same(w, o)) lost(id);
        else if (isTerminal(o)) finish(o);
      }
    }
  });

  // Fallback poll for ops whose terminal WS message we may have missed.
  setInterval(() => {
    const now = Date.now();
    for (const [id, w] of waiting) {
      const o = lookup(id);
      if (o && same(w, o) && isTerminal(o)) { finish(o); continue; }
      if (now - w.since > 6000 && (store.get() || {}).connected !== false) check(id);
    }
  }, 2500);

  return {
    /**
     * Track an api call. Resolves with the terminal Operation, the raw non-Operation body,
     * or null on rejection (already toasted). failText(opOrErr) -> string|null replaces the toast for a failed
     * op or a rejected call (e.g. editFailText for job edits); null falls back to the default wording.
     */
    track(promise, { els = [], okText = null, failText = null } = {}) {
      els = (Array.isArray(els) ? els : [els]).filter(Boolean);
      els.forEach((el) => busy(el, true));
      return Promise.resolve(promise).then((res) => {
        if (!isOp(res)) { els.forEach((el) => busy(el, false)); return res; }
        const seen = lookup(res.id);
        const op = seen && same(res, seen) && isTerminal(seen) ? seen : res;
        return new Promise((resolve) => {
          waiting.set(op.id, { els, resolve, since: Date.now(), okText, failText, kind: res.kind, source: res.source });
          if (isTerminal(op)) finish(op);
        });
      }, (err) => {
        els.forEach((el) => busy(el, false));
        toast((failText && failText(err)) || errText(err), errKind(err));
        return null;
      });
    },
    /** Active ops in state (anyone's), for the plan badge spinner. */
    active(state) { return ((state && state.operations) || []).filter((o) => o && (o.status === 'queued' || o.status === 'running')); },
  };
}

// Per-Operation loading state (ARCHITECTURE §13). Each tracked op owns its spinner on the element
// that started it; one op finishing never clears another's. Outcomes come from WS `operation`
// messages (or state.operations / api.getOperation as a fallback).
import { opOutcome, isTerminal, errText } from '../lib/derive.js';

const isOp = (x) => !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.status === 'string' && 'kind' in x;

export function createOps({ store, api, toast }) {
  const waiting = new Map(); // opId -> { els, resolve, since }

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
    if (out && out.kind === 'err') toast(out.text, 'err');
    else if (out && out.kind === 'warn') toast(out.text, 'warn');
    else if (out && w.okText) toast(typeof w.okText === 'function' ? w.okText(op) : w.okText);
    w.resolve(op);
  }

  function lookup(id) {
    const ops = (store.get() || {}).operations;
    return Array.isArray(ops) ? ops.find((o) => o && o.id === id) : null;
  }

  store.subscribe((state, msg) => {
    if (!msg) return;
    if (msg.type === 'operation' && msg.data && waiting.has(msg.data.id) && isTerminal(msg.data)) finish(msg.data);
    if (msg.type === 'snapshot') for (const id of [...waiting.keys()]) { const o = lookup(id); if (o && isTerminal(o)) finish(o); }
  });

  // Fallback poll for ops whose terminal WS message we may have missed.
  setInterval(() => {
    const now = Date.now();
    for (const [id, w] of waiting) {
      const o = lookup(id);
      if (o && isTerminal(o)) { finish(o); continue; }
      if (now - w.since > 6000 && typeof api.getOperation === 'function' && !w.polling) {
        w.polling = true;
        api.getOperation(id).then((op) => { w.polling = false; if (isOp(op) && isTerminal(op)) finish(op); }).catch(() => { w.polling = false; });
      }
    }
  }, 2500);

  return {
    /**
     * Track an api call. Resolves with the terminal Operation, the raw non-Operation body,
     * or null on rejection (already toasted).
     */
    track(promise, { els = [], okText = null } = {}) {
      els = (Array.isArray(els) ? els : [els]).filter(Boolean);
      els.forEach((el) => busy(el, true));
      return Promise.resolve(promise).then((res) => {
        if (!isOp(res)) { els.forEach((el) => busy(el, false)); return res; }
        const seen = lookup(res.id);
        const op = seen && isTerminal(seen) ? seen : res;
        return new Promise((resolve) => {
          waiting.set(op.id, { els, resolve, since: Date.now(), okText });
          if (isTerminal(op)) finish(op);
        });
      }, (err) => {
        els.forEach((el) => busy(el, false));
        toast(errText(err), 'err');
        return null;
      });
    },
    /** Active ops in state (anyone's), for the plan badge spinner. */
    active(state) { return ((state && state.operations) || []).filter((o) => o && (o.status === 'queued' || o.status === 'running')); },
  };
}

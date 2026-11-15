// Glass bottom sheets: Why (+ priority control), Mechanic booking, Approval, Add tractor.
import { clock, esc, tractorColor, priName, IMPLEMENTS, implName, plural } from '../lib/format.js';
import { errText, whyTieBreak } from '../lib/derive.js';

export function createSheets({ store, api, ops, toast, island, focusBlock, onBooked, dockPill, onRepair, caps = () => ({}) }) {
  // caps(): data/capabilities.js. A feature the connected backend lacks is never offered (no error round trip).
  const has = (k) => caps()[k] !== false;
  const whyEl = document.getElementById('why'), mechEl = document.getElementById('mech'), addEl = document.getElementById('addsheet');
  const all = [whyEl, mechEl, addEl];
  // Hiding the mechanic sheet for any reason counts as "shown" for that pending item: it never re-pops by itself
  // (the chip's "Book mechanic" reopens it on purpose).
  const closeAll = (except) => {
    all.forEach((e) => { if (e !== except) e.classList.remove('on'); });
    if (except !== mechEl && mechPending) { shown.add(mechPending.id); mechPending = null; }
  };
  // A focused control inside a sheet that slides off-stage makes Chrome scroll #stage (overflow:hidden) to keep it
  // visible. Blur it the moment its sheet closes, wherever the close came from.
  const mo = new MutationObserver((recs) => recs.forEach((r) => {
    const el = r.target, a = document.activeElement;
    if (!el.classList.contains('on') && a && el.contains(a)) a.blur();
  }));
  all.forEach((el) => mo.observe(el, { attributes: true, attributeFilter: ['class'] }));
  const st = () => store.get() || {};
  const trName = (id) => { const t = (st().fleet || []).find((x) => x.id === id); return t ? (t.name || t.id) : (id || '—'); };
  const trIdx = (id) => (st().fleet || []).findIndex((x) => x.id === id);

  // ---------------- Why ----------------
  let whyJob = null, whyData = null, whyReq = 0;
  function renderWhy() {
    const s = st(), j = (s.jobs || []).find((x) => x.id === whyJob);
    if (!j) { whyEl.classList.remove('on'); whyJob = null; return; }
    const w = whyData;
    const chosen = (w && w.chosen) || j.tractor;
    const title = j.status === 'done' ? (j.label || j.id) + ' is done'
      : chosen ? 'Why ' + esc(trName(chosen)) + ' for ' + esc(j.label || j.id) + '?' : 'Why is ' + esc(j.label || j.id) + ' unassigned?';
    let html = '<div class="shead"><p>' + title + '</p><button class="gbtn sm" data-x>Close</button></div>';
    if (j.unassigned_reason && j.status !== 'done') html += '<p class="unr"><b>Unassigned:</b> ' + esc(j.unassigned_reason) + '</p>';
    if (j.status === 'done') {
      html += '<p style="font-size:13px;margin:0 0 10px">Completed by ' + esc(trName(j.tractor)) + ' at ' + clock(j.end_t) + (j.end_t != null && j.deadline_t != null ? (j.end_t <= j.deadline_t ? ', before its ' + clock(j.deadline_t) + ' deadline.' : ', after its ' + clock(j.deadline_t) + ' deadline.') : '.') + '</p>';
    } else if (w === 'loading') {
      html += '<p style="font-size:13px;color:#6e6e73;margin:0 0 10px">Re-solving with this job on each tractor…</p>';
    } else if (w && w.unsupported) {
      html += '<p style="font-size:13px;color:#6e6e73;margin:0 0 10px">Comparing tractors for this job is not supported by this backend.</p>';
    } else if (w && w.error) {
      html += '<p style="font-size:13px;color:#B3261E;margin:0 0 10px">' + esc(w.error) + '</p>';
    } else if (w && Array.isArray(w.options)) {
      const t = s.clock ? s.clock.t : 0;
      const ok = w.options.filter((o) => o.feasible && o.finish_t != null);
      const mx = Math.max(t + 1, ...ok.map((o) => o.finish_t));
      const cho = w.options.find((o) => o.tractor === w.chosen);
      if (!w.options.length) html += '<p style="font-size:13px;margin:0 0 10px;color:#6e6e73">No tractors to compare.</p>';
      w.options.forEach((o) => {
        const isC = o.tractor === w.chosen;
        const width = o.feasible && o.finish_t != null ? Math.max(12, (o.finish_t - t) / (mx - t) * 100) : 0;
        let txt;
        if (!o.feasible) txt = esc(o.reason || 'Not feasible');
        else if (isC) txt = 'Chosen · finishes ' + clock(o.finish_t);
        else if (cho && cho.finish_t != null && o.finish_t != null) txt = esc(whyTieBreak(o, cho, s, j) || ('+' + Math.round(o.finish_t - cho.finish_t) + ' min later finish'));
        else txt = 'Finishes ' + clock(o.finish_t);
        if (o.deadlines_missed && o.deadlines_missed.length) txt += ' · plan misses ' + plural(o.deadlines_missed.length, 'deadline');
        const col = tractorColor((s.fleet || [])[trIdx(o.tractor)] || null, Math.max(0, trIdx(o.tractor)));
        html += '<div style="margin:0 0 9px;opacity:' + (isC ? 1 : 0.5) + '"><div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;margin-bottom:4px"><span style="font-weight:600">' + esc(trName(o.tractor)) + '</span><span style="text-align:right">' + txt + '</span></div><div style="height:8px;border-radius:4px;background:rgba(0,0,0,.07)"><div style="height:8px;border-radius:4px;width:' + width + '%;background:' + col + ';transition:width .6s cubic-bezier(.34,1.56,.64,1)"></div></div></div>';
      });
    }
    if (j.status !== 'done' && has('patchJob')) {
      html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px"><p style="font-size:11px;color:#6e6e73;margin:0">Deadline ' + clock(j.deadline_t) + (w && w.method ? ' · ' + (w.method === 'counterfactual' ? 'compared by re-planning with each tractor' : 'estimated') : '') + '</p>' +
        '<div class="seg" data-seg>' + [1, 2, 3].map((p) => '<button data-p="' + p + '" class="' + (j.priority === p ? 'on' : '') + '">' + (p === 1 ? 'Low' : p === 2 ? 'Med' : 'High') + '</button>').join('') + '</div></div>';
    }
    // preserve busy state of segment buttons across re-render
    const busyP = [...whyEl.querySelectorAll('.seg button.busy')].map((b) => b.dataset.p);
    whyEl.innerHTML = html;
    busyP.forEach((p) => { const b = whyEl.querySelector('.seg button[data-p="' + p + '"]'); if (b) { b.classList.add('busy'); b.dataset.busy = 1; } });
  }
  whyEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) { whyEl.classList.remove('on'); whyJob = null; return; }
    const b = e.target.closest('.seg button');
    if (b && whyJob && !b.classList.contains('busy')) {
      const p = +b.dataset.p, id = whyJob;
      const j = (st().jobs || []).find((x) => x.id === id);
      if (!j || j.priority === p) return;
      // NOTE: no optimistic change; the pill/segment update when WS plan/jobs arrive.
      ops.track(api.patchJob(id, { priority: p }), { els: [b, dockPill(id)] }).then((op) => {
        if (op && op.status === 'succeeded' && whyJob === id) { toast(j.label + ' set to ' + priName(p).toLowerCase() + ' priority'); openWhy(id, true); }
      });
    }
  });
  function openWhy(id, keepOpen) {
    whyJob = id; whyData = 'loading'; const req = ++whyReq;
    if (!keepOpen) { closeAll(whyEl); whyEl.classList.add('on'); }
    renderWhy();
    const j = (st().jobs || []).find((x) => x.id === id);
    if (j && j.block && !keepOpen) focusBlock(j.block);
    if (j && j.status === 'done') return;
    if (!has('why')) { whyData = { unsupported: true }; renderWhy(); return; }
    api.why(id).then((w) => { if (req !== whyReq) return; whyData = w || { options: [] }; renderWhy(); },
      (err) => { if (req !== whyReq) return; whyData = { error: errText(err) }; renderWhy(); });
  }

  // ---------------- Mechanic / approval ----------------
  const dismissed = new Set(); // "Not now" / booked / approved: never auto-open again
  const shown = new Set();     // auto-opened once already: never auto-open again (closed by another sheet, day end…)
  let mechPending = null, mechOpts = [], msel = 0, mechReq = 0;
  function renderMech() {
    const p = mechPending; if (!p) return;
    if (p.kind === 'approval') {
      mechEl.innerHTML = '<div class="shead"><p>' + esc(p.title || 'Approval needed') + '</p><span style="font-size:10px;color:#6e6e73">Plan v' + esc(p.plan_version ?? '–') + '</span></div>' +
        '<p style="font-size:13px;margin:0 0 12px;line-height:1.45">' + esc(p.text || '') + '</p>' +
        '<div style="display:flex;gap:8px"><button class="abtn" data-ap="approve">Approve</button><button class="gbtn" data-ap="override">Reject proposal</button><button class="gbtn" data-later style="margin-left:auto">Later</button></div>';
      return;
    }
    const opts = mechOpts;
    if (msel >= opts.length) msel = 0;
    const rec = opts.find((m) => m.recommended);
    mechEl.innerHTML = '<div class="shead"><p>Book a mechanic for ' + esc(trName(p.tractor)) + '?</p><span style="font-size:10px;color:#6e6e73">Sample listings' + (p.issue ? ' · ' + esc(p.issue) : '') + '</span></div>' +
      (opts.length ? '<div class="mgrid">' + opts.map((m, i) => '<div class="mc' + (i === msel ? ' sel' : '') + '" data-i="' + i + '">' + (m.recommended ? '<span class="bdg g">Recommended</span><br>' : '') +
        '<b style="font-weight:600">' + esc(m.name) + '</b><br>' + esc(m.rating ?? '–') + ' (' + esc(m.reviews ?? 0) + ') · ' + esc(m.source || '') + '<br>Arrives in ~' + Math.round(m.eta_min ?? 0) + ' min · $' + Math.round(m.est_cost ?? 0) + '<br>' +
        (m.mobile ? '<span class="bdg">Mobile</span>' : '<span class="bdg">Shop</span>') + (m.ag_equipment ? '<span class="bdg">Ag</span>' : '') + (m.distance_mi != null ? '<span class="bdg">' + (+m.distance_mi).toFixed(1) + ' mi</span>' : '') + '</div>').join('') + '</div>'
        : '<p style="font-size:13px;color:#6e6e73;margin:0 0 10px">Searching nearby mechanics…</p>') +
      (rec && rec.reason ? '<p style="font-size:11px;color:#6e6e73;margin:0 0 10px">Recommended: ' + esc(rec.reason) + '</p>' : '') +
      '<p style="font-size:11px;color:#6e6e73;margin:0 0 10px">Arrival and return times are estimates. The tractor stays out of the plan until you mark it repaired.</p>' +
      '<div style="display:flex;gap:8px"><button class="abtn" data-book ' + (opts.length ? '' : 'disabled') + '>Approve and book</button><button class="gbtn" data-later>Not now</button></div>';
  }
  function openPending(p) {
    if ((p.kind === 'mechanic' && !has('mechanics')) || (p.kind === 'approval' && !has('approve'))) return;
    mechPending = p; msel = 0; mechOpts = Array.isArray(p.options) ? p.options : [];
    closeAll(mechEl); whyJob = null; mechEl.classList.add('on'); renderMech();
    if (p.kind === 'mechanic' && p.tractor) {
      const req = ++mechReq;
      api.mechanics(p.tractor).then((r) => {
        if (req !== mechReq || !r || !Array.isArray(r.options) || !r.options.length) return;
        mechOpts = r.options; const ri = mechOpts.findIndex((m) => m.recommended); msel = ri < 0 ? 0 : ri; renderMech();
      }, (err) => { if (!mechOpts.length) toast(errText(err), 'err'); });
    }
  }
  mechEl.addEventListener('click', (e) => {
    const p = mechPending; if (!p) return;
    const card = e.target.closest('.mc');
    if (card) { msel = +card.dataset.i; mechEl.querySelectorAll('.mc').forEach((x, i) => x.classList.toggle('sel', i === msel)); return; }
    if (e.target.closest('[data-later]')) {
      dismissed.add(p.id); mechEl.classList.remove('on'); mechPending = null;
      if (p.kind === 'mechanic') toast('Mechanic booking skipped. ' + trName(p.tractor) + ' stays down.');
      return;
    }
    const bk = e.target.closest('[data-book]');
    if (bk && !bk.classList.contains('busy')) {
      const m = mechOpts[msel]; if (!m) return;
      const bookT = st().clock ? st().clock.t : 0;
      ops.track(api.bookMechanic(p.tractor, m.id), { els: bk }).then((res) => {
        if (!res) return;
        const r = res.status ? res.result : res; // Operation (§13) or legacy body
        if (res.status && res.status !== 'succeeded') return; // failure already toasted
        dismissed.add(p.id); mechEl.classList.remove('on'); mechPending = null;
        const arr = r && r.arrival_t != null ? r.arrival_t : bookT + (m.eta_min || 45);
        const back = r ? (r.estimated_return_t ?? r.return_t ?? null) : null;
        island.moment({ text: 'Mechanic booked · arrives ' + clock(arr) + ' (est.)', dot: '#0A84FF', ms: 2600 });
        toast(m.name + ' booked · estimated arrival ' + clock(arr) + (back != null ? ' · estimated back ' + clock(back) : ''), null,
          onRepair ? { label: 'Mark repaired', onClick: (b) => onRepair(p.tractor, [b]) } : null);
        onBooked && onBooked(p.tractor, bookT, arr);
      });
      return;
    }
    const ap = e.target.closest('[data-ap]');
    if (ap && !ap.classList.contains('busy')) {
      const decision = ap.dataset.ap;
      ops.track(api.approve(p.id, decision), { els: ap }).then((res) => {
        if (!res || (res.status && res.status !== 'succeeded')) return;
        dismissed.add(p.id); mechEl.classList.remove('on'); mechPending = null;
        const v = res.result ? res.result.applied_plan_version : null;
        toast(decision === 'approve' ? (v != null ? 'Approved · plan v' + v + ' applied' : 'Approved · no new plan applied') : 'Proposal rejected · current plan kept');
      });
    }
  });

  // ---------------- Add tractor ----------------
  let addImpl = new Set(['sprayer']), addFuel = 80;
  function renderAdd() {
    const s = st(), cap = s.capacity;
    const full = !!(cap && cap.max != null && cap.used >= cap.max);
    addEl.innerHTML = '<div class="shead"><p>Add a tractor</p><button class="gbtn sm" data-x>Close</button></div>' +
      '<p class="sub">Implements</p><div class="chkrow">' + IMPLEMENTS.map((i) => '<label class="chk' + (addImpl.has(i) ? ' sel' : '') + '"><input type="checkbox" data-impl="' + i + '"' + (addImpl.has(i) ? ' checked' : '') + '>' + implName(i) + '</label>').join('') + '</div>' +
      '<div class="srow"><span style="width:78px">Starting fuel</span><input type="range" min="10" max="100" step="1" value="' + addFuel + '" data-fuel><b style="width:38px;text-align:right" data-fv>' + addFuel + '%</b></div>' +
      (cap && cap.max != null ? '<p class="sub">Fleet capacity: ' + esc(cap.used ?? '?') + ' of ' + esc(cap.max) + ' tractors' + (cap.warm ? ' · ' + esc(cap.warm) + ' ready to start fast' : '') + '</p>' : '') +
      (full ? '<p class="sub" style="color:#c93400">The fleet is full (' + esc(cap.max) + ' tractors). Remove a tractor before adding another.</p>' : '') +
      '<div style="display:flex;gap:8px;margin-top:6px"><button class="abtn" data-add' + (addImpl.size && !full ? '' : ' disabled') + '>Add tractor</button><button class="gbtn" data-x>Cancel</button></div>';
  }
  addEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) { addEl.classList.remove('on'); return; }
    const b = e.target.closest('[data-add]');
    if (b && !b.classList.contains('busy') && !b.disabled && addImpl.size) {
      const s = st(), fleet = s.fleet || [];
      // id omitted (backend assigns the lowest free Tn); name follows the same rule.
      const used = new Set(fleet.map((t) => String(t.id)));
      let next = 1; while (used.has('T' + next)) next++;
      const depot = (s.scenario && s.scenario.depot) || { x: 1, y: 6 };
      const entry = { name: 'Tractor ' + next, implements: IMPLEMENTS.filter((i) => addImpl.has(i)), fuel_pct: addFuel, speed: 1.0, start: { x: depot.x, y: depot.y }, endpoint: 'auto' };
      ops.track(api.addTractor(entry), { els: b }).then((res) => {
        if (!res) return; // error already toasted verbatim
        addEl.classList.remove('on');
        const t = res.tractor;
        toast((t ? (t.name || t.id) : entry.name) + ' starting at the depot…');
      });
    }
  });
  addEl.addEventListener('input', (e) => {
    if (e.target.matches('[data-fuel]')) { addFuel = +e.target.value; const v = addEl.querySelector('[data-fv]'); if (v) v.textContent = addFuel + '%'; }
  });
  addEl.addEventListener('change', (e) => {
    const i = e.target.dataset && e.target.dataset.impl;
    if (i) { if (e.target.checked) addImpl.add(i); else addImpl.delete(i); renderAdd(); }
  });

  return {
    openWhy,
    openAdd() { closeAll(addEl); whyJob = null; renderAdd(); addEl.classList.add('on'); },
    reset() { mechPending = null; closeAll(null); dismissed.clear(); shown.clear(); whyJob = null; },
    /** Close whatever sheet is open (keeps "Not now" dismissals; an auto-opened mechanic sheet won't re-pop). */
    close() { closeAll(null); whyJob = null; },
    /** Open the pending mechanic booking for a tractor on purpose (chip button). False if nothing is pending. */
    openMechanicFor(trId) {
      const p = (st().pending || []).find((x) => x && x.kind === 'mechanic' && x.tractor === trId);
      if (!p) return false;
      dismissed.delete(p.id); shown.add(p.id); openPending(p); return true;
    },
    /** The open sheet element, or null. */
    openEl() { return all.find((e) => e.classList.contains('on')) || null; },
    sync(state, allowPending = true) {
      if (whyJob && whyEl.classList.contains('on')) {
        const j = (state.jobs || []).find((x) => x.id === whyJob);
        const sig = j ? j.priority + j.status + (j.tractor || '') + (j.unassigned_reason || '') : 'x';
        if (sig !== whyEl._sig) { whyEl._sig = sig; renderWhy(); }
      }
      // pending items -> sheet: each pending item auto-opens at most once, one at a time, never over another
      // open sheet, and never once the day is over (the end-of-day card owns the screen then).
      const c = state.clock, dayOver = !!(c && (c.ended || (c.day_minutes && c.t >= c.day_minutes)));
      if (mechPending && !(state.pending || []).some((p) => p && p.id === mechPending.id)) { mechEl.classList.remove('on'); mechPending = null; }
      if (dayOver && mechPending) { shown.add(mechPending.id); mechEl.classList.remove('on'); mechPending = null; }
      const pend = (state.pending || []).filter((p) => p && !dismissed.has(p.id) && !shown.has(p.id));
      if (allowPending && !dayOver && !mechPending && pend.length && !all.some((e) => e.classList.contains('on'))) { shown.add(pend[0].id); openPending(pend[0]); }
    },
  };
}

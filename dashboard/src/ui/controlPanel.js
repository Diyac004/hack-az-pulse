// Tractor Control Panel ("cockpit"): glass side sheet with tabs, rendered from GET /tractors/{id}/controls
// (PROJECT.md Change 8, ARCHITECTURE.md §5 rows 13-16 + §13.2). Works for ANY tractor the backend lists, mock or
// a real AgOpenWeb container; it never assumes which controls exist.
//
// Truth rules: values shown are what the backend reports (GET /controls, then tractor.agopenweb flags from WS),
// never optimistic. After every change the panel re-reads /controls (sync 200), or waits for the Operation
// (replans:true, /manual -> 202) and re-reads when it ends. Errors are shown inside the panel in plain words.
import './controlPanel.css';
import { createWidget, isChipToggle, pickCount } from './controlWidgets.js';
import { esc, tractorColor, statusInfo, isDown, clock, plural, durText, implName } from '../lib/format.js';
import { errText, isTerminal } from '../lib/derive.js';

const TAB_ORDER = ['Drive', 'Guidance', 'Implement', 'Vehicle', 'Fleet', 'Advanced'];
const TAB_LABEL = { Implement: 'Implement', Vehicle: 'Vehicle', Fleet: 'Fleet', Advanced: 'Advanced', Drive: 'Drive', Guidance: 'Guidance' };
const isOp = (x) => !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.status === 'string' && 'kind' in x;
const DOWN_TEXT = { broken: 'broken down', awaiting_mechanic: 'waiting for a mechanic', repair_scheduled: 'waiting for its mechanic', repairing: 'being repaired', removing: 'leaving the fleet', offline: 'offline', starting: 'starting up' };
const unusable = (tr) => !!tr && (isDown(tr.status) || ['repairing', 'removing', 'offline', 'starting'].includes(tr.status));
const sign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(Math.round(n));

/** Plain-language error copy for the panel banner. */
export function controlErrorCopy(err, trName) {
  const code = err && err.code;
  const msg = (err && err.message) || '';
  switch (code) {
    case 'SAFETY_REJECTED': return { title: 'The Safety Agent refused this', text: msg || 'It breaks a safety rule.', kind: 'err' };
    case 'WEATHER_BLOCKED': return { title: 'Blocked by the weather', text: msg, kind: 'err' };
    case 'NEEDS_MANUAL': return { title: 'Needs manual control', text: msg || `Take manual control of ${trName} first.`, kind: 'warn', action: 'manual' };
    case 'CONFLICT': return { title: 'A re-plan is already running', text: 'Nothing was changed. Try again when the current re-plan finishes.' + (msg && !/re-plan is already running/i.test(msg) ? ' (' + msg + ')' : ''), kind: 'warn' };
    case 'TIMEOUT': return { title: 'That took too long', text: 'The planner could not work out the impact within 2 seconds, so nothing was changed. Try again in a moment.', kind: 'warn' };
    case 'GATEWAY_UNAVAILABLE': return { title: `Can't reach ${trName}`, text: `Its AgOpenWeb container is not answering, so the command was not sent and nothing changed. ${msg && !/container/i.test(msg) ? msg + ' ' : ''}Check that the container is running; the panel shows its last reported state.`, kind: 'err' };
    case 'NOT_FOUND': return { title: 'Not found', text: msg || 'That tractor or control no longer exists.', kind: 'err' };
    case 'INVALID_INPUT': return { title: "That value won't work", text: msg, kind: 'warn' };
    case 'AT_CAPACITY': return { title: 'At capacity', text: msg, kind: 'err' };
    default: return { title: "Couldn't do that", text: errText(err), kind: code === 'UNCONFIRMED' ? 'warn' : 'err' };
  }
}

/**
 * @param deps {
 *   stage, store, api, ops, toast,
 *   mapPick?: { pick({count, label, color}) -> Promise<value|null>, active },
 *   onOpen?(id)  (e.g. close other sheets / focus the tractor)
 * }
 */
export function createControlPanel({ stage, store, api, ops, toast, mapPick = null, onOpen = null, onClose = null }) {
  const el = document.createElement('aside');
  el.className = 'cp gl'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Tractor controls'); el.setAttribute('aria-hidden', 'true');
  el.innerHTML =
    '<header class="cp-hd"><i class="cp-dot"></i><div class="cp-tt"><b class="cp-name"></b><span class="cp-sub"></span></div>' +
    '<span class="cp-badge" hidden>Manual</span>' +
    '<button type="button" class="cp-x" aria-label="Close"><svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg></button></header>' +
    '<div class="cp-aow"><i></i><span></span></div>' +
    '<div class="cp-man"><button type="button" class="cp-manb"></button><p class="cp-mant"></p><p class="cp-stopped" hidden>Stopped. Press Drive this line or Faster to move.</p></div>' +
    '<nav class="cp-tabs" role="tablist"></nav>' +
    '<div class="cp-err" role="alert" hidden><div><b></b><p></p></div><div class="cp-erra"></div><button type="button" class="cp-errx" aria-label="Dismiss"><svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg></button></div>' +
    '<div class="cp-body"></div>' +
    '<div class="cp-dlg" hidden><div class="cp-scrim"></div><div class="cp-card" role="alertdialog" aria-modal="true" aria-labelledby="cp-dlg-t"></div></div>';
  stage.appendChild(el);
  const $ = (s) => el.querySelector(s);
  const E = { dot: $('.cp-dot'), name: $('.cp-name'), sub: $('.cp-sub'), badge: $('.cp-badge'), x: $('.cp-x'), aow: $('.cp-aow'), aowT: $('.cp-aow span'),
    manb: $('.cp-manb'), mant: $('.cp-mant'), stop: $('.cp-stopped'), tabs: $('.cp-tabs'), err: $('.cp-err'), errB: $('.cp-err b'), errP: $('.cp-err p'), errA: $('.cp-erra'), errX: $('.cp-errx'),
    body: $('.cp-body'), dlg: $('.cp-dlg'), card: $('.cp-card'), scrim: $('.cp-scrim') };

  let trId = null, schema = null, values = {}, tab = 'Drive', req = 0, loadErr = null, search = '';
  let widgets = new Map(), schemaSig = '', busyIds = new Set(), manualBusy = false, lastManual = null, picking = false;
  const st = () => store.get() || {};
  const tractor = () => (st().fleet || []).find((t) => t.id === trId) || null;
  const trName = () => { const t = tractor(); return (t && (t.name || t.id)) || trId || 'this tractor'; };

  // ---------------------------------------------------------------- open / close
  function open(id) {
    if (!id) return;
    const same = id === trId && el.classList.contains('on');
    if (!same) { drive.run++; drive.on = false; drive.msg = ''; trId = id; schema = null; values = {}; schemaSig = ''; widgets = new Map(); E.body.innerHTML = ''; busyIds.clear(); clearError(); closeDialog(); lastManual = null; search = ''; }
    el.classList.add('on'); el.setAttribute('aria-hidden', 'false');
    onOpen && onOpen(id);
    renderHead(); refresh();
  }
  function close() {
    el.classList.remove('on'); el.setAttribute('aria-hidden', 'true'); closeDialog();
    const a = document.activeElement; if (a && el.contains(a)) a.blur();
    if (picking && mapPick) mapPick.cancel();
    drive.run++; drive.on = false; drive.msg = '';
    trId = null;
    onClose && onClose();
  }
  E.x.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !el.classList.contains('on') || picking) return;
    if (!E.dlg.hidden) closeDialog(); else close();
  });
  // the stage blocks text selection / touch scrolling for the 3D canvas; the panel needs both
  ['pointerdown', 'wheel', 'touchstart'].forEach((t) => el.addEventListener(t, (e) => e.stopPropagation(), { passive: true }));

  // ---------------------------------------------------------------- server reads
  function refresh() {
    const id = trId; if (!id) return Promise.resolve();
    const my = ++req;
    return Promise.resolve(api.getControls(id)).then((body) => {
      if (my !== req || id !== trId) return;
      if (!body || !Array.isArray(body.controls)) throw { code: 'INTERNAL', message: 'The backend sent no control list.' };
      loadErr = null; schema = body.controls; values = body.values || {};
      render();
    }, (e) => {
      if (my !== req || id !== trId) return;
      if (schema) { showError(e); return; } // controls already on screen: keep the last reported values, say why
      loadErr = e; render();
    });
  }

  // ---------------------------------------------------------------- header
  function renderHead() {
    const tr = tractor(); const s = st();
    if (!tr) { E.name.textContent = trId || ''; E.sub.textContent = 'Not in the fleet any more'; E.manb.disabled = true; return; }
    const i = (s.fleet || []).indexOf(tr);
    E.dot.style.background = tractorColor(tr, i);
    if (E.name.textContent !== (tr.name || tr.id)) E.name.textContent = tr.name || tr.id;
    const info = statusInfo(tr.status), spd = tr.pose && isFinite(tr.pose.speed_mph) ? (+tr.pose.speed_mph).toFixed(1) + ' mph' : null;
    const sub = [tr.id, info.label, spd, isFinite(tr.fuel_pct) ? Math.round(tr.fuel_pct) + '% fuel' : null, (tr.implements || []).map(implName).join(' + ')].filter(Boolean).join(' · ');
    if (E.sub.textContent !== sub) E.sub.textContent = sub;
    E.badge.hidden = !tr.manual;
    el.classList.toggle('manual', !!tr.manual);
    // AgOpenWeb link: real reported state (Tick flags), or the simulated gateway
    const aw = tr.agopenweb;
    let cls = '', txt;
    if (!aw) { cls = 'sim'; txt = 'No AgOpenWeb link · simulated tractor, controls drive the simulation'; }
    else {
      const age = isFinite(aw.heartbeat_age_ms) ? aw.heartbeat_age_ms : null;
      const stale = !aw.connected || (age != null && age > 3000);
      cls = stale ? 'off' : 'on';
      const flag = (v, on, off) => (v === true ? on : v === false ? off : null);
      txt = stale ? `AgOpenWeb not responding${age != null ? ' (last heartbeat ' + (age / 1000).toFixed(1) + ' s ago)' : ''}. Controls may fail until it reconnects.`
        : ['AgOpenWeb connected', age != null ? 'heartbeat ' + Math.round(age) + ' ms' : null, flag(aw.autosteer, 'autosteer on', 'autosteer off'), flag(aw.section_master, 'sections auto', 'sections manual'), flag(aw.youturn, 'U-turns on', 'U-turns off')].filter(Boolean).join(' · ');
    }
    E.aow.className = 'cp-aow ' + cls; if (E.aowT.textContent !== txt) E.aowT.textContent = txt;
    // manual hero
    const down = unusable(tr);
    E.manb.textContent = tr.manual ? 'Hand back to AI' : 'Take manual control';
    E.manb.classList.toggle('back', !!tr.manual);
    E.manb.disabled = manualBusy || (!tr.manual && down);
    E.manb.classList.toggle('busy', manualBusy);
    const mt = manualBusy ? (tr.manual ? 'Handing back… the AI re-plans from where it stands.' : 'Taking control… its work moves to other tractors.')
      : down && !tr.manual ? `${tr.name || tr.id} is ${DOWN_TEXT[tr.status] || tr.status}; it can't be driven right now.`
        : tr.manual ? 'Out of AI planning. Drive and guidance controls are live. Handing back re-plans from where it is now; job progress is kept.'
          : 'The AI is driving. Driving and guidance controls need manual control; taking it moves this tractor\'s jobs to others.';
    const spd0 = !(tr.pose && +tr.pose.speed_mph > 0.05);
    const asOff = tr.agopenweb && typeof tr.agopenweb.autosteer === 'boolean' ? !tr.agopenweb.autosteer : values.autosteer === false;
    const stopped = tr.manual && !manualBusy && !down && spd0 && asOff && !drive.on;
    if (E.mant.textContent !== mt) E.mant.textContent = mt;
    E.stop.hidden = !stopped;
    if (drive.card) syncDriveCard();
  }
  E.manb.addEventListener('click', () => setManual());
  function setManual(on) {
    const tr = tractor(); if (!tr || manualBusy) return;
    const want = on === undefined ? !tr.manual : on;
    if (want === !!tr.manual) return;
    manualBusy = true; clearError(); renderHead(); renderBody();
    const id = trId;
    Promise.resolve(api.manual(id, want)).then((op) => {
      if (!isOp(op)) return op;
      return ops.track(Promise.resolve(op), { els: [], okText: (o) => o.message || (want ? 'Manual control on' : 'Back with the AI') });
    }).then((op) => {
      if (op && op.status === 'failed' && id === trId) showError(op.error || { code: 'INTERNAL', message: op.message });
    }, (e) => { if (id === trId) showError(e); })
      .finally(() => { manualBusy = false; if (id === trId) { renderHead(); refresh(); } });
  }

  // ---------------------------------------------------------------- errors
  function showError(e) {
    const c = controlErrorCopy(e, trName());
    E.err.hidden = false; E.err.className = 'cp-err ' + c.kind;
    E.errB.textContent = c.title; E.errP.textContent = c.text;
    E.errA.innerHTML = '';
    if (c.action === 'manual' && tractor() && !tractor().manual) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'cp-mini'; b.textContent = 'Take manual control';
      b.addEventListener('click', () => setManual(true)); E.errA.appendChild(b);
    }
    E.err.classList.remove('shake'); void E.err.offsetWidth; E.err.classList.add('shake');
  }
  function clearError() { E.err.hidden = true; }
  E.errX.addEventListener('click', clearError);

  // ---------------------------------------------------------------- tabs + body
  function tabsOf() { const have = new Set((schema || []).map((c) => c.tab)); return [...TAB_ORDER.filter((t) => have.has(t)), ...[...have].filter((t) => !TAB_ORDER.includes(t))]; }
  function render() {
    if (!el.classList.contains('on')) return;
    renderHead();
    if (!schema) {
      E.tabs.innerHTML = '';
      E.body.innerHTML = loadErr ? '' : '<p class="cp-empty">Loading controls…</p>';
      if (loadErr) {
        const c = controlErrorCopy(loadErr, trName());
        E.body.innerHTML = '<div class="cp-load"><b>' + esc(c.title) + '</b><p>' + esc(c.text) + '</p><button type="button" class="cp-mini">Try again</button></div>';
        E.body.querySelector('button').addEventListener('click', () => { loadErr = null; render(); refresh(); });
      }
      return;
    }
    const tabs = tabsOf();
    if (!tabs.includes(tab)) tab = tabs[0];
    el.dataset.tab = tab;
    const tsig = tabs.join('|');
    if (E.tabs._sig !== tsig) {
      E.tabs._sig = tsig;
      E.tabs.innerHTML = tabs.map((t) => '<button type="button" role="tab" data-t="' + esc(t) + '">' + esc(TAB_LABEL[t] || t) + '</button>').join('');
    }
    E.tabs.querySelectorAll('button').forEach((b) => { const on = b.dataset.t === tab; b.setAttribute('aria-selected', String(on)); b.classList.toggle('on', on); });
    renderBody();
  }
  E.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-t]'); if (!b || b.dataset.t === tab) return;
    tab = b.dataset.t; schemaSig = ''; E.body.scrollTop = 0; render();
  });

  /** state for one control: disabled + reason, busy */
  function stateOf(c, tr) {
    const busy = busyIds.has(c.id) || (c.replans && busyIds.has('*replan'));
    if (!tr) return { disabled: true, reason: 'This tractor left the fleet.', busy };
    if (manualBusy) return { disabled: true, reason: null, busy };
    if (c.needs_manual && unusable(tr)) return { disabled: true, reason: `${tr.name || tr.id} is ${DOWN_TEXT[tr.status] || tr.status}.`, busy };
    if (c.needs_manual && !tr.manual) return { disabled: true, reason: 'Needs manual control', busy };
    return { disabled: false, reason: null, busy };
  }

  // Simulated (mock) tractors have no AgOpenWeb behind them: say which settings only matter on real ones.
  const STORED = 'Applies on AgOpenWeb tractors — stored, no effect in simulation.';
  function simNote(tabName, group, tr) {
    if (!tr || tr.agopenweb) return null; // real AgOpenWeb tractor: every setting is live
    if (tabName === 'Vehicle') return group === 'Steering' ? 'In simulation only Max steer angle is used (it limits autosteer). ' + STORED : STORED;
    if (tabName === 'Advanced') return STORED;
    if (tabName === 'Implement' && group === 'Setup') return 'In simulation, Sections × Section width sets the implement bar and the painted stripe. The rest applies on AgOpenWeb tractors.';
    return null;
  }

  function groupsOf(list) {
    const out = []; let cur = null;
    for (const c of list) {
      const g = c.group || null;
      if (!cur || cur.name !== g) { cur = { name: g, items: [] }; out.push(cur); }
      cur.items.push(c);
    }
    return out;
  }

  function renderBody() {
    if (!schema || !trId) return;
    const tr = tractor();
    let list = schema.filter((c) => c.tab === tab);
    const searchable = tab === 'Advanced' || list.length > 24;
    if (searchable && search) { const q = search.toLowerCase(); list = list.filter((c) => (c.label + ' ' + (c.help || '') + ' ' + c.id).toLowerCase().includes(q)); }
    const sig = tab + '|' + search + '|' + list.map((c) => c.id + ':' + c.type + ':' + JSON.stringify(c.options) + c.min + c.max + c.label).join(',');
    if (sig !== schemaSig) {
      schemaSig = sig;
      const keepSearch = E.body.querySelector('.cp-search input');
      const hadFocus = keepSearch && document.activeElement === keepSearch;
      E.body.innerHTML = ''; widgets = new Map();
      if (searchable) {
        const s = document.createElement('div'); s.className = 'cp-search';
        s.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg><input type="search" placeholder="Search ' + plural(schema.filter((c) => c.tab === tab).length, 'setting') + '" aria-label="Search settings">';
        const inp = s.querySelector('input'); inp.value = search;
        inp.addEventListener('input', () => { search = inp.value; renderBody(); });
        E.body.appendChild(s);
        if (hadFocus) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
      }
      // tab-level lock note: one sentence + action instead of a reason under every control
      const lock = document.createElement('div'); lock.className = 'cp-lock'; E.body.appendChild(lock);
      drive.card = null;
      if (tab === 'Guidance' && canDriveLine()) { drive.card = driveCardEl(); E.body.appendChild(drive.card); }
      for (const g of groupsOf(list)) {
        const sec = document.createElement('section'); sec.className = 'cp-g';
        if (g.name) { const h = document.createElement('h3'); h.textContent = g.name; sec.appendChild(h); }
        const note = simNote(tab, g.name, tr);
        if (note) { const n = document.createElement('p'); n.className = 'cp-simnote'; n.textContent = note; sec.appendChild(n); }
        let row = null, rowKind = null;
        for (const c of g.items) {
          const w = createWidget(c, { onChange: change, onPick: pick });
          widgets.set(c.id, w);
          const kind = isChipToggle(c) ? 'chips' : c.type === 'button' ? 'btns' : null;
          if (kind) {
            if (rowKind !== kind) { row = document.createElement('div'); row.className = 'cp-' + kind; sec.appendChild(row); rowKind = kind; }
            row.appendChild(w.el);
          } else { rowKind = null; sec.appendChild(w.el); }
        }
        E.body.appendChild(sec);
      }
      if (!list.length) { const p = document.createElement('p'); p.className = 'cp-empty'; p.textContent = search ? 'No setting matches "' + search + '".' : 'Nothing to change here.'; E.body.appendChild(p); }
    }
    // values + states (in place; skip the widget being typed in or dragged)
    let locked = 0;
    for (const [id, w] of widgets) {
      const s = stateOf(w.control, tr);
      if (s.disabled && s.reason === 'Needs manual control') locked++;
      if (w.focused() && !s.busy) continue;
      w.update(values[id], { ...s, groupReason: s.reason === 'Needs manual control' });
    }
    const lock = E.body.querySelector('.cp-lock');
    if (lock) {
      const show = locked > 0 && tr && !tr.manual;
      lock.hidden = !show;
      if (show && !lock._on) {
        lock.innerHTML = '<p>' + (locked === widgets.size ? 'These controls need manual control.' : plural(locked, 'control') + ' here need manual control.') + '</p><button type="button" class="cp-mini">Take manual control</button>';
        lock.querySelector('button').addEventListener('click', () => setManual(true));
      }
      lock._on = show;
    }
    if (drive.card) syncDriveCard();
  }

  // ---------------------------------------------------------------- "Drive this line"
  // Real AgOpenWeb starts at 0 speed with autosteer off and has no set-speed command, so a fresh AB line leaves
  // the tractor parked. This turns autosteer on (the schema's `autosteer` toggle) and taps the schema's
  // `speed_up` button (~5/s, waiting for the reported speed to move) until pose.speed_mph reaches the target.
  const drive = { card: null, on: false, run: 0, target: 4.5, msg: '' };
  const has = (id) => !!(schema && schema.some((c) => c.id === id));
  const canDriveLine = () => has('autosteer') && has('speed_up');
  const lineActive = () => { const v = values.ab_line; return Array.isArray(v) ? v.length >= 2 : !!v || !!values.ab_select; };
  const speedNow = () => { const t = tractor(); return t && t.pose && isFinite(t.pose.speed_mph) ? +t.pose.speed_mph : 0; };
  function driveCardEl() {
    const d = document.createElement('div'); d.className = 'cp-drive';
    d.innerHTML = '<div class="cp-drive-row"><button type="button" class="cp-drive-go">Drive this line</button>' +
      '<div class="cp-drive-sp" title="Target speed"><button type="button" data-d="-0.5" aria-label="Slower target"><svg viewBox="0 0 12 12"><path d="M2.5 6h7"/></svg></button>' +
      '<span><b></b><small>mph</small></span><button type="button" data-d="0.5" aria-label="Faster target"><svg viewBox="0 0 12 12"><path d="M2.5 6h7M6 2.5v7"/></svg></button></div>' +
      '<button type="button" class="cp-drive-stop">Stop</button></div><p class="cp-drive-msg"></p>';
    d.querySelector('.cp-drive-go').addEventListener('click', driveLine);
    d.querySelector('.cp-drive-stop').addEventListener('click', stopLine);
    d.querySelectorAll('.cp-drive-sp button').forEach((b) => b.addEventListener('click', () => { drive.target = Math.max(1, Math.min(10, Math.round((drive.target + +b.dataset.d) * 2) / 2)); syncDriveCard(); }));
    return d;
  }
  function syncDriveCard() {
    const d = drive.card; if (!d || !d.isConnected) return;
    const tr = tractor(); const ok = !!tr && tr.manual && !unusable(tr) && !manualBusy;
    d.hidden = !lineActive() || !tr || !tr.manual;
    d.querySelector('.cp-drive-sp b').textContent = drive.target.toFixed(1);
    const go = d.querySelector('.cp-drive-go'); go.disabled = !ok || drive.on; go.classList.toggle('busy', drive.on);
    d.querySelector('.cp-drive-stop').disabled = !ok;
    const msg = drive.on ? drive.msg : drive.msg || (speedNow() > 0.05 ? 'Moving at ' + speedNow().toFixed(1) + ' mph' + (values.autosteer ? ' on autosteer.' : '.') : 'Autosteer on, then speeds up to the target.');
    const m = d.querySelector('.cp-drive-msg'); if (m.textContent !== msg) m.textContent = msg;
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function driveLine() {
    if (drive.on || !trId) return;
    const id = trId, my = ++drive.run; drive.on = true; clearError();
    const alive = () => drive.run === my && trId === id && drive.on;
    const say = (t) => { drive.msg = t; syncDriveCard(); renderHead(); };
    try {
      if (values.autosteer !== true && !(tractor() && tractor().agopenweb && tractor().agopenweb.autosteer === true)) {
        say('Turning autosteer on…');
        await api.control(id, { control: 'autosteer', value: true });
        await refresh();
      }
      const target = drive.target, t0 = Date.now();
      let presses = 0;
      while (alive() && speedNow() < target - 0.05) {
        if (presses > 60 || Date.now() - t0 > 30000) throw { code: 'INTERNAL', message: `Speed stayed at ${speedNow().toFixed(1)} mph after ${presses} presses. The tractor may not be responding.` };
        const before = speedNow();
        say(`Speeding up… ${before.toFixed(1)} → ${target.toFixed(1)} mph`);
        await api.control(id, { control: 'speed_up', value: null }); presses++;
        // ~5 presses a second, but wait (up to 1 s) for the reported speed to move so lag can't overshoot much
        const until = Date.now() + 1000; await wait(200);
        while (alive() && speedNow() <= before + 1e-6 && Date.now() < until) await wait(100);
      }
      if (alive()) say(`Driving the line at ${speedNow().toFixed(1)} mph.`);
    } catch (e) { if (trId === id) { showError(e); drive.msg = ''; } }
    finally { if (drive.run === my) { drive.on = false; syncDriveCard(); renderHead(); if (trId === id) refresh(); } }
  }
  function stopLine() {
    drive.run++; drive.on = false; drive.msg = 'Stopping…'; syncDriveCard();
    const id = trId; if (!id) return;
    Promise.resolve(api.control(id, { control: 'stop', value: null })).then(() => { if (trId === id) { drive.msg = 'Stopped.'; refresh(); syncDriveCard(); } }, (e) => { if (trId === id) { drive.msg = ''; showError(e); } });
  }

  // ---------------------------------------------------------------- changes
  function change(c, value) {
    if (!trId) return;
    clearError();
    if (c.replans) return previewThenApply(c, value);
    send(c, value);
  }

  function send(c, value) {
    if (c.type === 'map_pick' && pickCount(c) === 2) drive.msg = '';
    const id = trId, w = widgets.get(c.id);
    busyIds.add(c.id); if (c.replans) busyIds.add('*replan'); renderBody();
    const done = () => { busyIds.delete(c.id); if (c.replans) busyIds.delete('*replan'); };
    return Promise.resolve(api.control(id, { control: c.id, value })).then((res) => {
      if (isOp(res)) {
        // §13.2 replans:true -> 202 Operation. Spinner until it ends; the usual outcome toast comes from ops.
        return ops.track(Promise.resolve(res), { els: [], okText: (op) => op.message || c.label + ' updated' }).then((op) => {
          if (op && op.status === 'failed' && id === trId) showError(op.error || { code: 'INTERNAL', message: op.message });
          if (op && op.status === 'superseded' && id === trId) showError({ code: 'CONFLICT', message: 'Replaced by a newer request.' });
        });
      }
      return res;
    }).then(() => { done(); if (id === trId) return Promise.resolve(refresh()).then(() => savedTick(c.id)); }, (e) => {
      done(); if (id !== trId) return;
      if (w) w.revert();
      showError(e); renderBody();
    });
  }

  // subtle confirmation after the value was re-read from the backend
  function savedTick(cid) {
    const w = widgets.get(cid); if (!w || !w.el || !w.el.isConnected) return;
    let t = w.el.querySelector(':scope > .cp-saved');
    if (!t) { t = document.createElement('span'); t.className = 'cp-saved'; t.setAttribute('role', 'status'); w.el.appendChild(t); }
    t.textContent = '\u2713 Saved'; t.classList.remove('on'); void t.offsetWidth; t.classList.add('on');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 1600);
  }

  // ---------------------------------------------------------------- map pick
  function pick(c) {
    if (!mapPick) { showError({ code: 'INVALID_INPUT', message: 'Map picking is not available here.' }); return; }
    const tr = tractor(); const i = (st().fleet || []).indexOf(tr);
    picking = true; el.classList.add('picking');
    const id = trId;
    // the panel slides fully out of the way while picking; the pick hint says who it is for and offers Cancel
    Promise.resolve(mapPick.pick({ count: pickCount(c), label: c.label, color: tractorColor(tr, i), who: (tr && (tr.name || tr.id)) || trId })).then((v) => {
      picking = false; el.classList.remove('picking');
      if (v == null || id !== trId) return;
      change(c, v);
    }, () => { picking = false; el.classList.remove('picking'); });
  }

  // ---------------------------------------------------------------- preview confirm dialog
  let dlgReq = 0;
  function closeDialog() { E.dlg.hidden = true; el.classList.remove('dlg'); dlgReq++; }
  E.scrim.addEventListener('click', closeDialog);
  function dialog(html) { E.card.innerHTML = html; E.dlg.hidden = false; el.classList.add('dlg'); }
  function previewThenApply(c, value) {
    const id = trId, my = ++dlgReq;
    const valueText = Array.isArray(value) ? value.map((v) => optText(c, v)).join(' + ') : c.type === 'button' ? '' : optText(c, value);
    const head = '<h4 id="cp-dlg-t">' + esc(c.type === 'button' ? c.label : c.label + ': ' + valueText) + '</h4>';
    dialog(head + '<p class="cp-dlg-load"><span class="cp-spin"></span>Working out what changes…</p><div class="cp-dlg-act"><button type="button" class="gbtn" data-x>Cancel</button></div>');
    E.card.querySelector('[data-x]').addEventListener('click', closeDialog);
    busyIds.add(c.id); renderBody();
    Promise.resolve(api.preview(id, { control: c.id, value })).then((pv) => {
      busyIds.delete(c.id); renderBody();
      if (my !== dlgReq || id !== trId) return;
      if (!pv || pv.allowed === false) {
        dialog(head + '<div class="cp-refuse"><b>The Safety Agent refused this</b><p>' + esc((pv && pv.refused_reason) || 'It breaks a safety rule.') + '</p></div><div class="cp-dlg-act"><button type="button" class="abtn" data-x>OK</button></div>');
        E.card.querySelector('[data-x]').addEventListener('click', closeDialog);
        widgets.get(c.id)?.revert();
        return;
      }
      dialog(head + impactHtml(pv) + '<div class="cp-dlg-act"><button type="button" class="gbtn" data-x>Cancel</button><button type="button" class="abtn" data-ok>Apply and re-plan</button></div>');
      E.card.querySelector('[data-x]').addEventListener('click', () => { closeDialog(); widgets.get(c.id)?.revert(); });
      const okB = E.card.querySelector('[data-ok]');
      okB.focus({ preventScroll: true });
      okB.addEventListener('click', () => { closeDialog(); send(c, value); });
    }, (e) => {
      busyIds.delete(c.id); renderBody();
      if (my !== dlgReq || id !== trId) return;
      widgets.get(c.id)?.revert();
      const cc = controlErrorCopy(e, trName());
      dialog(head + '<div class="cp-refuse ' + cc.kind + '"><b>' + esc(cc.title) + '</b><p>' + esc(cc.text) + '</p></div><div class="cp-dlg-act"><button type="button" class="gbtn" data-x>Close</button>' +
        (e && (e.code === 'TIMEOUT' || e.code === 'CLIENT_TIMEOUT' || e.code === 'NETWORK') ? '<button type="button" class="abtn" data-retry>Try again</button>' : '') + '</div>');
      E.card.querySelector('[data-x]').addEventListener('click', closeDialog);
      const r = E.card.querySelector('[data-retry]'); if (r) r.addEventListener('click', () => previewThenApply(c, value));
    });
  }
  function optText(c, v) {
    const o = (c.options || []).find((x) => x.value === v || (x.value == null && v == null));
    if (o) return o.label;
    if (v != null && typeof v === 'object') return 'picked point';
    return v == null ? 'none' : String(v) + (c.unit ? ' ' + c.unit : '');
  }
  function impactHtml(pv) {
    const s = st(); const jobs = new Map((s.jobs || []).map((j) => [j.id, j]));
    const name = (id) => { const t = (s.fleet || []).find((x) => x.id === id); return (t && (t.name || t.id)) || id || 'no tractor'; };
    const jl = (id) => (jobs.get(id) && jobs.get(id).label) || id;
    const ex = pv.explanation || null, f = (ex && ex.facts) || {}, md = pv.metrics_delta || {}, diff = (pv.plan && pv.plan.diff) || {};
    let h = ex && ex.text ? '<p class="cp-dlg-txt">' + esc(ex.text) + '</p>' : '';
    const tiles = [['travel_min', 'Travel', 'min'], ['idle_min', 'Idle', 'min'], ['late_jobs', 'Late jobs', '']].filter(([k]) => isFinite(md[k]));
    if (tiles.length) {
      h += '<div class="cp-tiles">' + tiles.map(([k, l, u]) => {
        const v = +md[k], cls = v > 0 ? 'worse' : v < 0 ? 'better' : '';
        return '<div class="' + cls + '"><span>' + l + '</span><b>' + sign(v) + (u ? '<small> ' + u + '</small>' : '') + '</b></div>';
      }).join('') + '</div>';
    }
    const moved = Array.isArray(diff.moved) && diff.moved.length ? diff.moved : Array.isArray(f.moved) ? f.moved : [];
    if (moved.length) h += '<p class="cp-dlg-h">' + plural(moved.length, 'job') + ' move</p><ul class="cp-list">' + moved.slice(0, 6).map((m) => '<li><b>' + esc(jl(m.job)) + '</b> ' + esc(m.from ? name(m.from) : 'unassigned') + ' → ' + esc(name(m.to)) + (m.progress_kept > 0 ? ' <small>(' + Math.round(m.progress_kept * 100) + '% kept)</small>' : '') + '</li>').join('') + (moved.length > 6 ? '<li><small>and ' + (moved.length - 6) + ' more</small></li>' : '') + '</ul>';
    // only jobs that would LOSE their tractor (already-unassigned work is not an impact of this change)
    const lost = (f.unassigned || []).filter((u) => u && u.job && jobs.get(u.job) && jobs.get(u.job).tractor);
    if (lost.length) h += '<p class="cp-dlg-h">' + plural(lost.length, 'job') + ' without a tractor</p><ul class="cp-list warn">' + lost.slice(0, 4).map((u) => '<li><b>' + esc(jl(u.job)) + '</b> ' + esc(u.reason || '') + '</li>').join('') + '</ul>';
    const late = (f.context && Array.isArray(f.context.newly_late) ? f.context.newly_late : f.deadlines_missed) || [];
    if (late.length) {
      const fin = new Map(); for (const e of (pv.plan && pv.plan.entries) || []) if (e.kind === 'work' && e.job) fin.set(e.job, Math.max(fin.get(e.job) || 0, e.end_t));
      h += '<p class="cp-dlg-h">Deadlines affected</p><ul class="cp-list warn">' + late.slice(0, 4).map((id) => { const j = jobs.get(id); const e = fin.get(id); return '<li><b>' + esc(jl(id)) + '</b> ' + (j && e != null ? 'finishes ' + esc(clock(e)) + ', ' + esc(durText(e - j.deadline_t)) + ' after its ' + esc(clock(j.deadline_t)) + ' deadline' : 'misses its deadline') + '</li>'; }).join('') + '</ul>';
    }
    if (!moved.length && !lost.length && !late.length && !ex) h += '<p class="cp-dlg-txt">No other job changes.</p>';
    h += '<p class="cp-dlg-foot">Preview only. Nothing changes until you apply.</p>';
    return h;
  }

  // ---------------------------------------------------------------- live updates
  store.subscribe((state, msg) => {
    if (!trId || !msg) return;
    const t = msg.type;
    if (t === 'fleet' || t === 'poses' || t === 'snapshot') {
      const tr = tractor();
      if (!tr) { renderHead(); if (t !== 'poses') renderBody(); return; }
      // the tractor's own reported flags (Tick truth) override what /controls said a moment ago
      const aw = tr.agopenweb;
      let changed = false;
      if (aw && schema) {
        const set = (k, v) => { if (v !== undefined && v !== null && values[k] !== undefined && values[k] !== v) { values[k] = v; changed = true; } };
        set('autosteer', aw.autosteer); set('youturn', aw.youturn);
        if (typeof aw.section_master === 'boolean') set('section_master', aw.section_master ? 'auto' : 'manual');
      }
      if (lastManual !== null && lastManual !== !!tr.manual) { lastManual = !!tr.manual; refresh(); }
      lastManual = !!tr.manual;
      headDirty = true; if (changed || t !== 'poses') bodyDirty = true;
    }
    if (t === 'snapshot') refresh(); // new run / reconnect: the backend's state may have reset
    if (t === 'operation' && msg.data && isTerminal(msg.data) && (msg.data.source === 'control' || msg.data.source === 'manual')) refresh();
    // pin options list unfinished jobs: re-read only when a job finishes, never on routine progress/pose traffic
    if (t === 'jobs' && schema && msg.data && (msg.data.jobs || []).some((j) => j.status === 'done' || j.status === 'dropped')) refreshSoon();
  });
  let headDirty = false, bodyDirty = false, soon = null;
  const refreshSoon = () => { if (!soon) soon = setTimeout(() => { soon = null; refresh(); }, 1500); };

  return {
    open, close,
    get id() { return el.classList.contains('on') ? trId : null; },
    el,
    /** throttled DOM sync from the main loop */
    sync() {
      if (!trId) return;
      if (headDirty) { headDirty = false; renderHead(); }
      if (bodyDirty) { bodyDirty = false; renderBody(); }
    },
    _debug: { get values() { return values; }, get schema() { return schema; }, showError },
  };
}

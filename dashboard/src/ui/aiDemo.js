// "▶ AI demo": one click plays data/demoScript.js (every agent + the AI Supervisor, on cue) with a caption pill
// above the dock for the presenter. Only offered on the in-browser Mock or a connected Node mock-backend
// (capabilities.backend), never on the FastAPI backend or the AgOpenWeb bridge.
// The UI side of the script lives here: button, caption pill, progress dots, and the small page helpers the
// script needs (speed chips, 3D/Map toggle, mechanic sheet, AI Supervisor sheet). No other module is changed.
import './aiDemo.css';
import { esc } from '../lib/format.js';
import { DEMO_STEPS, createDemoRunner } from '../data/demoScript.js';

const svg = (d) => '<svg viewBox="0 0 16 16" aria-hidden="true">' + d + '</svg>';
const ICON = {
  play: svg('<path d="M5 3.2v9.6l7.6-4.8z"/>'),
  pause: svg('<rect x="4" y="3" width="2.6" height="10" rx=".8"/><rect x="9.4" y="3" width="2.6" height="10" rx=".8"/>'),
  stop: svg('<rect x="4" y="4" width="8" height="8" rx="1.4"/>'),
  restart: svg('<path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.78M2.5 2.5v3h3"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
};

export function createAiDemo({ stage, store, api, ops, sourceInfo, capabilities, sheets, viewToggle }) {
  const $ = (sel, root = document) => root.querySelector(sel);
  const st = () => store.get() || {};

  // ---- entry button (Run row, before the view icons)
  const btn = document.createElement('button');
  btn.type = 'button'; btn.id = 'bDemo'; btn.className = 'cb-chip cb-demo';
  btn.innerHTML = ICON.play + '<span class="cb-lbl">AI demo</span>';
  btn.title = 'Play a ~75 s scripted demo of everything the AI handles, with captions';
  const view = $('#cbView');
  if (view) view.insertBefore(btn, view.firstChild); else ($('.cb-run') || document.body).appendChild(btn);

  // ---- caption pill
  const pill = document.createElement('div');
  pill.id = 'aidemo'; pill.className = 'gl aidemo'; pill.setAttribute('role', 'region'); pill.setAttribute('aria-label', 'AI demo');
  pill.innerHTML = '<div class="adm-top"><ol class="adm-dots" aria-hidden="true"></ol><span class="adm-step"></span>' +
    '<span class="adm-btns"><button type="button" class="adm-b" data-pp></button><button type="button" class="adm-b" data-stop title="Stop demo" aria-label="Stop demo">' + ICON.stop + '</button>' +
    '<button type="button" class="adm-b adm-txt" data-restart>' + ICON.restart + '<span>Restart</span></button><button type="button" class="adm-b" data-close title="Close" aria-label="Close">' + ICON.close + '</button></span></div>' +
    '<p class="adm-cap" aria-live="polite"></p><p class="adm-det"></p>';
  stage.appendChild(pill);
  const dotsEl = $('.adm-dots', pill), stepEl = $('.adm-step', pill), capEl = $('.adm-cap', pill), detEl = $('.adm-det', pill);
  const bPP = $('[data-pp]', pill), bStop = $('[data-stop]', pill), bRestart = $('[data-restart]', pill), bClose = $('[data-close]', pill);

  // ---- page helpers for the script
  let switchedFrom = null; // view to restore if the demo is stopped while it shows the Map
  const clickIf = (el) => { if (el && !el.disabled) { el.click(); return true; } return false; };
  const setSpeed = (n) => {
    const b = $(n > 1 ? '#bFast' : '#bSpd1');
    if (!clickIf(b)) api.setClock({ playing: true, speed: n }).catch(() => {});
  };
  const setView = (v) => {
    if (!viewToggle || viewToggle.view === v) return;
    if (switchedFrom == null) switchedFrom = viewToggle.view;
    const b = viewToggle.el.querySelector('[data-v="' + v + '"]');
    if (b) b.click(); // keyboard-style click: goes through the toggle like a user press
    if (v === switchedFrom) switchedFrom = null;
  };
  const mechEl = () => document.getElementById('mech');
  const mech = {
    isOpen: () => { const m = mechEl(); return !!(m && m.classList.contains('on') && m.querySelector('[data-book]')); },
    open: (id) => sheets && sheets.openMechanicFor && sheets.openMechanicFor(id),
    options() {
      const m = mechEl(); if (!m || !m.classList.contains('on')) return null;
      const cards = [...m.querySelectorAll('.mc')];
      const p = (st().pending || []).find((x) => x && x.kind === 'mechanic');
      const data = (p && p.options) || [];
      return cards.map((c) => {
        const name = (c.querySelector('b') || {}).textContent || '';
        const o = data.find((x) => x.name === name) || {};
        return { name, recommended: !!c.querySelector('.bdg.g'), reason: o.reason || null, id: o.id || null, eta_min: o.eta_min ?? null };
      });
    },
    select: (i) => clickIf(mechEl() && mechEl().querySelector('.mc[data-i="' + i + '"]')),
    book: () => clickIf(mechEl() && mechEl().querySelector('[data-book]')),
  };
  const aiSheet = () => document.getElementById('aisheet');
  let hlId = null;
  const ai = {
    openSheet() { const s = aiSheet(); if (!(s && s.classList.contains('on'))) clickIf($('.aicard [data-open]')); },
    closeSheet() { const s = aiSheet(); if (s && s.classList.contains('on')) clickIf($('.aicard [data-open]')); },
    highlight(id) { hlId = id; applyHl(); },
    approve(id) { const s = aiSheet(); return clickIf(s && s.querySelector('[data-approve][data-id="' + CSS.escape(id) + '"]')); },
    flashPlots(on) { document.body.classList.toggle('aidemo-plots', !!on); },
  };
  function applyHl() {
    const s = aiSheet(); if (!s) return;
    const b = hlId ? s.querySelector('[data-approve][data-id="' + CSS.escape(hlId) + '"]') : null;
    const card = b ? b.closest('.aif') : null;
    s.querySelectorAll('.aif.aidemo-hl').forEach((x) => { if (x !== card) x.classList.remove('aidemo-hl'); });
    if (card && !card.classList.contains('aidemo-hl')) {
      card.classList.add('aidemo-hl');
      // keep the card in view inside the sheet without scrolling #stage
      const top = card.offsetTop - 8, bot = card.offsetTop + card.offsetHeight + 8;
      if (top < s.scrollTop || bot > s.scrollTop + s.clientHeight) s.scrollTop = Math.max(0, top - 40);
    }
  }

  const ctx = {
    api, state: st, caps: () => capabilities.get(),
    track: (p) => ops.track(p),
    setSpeed, setView, view: () => (viewToggle ? viewToggle.view : 'sim'), mech, ai,
    onPause: () => api.setClock({ playing: false }).catch(() => {}),
    onResume: () => api.setClock({ playing: true }).catch(() => {}),
    onStop: () => { cleanup(); setSpeed(1); },
    onFinish: () => { cleanup(false); },
  };
  function cleanup(restoreView = true) {
    ai.highlight(null); ai.flashPlots(false);
    if (restoreView && switchedFrom != null) setView(switchedFrom);
    switchedFrom = null;
  }

  const runner = createDemoRunner({ steps: DEMO_STEPS, ctx, onUpdate: render });

  // ---- render
  function render(v) {
    const on = v.status === 'playing' || v.status === 'paused' || v.status === 'done';
    pill.classList.toggle('on', on);
    document.body.classList.toggle('aidemo-on', on);
    btn.setAttribute('aria-pressed', String(v.status === 'playing' || v.status === 'paused'));
    btn.querySelector('.cb-lbl').textContent = v.status === 'playing' ? 'Demo running' : v.status === 'paused' ? 'Demo paused' : 'AI demo';
    dotsEl.innerHTML = v.steps.map((s, i) => '<li class="' + s.state + (i === v.index && v.status !== 'done' ? ' cur' : '') + '" title="' + esc(s.title) + '"></li>').join('');
    stepEl.textContent = v.status === 'done' ? 'Demo complete' : v.index >= 0 ? (v.index + 1) + ' of ' + v.steps.length + ' · ' + v.steps[v.index].title : '';
    const c = v.caption || {};
    if (capEl.textContent !== (c.text || '')) { capEl.textContent = c.text || ''; pill.classList.remove('adm-pop'); void pill.offsetWidth; pill.classList.add('adm-pop'); }
    detEl.textContent = c.detail || ''; detEl.hidden = !c.detail;
    pill.classList.toggle('skip', c.tone === 'skip'); pill.classList.toggle('err', c.tone === 'err');
    const running = v.status === 'playing' || v.status === 'paused';
    bPP.hidden = !running; bStop.hidden = !running; bRestart.hidden = v.status !== 'done'; bClose.hidden = v.status !== 'done';
    bPP.innerHTML = v.status === 'paused' ? ICON.play : ICON.pause;
    bPP.title = v.status === 'paused' ? 'Resume demo' : 'Pause demo'; bPP.setAttribute('aria-label', bPP.title);
    place();
  }
  btn.addEventListener('click', () => {
    const s = runner.status;
    if (s === 'playing') runner.pause(); else runner.play();
  });
  bPP.addEventListener('click', () => (runner.status === 'paused' ? runner.play() : runner.pause()));
  bStop.addEventListener('click', () => runner.stop());
  bRestart.addEventListener('click', () => runner.play());
  bClose.addEventListener('click', () => { pill.classList.remove('on'); document.body.classList.remove('aidemo-on'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (runner.status === 'playing' || runner.status === 'paused')) runner.stop(); });

  // ---- placement: above the dock, or above whatever sheet is open (#aisheet included); never under the chips
  let lastPos = '';
  function place() {
    if (!pill.classList.contains('on')) return;
    const r = stage.getBoundingClientRect();
    const dock = document.getElementById('dock');
    let bottom = dock ? r.bottom - dock.getBoundingClientRect().top + 10 : 160;
    for (const sh of stage.querySelectorAll('.sheet.on')) bottom = Math.max(bottom, r.bottom - sh.getBoundingClientRect().top + 10);
    const h = pill.offsetHeight || 64;
    const chipsB = parseFloat(getComputedStyle(stage).getPropertyValue('--chipsb')) || 0;
    bottom = Math.min(bottom, Math.max(10, r.height - chipsB - h - 4));
    const key = Math.round(bottom) + '|' + h;
    if (key === lastPos) return;
    lastPos = key;
    pill.style.bottom = Math.round(bottom) + 'px';
    document.body.style.setProperty('--aidemo-h', h + 'px');
    document.body.style.setProperty('--aidemo-b', Math.round(bottom + h + 8) + 'px');
  }
  setInterval(() => { if (pill.classList.contains('on')) { place(); applyHl(); } }, 200);
  window.addEventListener('resize', () => { lastPos = ''; place(); });

  // ---- visibility: in-browser Mock, or Live on our Node mock-backend (after capability detection says so)
  const allowed = (c) => sourceInfo.kind === 'mock' || (sourceInfo.kind === 'live' && !sourceInfo.error && c && c.backend === 'mock-backend');
  capabilities.subscribe((c) => {
    const ok = allowed(c);
    btn.hidden = !ok;
    if (!ok) runner.stop();
  });

  render(runner.view);
  return { runner, get status() { return runner.status; } };
}

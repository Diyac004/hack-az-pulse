// Mock | Live mode switch (top-right of the stage, replaces the MOCK/LIVE badge).
//   Mock = in-browser simulation, every feature on ("Simulation — full feature showcase").
//   Live = a connected backend (default Anay's FastAPI planner on :8000), capability-detected as before.
// Switching rewrites ?source= / ?api= and reloads (the data layer picks its source once, at load). Plain
// ?source=live&api=... URLs keep working; the switch only edits them. The Live URL is remembered per browser.
import { esc } from '../lib/format.js';
import './modeSwitch.css';

export const DEFAULT_LIVE_API = 'http://localhost:8000';
const LS_KEY = 'hf.liveApi';
export const PRESETS = [
  { name: 'Planner backend (FastAPI)', url: 'http://localhost:8000', hint: "Anay's planner: real scheduler, re-planning and scorecard" },
  { name: 'AgOpenWeb bridge', url: 'http://localhost:8040', hint: 'Real AgOpenWeb tractors; no scheduler, no scorecard' },
  { name: 'Simulated backend (mock-backend)', url: 'http://localhost:8001', hint: 'Node mock-backend: start it with PORT=8001 npm start' },
];

const lsGet = () => { try { return globalThis.localStorage.getItem(LS_KEY); } catch { return null; } };
const lsSet = (v) => { try { globalThis.localStorage.setItem(LS_KEY, v); } catch { /* private window etc. */ } };
const validUrl = (u) => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } };

/** URL for a mode: keeps every other query param (pace, etc.). */
export function modeHref(loc, kind, api) {
  const u = new URL(loc.href);
  if (kind === 'live') { u.searchParams.set('source', 'live'); u.searchParams.set('api', api); }
  else { u.searchParams.delete('source'); u.searchParams.delete('api'); }
  return u.toString();
}

/** Caption under the segments: what this mode is, honestly. */
export function modeCaption(kind, backend) {
  if (kind !== 'live') return 'Simulation — full feature showcase';
  if (backend === 'bridge') return 'Live — AgOpenWeb bridge';
  if (backend === 'mock-backend') return 'Live — simulated backend (mock-backend)';
  if (backend === 'fastapi') return 'Live — planner backend';
  return 'Live — backend';
}

/**
 * @param {{el: HTMLElement, sourceInfo: {kind, api, error}, caps: () => object, linkProblem: (state) => object|null}} o
 */
export function createModeSwitch({ el, sourceInfo, caps, linkProblem }) {
  const kind = sourceInfo.kind === 'live' ? 'live' : 'mock';
  const liveApi = () => (kind === 'live' && sourceInfo.api) || lsGet() || DEFAULT_LIVE_API;
  if (kind === 'live' && sourceInfo.api && !sourceInfo.error) lsSet(sourceInfo.api);
  const go = (k, api) => { const href = modeHref(globalThis.location, k, api); if (href !== globalThis.location.href) globalThis.location.assign(href); };

  el.className = 'gl modesw';
  el.innerHTML =
    '<div class="msrow"><div class="seg2" role="radiogroup" aria-label="Data source">' +
    '<button type="button" role="radio" data-mode="mock"><i></i>Mock</button>' +
    '<button type="button" role="radio" data-mode="live"><i></i>Live</button></div>' +
    '<button type="button" class="msmore" aria-label="Live backend address" aria-haspopup="dialog" title="Live backend address">⋯</button></div>' +
    '<p class="mscap"></p><button type="button" class="mstomock" hidden>Switch to Mock</button>' +
    '<div class="mspop gl" role="dialog" aria-label="Live backend address"><p class="msh">Live backend</p>' +
    PRESETS.map((p, i) => '<button type="button" class="mspre" data-i="' + i + '"><b>' + esc(p.name) + '</b><span>' + esc(p.url.replace(/^https?:\/\//, '')) + '</span><em>' + esc(p.hint) + '</em></button>').join('') +
    '<label class="msurl"><span>Address</span><input type="url" spellcheck="false" autocomplete="off"></label>' +
    '<p class="mserr" hidden></p><div class="msact"><button type="button" class="msgo">Connect</button><button type="button" class="mscancel">Cancel</button></div></div>';

  const segs = [...el.querySelectorAll('[data-mode]')];
  const cap = el.querySelector('.mscap'), toMock = el.querySelector('.mstomock');
  const pop = el.querySelector('.mspop'), input = pop.querySelector('input'), err = pop.querySelector('.mserr');
  for (const b of segs) { const on = b.dataset.mode === kind; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const seg = e.target.closest('[data-mode]');
    if (seg) { if (seg.dataset.mode !== kind) go(seg.dataset.mode, liveApi()); return; }
    if (e.target.closest('.mstomock')) { go('mock'); return; }
    if (e.target.closest('.msmore')) { input.value = liveApi(); err.hidden = true; pop.classList.toggle('on'); if (pop.classList.contains('on')) input.focus(); return; }
    const pre = e.target.closest('.mspre');
    if (pre) { input.value = PRESETS[+pre.dataset.i].url; err.hidden = true; return; }
    if (e.target.closest('.mscancel')) { pop.classList.remove('on'); return; }
    if (e.target.closest('.msgo')) connect();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); if (e.key === 'Escape') pop.classList.remove('on'); });
  document.addEventListener('click', () => pop.classList.remove('on'));
  function connect() {
    const v = input.value.trim().replace(/\/+$/, '');
    if (!validUrl(v)) { err.textContent = 'Enter an http:// or https:// address, e.g. http://localhost:8000'; err.hidden = false; return; }
    lsSet(v); pop.classList.remove('on');
    if (kind === 'live' && v === sourceInfo.api) return;
    go('live', v);
  }

  let key = '';
  return {
    /** Status dot + caption, from the store's connection state and the detected backend. */
    sync(state) {
      const prob = linkProblem(state);
      const connected = !!(state && state.connected);
      const ever = !!(state && state.link && state.link.everConnected);
      const suffix = prob ? prob.badge : connected ? '' : kind === 'live' ? (ever ? 'reconnecting' : 'connecting') : state && state.connected === false && state.clock ? 'reconnecting' : '';
      const st = prob || (!connected && (kind !== 'live' || ever) && suffix) ? 'down' : connected ? kind : 'wait';
      const backend = (caps() || {}).backend;
      const text = modeCaption(kind, backend) + (suffix ? ' · ' + suffix : '');
      const title = prob ? prob.title : kind === 'live' ? text + ' · ' + (sourceInfo.api || '') : 'In-browser simulation with every feature on. Live connects to a backend.';
      const k = st + '|' + text + '|' + title + '|' + !!prob;
      if (k === key) return;
      key = k;
      el.dataset.st = st;
      cap.textContent = text;
      el.title = title;
      toMock.hidden = !(kind === 'live' && prob);
    },
  };
}

// AgOpenGPS-style overlays for the Map (Live feed) view:
//   1. implement section strip: the tool bar split into N sections, green = on, grey = off
//      (data: tractor.agopenweb.sections from the AgOpenWeb bridge, or tractor.tool.sections)
//   2. headland lines: dashed rectangle ~1 implement width inside each scenario block
//   3. DOM chrome over the map canvas: scale bar (bottom-left), north arrow (top-right), imagery attribution
//      (bottom-right, only while the satellite basemap is shown)
//
// World units = grid cells (world = grid - (size-1)/2, +x east, +z south), 1 cell = geo.cellM metres, like
// scene/livefeed.js + scene/liveTractors.js. The Map camera is orthographic, straight down, north up.
// update() allocates nothing per frame (only when the scenario, fleet membership or implement width changes).
import * as THREE from 'three';
import { makeGrid } from '../lib/derive.js';
import { makeGeo, poseToGrid } from '../lib/geo.js';

export const SCALE_STEPS_M = [10, 20, 50, 100, 200, 500, 1000];
export const DEFAULT_ATTRIBUTION = 'Imagery: USGS The National Map / NAIP (public domain)';
const FALLBACK_TOOL_M = 6;
const MAX_SECTIONS = 16;
const ON = '#30D158', OFF = '#8e8e93';

/**
 * Scale bar choice: the largest step (metres) whose on-screen length fits in maxPx.
 * @param mPerPx metres per screen pixel
 * @returns {{ m: number, px: number }} (smallest step if even that is too long)
 */
export function pickScaleBar(mPerPx, maxPx = 120, steps = SCALE_STEPS_M) {
  if (!(mPerPx > 0) || !isFinite(mPerPx)) return { m: steps[0], px: 0 };
  let m = steps[0];
  for (let i = 0; i < steps.length; i++) if (steps[i] / mPerPx <= maxPx) m = steps[i];
  return { m, px: m / mPerPx };
}

/**
 * Headland rectangle of a block (grid units; block covers cells x..x+w-1, so its edges are x-0.5 .. x+w-0.5),
 * inset by `insetCells` on every side. Returns null when the block is too small to have an inner headland.
 */
export function headlandRect(b, insetCells, out = {}) {
  const x0 = b.x - 0.5, y0 = b.y - 0.5, x1 = b.x + b.w - 0.5, y1 = b.y + b.h - 0.5;
  const d = Math.max(0, insetCells);
  if (x1 - x0 <= 2 * d + 1e-6 || y1 - y0 <= 2 * d + 1e-6) return null;
  out.x0 = x0 + d; out.y0 = y0 + d; out.x1 = x1 - d; out.y1 = y1 - d;
  return out;
}

/** Section flag -> on? Accepts booleans, 0/1, or {on|isOn|active|state:'on'} objects. */
export function sectionOn(v) {
  if (v === true || v === 1) return true;
  if (v && typeof v === 'object') return !!(v.on || v.isOn || v.active || v.state === 'on' || v.state === true);
  return false;
}

/** Section array of a tractor (AgOpenWeb bridge first, then tool.sections), or null. */
export function tractorSections(tr) {
  if (!tr) return null;
  const a = tr.agopenweb && Array.isArray(tr.agopenweb.sections) && tr.agopenweb.sections.length ? tr.agopenweb.sections : null;
  if (a) return a;
  const t = tr.tool && Array.isArray(tr.tool.sections) && tr.tool.sections.length ? tr.tool.sections : null;
  return t;
}

const CSS = `
.mo-ui{position:absolute;z-index:4;pointer-events:none;color:rgba(255,255,255,.92);font:500 11px/1.2 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",system-ui,sans-serif;letter-spacing:.01em;
  background:rgba(28,28,30,.48);-webkit-backdrop-filter:blur(18px) saturate(170%);backdrop-filter:blur(18px) saturate(170%);
  border:1px solid rgba(255,255,255,.14);border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.22);transition:opacity .25s ease}
.mo-hidden{opacity:0!important}
.mo-scale{left:16px;padding:6px 9px 7px}
.mo-scale-bar{height:5px;border:1.5px solid rgba(255,255,255,.92);border-top:0;margin-top:3px;box-sizing:border-box}
.mo-north{right:16px;width:34px;height:42px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:700;font-size:10px}
.mo-north svg{display:block;margin-bottom:1px}
.mo-attr{right:16px;padding:4px 8px;font-size:10px;color:rgba(255,255,255,.78);border-radius:7px;max-width:60%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;

/**
 * @param scene     the Map view's THREE.Scene (livefeed's `L`)
 * @param camera    the Map ortho camera (livefeed's `O`)
 * @param renderer  the Map WebGLRenderer (its canvas's parent hosts the DOM chrome unless `stage` is given)
 * @param geo       lib/geo.js helper (optional; rebuilt from state.scenario.geo when missing)
 * @param store     data store (optional; update() falls back to store.state)
 * @param getView   () => { satellite: bool } | 'satellite' | 'simple' (optional) - attribution only while satellite
 * @param tractors  scene/liveTractors.js instance (optional): section strip is laid exactly on its implement bar
 * @param stage     DOM container for the chrome (optional)
 */
export function createMapOverlays({ scene, camera, renderer, geo = null, grid: grid0 = null, store = null, getView = null, tractors = null, stage = null }) {
  const root = new THREE.Group(); root.name = 'mapOverlays'; scene.add(root);
  const quad = new THREE.PlaneGeometry(1, 1);
  const mOn = new THREE.MeshBasicMaterial({ color: ON, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
  const mOff = new THREE.MeshBasicMaterial({ color: OFF, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
  const headMat = new THREE.LineDashedMaterial({ color: '#ffffff', transparent: true, opacity: 0.7, dashSize: 0.35, gapSize: 0.22, depthTest: false, depthWrite: false });
  let headLines = null;
  const strips = new Map(); // tractor id -> { holder, segs[], seen }
  const tmpG = { x: 0, y: 0 }, tmpR = {}, eul = new THREE.Euler(0, 0, 0, 'YXZ'), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();

  let grid = grid0, gg = geo, scSig = null, headW = -1, frameNo = 0, visible = false, W = 0, H = 0;

  // ---------- DOM chrome
  const host = stage || (renderer && renderer.domElement && renderer.domElement.parentElement) || null;
  const style = document.createElement('style'); style.textContent = CSS;
  const scaleEl = document.createElement('div'); scaleEl.className = 'mo-ui mo-scale mo-hidden';
  const scaleTxt = document.createElement('div'); const scaleBar = document.createElement('div'); scaleBar.className = 'mo-scale-bar';
  scaleEl.append(scaleTxt, scaleBar);
  const north = document.createElement('div'); north.className = 'mo-ui mo-north mo-hidden'; north.setAttribute('aria-label', 'North is up');
  north.innerHTML = '<svg width="14" height="18" viewBox="0 0 14 18" aria-hidden="true"><path d="M7 0 L13 17 L7 13 L1 17 Z" fill="#FF453A"/><path d="M7 0 L7 13 L1 17 Z" fill="rgba(255,255,255,.85)"/></svg><span>N</span>';
  const attr = document.createElement('div'); attr.className = 'mo-ui mo-attr mo-hidden'; attr.textContent = DEFAULT_ATTRIBUTION;
  if (host) { if (getComputedStyle(host).position === 'static') host.style.position = 'relative'; host.append(style, scaleEl, north, attr); }
  let disposed = false;
  try {
    fetch('/static/naip.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (disposed || !j) return;
      const a = j.attribution || (j.meta && j.meta.attribution);
      if (typeof a === 'string' && a.trim()) attr.textContent = /^imagery/i.test(a.trim()) ? a.trim() : 'Imagery: ' + a.trim();
    }).catch(() => {});
  } catch (e) { /* no fetch (tests) */ }

  function cssPx(name, dflt) { if (!host) return dflt; const n = parseFloat(getComputedStyle(host).getPropertyValue(name)); return isFinite(n) && n > 0 ? n : dflt; }
  function placeChrome() {
    const bot = cssPx('--dockh', 120) + 14, top = cssPx('--chipsb', 120) + 10;
    scaleEl.style.bottom = bot + 'px'; attr.style.bottom = bot + 'px'; north.style.top = top + 'px';
  }
  placeChrome();

  // ---------- headland lines
  function buildHeadland(widthM) {
    if (headLines) { root.remove(headLines); headLines.geometry.dispose(); headLines = null; }
    headW = widthM;
    if (!grid || !gg) return;
    const inset = widthM / gg.cellM, ox = (grid.w - 1) / 2, oy = (grid.h - 1) / 2, pts = [];
    for (const b of grid.blocks) {
      const r = headlandRect(b, inset, tmpR); if (!r) continue;
      const a = [r.x0 - ox, r.y0 - oy], c = [r.x1 - ox, r.y0 - oy], d = [r.x1 - ox, r.y1 - oy], e = [r.x0 - ox, r.y1 - oy];
      for (const [p0, p1] of [[a, c], [c, d], [d, e], [e, a]]) pts.push(p0[0], 0, p0[1], p1[0], 0, p1[1]);
    }
    if (!pts.length) return;
    const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    headLines = new THREE.LineSegments(geom, headMat); headLines.computeLineDistances(); headLines.renderOrder = 5; headLines.frustumCulled = false;
    root.add(headLines);
  }

  // ---------- section strips
  function strip(id) {
    let st = strips.get(id);
    if (st) return st;
    const holder = new THREE.Object3D(); holder.matrixAutoUpdate = false;
    const segs = [];
    for (let i = 0; i < MAX_SECTIONS; i++) { const m = new THREE.Mesh(quad, mOff); m.renderOrder = 11; m.visible = false; m.frustumCulled = false; holder.add(m); segs.push(m); }
    root.add(holder);
    st = { holder, segs, seen: 0, n: -1 };
    strips.set(id, st);
    return st;
  }
  function dropStrip(id, st) { root.remove(st.holder); strips.delete(id); }

  function wppNow() { if (!(H > 0) && renderer && renderer.domElement) H = renderer.domElement.clientHeight; return camera && camera.isOrthographicCamera && H > 0 ? (camera.top - camera.bottom) / camera.zoom / H : 0.05; }

  function updateStrips(state, wpp) {
    frameNo++;
    const fleet = state.fleet || [], ox = grid ? (grid.w - 1) / 2 : 0, oy = grid ? (grid.h - 1) / 2 : 0;
    for (let i = 0; i < fleet.length; i++) {
      const tr = fleet[i]; if (!tr || !tr.id) continue;
      const secs = tractorSections(tr);
      if (!secs) continue;
      const st = strip(tr.id); st.seen = frameNo;
      const n = Math.min(MAX_SECTIONS, secs.length), gap = n > 1 ? 0.06 / n : 0;
      for (let k = 0; k < MAX_SECTIONS; k++) {
        const m = st.segs[k];
        if (k >= n) { m.visible = false; continue; }
        m.visible = true; m.material = sectionOn(secs[k]) ? mOn : mOff;
        if (st.n !== n) { m.scale.set(1 / n - gap, 1, 1); m.position.set(-0.5 + (k + 0.5) / n, 0, 0); m.updateMatrix(); }
      }
      st.n = n;
      // transform: lay the strip on liveTractors' implement bar when available (exact, interpolated), else own pose
      const rec = tractors && tractors.get ? tractors.get(tr.id) : null;
      const bar = rec && rec.icon && rec.icon.bar;
      if (bar && rec.icon.root.visible !== false) {
        rec.icon.root.updateMatrixWorld(true);
        st.holder.matrix.copy(bar.matrixWorld);
        // a little thicker than the bar so the colours read over it
        s.set(1, 1.7, 1); st.holder.matrix.scale(s);
      } else {
        const p = tr.tool && isFinite(tr.tool.lat) ? tr.tool : tr.pose;
        if (!poseToGrid(gg, p, tmpG)) { st.holder.visible = false; continue; }
        const hd = p && isFinite(p.heading_deg) ? +p.heading_deg : (tr.pose && +tr.pose.heading_deg) || 0;
        const wm = tr.tool && tr.tool.width_m > 0 ? +tr.tool.width_m : FALLBACK_TOOL_M;
        const cm = gg ? gg.cellM : 1;
        eul.set(-Math.PI / 2, -(hd * Math.PI) / 180, 0, 'YXZ'); q.setFromEuler(eul);
        v.set(tmpG.x - ox, 0, tmpG.y - oy); s.set(Math.max(wm / cm, 36 * wpp), Math.max(0.05, 6 * wpp), 1);
        st.holder.matrix.compose(v, q, s);
      }
      st.holder.visible = true;
      st.holder.matrixWorldNeedsUpdate = true;
    }
    for (const [id, st] of strips) if (st.seen !== frameNo) dropStrip(id, st);
  }

  function satelliteShown() {
    if (!getView) return true;
    const vw = getView();
    if (vw === 'satellite') return true;
    if (vw && typeof vw === 'object') return !!(vw.satellite || vw.basemap === 'satellite');
    return false;
  }

  let lastScaleM = -1, lastScalePx = -1, lastState = null;
  function update(state) {
      if (disposed) return;
      state = state || lastState || (store && store.state) || null;
      if (!state) return;
      const sc = state.scenario;
      if (sc && sc !== scSig && !grid) { // standalone use: derive grid/geo from the scenario
        scSig = sc; grid = makeGrid(sc); gg = makeGeo(sc) || geo; headW = -1;
      }
      if (!visible || !grid) return;
      // implement width for the headland: widest tool in the fleet
      let wm = 0; const fl = state.fleet || [];
      for (let i = 0; i < fl.length; i++) { const t = fl[i] && fl[i].tool; if (t && t.width_m > wm) wm = +t.width_m; }
      if (!(wm > 0)) wm = FALLBACK_TOOL_M;
      if (grid && Math.abs(wm - headW) > 0.05) buildHeadland(wm);
      const wpp = wppNow();
      updateStrips(state, wpp);
      // scale bar
      if (gg && wpp > 0) {
        const sb = pickScaleBar(wpp * gg.cellM, 120);
        const px = Math.round(sb.px);
        if (sb.m !== lastScaleM) { lastScaleM = sb.m; scaleTxt.textContent = sb.m >= 1000 ? sb.m / 1000 + ' km' : sb.m + ' m'; }
        if (px !== lastScalePx) { lastScalePx = px; scaleBar.style.width = px + 'px'; }
        scaleEl.classList.remove('mo-hidden');
      } else scaleEl.classList.add('mo-hidden');
      attr.classList.toggle('mo-hidden', !satelliteShown());
  }
  return {
    /** livefeed calls this when the scenario (grid/geo) is rebuilt. */
    rebuild(g, ge, scenario) { grid = g || (scenario ? makeGrid(scenario) : null); gg = ge || (scenario && makeGeo(scenario)) || null; scSig = scenario || null; headW = -1; },
    /** On every store message (cheap: just keeps the latest state). */
    sync(state) { if (state) lastState = state; },
    /** Per visible Map frame. dt/zoom unused (zoom is read from the camera). */
    frame() { update(null); },
    /** Alternative single-call API: update(state, now). */
    update(state) { if (state) lastState = state; update(state); },
    resize(w, h) { W = w; H = h; placeChrome(); },
    setVisible(on) {
      visible = !!on; root.visible = visible;
      north.classList.toggle('mo-hidden', !visible);
      if (!visible) { scaleEl.classList.add('mo-hidden'); attr.classList.add('mo-hidden'); }
      else placeChrome();
    },
    dispose() {
      disposed = true;
      for (const [id, st] of strips) dropStrip(id, st);
      if (headLines) { headLines.geometry.dispose(); headLines = null; }
      scene.remove(root);
      quad.dispose(); mOn.dispose(); mOff.dispose(); headMat.dispose();
      style.remove(); scaleEl.remove(); north.remove(); attr.remove();
    },
  };
}

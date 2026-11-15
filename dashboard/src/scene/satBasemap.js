// Map view satellite basemap (AgOpenGPS / AgOpenWeb field-view look): the real USGS NAIP aerial of the farm under
// our overlays, plus the "Satellite | Simple" switch (Simple = liveBasemap's generated aerial underneath).
//
// Source, in order:
//   1. scenario.basemap when it has an image_url and finite west/east/south/north (backend contract)
//   2. /static/naip.json (pre-baked by tools/fetch-basemap.mjs: naip.jpg + bounds + the origin it was baked for)
// Placement: lat/lon bounds -> grid via lib/geo.js (same flat-earth formula as the backend) -> world.
// Safety net: if those bounds do not cover the farm (scenario.geo origin differs from the one the image was baked
// for), the image is re-anchored using naip.json's own origin so the farm still sits on the imaged farm, and a
// console warning names both origins. Without naip.json's origin we stay on Simple.
//
// The image is toned in a tiny shader (saturation / contrast / slight lift) so coverage, trails and outlines pop.
import * as THREE from 'three';
import { makeGeo } from '../lib/geo.js';

export const SAT_TONE = { saturation: 0.82, contrast: 1.1, brightness: -0.03, warm: 0.015 };
const PREF_KEY = 'hf.mapBasemap';
const BASE = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';

const VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = `
uniform sampler2D map; uniform float opacity, saturation, contrast, brightness, warm;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(map, vUv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, saturation);
  c = (c - 0.5) * contrast + 0.5 + brightness;
  c += vec3(warm, warm * 0.4, -warm);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), opacity);
}`;

const finite4 = (b) => b && [b.west, b.east, b.south, b.north].every((v) => v !== null && v !== '' && isFinite(v));

/**
 * Pure: grid-space rectangle (cell-edge coords) for an image with lat/lon bounds `b`, given the scenario geo and the
 * farm size. Returns { x0, x1, y0, y1, anchored: 'bounds' | 'reanchored' } or null.
 * @param bakedOrigin {lat, lon, cell_m} the origin the image was baked for (naip.json), used to re-anchor
 */
export function placeImage(geo, b, gw, gh, bakedOrigin) {
  if (!geo || !finite4(b)) return null;
  const nw = geo.toGrid(+b.north, +b.west), se = geo.toGrid(+b.south, +b.east);
  const r = { x0: nw.x, y0: nw.y, x1: se.x, y1: se.y, anchored: 'bounds' };
  const covers = r.x0 <= -0.5 + 0.05 && r.y0 <= -0.5 + 0.05 && r.x1 >= gw - 0.5 - 0.05 && r.y1 >= gh - 0.5 - 0.05;
  if (covers) return r;
  if (!bakedOrigin || !isFinite(bakedOrigin.lat) || !isFinite(bakedOrigin.lon)) return null;
  const g2 = makeGeo({ geo: { origin_lat: +bakedOrigin.lat, origin_lon: +bakedOrigin.lon, cell_m: +(bakedOrigin.cell_m || geo.cellM) } });
  const a = g2.toGrid(+b.north, +b.west), c = g2.toGrid(+b.south, +b.east);
  return { x0: a.x, y0: a.y, x1: c.x, y1: c.y, anchored: 'reanchored' };
}

function readPref() { try { return window.localStorage.getItem(PREF_KEY); } catch (e) { return null; } }
function writePref(v) { try { window.localStorage.setItem(PREF_KEY, v); } catch (e) { /* private mode */ } }

let cssDone = false;
function injectCss() {
  if (cssDone || typeof document === 'undefined') return; cssDone = true;
  const s = document.createElement('style');
  s.textContent = `
.sat-switch{position:absolute;left:16px;top:calc(var(--chipsb,120px) + 8px);z-index:6;display:flex;padding:3px;gap:2px;border-radius:12px;
  background:rgba(28,28,30,.42);-webkit-backdrop-filter:blur(18px) saturate(1.6);backdrop-filter:blur(18px) saturate(1.6);
  box-shadow:inset 0 0 0 .5px rgba(255,255,255,.22),0 6px 20px rgba(0,0,0,.22);font:600 12px/1 -apple-system,BlinkMacSystemFont,'SF Pro Text','Inter',system-ui,sans-serif;
  transition:opacity .25s ease;opacity:0;pointer-events:none}
.sat-switch.on{opacity:1;pointer-events:auto}
.sat-switch button{all:unset;cursor:pointer;padding:7px 11px;border-radius:9px;color:rgba(255,255,255,.78);letter-spacing:.01em;transition:background .2s,color .2s}
.sat-switch button:hover{color:#fff}
.sat-switch button[aria-pressed="true"]{background:rgba(255,255,255,.9);color:#1c1c1e;box-shadow:0 1px 3px rgba(0,0,0,.18)}
.sat-switch button:focus-visible{outline:2px solid #0A84FF;outline-offset:1px}
.sat-switch button[disabled]{opacity:.4;cursor:default}
@media (max-width:600px){.sat-switch{left:12px}}`;
  document.head.appendChild(s);
}

/**
 * @param scene  the Map view's THREE.Scene
 * @param stage  DOM container for the switch
 * @param onChange (mode) => void, called when the user flips the switch
 * @returns { rebuild(grid, geo, scenario, apiBase), setVisible(on), get mode, get ready, get info, dispose() }
 */
export function createSatBasemap({ scene, stage = null, onChange = null }) {
  const group = new THREE.Group(); group.name = 'satBasemap';
  scene.add(group);
  let mesh = null, tex = null, mat = null, gen = 0;
  let mode = readPref() === 'simple' ? 'simple' : 'satellite';
  let ready = false, info = { source: null, anchored: null, url: null };
  let naipMeta = null, naipPromise = null;
  let fade = 0; // shown opacity, eased toward target

  // ---- switch (DOM)
  let el = null, btnSat = null, btnSimple = null;
  if (stage && typeof document !== 'undefined') {
    injectCss();
    el = document.createElement('div'); el.className = 'sat-switch'; el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Map basemap');
    btnSat = document.createElement('button'); btnSat.type = 'button'; btnSat.textContent = 'Satellite';
    btnSimple = document.createElement('button'); btnSimple.type = 'button'; btnSimple.textContent = 'Simple';
    btnSat.addEventListener('click', () => setMode('satellite', true));
    btnSimple.addEventListener('click', () => setMode('simple', true));
    el.append(btnSat, btnSimple); stage.appendChild(el);
  }
  function paintSwitch() {
    if (!el) return;
    const sat = mode === 'satellite' && ready;
    btnSat.setAttribute('aria-pressed', String(sat)); btnSimple.setAttribute('aria-pressed', String(!sat));
    btnSat.disabled = !ready; btnSat.title = ready ? 'Real aerial imagery (USGS NAIP)' : 'Aerial imagery not available';
  }
  function setMode(m, user) {
    mode = m === 'simple' ? 'simple' : 'satellite';
    if (user) writePref(mode);
    paintSwitch();
    if (onChange) onChange(api.mode);
  }

  function loadNaipMeta() {
    if (naipPromise) return naipPromise;
    naipPromise = fetch(BASE + 'static/naip.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { naipMeta = j; return j; })
      .catch(() => null);
    return naipPromise;
  }

  function clearMesh() {
    if (mesh) { group.remove(mesh); mesh.geometry.dispose(); mesh = null; }
    if (mat) { mat.dispose(); mat = null; }
    if (tex) { tex.dispose(); tex = null; }
    ready = false;
  }

  async function rebuild(grid, geo, scenario, apiBase) {
    const my = ++gen;
    clearMesh(); paintSwitch();
    if (!grid || !geo) return;
    const bm = scenario && scenario.basemap;
    let url = null, bounds = null, baked = null, source = null;
    const meta = await loadNaipMeta();
    if (my !== gen) return;
    const isOurNaip = bm && bm.image_url && /(^|\/)static\/naip\.(png|jpg)(\?|$)/.test(String(bm.image_url));
    if (isOurNaip && meta && finite4(meta)) {
      // the scenario points at our own pre-baked image: naip.json has its true bounds (with margin) + the lighter jpg
      const off = ['west', 'east', 'south', 'north'].some((k) => Math.abs(+bm[k] - +meta[k]) > 1e-6);
      if (off) console.warn('[map] scenario.basemap bounds differ from /static/naip.json (the image\'s true extent); using naip.json bounds: ' + JSON.stringify({ west: meta.west, east: meta.east, south: meta.south, north: meta.north }));
      url = BASE + 'static/' + (meta.image || 'naip.png'); bounds = meta; baked = meta.origin; source = 'naip.json (scenario.basemap -> naip)';
    } else if (bm && bm.image_url && finite4(bm)) {
      url = String(bm.image_url); bounds = bm; source = 'scenario.basemap';
      try { url = new URL(url, apiBase || location.href).href; } catch (e) { /* keep */ }
      if (meta && meta.origin) baked = meta.origin;
    } else if (meta && finite4(meta)) {
      url = BASE + 'static/' + (meta.image || 'naip.png'); bounds = meta; baked = meta.origin; source = 'naip.json';
    }
    if (!url) { console.info('[map] no satellite basemap (no scenario.basemap.image_url, no /static/naip.json): Simple only'); return; }
    const rect = placeImage(geo, bounds, grid.w, grid.h, baked);
    if (!rect) { console.warn('[map] satellite image bounds do not cover the farm and cannot be re-anchored: Simple only'); return; }
    if (rect.anchored === 'reanchored') {
      console.warn('[map] satellite image was baked for origin ' + baked.lat + ',' + baked.lon + ' but scenario.geo is ' + geo.lat0 + ',' + geo.lon0
        + ': re-anchoring the image to the farm grid. Set scenario.geo (mockSource GEO / bridge scenario.json) to the baked origin so real positions line up.');
    }
    const loader = new THREE.TextureLoader(); loader.setCrossOrigin('anonymous');
    loader.load(url, (t) => {
      if (my !== gen) { t.dispose(); return; }
      tex = t; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
      mat = new THREE.ShaderMaterial({
        uniforms: { map: { value: t }, opacity: { value: fade }, saturation: { value: SAT_TONE.saturation }, contrast: { value: SAT_TONE.contrast }, brightness: { value: SAT_TONE.brightness }, warm: { value: SAT_TONE.warm } },
        vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false,
      });
      const ox = (grid.w - 1) / 2, oy = (grid.h - 1) / 2;
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(rect.x1 - rect.x0), Math.abs(rect.y1 - rect.y0)), mat);
      mesh.rotation.x = -Math.PI / 2; mesh.renderOrder = 2;
      mesh.position.set((rect.x0 + rect.x1) / 2 - ox, 0, (rect.y0 + rect.y1) / 2 - oy);
      group.add(mesh);
      ready = true; info = { source, anchored: rect.anchored, url, rect, attribution: (meta && meta.attribution) || 'Imagery: USGS The National Map / NAIP, public domain' };
      paintSwitch();
      if (onChange) onChange(api.mode);
    }, undefined, () => { if (my === gen) console.warn('[map] satellite image failed to load (' + url + '): Simple only'); });
  }

  const api = {
    group,
    rebuild,
    /** 'satellite' only once the image is actually loaded */
    get mode() { return mode === 'satellite' && ready ? 'satellite' : 'simple'; },
    get preferred() { return mode; },
    get ready() { return ready; },
    get info() { return { ...info, mode: api.mode, preferred: mode }; },
    setMode: (m) => setMode(m, true),
    /** show/hide the switch (Map view visible) */
    setVisible(on) { if (el) el.classList.toggle('on', !!on); },
    /** per visible frame: cross-fade Satellite <-> Simple */
    frame(dt) {
      const target = api.mode === 'satellite' ? 1 : 0;
      if (fade !== target) { const k = 1 - Math.exp(-(dt || 0.016) * 9); fade += (target - fade) * k; if (Math.abs(target - fade) < 0.004) fade = target; }
      if (mat) mat.uniforms.opacity.value = fade;
      if (mesh) mesh.visible = fade > 0.001;
    },
    dispose() { gen++; clearMesh(); scene.remove(group); if (el) el.remove(); },
  };
  paintSwitch();
  return api;
}

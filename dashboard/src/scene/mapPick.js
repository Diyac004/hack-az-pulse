// map_pick interaction for the Tractor Control Panel, in BOTH views (3D diorama and the Map/Live feed).
// pick({count, label, color}) resolves to one point {lat, lon, x, y} (count 1) or an array of two (AB line),
// or null when cancelled (Esc / Cancel). x/y are grid cells; lat/lon from scenario.geo (null without geo).
//
// Taps are read from pointerdown/up on #stage without stopping propagation (OrbitControls must still see its
// pointerup). The views' own tap-to-select handlers consult `active` and stand down while a pick is running.
import * as THREE from 'three';
import { makeGrid } from '../lib/derive.js';
import { makeGeo } from '../lib/geo.js';

/**
 * @param deps {
 *   stage, world (scene/world.js: cam),
 *   getScenario(): Scenario | null,
 *   view(): { screenToGround(px, py) -> {x, z}|null, groundToScreen(x, z) -> {x, y}|null } | null
 *          the active view's projection (the Map view supplies its own); null -> diorama camera
 * }
 */
export function createMapPick({ stage, world, getScenario, view = () => null }) {
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3(), tmp = new THREE.Vector3();
  const r = () => stage.getBoundingClientRect();
  function s2g(px, py) {
    const v = view(); if (v && v.screenToGround) return v.screenToGround(px, py);
    const b = r(); ndc.set((px / b.width) * 2 - 1, -(py / b.height) * 2 + 1);
    ray.setFromCamera(ndc, world.cam);
    return ray.ray.intersectPlane(plane, hit) ? { x: hit.x, z: hit.z } : null;
  }
  function g2s(x, z) {
    const v = view(); if (v && v.groundToScreen) return v.groundToScreen(x, z);
    const b = r(); tmp.set(x, 0.05, z).project(world.cam);
    if (tmp.z > 1) return null;
    return { x: (tmp.x * 0.5 + 0.5) * b.width, y: (-tmp.y * 0.5 + 0.5) * b.height };
  }

  const hint = document.createElement('div'); hint.className = 'mp-hint'; hint.setAttribute('role', 'status');
  hint.innerHTML = '<i></i><span></span><button type="button">Cancel</button>';
  stage.appendChild(hint);
  const hintTxt = hint.querySelector('span'), hintDot = hint.querySelector('i');
  hint.addEventListener('pointerdown', (e) => e.stopPropagation());

  let cur = null; // { count, color, pts:[{wx,wz,val}], resolve, marks:[], line }
  let down = null, raf = 0;

  function finish(val) {
    if (!cur) return;
    const c = cur; cur = null;
    stage.classList.remove('mp-on'); hint.classList.remove('on');
    cancelAnimationFrame(raf);
    // leave the markers a beat so the operator sees where they tapped
    setTimeout(() => { c.marks.forEach((m) => m.remove()); if (c.line) c.line.remove(); }, val ? 700 : 0);
    c.resolve(val);
  }
  hint.querySelector('button').addEventListener('click', () => finish(null));
  document.addEventListener('keydown', (e) => { if (cur && e.key === 'Escape') { e.preventDefault(); finish(null); } });

  function say() {
    const n = cur.pts.length;
    const who = cur.who ? `${cur.who} · ` : '';
    const lbl = String(cur.label).replace(/(…|\.\.\.)$/, ''); // "Drive to…" -> "Drive to: tap…"
    hintTxt.textContent = who + (cur.count === 2 ? (n === 0 ? `${lbl}: tap point A` : `${lbl}: now tap point B`) : `${lbl}: tap a spot on the map`);
  }
  function place() {
    if (!cur) return;
    cur.pts.forEach((p, i) => {
      const s = g2s(p.wx, p.wz), m = cur.marks[i];
      if (!s) { m.style.display = 'none'; return; }
      m.style.display = ''; m.style.transform = `translate(${s.x}px, ${s.y}px)`;
      p.sx = s.x; p.sy = s.y;
    });
    if (cur.line) {
      const a = cur.pts[0], b = cur.pts[1] || cur.hover;
      if (a && b && a.sx != null && b.sx != null) {
        const dx = b.sx - a.sx, dy = b.sy - a.sy;
        cur.line.style.display = ''; cur.line.style.width = Math.hypot(dx, dy) + 'px';
        cur.line.style.transform = `translate(${a.sx}px, ${a.sy}px) rotate(${Math.atan2(dy, dx)}rad)`;
      } else cur.line.style.display = 'none';
    }
    raf = requestAnimationFrame(place);
  }

  const local = (e) => { const b = r(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  const onCanvas = (e) => e.target && e.target.tagName === 'CANVAS';
  stage.addEventListener('pointerdown', (e) => { if (cur && onCanvas(e)) down = { ...local(e), t: performance.now() }; }, true);
  stage.addEventListener('pointermove', (e) => {
    if (!cur || cur.count !== 2 || cur.pts.length !== 1 || (e.buttons & 7)) return;
    const q = local(e); cur.hover = { sx: q.x, sy: q.y };
  }, true);
  stage.addEventListener('pointerup', (e) => {
    if (!cur || !down) return;
    const q = local(e), d = down; down = null;
    if (Math.hypot(q.x - d.x, q.y - d.y) > 6 || performance.now() - d.t > 700) return; // a drag = orbit/pan, not a pick
    const g = s2g(q.x, q.y); if (!g) return;
    const sc = getScenario(); const grid = makeGrid(sc), geo = makeGeo(sc);
    const gx = g.x + (grid.w - 1) / 2, gy = g.z + (grid.h - 1) / 2;
    if (gx < -0.5 || gy < -0.5 || gx > grid.w - 0.5 || gy > grid.h - 0.5) { hintTxt.textContent = 'That is outside the farm. Tap inside it.'; return; }
    const ll = geo ? geo.toLatLon(gx, gy) : { lat: null, lon: null };
    const r6 = (v) => (v == null ? null : Math.round(v * 1e6) / 1e6), r2 = (v) => Math.round(v * 100) / 100;
    const val = { lat: r6(ll.lat), lon: r6(ll.lon), x: r2(gx), y: r2(gy) };
    const m = document.createElement('div'); m.className = 'mp-mark'; m.style.background = cur.color;
    if (cur.count === 2) m.textContent = cur.pts.length ? 'B' : 'A';
    stage.appendChild(m); cur.marks.push(m);
    cur.pts.push({ wx: g.x, wz: g.z, val });
    if (cur.pts.length >= cur.count) { place(); finish(cur.count === 1 ? val : cur.pts.map((p) => p.val)); }
    else say();
  }, true);

  return {
    get active() { return !!cur; },
    /** @returns Promise<point | point[] | null> */
    pick({ count = 1, label = 'Pick', color = '#0A84FF', who = null } = {}) {
      if (cur) finish(null);
      return new Promise((resolve) => {
        cur = { count, label, color, who, pts: [], marks: [], line: null, hover: null, resolve };
        if (count === 2) { const l = document.createElement('div'); l.className = 'mp-line'; l.style.background = color; l.style.display = 'none'; stage.appendChild(l); cur.line = l; }
        hintDot.style.background = color; say();
        stage.classList.add('mp-on'); hint.classList.add('on');
        raf = requestAnimationFrame(place);
      });
    },
    cancel() { finish(null); },
  };
}

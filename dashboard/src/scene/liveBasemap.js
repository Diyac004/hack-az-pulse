// Live feed ground: aerial basemap + block outlines + depot marker, in grid world units (1 unit = 1 cell,
// world = grid.toWorld). Uses scenario.basemap.image_url (placed by its lat/lon bounds) when present;
// otherwise paints a procedural aerial from the scenario grid (orchard rows per block, dirt roads, depot).
import * as THREE from 'three';

const MARGIN = 5;      // cells of surrounding land drawn around the farm
const PX = 40;         // canvas px per cell for the procedural aerial
export const LAND = '#A8916C';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Procedural aerial canvas covering grid edges [-0.5-MARGIN, W-0.5+MARGIN] x [-0.5-MARGIN, H-0.5+MARGIN]. */
function paintAerial(g) {
  const cw = (g.w + 2 * MARGIN) * PX, ch = (g.h + 2 * MARGIN) * PX;
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const c = cv.getContext('2d');
  const X = (x) => (x + 0.5 + MARGIN) * PX, Y = (y) => (y + 0.5 + MARGIN) * PX; // grid edge coord -> px
  const r = rng(7919 + g.w * 131 + g.h * 7);

  // desert land with soft tonal blotches
  c.fillStyle = LAND; c.fillRect(0, 0, cw, ch);
  for (let i = 0; i < 70; i++) {
    const x = r() * cw, y = r() * ch, rad = (2 + r() * 6) * PX;
    const gr = c.createRadialGradient(x, y, 0, x, y, rad);
    const tone = r() < 0.5 ? '120,98,66' : '196,178,142';
    gr.addColorStop(0, `rgba(${tone},${0.08 + r() * 0.1})`); gr.addColorStop(1, `rgba(${tone},0)`);
    c.fillStyle = gr; c.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // creosote scrub outside the farm
  for (let i = 0; i < (cw * ch) / 900; i++) {
    const x = r() * cw, y = r() * ch;
    if (x > X(-0.5) && x < X(g.w - 0.5) && y > Y(-0.5) && y < Y(g.h - 0.5)) continue;
    c.fillStyle = `rgba(${70 + r() * 20 | 0},${78 + r() * 20 | 0},${48 + r() * 12 | 0},${0.35 + r() * 0.3})`;
    c.beginPath(); c.arc(x, y, 1.2 + r() * 2.4, 0, 6.283); c.fill();
  }
  // cultivated farm ground
  c.fillStyle = '#9E8763'; c.fillRect(X(-0.5), Y(-0.5), g.w * PX, g.h * PX);
  for (let i = 0; i < (g.w * g.h * PX * PX) / 60; i++) {
    c.fillStyle = r() < 0.5 ? 'rgba(80,64,40,.10)' : 'rgba(210,192,156,.10)';
    c.fillRect(X(-0.5) + r() * g.w * PX, Y(-0.5) + r() * g.h * PX, 1 + r() * 2, 1 + r() * 2);
  }

  // orchard blocks: inter-row ground + E-W canopy rows (same direction as the sweep)
  for (const b of g.blocks) {
    const x0 = X(b.x - 0.5), y0 = Y(b.y - 0.5), w = b.w * PX, h = b.h * PX;
    c.fillStyle = '#8A7F57'; c.fillRect(x0, y0, w, h);
    const rows = Math.round(b.h * 5.5), per = Math.round(b.w * 7);
    const dy = h / rows, dx = w / per, rad = Math.min(dy, dx) * 0.47;
    const ripe = Math.max(0, Math.min(1, b.ripeness || 0));
    for (let i = 0; i < rows; i++) {
      const cy = y0 + (i + 0.5) * dy;
      for (let k = 0; k < per; k++) {
        if (r() < 0.025) continue; // a missing tree here and there
        const cx = x0 + (k + 0.5) * dx + (r() - 0.5) * dx * 0.12, rr = rad * (0.82 + r() * 0.3);
        c.fillStyle = 'rgba(38,40,22,.45)'; c.beginPath(); c.arc(cx + rr * 0.35, cy + rr * 0.4, rr, 0, 6.283); c.fill(); // shadow (sun NW)
        const l = 26 + r() * 8;
        c.fillStyle = `hsl(${95 - ripe * 10 + (r() - 0.5) * 8},${30 + r() * 8}%,${l}%)`; c.beginPath(); c.arc(cx, cy, rr, 0, 6.283); c.fill();
        c.fillStyle = `hsla(${88 - ripe * 12},40%,${l + 12}%,.55)`; c.beginPath(); c.arc(cx - rr * 0.28, cy - rr * 0.3, rr * 0.45, 0, 6.283); c.fill();
      }
    }
  }

  // dirt roads with faint tire tracks
  const road = (x, y, w, h, horiz) => {
    c.fillStyle = '#D6C6A2'; c.fillRect(x, y, w, h);
    c.fillStyle = 'rgba(120,100,70,.18)';
    if (horiz) { c.fillRect(x, y + h * 0.3, w, h * 0.08); c.fillRect(x, y + h * 0.62, w, h * 0.08); }
    else { c.fillRect(x + w * 0.3, y, w * 0.08, h); c.fillRect(x + w * 0.62, y, w * 0.08, h); }
  };
  const rw = 0.5 * PX;
  g.rows.forEach((y) => road(X(-0.5), Y(y) - PX / 2 + (PX - rw) / 2, g.w * PX, rw, true));
  g.cols.forEach((x) => road(X(x) - PX / 2 + (PX - rw) / 2, Y(-0.5), rw, g.h * PX, false));

  // depot: gravel pad, shed roof (red, ridge), tanks
  const d = g.depot, px = X(d.x + 0.6), py = Y(d.y + 0.9);
  c.fillStyle = '#CDC3AE'; c.fillRect(px, py, 2.0 * PX, 1.7 * PX);
  c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(px + 0.35 * PX + 5, py + 0.3 * PX + 6, 1.3 * PX, 0.8 * PX);
  c.fillStyle = '#B4473B'; c.fillRect(px + 0.35 * PX, py + 0.3 * PX, 1.3 * PX, 0.8 * PX);
  c.fillStyle = 'rgba(255,255,255,.35)'; c.fillRect(px + 0.35 * PX, py + 0.69 * PX, 1.3 * PX, 2);
  c.fillStyle = '#ECE9E2';
  [[1.82, 0.4], [1.82, 0.85]].forEach(([ox, oy]) => { c.beginPath(); c.arc(px + ox * PX, py + oy * PX, 0.13 * PX, 0, 6.283); c.fill(); });

  // light desaturating wash so colored overlays pop
  c.fillStyle = 'rgba(236,230,214,.10)'; c.fillRect(0, 0, cw, ch);
  return cv;
}

function frameGeo(w, h, t) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -h / 2); s.lineTo(w / 2, -h / 2); s.lineTo(w / 2, h / 2); s.lineTo(-w / 2, h / 2); s.lineTo(-w / 2, -h / 2);
  const hole = new THREE.Path();
  hole.moveTo(-w / 2 + t, -h / 2 + t); hole.lineTo(-w / 2 + t, h / 2 - t); hole.lineTo(w / 2 - t, h / 2 - t); hole.lineTo(w / 2 - t, -h / 2 + t); hole.lineTo(-w / 2 + t, -h / 2 + t);
  s.holes.push(hole);
  return new THREE.ShapeGeometry(s);
}

const flat = (m) => { m.rotation.x = -Math.PI / 2; return m; };
const basic = (o) => new THREE.MeshBasicMaterial(Object.assign({ transparent: true, depthTest: false, depthWrite: false }, o));

/**
 * @param g grid from makeGeo/makeGrid; geo from lib/geo.js (may be null); scenario; apiBase for relative image urls.
 * @returns { group, blocks: {id: {outline, fill}}, extent, dispose }
 */
export function buildGround(g, geo, scenario, apiBase) {
  const group = new THREE.Group();
  const owned = []; // geometries / materials / textures to dispose
  const own = (x) => { owned.push(x); return x; };
  const ox = (g.w - 1) / 2, oy = (g.h - 1) / 2;
  const W = (x, y) => ({ x: x - ox, z: y - oy });

  // endless land under everything
  const land = flat(new THREE.Mesh(own(new THREE.PlaneGeometry(400, 400)), own(basic({ color: LAND, transparent: false }))));
  land.renderOrder = 0; group.add(land);

  // procedural aerial (always built: it is also the fallback if the image fails)
  const ex = { x0: -0.5 - MARGIN, x1: g.w - 0.5 + MARGIN, y0: -0.5 - MARGIN, y1: g.h - 0.5 + MARGIN };
  let aerial = null;
  if (typeof document !== 'undefined') {
    const tex = own(new THREE.CanvasTexture(paintAerial(g)));
    tex.anisotropy = 4;
    const c = W((ex.x0 + ex.x1) / 2, (ex.y0 + ex.y1) / 2);
    aerial = flat(new THREE.Mesh(own(new THREE.PlaneGeometry(ex.x1 - ex.x0, ex.y1 - ex.y0)), own(basic({ map: tex, transparent: false }))));
    aerial.position.set(c.x, 0, c.z); aerial.renderOrder = 1; group.add(aerial);
  }

  // real basemap image, placed by its bounds (mock: image_url null -> skipped)
  const bm = scenario && scenario.basemap;
  let imgTex = null, disposed = false;
  if (bm && bm.image_url && geo && [bm.west, bm.east, bm.south, bm.north].every((v) => isFinite(v))) {
    let url = String(bm.image_url);
    try { url = new URL(url, apiBase || location.href).href; } catch (e) { /* keep as is */ }
    const nw = geo.toGrid(+bm.north, +bm.west), se = geo.toGrid(+bm.south, +bm.east);
    const loader = new THREE.TextureLoader(); loader.setCrossOrigin('anonymous');
    loader.load(url, (t) => {
      if (disposed) { t.dispose(); return; }
      imgTex = own(t); t.anisotropy = 4;
      // grid point -> cell-edge: bounds are true edges, grid coords are cell centers, so no half-cell shift
      const c = W((nw.x + se.x) / 2, (nw.y + se.y) / 2);
      const m = flat(new THREE.Mesh(own(new THREE.PlaneGeometry(Math.abs(se.x - nw.x), Math.abs(se.y - nw.y))), own(basic({ map: t, transparent: false }))));
      m.position.set(c.x, 0, c.z); m.renderOrder = 2; group.add(m);
    }, undefined, () => console.warn('[livefeed] basemap image failed to load (' + url + '); using the procedural aerial'));
  }

  // block outlines + heat fill
  const blocks = {};
  for (const b of g.blocks) {
    const c = W(b.x + (b.w - 1) / 2, b.y + (b.h - 1) / 2);
    const fill = flat(new THREE.Mesh(own(new THREE.PlaneGeometry(b.w, b.h)), own(basic({ color: '#FF6A2A', opacity: 0 }))));
    fill.position.set(c.x, 0, c.z); fill.renderOrder = 6; fill.visible = false;
    const outline = flat(new THREE.Mesh(own(frameGeo(b.w + 0.12, b.h + 0.12, 0.07)), own(basic({ color: '#ffffff', opacity: 0.85 }))));
    outline.position.set(c.x, 0, c.z); outline.renderOrder = 7;
    group.add(fill, outline);
    blocks[b.id] = { outline, fill, base: 0.85 };
  }

  return {
    group, blocks,
    dispose() { disposed = true; group.parent && group.parent.remove(group); owned.forEach((o) => o.dispose()); owned.length = 0; },
  };
}

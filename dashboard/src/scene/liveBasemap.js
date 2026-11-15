// Live feed ground: aerial basemap + block outlines + depot marker, in grid world units (1 unit = 1 cell,
// world = grid.toWorld). Uses scenario.basemap.image_url (placed by its lat/lon bounds) when present;
// otherwise paints a procedural aerial from the scenario grid (orchard rows per block, dirt roads, depot).
import * as THREE from 'three';
import { hubPlacement, HUB_PLAN } from './depotHub.js';

// direction A + B's touches palette (textures/_build/trees.mjs P), aerial tones
const A = { grass: '#7E9A4E', grassLight: '#8CA759', berm: '#8E7150', wet: '#6A5236', drip: 'rgba(28,28,30,.7)', tram: 'rgba(110,88,58,.85)',
  leafDeep: '#2C5424', leaf: '#41712E', leafTip: '#7AA63F' };
const mixHex = (h1, h2, t) => { const a = new THREE.Color(h1).lerp(new THREE.Color(h2), Math.max(0, Math.min(1, t))); return '#' + a.getHexString(); };

const MARGIN = 5;      // cells of surrounding land drawn around the farm
const PX = 48;         // canvas px per cell for the procedural aerial (48: room for the alleys' tram lines)
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

  // orchard blocks, direction A + B's touches at the aerial's own density (~5.5 canopy rows per cell, E-W like
  // the sweep): mowed grass middles in alternating passes, bare berm + dark wet strip + drip line under each row,
  // twin tram lines down every alley, NW-lit canopies with a lighter flush and an SE shadow (trees.mjs palette)
  for (const b of g.blocks) {
    const x0 = X(b.x - 0.5), y0 = Y(b.y - 0.5), w = b.w * PX, h = b.h * PX;
    c.fillStyle = A.grass; c.fillRect(x0, y0, w, h);
    const rows = Math.round(b.h * 5.5), per = Math.round(b.w * 7);
    const dy = h / rows, dx = w / per, rad = Math.min(dy * 0.31, dx * 0.47);
    const ripe = Math.max(0, Math.min(1, b.ripeness || 0));
    for (let i = 0; i <= rows; i++) { // alleys (between rows, plus the two headlands)
      const ay = y0 + i * dy;
      c.fillStyle = A.grassLight; c.fillRect(x0, Math.max(y0, ay - dy * 0.22), w, Math.min(dy * 0.22, ay - y0)); // north pass lighter
      if (i > 0 && i < rows) { c.fillStyle = A.tram; for (const d of [-0.13, 0.13]) c.fillRect(x0 + 2, ay + d * dy - 0.5, w - 4, 1); }
    }
    for (let i = 0; i < rows; i++) {
      const cy = y0 + (i + 0.5) * dy;
      c.fillStyle = A.berm; c.fillRect(x0 + 2, cy - dy * 0.28, w - 4, dy * 0.56);
      c.fillStyle = A.wet; c.fillRect(x0 + 3, cy - dy * 0.1, w - 6, dy * 0.26);
      c.fillStyle = A.drip; c.fillRect(x0 + 3, cy + dy * 0.2, w - 6, 0.8);
      for (let k = 0; k < per; k++) { // SE shadows first so a canopy never sits under its neighbour's shadow
        const cx = x0 + (k + 0.5) * dx;
        c.fillStyle = 'rgba(26,26,14,.42)'; c.beginPath(); c.ellipse(cx + rad * 0.35, cy + rad * 0.4, rad * 1.05, rad * 0.95, 0, 0, 6.283); c.fill();
      }
      for (let k = 0; k < per; k++) {
        if (r() < 0.025) continue; // a missing tree here and there
        const cx = x0 + (k + 0.5) * dx + (r() - 0.5) * dx * 0.1, rr = rad * (0.86 + r() * 0.24), l = r();
        c.fillStyle = mixHex(A.leafDeep, A.leaf, 0.55 + l * 0.35 - ripe * 0.1); c.beginPath(); c.arc(cx, cy, rr, 0, 6.283); c.fill();
        c.fillStyle = mixHex(A.leaf, A.leafTip, 0.55 + l * 0.2); c.globalAlpha = 0.8; c.beginPath(); c.arc(cx - rr * 0.3, cy - rr * 0.32, rr * 0.48, 0, 6.283); c.fill(); c.globalAlpha = 1;
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

  // depot: the Fleet hub's footprint at its real placement (depotHub.js hubPlacement + HUB_PLAN): concrete pad,
  // solar canopy with the fleet-blue fascia, bay-entry stripes (amber refuel, grey service), control building, mast
  const hp = hubPlacement(g), f = hp.ry ? -1 : 1;
  const hub = (q, fill, dx = 0, dy = 0) => {
    const ax = X(hp.x + q.x0 * hp.sw * f), bx = X(hp.x + q.x1 * hp.sw * f), ay = Y(hp.y + q.z0 * hp.sz * f), by = Y(hp.y + q.z1 * hp.sz * f);
    c.fillStyle = fill; c.fillRect(Math.min(ax, bx) + dx, Math.min(ay, by) + dy, Math.abs(bx - ax), Math.abs(by - ay));
  };
  const HP = HUB_PLAN, HC = HP.colors, cn = HP.canopy, ct = HP.control;
  hub(HP.pad, HC.concrete);
  hub(cn, 'rgba(26,26,14,.35)', 0.12 * PX, 0.14 * PX); hub(ct, 'rgba(26,26,14,.35)', 0.1 * PX, 0.12 * PX);
  for (const bay of HP.bays) hub({ x0: bay.x0, x1: bay.x1, z0: cn.z1 + 0.01, z1: HP.pad.z1 - 0.02 }, bay.fill);
  hub(cn, HC.roof);
  const cnw = cn.x1 - cn.x0, cd = cn.z1 - cn.z0;
  hub({ x0: cn.x0 + cnw * 0.04, x1: cn.x0 + cnw * 0.96, z0: cn.z0 + cd * 0.08, z1: cn.z1 - cd * 0.08 }, HC.solar);
  for (let i = 1; i < 6; i++) { const u = cn.x0 + cnw * (0.04 + (0.92 * i) / 6); hub({ x0: u - 0.006, x1: u + 0.006, z0: cn.z0 + cd * 0.08, z1: cn.z1 - cd * 0.08 }, HC.solarLine); }
  for (let j = 1; j < 3; j++) { const z = cn.z0 + cd * (0.08 + (0.84 * j) / 3); hub({ x0: cn.x0 + cnw * 0.04, x1: cn.x0 + cnw * 0.96, z0: z - 0.01, z1: z + 0.01 }, HC.solarLine); }
  hub({ x0: cn.x0, x1: cn.x1, z0: cn.z1 - 0.05, z1: cn.z1 }, HC.fascia);
  hub(ct, HC.roof); hub({ x0: ct.x0, x1: ct.x1, z0: ct.z1 - 0.05, z1: ct.z1 }, HC.fascia); hub({ x0: ct.x1 - 0.05, x1: ct.x1, z0: ct.z0, z1: ct.z1 }, HC.fascia);
  c.fillStyle = HC.light; c.beginPath(); c.arc(X(hp.x + HP.mast.x * hp.sw * f), Y(hp.y + HP.mast.z * hp.sz * f), HP.mast.r * hp.sw * PX, 0, 6.283); c.fill();

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

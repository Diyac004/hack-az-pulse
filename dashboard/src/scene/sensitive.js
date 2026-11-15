// Sensitive areas next to blocks (scenario.sensitive: canal, houses, apiary) with a downwind warning.
// Placement is derived from the scenario's block / road geometry (sensitivePlacement, pure), so an area can never
// sit on a block, a road or the Fleet hub again: it goes into the empty ground on its side of the block (the
// strip between the soil bed and the next road or the island edge). When that side has no room (blocks sit 0.1
// from the column roads, so E/W sides are usually only the road), it moves to the block's corner in the strip in
// front of (south of) the block, else behind it, on the side the area faces.
// Downwind warning = a soft red halo under the feature + a thin red edge along the block side that faces it (no
// wash over the trees); the label sits at the block corner so it never covers the block's own label.
// Built once per scenario layout; each area owns its halo/edge materials + one label texture (disposed on rebuild).
// tick() only changes opacities (no allocation).
import * as THREE from 'three';
import { createBuilder } from './lowpoly.js';
import { shedParts, SHED_FOOTPRINT as FP } from './machineShed.js';
import { hubPlacement, HUB_PLAN } from './depotHub.js';

// Neighbour houses = house direction A (machine shed) at 0.38x; per-house trim/wall/rotation variation.
const HOUSE_K = 0.38, HOUSE_STEP = 1.25;
const HOUSE_VAR = [{ trim: '#B4553F', wall: '#ECEAE5', ry: 0.07 }, { trim: '#5E7A8C', wall: '#F2EDE4', ry: -0.05 }, { trim: '#7A8B5A', wall: '#E6E1D8', ry: 0.1 }];

const RED = new THREE.Color('#FF453A');
const NAME = { canal: 'Canal', houses: 'Houses', apiary: 'Apiary' };
const BED = 0.08, ROAD = 0.4, GAP = 0.06; // farm.js soil-bed pad, road half width, clearance
const LABEL_OFF = 1.9; // block label is ~2.1 wide around the block centre; ours (1.6 wide) is centred this far out

const kindOf = (what) => { const w = String(what || '').toLowerCase(); return w.includes('canal') ? 'canal' : w.includes('house') ? 'houses' : 'apiary'; };
// feature footprint along / across its run (grid cells)
const SIZE = { canal: { len: Infinity, depth: 0.5, min: 0.36 }, houses: { len: 2 * HOUSE_STEP + (FP.x1 - FP.x0) * HOUSE_K, depth: (FP.z1 - FP.z0) * HOUSE_K, min: (FP.z1 - FP.z0) * HOUSE_K }, apiary: { len: 1.3, depth: 0.3, min: 0.3 } };
const sideOf = (deg) => { const d = (((+deg || 0) % 360) + 360) % 360; return d >= 315 || d < 45 ? 'N' : d < 135 ? 'E' : d < 225 ? 'S' : 'W'; };
const overlap = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/**
 * Pure placement (grid coords; x east, y south). Island spans grid -1 .. w / h (farm.js island box).
 * @returns [{ area, kind, side, rect:{x0,x1,y0,y1}, along:'x'|'y', edge:{x0,x1,y0,y1}, label:{x,y} }]
 */
export function sensitivePlacement(g, areas) {
  let hub = null;
  try {
    const p = hubPlacement(g), f = p.ry ? -1 : 1, P = HUB_PLAN.pad;
    const xs = [p.x + P.x0 * p.sw * f, p.x + P.x1 * p.sw * f], ys = [p.y + P.z0 * p.sz * f, p.y + P.z1 * p.sz * f];
    hub = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  } catch (e) { /* no depot: nothing to avoid */ }
  const beds = g.blocks.map((b) => ({ id: b.id, x0: b.x - 0.5 - BED, x1: b.x + b.w - 0.5 + BED, y0: b.y - 0.5 - BED, y1: b.y + b.h - 0.5 + BED }));
  const taken = hub ? [hub] : [];
  const free = (r) => !beds.some((q) => overlap(r, q)) && !taken.some((q) => overlap(r, q))
    && !g.rows.some((y) => overlap(r, { x0: -1e9, x1: 1e9, y0: y - ROAD, y1: y + ROAD }))
    && !g.cols.some((x) => overlap(r, { x0: x - ROAD, x1: x + ROAD, y0: -1e9, y1: 1e9 }));
  // empty ground on one side of a bed: [near, far] across the side, limited by roads / other beds / island edge
  function strip(bed, side) {
    if (side === 'N' || side === 'S') {
      const inX = (q) => q.x0 < bed.x1 && q.x1 > bed.x0;
      if (side === 'N') return [bed.y0, Math.max(-1, ...g.rows.filter((y) => y + ROAD <= bed.y0 + 1e-6).map((y) => y + ROAD), ...beds.filter((q) => q !== bed && inX(q) && q.y1 <= bed.y0 + 1e-6).map((q) => q.y1))];
      return [bed.y1, Math.min(g.h, ...g.rows.filter((y) => y - ROAD >= bed.y1 - 1e-6).map((y) => y - ROAD), ...beds.filter((q) => q !== bed && inX(q) && q.y0 >= bed.y1 - 1e-6).map((q) => q.y0))];
    }
    const inY = (q) => q.y0 < bed.y1 && q.y1 > bed.y0;
    if (side === 'W') return [bed.x0, Math.max(-1, ...g.cols.filter((x) => x + ROAD <= bed.x0 + 1e-6).map((x) => x + ROAD), ...beds.filter((q) => q !== bed && inY(q) && q.x1 <= bed.x0 + 1e-6).map((q) => q.x1))];
    return [bed.x1, Math.min(g.w, ...g.cols.filter((x) => x - ROAD >= bed.x1 - 1e-6).map((x) => x - ROAD), ...beds.filter((q) => q !== bed && inY(q) && q.x0 >= bed.x1 - 1e-6).map((q) => q.x0))];
  }
  const out = [];
  for (const a of areas || []) {
    const b = g.blockById[a.block]; if (!b) continue;
    const bed = beds.find((q) => q.id === b.id), kind = kindOf(a.what), side = sideOf(a.dir_deg), sz = SIZE[kind];
    const cx = b.x + (b.w - 1) / 2, cy = b.y + (b.h - 1) / 2;
    // the facing edge of the block (thin red line on the soil bed's outer rim)
    const edge = side === 'N' ? { x0: bed.x0, x1: bed.x1, y0: bed.y0, y1: bed.y0 + 0.06 } : side === 'S' ? { x0: bed.x0, x1: bed.x1, y0: bed.y1 - 0.06, y1: bed.y1 }
      : side === 'W' ? { x0: bed.x0, x1: bed.x0 + 0.06, y0: bed.y0, y1: bed.y1 } : { x0: bed.x1 - 0.06, x1: bed.x1, y0: bed.y0, y1: bed.y1 };
    const tryStrip = (s, anchor) => { // anchor: null = centred on the block, 'E' / 'W' = hug that corner
      const [near, far] = strip(bed, s), sign = s === 'N' || s === 'W' ? -1 : 1, avail = Math.abs(far - near) - 2 * GAP;
      if (avail < sz.min) return null;
      const depth = Math.min(sz.depth, avail);
      // centre across the strip, nudged away from the block (toward the road) when there is slack
      const mid = near + sign * (Math.abs(far - near) / 2 + Math.min(0.15, (avail - depth) / 2));
      const runsX = s === 'N' || s === 'S';
      const span = runsX ? [bed.x0 + GAP, bed.x1 - GAP] : [bed.y0 + GAP, bed.y1 - GAP];
      const len = Math.min(sz.len, span[1] - span[0], anchor ? (runsX ? b.w : b.h) / 2 : Infinity);
      let c0 = (span[0] + span[1]) / 2 - len / 2;
      if (anchor === 'E') c0 = span[1] - len; else if (anchor === 'W') c0 = span[0];
      const rect = runsX ? { x0: c0, x1: c0 + len, y0: mid - depth / 2, y1: mid + depth / 2 } : { x0: mid - depth / 2, x1: mid + depth / 2, y0: c0, y1: c0 + len };
      return free(rect) ? { rect, along: runsX ? 'x' : 'y', strip: s } : null;
    };
    let pl = tryStrip(side, null);
    if (!pl && (side === 'E' || side === 'W')) pl = tryStrip('S', side) || tryStrip('N', side);
    if (!pl && (side === 'N' || side === 'S')) pl = tryStrip(side, 'W') || tryStrip(side, 'E');
    if (!pl) continue; // nowhere empty: skip the feature rather than draw it over something
    taken.push(pl.rect);
    const r = pl.rect, fx = (r.x0 + r.x1) / 2, fy = (r.y0 + r.y1) / 2;
    // label at the block corner on the feature's side, so it clears the block's own label
    let lx = fx, ly = fy;
    if (pl.along === 'x') { const s = side === 'E' ? 1 : side === 'W' ? -1 : (fx - cx > 0.3 ? 1 : -1); lx = cx + s * LABEL_OFF; }
    else ly = Math.abs(fy - cy) < LABEL_OFF ? cy + (side === 'S' ? 1 : -1) * LABEL_OFF * 0.6 : fy;
    out.push({ area: a, kind, side, rect: r, along: pl.along, edge, label: { x: lx, y: ly } });
  }
  return out;
}

function labelCanvas(text) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(160,24,18,.9)';
  g.beginPath(); g.roundRect ? g.roundRect(4, 8, 248, 48, 24) : g.rect(4, 8, 248, 48); g.fill();
  g.fillStyle = '#fff'; g.font = '600 26px -apple-system,BlinkMacSystemFont,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 33);
  return c;
}
function haloCanvas() { // radial falloff, stretched per feature into a soft ellipse
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,.75)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return c;
}

export function createSensitive(world) {
  const { S } = world;
  let group = null, recs = [], sig = '';
  // shared, created once
  const plane = new THREE.PlaneGeometry(1, 1);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const haloTex = typeof document !== 'undefined' ? new THREE.CanvasTexture(haloCanvas()) : null;
  const mats = {
    water: new THREE.MeshLambertMaterial({ color: '#4FA3D9', emissive: '#0b3a5c', emissiveIntensity: 0.35 }),
    bank: new THREE.MeshLambertMaterial({ color: '#C8B48A' }),
    shed: new THREE.MeshLambertMaterial({ vertexColors: true }), // merged neighbour houses (vertex colours)
    hive: new THREE.MeshLambertMaterial({ color: '#F2C14E' }),
  };

  function clear() {
    if (!group) return;
    S.remove(group);
    for (const r of recs) { r.haloMat.dispose(); r.edgeMat.dispose(); r.label.material.map.dispose(); r.label.material.dispose(); if (r.geo) r.geo.dispose(); }
    group = null; recs = [];
  }

  function build(grid, areas) {
    clear();
    group = new THREE.Group();
    const flat = (m, w, h, x, y, z, order) => { const o = new THREE.Mesh(plane, m); o.rotation.x = -Math.PI / 2; o.scale.set(w, h, 1); o.position.set(x, y, z); o.renderOrder = order; return o; };
    for (const p of sensitivePlacement(grid, areas)) {
      const r = p.rect, c = grid.toWorld((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2);
      const len = p.along === 'x' ? r.x1 - r.x0 : r.y1 - r.y0, depth = p.along === 'x' ? r.y1 - r.y0 : r.x1 - r.x0;
      // halo: soft red ellipse under the feature, kept to the empty strip (fades to 0 at its rim)
      const haloMat = new THREE.MeshBasicMaterial({ color: RED, map: haloTex, transparent: true, opacity: 0, depthWrite: false });
      // under the feature (the canal / sheds stay readable) and spilling ~0.4 past it as a soft ring
      const hw = (r.x1 - r.x0) * 1.15 + 0.8, hd = (r.y1 - r.y0) * 1.15 + 0.8;
      group.add(flat(haloMat, hw, hd, c.x, 0.016, c.z, 0)); // over roads (0.01-0.012), under the soil bed (0.02)
      // thin red edge along the block side that faces the area
      const edgeMat = new THREE.MeshBasicMaterial({ color: RED, transparent: true, opacity: 0, depthWrite: false });
      const e = p.edge, ec = grid.toWorld((e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2);
      group.add(flat(edgeMat, e.x1 - e.x0, e.y1 - e.y0, ec.x, 0.045, ec.z, 2));

      const g = new THREE.Group(); g.position.set(c.x, 0, c.z); if (p.along === 'y') g.rotation.y = Math.PI / 2;
      // local frame: x = along the run, +z = toward the block for N strips (houses face the block)
      const towardBlock = p.strip === 'N' || p.strip === 'W' ? 1 : -1;
      let geo = null; // per-area geometry (houses), disposed in clear()
      if (p.kind === 'canal') {
        const bank = new THREE.Mesh(plane, mats.bank); bank.rotation.x = -Math.PI / 2; bank.scale.set(len, depth, 1); bank.position.y = 0.025; g.add(bank);
        const water = new THREE.Mesh(plane, mats.water); water.rotation.x = -Math.PI / 2; water.scale.set(len, depth * 0.6, 1); water.position.y = 0.03; g.add(water);
      } else if (p.kind === 'houses') {
        // up to three small machine sheds merged into ONE mesh (1 draw call), fronts facing the block
        const n = Math.max(1, Math.min(3, Math.floor((len - (FP.x1 - FP.x0) * HOUSE_K) / HOUSE_STEP) + 1));
        const hb = createBuilder(), face = towardBlock > 0 ? 0 : Math.PI;
        HOUSE_VAR.slice(0, n).forEach((hv, k) => {
          const lx = (k - (n - 1) / 2) * HOUSE_STEP, ox = -((FP.x0 + FP.x1) / 2) * HOUSE_K, oz = -((FP.z0 + FP.z1) / 2) * HOUSE_K, a = face + hv.ry;
          // rotate the model offset with the house so the footprint stays centred
          hb.add(shedParts(hv.trim, hv.wall), { x: lx + ox * Math.cos(a) + oz * Math.sin(a), z: -ox * Math.sin(a) + oz * Math.cos(a), ry: a, k: HOUSE_K });
        });
        geo = hb.toGeometry();
        const sheds = new THREE.Mesh(geo, mats.shed); sheds.castShadow = sheds.receiveShadow = true; sheds.name = 'neighbourHouses';
        g.add(sheds);
      } else {
        for (let i = -1; i <= 1; i++) { const hv = new THREE.Mesh(box, mats.hive); hv.scale.set(0.22, 0.26, 0.22); hv.position.set(i * 0.5, 0.13, 0); hv.castShadow = true; g.add(hv); }
      }
      group.add(g);
      const lw = grid.toWorld(p.label.x, p.label.y);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(labelCanvas((NAME[p.kind] || p.area.what) + ' · downwind')), depthTest: false, transparent: true, opacity: 0 }));
      label.center.set(0.5, 0); label.scale.set(1.6, 0.4, 1); label.position.set(lw.x, 0.55, lw.z); label.renderOrder = 11; label.visible = false;
      group.add(label);
      recs.push({ key: p.area.block + '|' + p.area.what, haloMat, edgeMat, label, geo, level: 0, goal: 0 });
    }
    S.add(group);
  }

  return {
    clear() { clear(); sig = ''; },
    /** areas: derive.sensitiveState(state) */
    sync(grid, areas) {
      if (!grid) return;
      const s = grid.w + 'x' + grid.h + JSON.stringify((areas || []).map((a) => [a.block, a.what, a.dir_deg])) + JSON.stringify(grid.blocks.map((b) => [b.id, b.x, b.y, b.w, b.h])) + JSON.stringify([grid.rows, grid.cols, grid.depot]);
      if (s !== sig) { sig = s; build(grid, areas || []); }
      for (const r of recs) {
        const a = (areas || []).find((x) => x.block + '|' + x.what === r.key);
        r.goal = !a ? 0 : a.active ? 1 : a.toward ? 0.45 : 0;
      }
    },
    tick(now, dt) {
      for (const r of recs) {
        r.level += (r.goal - r.level) * (1 - Math.exp(-dt * 4));
        const pulse = r.goal >= 1 ? 0.75 + 0.25 * Math.sin(now / 320) : 1;
        r.haloMat.opacity = 0.75 * r.level * pulse;
        r.edgeMat.opacity = 0.9 * r.level * pulse;
        r.label.visible = r.level > 0.6;
        r.label.material.opacity = Math.max(0, (r.level - 0.6) / 0.4);
      }
    },
  };
}

// Orchard trees, direction A + B's touches (textures/index.html "Decisions" 1, textures/_build/trees.mjs treeA,
// rowPost, tufts). Part list and dimensions are copied from the generator; the layout is derived from each
// block's footprint and mockSource's sweep, never hard-coded:
//   - the tractor sweeps SWEEP_ROWS (3) E-W lanes at block.y - 0.5 + k * h/3 (mockSource.sweepPos), so the row
//     pitch is p = h / 3, drive lanes sit at top + k*p and tree rows half a pitch below them (top + (k + 0.5)*p).
//     For the 4 x 3 blocks this is exactly the generator's ROWZ / LANES; E-H (h 4) get a 1.33 pitch.
//   - in-row spacing 0.6 (4 m at 6.5 m row pitch), centred: 6 trees on a 4-wide block (18 per 3-row block),
//     row-end posts at the grass edge (+-(w/2 - 0.1)).
// GPU layout: canopy lobes (Icosahedron(1, 0), 3 instances per tree), trunks (Cylinder 5) and fruit
// (Octahedron) are one InstancedMesh each (trunk caps dropped: the top sits inside the canopy, the bottom on the ground); edge tufts + row-end posts are one merged static vertex-coloured mesh.
// Contact AO, berms, wet strips, drip lines, mowed stripes and tram lines are baked into the ground texture
// (groundTexture.js). Total: 4 draws (+2 in the shadow pass) for every block on the farm.
import * as THREE from 'three';
import { box, createBuilder } from './lowpoly.js';

export const SWEEP_ROWS = 3;      // mockSource.sweepPos: 3 boustrophedon rows per block
export const ROW_SPACING = 0.6;   // in-row tree spacing (4 m)
export const GRASS_INSET = 0.1;   // farm.js: grass plane inset inside the block footprint
export const P = {
  leafDeep: '#2C5424', leaf: '#41712E', leafTip: '#7AA63F', leafIn: '#2A4A22', bark: '#6E6151',
  orange: '#F08A1A', breakColor: '#D9B23A', lemon: '#EDD23A',
  grass: '#7E9A4E', grassLight: '#93AE5E', soil: '#9C7A52', berm: '#8E7150', wet: '#6A5236', drip: '#1C1C1E',
  tilledDark: '#8D6F4B', post: '#C9C3B6', heatCanopy: '#A39A4A',
};

export function rng(seed) { // mulberry32 (same as farm.js / trees.mjs)
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const _a = new THREE.Color(), _b = new THREE.Color();
/** trees.mjs mix(): straight per-channel lerp of two hex colours -> THREE.Color (no colour management in r128). */
export const mix = (h1, h2, t, out = new THREE.Color()) => out.copy(_a.set(h1)).lerp(_b.set(h2), t);

/**
 * Block-local layout, origin at the block's NW footprint corner (x east 0..w, z south 0..h), in grid cells.
 * Shared by the trees, the statics and the ground texture so they always agree. Pure.
 */
export function blockLayout(w, h) {
  const pitch = h / SWEEP_ROWS;
  const lanes = Array.from({ length: SWEEP_ROWS }, (_, k) => k * pitch);
  const rows = lanes.map((l) => l + pitch / 2);
  const n = Math.max(1, Math.round((w - 1) / ROW_SPACING) + 1);
  const xs = Array.from({ length: n }, (_, i) => w / 2 + (i - (n - 1) / 2) * ROW_SPACING);
  const young = { row: rows.length - 1, i: Math.min(2, n - 1) }; // one young replant per block (trees.mjs: z = 1, i = 2)
  return { w, h, pitch, lanes, rows, xs, young, postX: [GRASS_INSET, w - GRASS_INSET] };
}

/** Fruit per block (index.html A: none below 0.5, a few at colour break up to 0.7, heavy above; lemons yellow). */
export function fruitFor(b) {
  const r = b.ripeness || 0, lemon = /lemon/i.test(b.variety || '');
  if (r < 0.5) return { k: 0, color: P.orange };
  if (r < 0.7) return { k: 3, color: lemon ? P.lemon : P.breakColor };
  return { k: 9, color: lemon ? P.lemon : P.orange };
}

// ---------- shared geometries (built per farm build, disposed with the farm group) ----------
/** Icosahedron(1, 0), non-indexed, per-face vertex colours = trees.mjs leafMat (flush top, mid, deep, interior). */
function lobeGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 0); // r128: non-indexed, flat normals
  const pos = g.attributes.position, r = rng(4242), col = new Float32Array(pos.count * 3), c = new THREE.Color();
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), n = new THREE.Vector3();
  for (let f = 0; f < pos.count / 3; f++) {
    va.fromBufferAttribute(pos, f * 3); vb.fromBufferAttribute(pos, f * 3 + 1); vc.fromBufferAttribute(pos, f * 3 + 2);
    n.subVectors(vc, vb).cross(vb.clone().sub(va)).normalize();
    if (n.dot(va) < 0) n.negate();
    const j = (r() - 0.5) * 0.16;
    if (n.y > 0.62) mix(P.leaf, P.leafTip, 0.5 + j, c);
    else if (n.y > 0.12) mix(P.leaf, P.leafTip, 0.08 + j * 0.6, c);
    else if (n.y > -0.35) mix(P.leaf, P.leafDeep, 0.35 + j, c);
    else c.set(P.leafIn);
    for (let k = 0; k < 3; k++) c.toArray(col, (f * 3 + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Heat tint as a multiplier (instanceColor multiplies): mix(leaf, #A39A4A, 0.28) / leaf, per channel. */
const HEAT_MUL = (() => { const l = new THREE.Color(P.leaf), m = mix(P.leaf, P.heatCanopy, 0.28); return [m.r / l.r, m.g / l.g, m.b / l.b]; })();

/** Edge tufts (trees.mjs tufts(), 3-sided pyramids) for one block, block-local, as low-poly parts. */
function tuftParts(w, h, seed, out) {
  const r = rng(seed), g0 = GRASS_INSET, gx1 = w - GRASS_INSET, gz1 = h - GRASS_INSET;
  const tuft = (x, z) => {
    const ht = 0.045 + r() * 0.03, s = 0.035, top = [x, ht, z];
    const b = [[x - s, 0.02, z + s * 0.6], [x + s, 0.02, z + s * 0.6], [x, 0.02, z - s]];
    const c = '#' + mix(P.grass, '#4F6B2C', r() * 0.6).getHexString();
    out.push({ faces: [[b[0], b[1], top], [b[1], b[2], top], [b[2], b[0], top]].map((pts) => ({ pts, mat: c, decals: [] })), name: 'tuft' });
  };
  for (let x = 0.15; x < w; x += 0.32 + r() * 0.2) { tuft(x, gz1 - 0.02); tuft(x + 0.1, g0 + 0.02); }
  for (let z = 0.25; z < h; z += 0.34 + r() * 0.2) { tuft(g0 + 0.02, z); tuft(gx1 - 0.02, z + 0.1); }
}
/** B's white-tagged row-end post (trees.mjs rowPost). */
const rowPost = (x, z, out) => out.push(
  box(x - 0.02, x + 0.02, 0, 0.42, z - 0.02, z + 0.02, P.post, { name: 'post' }),
  box(x - 0.024, x + 0.024, 0.3, 0.36, z - 0.024, z + 0.024, '#FFFFFF', { name: 'postTag' }),
);

/**
 * Build every block's trees + statics.
 * @param g grid (blocks, toWorld)
 * @returns {{ meshes: THREE.Object3D[], setHeat(set:Set<string>):void, tris:number }}
 */
export function createOrchard(g) {
  const plan = []; // per tree: { b, x, z, s, rot, young, tint:[r,g,b] }
  const fruit = []; // { x, y, z, size, color }
  const statics = createBuilder();
  for (const b of g.blocks) {
    const L = blockLayout(b.w, b.h), nw = g.toWorld(b.x - 0.5, b.y - 0.5); // footprint NW corner, world
    const seed = [...String(b.id)].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 1337) >>> 0;
    const r = rng(seed), fr = fruitFor(b);
    const parts = [];
    L.rows.forEach((rz, ri) => {
      rowPost(L.postX[0], rz, parts); rowPost(L.postX[1], rz, parts);
      L.xs.forEach((tx, i) => {
        const young = ri === L.young.row && i === L.young.i;
        const x = nw.x + tx + (r() - 0.5) * 0.03, z = nw.z + rz + (r() - 0.5) * 0.02;
        const s = young ? 0.55 : 0.92 + r() * 0.16, rot = r() * Math.PI;
        const l = 0.93 + r() * 0.1, hue = (r() - 0.5) * 0.06; // per-tree tint variation (multiplier around 1)
        const t = { b, x, z, s, rot, young, tint: [l * (1 + hue), l, l * (1 - hue)] };
        plan.push(t);
        if (!young && fr.k) {
          const lobes = lobesOf(t);
          const place = (lo, lrot, k, size) => { for (let q = 0; q < k; q++) {
            const a = r() * Math.PI * 2, e = -0.35 + r() * 0.85;
            const px = Math.cos(a) * Math.cos(e) * lo.rad[0] * 1.02, pz = Math.sin(a) * Math.cos(e) * lo.rad[2] * 1.02, py = Math.sin(e) * lo.rad[1];
            const cs = Math.cos(lrot), sn = Math.sin(lrot);
            fruit.push({ x: lo.c[0] + px * cs + pz * sn, y: lo.c[1] + py, z: lo.c[2] - px * sn + pz * cs, size, color: fr.color });
          } };
          place(lobes[0], rot, Math.ceil(fr.k * 0.6), 0.03);
          place(lobes[1], rot + 0.7, Math.floor(fr.k * 0.4), 0.028);
        }
      });
    });
    tuftParts(b.w, b.h, seed ^ 77, parts);
    statics.add(parts, { x: nw.x, z: nw.z });
  }

  // canopy: 3 lobes per tree
  const lobeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const can = new THREE.InstancedMesh(lobeGeometry(), lobeMat, Math.max(1, plan.length * 3));
  const trk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.034, 0.034, 0.16, 5, 1, true), new THREE.MeshLambertMaterial({ color: P.bark }), Math.max(1, plan.length));
  const fru = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ emissive: '#3a1800' }), Math.max(1, fruit.length));
  can.count = plan.length * 3; trk.count = plan.length; fru.count = fruit.length;
  const dm = new THREE.Object3D(), col = new THREE.Color();
  plan.forEach((t, i) => {
    lobesOf(t).forEach((lo, k) => {
      dm.position.set(lo.c[0], lo.c[1], lo.c[2]); dm.rotation.set(0, t.rot + k * 0.7, 0); dm.scale.set(lo.rad[0], lo.rad[1], lo.rad[2]);
      dm.updateMatrix(); can.setMatrixAt(i * 3 + k, dm.matrix);
    });
    const ts = Math.min(1, t.s);
    dm.position.set(t.x, 0.08, t.z); dm.rotation.set(0, t.rot, 0); dm.scale.set(ts, 1, ts); dm.updateMatrix(); trk.setMatrixAt(i, dm.matrix);
  });
  fruit.forEach((f, i) => {
    dm.position.set(f.x, f.y, f.z); dm.rotation.set(0, 0, 0); dm.scale.setScalar(f.size); dm.updateMatrix(); fru.setMatrixAt(i, dm.matrix);
    fru.setColorAt(i, col.set(f.color));
  });
  if (!fruit.length) fru.setColorAt(0, col.set(P.orange));
  if (fru.instanceColor) fru.instanceColor.needsUpdate = true;

  function paintCanopy(heat) {
    plan.forEach((t, i) => {
      const hm = heat && heat.has(t.b.id) ? HEAT_MUL : null;
      col.setRGB(t.tint[0] * (hm ? hm[0] : 1), t.tint[1] * (hm ? hm[1] : 1), t.tint[2] * (hm ? hm[2] : 1));
      for (let k = 0; k < 3; k++) can.setColorAt(i * 3 + k, col);
    });
    if (!plan.length) can.setColorAt(0, col.setRGB(1, 1, 1));
    can.instanceColor.needsUpdate = true;
  }
  paintCanopy(null);

  const st = new THREE.Mesh(statics.toGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  st.name = 'orchardStatics'; st.receiveShadow = true; st.matrixAutoUpdate = false; st.updateMatrix();
  can.name = 'treeCanopy'; trk.name = 'treeTrunks'; fru.name = 'treeFruit';
  can.castShadow = trk.castShadow = true; can.receiveShadow = true;
  // r128 culls an InstancedMesh by its unit geometry's sphere at the origin: the instances span the farm
  for (const m of [can, trk, fru]) { m.frustumCulled = false; m.matrixAutoUpdate = false; m.instanceMatrix.needsUpdate = true; }

  let heatKey = '';
  return {
    meshes: [can, trk, fru, st],
    tris: can.count * 20 + trk.count * 10 + fru.count * 8 + statics.tris,
    trees: plan.length, fruit: fruit.length,
    /** Yellowed canopy on heat-stressed blocks; recolours only when the set changes. */
    setHeat(set) {
      const key = [...(set || [])].sort().join(',');
      if (key === heatKey) return; heatKey = key;
      paintCanopy(set);
    },
  };
}

/** trees.mjs treeA lobes: rounded dome (skirt at 0.06) + two offset shoulder lobes; offsets are not rotated. */
function lobesOf(t) {
  const { x, z, s } = t;
  return [
    { c: [x, 0.06 + 0.23 * s, z], rad: [0.3 * s, 0.23 * s, 0.215 * s] },
    { c: [x + 0.1 * s, 0.06 + 0.36 * s, z - 0.03 * s], rad: [0.18 * s, 0.15 * s, 0.15 * s] },
    { c: [x - 0.12 * s, 0.06 + 0.33 * s, z + 0.04 * s], rad: [0.17 * s, 0.14 * s, 0.14 * s] },
  ];
}

// Orchard trees + block ground ("plots") concepts. Same method as the tractors and houses: every direction is a
// low-poly part list in SCENE units (1 unit = 1 grid cell; x east, y up, z south = toward the default camera),
// projected by build.mjs with the same light and four flat tones. The new primitives below (icosahedron lobes,
// octahedron fruit, extruded hedge prism, flat ground quads) are exactly IcosahedronGeometry(1, 0|1),
// OctahedronGeometry(1, 0), an ExtrudeGeometry / custom prism, and PlaneGeometry / CircleGeometry in three.js r128.
//
// Realism scale. A block is 4 x 3 cells and the tractor drives E-W lanes at grid y = b.y - 0.5 + row
// (mockSource sweepPos): the north headland and the two alleys between the three tree rows. Reading one row pitch
// (1 cell) as a real 6.5 m row spacing gives: in-row spacing 4 m = 0.62, canopy top 4 m = 0.6, skirt 40 cm = 0.06,
// trunk ~15 cm = 0.035 radius. Tractor A at scene scale 0.85 is 0.6 wide (real 2.2 m would be 0.34), so the
// canopy is kept to about 0.44 across the row, which leaves the oversized tractor a believable 0.56 alley.

// ---------- deterministic randomness (mulberry32, same as farm.js) ----------
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
const avg = (ps) => ps.reduce((s, p) => [s[0] + p[0] / ps.length, s[1] + p[1] / ps.length, s[2] + p[2] / ps.length], [0, 0, 0]);

// ---------- polyhedra ----------
const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_V = [[-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0], [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI], [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]].map(nrm);
const ICO_F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
const icoTris = (detail) => {
  let tris = ICO_F.map((f) => f.map((i) => ICO_V[i]));
  for (let d = 0; d < detail; d++) {
    const mid = (a, b) => nrm([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
    tris = tris.flatMap(([a, b, c]) => { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); return [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]; });
  }
  return tris;
};
const ICO = [icoTris(0), icoTris(1)];
const OCT = (() => { const P = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]; const F = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [0, 4, 3], [4, 1, 3], [1, 5, 3], [5, 0, 3]]; return F.map((f) => f.map((i) => P[i])); })();

/** Unit-sphere triangle list -> part. r = [rx, ry, rz], rot about y; mat(face normal, centroid, index) -> colour. */
function poly(tris, c, r, rot, mat, o = {}) {
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const T = ([x, y, z]) => { const px = x * r[0], pz = z * r[2]; return [c[0] + px * cs + pz * sn, c[1] + y * r[1], c[2] - px * sn + pz * cs]; };
  const faces = tris.map((t, i) => {
    const pts = t.map(T);
    let n = nrm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    const fc = avg(pts); if ((fc[0] - c[0]) * n[0] + (fc[1] - c[1]) * n[1] + (fc[2] - c[2]) * n[2] < 0) n = n.map((v) => -v);
    return { pts, mat: typeof mat === 'function' ? mat(n, fc, i) : mat, decals: [], op: o.op };
  });
  return { faces, bias: o.bias || 0, tris: tris.length, name: o.name };
}
export const ico = (c, r, rot, mat, o = {}) => poly(ICO[o.detail || 0], c, r, rot, mat, o);
export const octa = (c, rad, mat, o = {}) => poly(OCT, c, [rad, rad, rad], 0, mat, o);
/** Convex prism along x: profile [[z, y], ...] counter-clockwise seen from +x. three.js: 2n side tris + 2(n-2) cap tris. */
function prism(profile, x0, x1, zc, mat, o = {}) {
  const A = profile.map(([z, y]) => [x0, y, zc + z]), B = profile.map(([z, y]) => [x1, y, zc + z]);
  const n = profile.length, faces = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, pts = [A[i], A[j], B[j], B[i]];
    const nz = (profile[i][0] + profile[j][0]) / 2, ny = (profile[i][1] + profile[j][1]) / 2;
    faces.push({ pts, mat: typeof mat === 'function' ? mat([0, ny - 0.3, nz], avg(pts), i) : mat, decals: [], op: o.op });
  }
  const capMat = o.cap || (typeof mat === 'function' ? mat([0, 0, 0], [0, 0.3, 0], -1) : mat);
  faces.push({ pts: [...A].reverse(), mat: capMat, decals: [] }, { pts: B, mat: capMat, decals: [] });
  return { faces, bias: o.bias || 0, tris: 2 * n + 2 * (n - 2), name: o.name };
}
/** Flat horizontal quad / disc on the ground (drawn in list order by the scene renderer). */
export const quad = (x0, x1, z0, z1, y, fill, op) => ({ faces: [{ pts: [[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]], mat: fill, decals: [], op }], bias: 0, tris: 2, name: 'ground' });
export const disc = (x, z, rx, rz, n, y, fill, op, rot = 0) => ({ faces: [{ pts: Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; const px = Math.cos(a) * rx, pz = Math.sin(a) * rz; return [x + px * Math.cos(rot) + pz * Math.sin(rot), y, z - px * Math.sin(rot) + pz * Math.cos(rot)]; }).reverse(), mat: fill, decals: [], op }], bias: 0, tris: n, name: 'disc' });

export function makeOrchard({ box, beam, cyl, M, mix, placePart, tractor, hub }) {
  // ---------- palettes ----------
  const P = {
    // A: real citrus. Deep glossy green, lighter new-growth flush on top, near-black interior.
    leafDeep: '#2C5424', leaf: '#41712E', leafTip: '#7AA63F', leafIn: '#2A4A22', bark: '#6E6151',
    orange: '#F08A1A', orangeLit: '#FFAD45', breakColor: '#D9B23A', lemon: '#EDD23A',
    grass: '#7E9A4E', grassLight: '#93AE5E', soil: '#9C7A52', berm: '#8E7150', wet: '#6A5236', track: '#6C7F43', drip: '#1C1C1E',
    // B: hedgerow, slightly cooler and more uniform (machine-hedged faces)
    hedge: '#3C6E2D', hedgeTop: '#5F8F36', hedgeIn: '#2A4A22', tilled: '#A7865C', tilledDark: '#8D6F4B', post: '#C9C3B6',
    // C: soft minimal, calm sage
    sage: '#7FA26A', sageTop: '#9DBC84', sageGrass: '#A9BB86', sageGrassLight: '#B5C694', sageSoil: '#B39C7C',
    // current scene
    curCanopy: '#4E7A2C', curTrunk: '#6B4F33', curFruit: '#FF8A1F', curGrass: '#86A257', curSoil: '#9C7A52',
    island: '#D9C49B', road: '#EEE2C6',
  };

  // ---------- trees ----------
  const leafMat = (r, base, tip, deep, inner, tint) => (n, fc, i) => {
    const j = (r() - 0.5) * 0.16;
    let c = n[1] > 0.62 ? mix(base, tip, 0.5 + j) : n[1] > 0.12 ? mix(base, tip, 0.08 + j * 0.6) : n[1] > -0.35 ? mix(base, deep, 0.35 + j) : inner;
    if (tint) c = mix(c, tint[0], tint[1]);
    return c;
  };
  // fruit on the lobe surface: mostly the outer, lower-middle band where citrus actually hangs
  const fruitOn = (r, c, rad, rot, k, mat, size) => Array.from({ length: k }, () => {
    const a = r() * Math.PI * 2, e = -0.35 + r() * 0.85;
    const x = Math.cos(a) * Math.cos(e) * rad[0] * 1.02, z = Math.sin(a) * Math.cos(e) * rad[2] * 1.02, y = Math.sin(e) * rad[1];
    const cs = Math.cos(rot), sn = Math.sin(rot);
    return octa([c[0] + x * cs + z * sn, c[1] + y, c[2] - x * sn + z * cs], size, (n) => (n[1] > 0.3 ? mix(mat, '#FFFFFF', 0.25) : mat), { name: 'fruit' });
  });
  const FRUIT = { none: 0, few: 3, heavy: 9 };

  /** A: refined citrus. Short trunk, skirt at 0.06, three stacked lobes, two-tone leaves, fruit by ripeness. */
  function treeA(x, z, o = {}) {
    const r = rng(o.seed ?? 1);
    const s = o.s ?? 0.92 + r() * 0.16, rot = o.rot ?? r() * Math.PI, tint = o.tint;
    const lm = leafMat(r, P.leaf, P.leafTip, P.leafDeep, P.leafIn, tint);
    // one rounded dome (skirt at 0.06) + two offset shoulder lobes that break the silhouette like real flush growth
    const lobes = [
      { c: [x, 0.06 + 0.23 * s, z], rad: [0.3 * s, 0.23 * s, 0.215 * s] },
      { c: [x + 0.1 * s, 0.06 + 0.36 * s, z - 0.03 * s], rad: [0.18 * s, 0.15 * s, 0.15 * s] },
      { c: [x - 0.12 * s, 0.06 + 0.33 * s, z + 0.04 * s], rad: [0.17 * s, 0.14 * s, 0.14 * s] },
    ];
    const parts = [
      cyl('y', [x, 0.08, z], 0.034 * Math.min(1, s), 0.16, 5, P.bark, { name: 'trunk' }),
      ...(o.lite ? lobes.slice(0, 1) : lobes).map((l, i) => ico(l.c, l.rad, rot + i * 0.7, lm, { name: 'canopy' })),
    ];
    const k = FRUIT[o.fruit || 'none'];
    if (k) parts.push(...fruitOn(r, lobes[0].c, lobes[0].rad, rot, Math.ceil(k * 0.6), o.fruitColor || P.orange, 0.03), ...fruitOn(r, lobes[1].c, lobes[1].rad, rot + 0.7, Math.floor(k * 0.4), o.fruitColor || P.orange, 0.028));
    return { parts, ao: [disc(x, z, 0.36 * s, 0.27 * s, 10, 0.021, '#1A1A0E', 0.42, rot * 0.2)] };
  }

  /** current scene tree (farm.js): Icosahedron(0.34) at y 0.58 scaled (s, 0.9s, s), Cylinder(0.05, 0.07, 0.4, 6), Sphere fruit */
  function treeCur(x, z, o = {}) {
    const r = rng(o.seed ?? 1);
    const s = o.s ?? 0.85 + r() * 0.3, rot = r() * 3;
    const col = o.tint ? mix(P.curCanopy, o.tint[0], o.tint[1]) : P.curCanopy;
    const parts = [
      cyl('y', [x, 0.2, z], 0.06, 0.4, 6, P.curTrunk, { name: 'trunk' }),
      ico([x, 0.58, z], [0.34 * s, 0.34 * s * 0.9, 0.34 * s], rot, col, { name: 'canopy' }),
    ];
    for (let f = 0; f < (o.fruitN || 0); f++) {
      const a = r() * 6.28, e = r() * 1.2 - 0.3;
      parts.push(ico([x + Math.cos(a) * 0.3 * s, 0.58 + Math.sin(e) * 0.28, z + Math.sin(a) * 0.3 * s], [0.06, 0.06, 0.06], 0, P.curFruit, { name: 'fruit', detail: 1 }));
    }
    return { parts, ao: [] };
  }

  /** B: hedgerow segment (one cell of row, the instancing unit). Machine-hedged faces, rounded top, skirted base. */
  const HEDGE = [[-0.17, 0.07], [0.17, 0.07], [0.215, 0.2], [0.21, 0.4], [0.15, 0.54], [-0.15, 0.54], [-0.21, 0.4], [-0.215, 0.2]].map(([z, y]) => [-z, y]);
  function hedgeSeg(x0, x1, z, o = {}) {
    const r = rng(o.seed ?? 3), h = o.h ?? 0.95 + r() * 0.1;
    const prof = HEDGE.map(([pz, py]) => [pz, py <= 0.07 ? py : py * h]);
    const tint = o.tint;
    const hm = (n) => { let c = n[1] > 0.15 ? mix(P.hedge, P.hedgeTop, 0.45 + (r() - 0.5) * 0.2) : n[1] < -0.2 ? P.hedgeIn : mix(P.hedge, P.hedgeTop, (r() - 0.5) * 0.12); return tint ? mix(c, tint[0], tint[1]) : c; };
    const lm = leafMat(r, P.hedge, P.leafTip, P.leafDeep, P.leafIn, tint);
    const xm = (x0 + x1) / 2, L = x1 - x0;
    const parts = [
      ...[0.25, 0.75].map((t) => cyl('y', [x0 + L * t, 0.06, z], 0.03, 0.12, 5, P.bark, { name: 'trunk' })),
      prism(prof, x0, x1, z, hm, { name: 'hedge' }),
      ico([xm - L * 0.22, 0.51 * h, z + 0.01], [L * 0.24, 0.085, 0.14], 0.3 + r() * 0.4, lm, { name: 'top' }),
      ico([xm + L * 0.24, 0.52 * h, z - 0.01], [L * 0.22, 0.08, 0.135], 0.3 + r() * 0.4, lm, { name: 'top' }),
    ];
    const k = { none: 0, few: 2, heavy: 6 }[o.fruit || 'none'];
    for (let i = 0; i < k; i++) {
      const side = i % 2 ? -1 : 1, fy = 0.14 + r() * 0.3;
      parts.push(octa([x0 + L * (0.1 + r() * 0.8), fy, z + side * 0.218], 0.028, (n) => (n[1] > 0.3 ? P.orangeLit : P.orange), { name: 'fruit' }));
    }
    return { parts, ao: [quad(x0, x1, z - 0.27, z + 0.27, 0.021, '#1A1A0E', 0.3)] };
  }
  const rowPost = (x, z) => [
    box(x - 0.02, x + 0.02, 0, 0.42, z - 0.02, z + 0.02, P.post, { name: 'post' }),
    box(x - 0.024, x + 0.024, 0.3, 0.36, z - 0.024, z + 0.024, '#FFFFFF', { name: 'postTag' }),
  ];

  /** C: soft minimal blob, Icosahedron(1, 1), one calm tone + soft contact disc. */
  function treeC(x, z, o = {}) {
    const r = rng(o.seed ?? 5), s = o.s ?? 0.94 + r() * 0.12;
    const base = o.tint ? mix(P.sage, o.tint[0], o.tint[1]) : P.sage;
    const parts = [
      cyl('y', [x, 0.05, z], 0.03, 0.1, 5, P.bark, { name: 'trunk' }),
      ico([x, 0.08 + 0.25 * s, z], [0.29 * s, 0.25 * s, 0.215 * s], r() * 3, (n) => (n[1] > 0.55 ? mix(base, P.sageTop, 0.5) : base), { name: 'canopy', detail: 1 }),
    ];
    const k = { none: 0, few: 2, heavy: 5 }[o.fruit || 'none'];
    for (let i = 0; i < k; i++) {
      const a = -0.6 + r() * 2.2, e = -0.1 + r() * 0.5;
      parts.push(octa([x + Math.cos(a) * 0.29 * s, 0.08 + 0.25 * s + Math.sin(e) * 0.24 * s, z + Math.sin(a) * 0.215 * s], 0.026, '#EE9A4A', { name: 'fruit' }));
    }
    return { parts, ao: [disc(x, z, 0.36 * s, 0.28 * s, 16, 0.021, '#3A3A20', 0.38)] };
  }

  const trees = {
    current: { title: 'Current tree', ...treeCur(0, 0, { s: 1, fruitN: 2 }) },
    A: { title: 'A. Refined citrus', ...treeA(0, 0, { s: 1, rot: 0.4, fruit: 'heavy', seed: 11 }) },
    B: { title: 'B. Orchard hedgerow (one cell)', ...(() => { const a = hedgeSeg(-0.5, 0.5, 0, { h: 1, fruit: 'heavy', seed: 7 }); return { parts: [...a.parts, ...rowPost(-0.56, 0)], ao: a.ao }; })() },
    C: { title: 'C. Soft minimal', ...treeC(0, 0, { s: 1, fruit: 'few', seed: 9 }) },
  };

  // ---------- plots: one block (4 x 3 cells) centred on the origin ----------
  // footprint x -2..2, z -1.5..1.5; tree rows z = -1, 0, 1; sweep lanes z = -1.5, -0.5, 0.5 (E-W serpentine)
  const BW = 4, BH = 3, BED = 0.08, INSET = 0.1;
  const X0 = -BW / 2, X1 = BW / 2, Z0 = -BH / 2, Z1 = BH / 2;
  const gx0 = X0 + INSET, gx1 = X1 - INSET, gz0 = Z0 + INSET, gz1 = Z1 - INSET;
  const ROWZ = [-1, 0, 1], LANES = [-1.5, -0.5, 0.5];
  const addE = (h, e, k) => { const a = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)), b = [1, 3, 5].map((i) => parseInt(e.slice(i, i + 2), 16)); return '#' + a.map((v, i) => Math.min(255, Math.round(v + b[i] * k)).toString(16).padStart(2, '0')).join('').toUpperCase(); };
  // block tint = Lambert base + emissive (what farm.js tick() can actually produce); ripe uses a stronger 0.15
  const STATE = {
    normal: { grass: (g) => g, canopy: null, fruit: 'none' },
    ripe: { grass: (g) => addE(g, '#FF7A1A', 0.15), canopy: null, fruit: 'heavy' },
    heat: { grass: (g) => addE(mix(g, '#B5A35A', 0.3), '#FF4A10', 0.27), canopy: ['#A39A4A', 0.28], fruit: 'few' },
  };

  /** grass treatments per direction -> list of ground quads (one CanvasTexture in three.js, zero extra draws) */
  function ground(dir, state) {
    const g = [];
    const st = STATE[state];
    if (dir === 'current') { // today's farm.js tick(): ripe 0.22 * (0.72 - 0.6) * 3.3 = 0.087, heat pulse mid 0.27, nothing else
      const cg = state === 'ripe' ? addE(P.curGrass, '#FF7A1A', 0.087) : state === 'heat' ? addE(P.curGrass, '#FF4A10', 0.27) : P.curGrass;
      g.push(quad(X0 - BED, X1 + BED, Z0 - BED, Z1 + BED, 0.02, P.curSoil), quad(gx0, gx1, gz0, gz1, 0.02, cg));
      return g;
    }
    if (dir === 'A' || dir === 'AB') {
      const G = st.grass(P.grass), GL = st.grass(P.grassLight);
      g.push(quad(X0 - BED, X1 + BED, Z0 - BED, Z1 + BED, 0.02, P.soil), quad(gx0, gx1, gz0, gz1, 0.02, G));
      // mowed stripes in the middles, along the work direction (E-W): two passes per alley
      for (const lz of [-0.5, 0.5]) g.push(quad(gx0, gx1, lz - 0.25, lz, 0.02, GL));
      g.push(quad(gx0, gx1, gz0, -1.25, 0.02, GL)); // headland pass
      g.push(quad(gx0, gx1, 1.25, gz1, 0.02, GL));
      // tilled tree-row berms (bare, herbicide strip) with a darker wet band under the drip line
      for (const z of ROWZ) {
        g.push(quad(gx0 + 0.04, gx1 - 0.04, z - 0.25, z + 0.25, 0.02, st === STATE.heat ? mix(P.berm, '#B89A6A', 0.4) : P.berm));
        g.push(quad(gx0 + 0.06, gx1 - 0.06, z - 0.12, z + 0.16, 0.02, state === 'heat' ? mix(P.wet, P.berm, 0.6) : P.wet, 0.85));
        g.push(quad(gx0 + 0.06, gx1 - 0.06, z + 0.11, z + 0.122, 0.02, P.drip, 0.8)); // drip line, visible between trees
      }
      // tyre tracks in each lane (wheel track of tractor A at 0.85: +-0.24); AB swaps them for B's bare twin tram lines
      for (const lz of LANES) for (const d of [-0.24, 0.24]) {
        const z = lz + d; if (z < gz0 + 0.02 || z > gz1 - 0.02) continue;
        if (dir === 'AB') g.push(quad(X0 + 0.02, X1 - 0.02, z - 0.035, z + 0.035, 0.02, P.tilledDark, 0.85));
        else g.push(quad(gx0, gx1, z - 0.03, z + 0.03, 0.02, P.track, 0.55));
      }
      return g;
    }
    if (dir === 'B') {
      const G = st.grass(P.grass), GL = st.grass(P.grassLight);
      g.push(quad(X0 - BED, X1 + BED, Z0 - BED, Z1 + BED, 0.02, P.soil), quad(gx0, gx1, gz0, gz1, 0.02, G));
      for (const lz of [-0.5, 0.5]) { g.push(quad(gx0, gx1, lz - 0.13, lz + 0.13, 0.02, GL)); }
      g.push(quad(gx0, gx1, gz0, -1.3, 0.02, GL));
      for (const z of ROWZ) {
        g.push(quad(gx0 + 0.04, gx1 - 0.04, z - 0.3, z + 0.3, 0.02, P.tilled));
        g.push(quad(gx0 + 0.04, gx1 - 0.04, z - 0.2, z + 0.22, 0.02, state === 'heat' ? P.tilled : P.tilledDark, 0.9));
        g.push(quad(gx0 + 0.02, gx1 - 0.02, z + 0.24, z + 0.256, 0.02, P.drip, 0.85)); // drip line just outside the hedge skirt
      }
      // tram lines: bare twin tracks the full length of each lane
      for (const lz of LANES) for (const d of [-0.24, 0.24]) {
        const z = lz + d; if (z < gz0 + 0.02 || z > gz1 - 0.02) continue;
        g.push(quad(X0 + 0.02, X1 - 0.02, z - 0.035, z + 0.035, 0.02, P.tilledDark, 0.85));
      }
      return g;
    }
    // C
    const G = st.grass(P.sageGrass), GL = st.grass(P.sageGrassLight);
    g.push(quad(X0 - BED, X1 + BED, Z0 - BED, Z1 + BED, 0.02, P.sageSoil), quad(gx0, gx1, gz0, gz1, 0.02, G));
    for (const lz of LANES) { const a = Math.max(gz0, lz - 0.25), b = Math.min(gz1, lz + 0.25); g.push(quad(gx0, gx1, a, b, 0.02, GL, 0.8)); }
    return g;
  }
  // optional edge tufts along the frame (A only): 4-tri pyramids, one merged static mesh in three.js
  function tufts(seed) {
    const r = rng(seed), out = [];
    const tuft = (x, z) => { const h = 0.045 + r() * 0.03, w = 0.035; const top = [x, h, z];
      const b = [[x - w, 0.02, z + w * 0.6], [x + w, 0.02, z + w * 0.6], [x, 0.02, z - w]];
      return { faces: [[b[0], b[1], top], [b[1], b[2], top], [b[2], b[0], top]].map((pts) => ({ pts, mat: mix(P.grass, '#4F6B2C', r() * 0.6), decals: [] })), bias: 0, tris: 4, name: 'tuft' }; };
    for (let x = X0 + 0.15; x < X1; x += 0.32 + r() * 0.2) { out.push(tuft(x, gz1 - 0.02), tuft(x + 0.1, gz0 + 0.02)); }
    for (let z = Z0 + 0.25; z < Z1; z += 0.34 + r() * 0.2) { out.push(tuft(gx0 + 0.02, z), tuft(gx1 - 0.02, z + 0.1)); }
    return out;
  }

  /** all trees of one block for a direction + state -> [{parts, ao}] (one entry per tree / hedge segment) */
  function orchard(dir, state, seed = 1337) {
    const st = STATE[state], r = rng(seed), out = [];
    if (dir === 'current') {
      const fruitN = state === 'ripe' ? 2 : 0; // ripeness 0.72 -> round((0.72 - 0.45) * 8) = 2
      for (const z of ROWZ) for (const x of [-1.5, -0.5, 0.5, 1.5]) out.push(treeCur(x, z, { seed: (r() * 1e9) | 0, fruitN }));
    } else if (dir === 'A' || dir === 'AB') {
      // AB pulls the row ends in 0.05 so B's row-end posts stand clear of the last canopy
      const xs = dir === 'AB' ? [-1.5, -0.9, -0.3, 0.3, 0.9, 1.5] : [-1.55, -0.93, -0.31, 0.31, 0.93, 1.55];
      if (dir === 'AB') for (const z of ROWZ) out.push({ parts: [...rowPost(-1.9, z), ...rowPost(1.9, z)], ao: [] });
      for (const z of ROWZ) xs.forEach((x, i) => {
        const young = z === 1 && i === 2; // one young replant: real groves always have a few
        out.push(treeA(x + (r() - 0.5) * 0.03, z + (r() - 0.5) * 0.02, { seed: (r() * 1e9) | 0, s: young ? 0.55 : undefined, fruit: young ? 'none' : st.fruit, fruitColor: st.fruit === 'few' ? P.breakColor : P.orange, tint: st.canopy }));
      });
    } else if (dir === 'B') {
      for (const z of ROWZ) {
        for (let i = 0; i < 4; i++) out.push(hedgeSeg(-1.82 + i * 0.91, -1.82 + (i + 1) * 0.91, z, { seed: (r() * 1e9) | 0, fruit: st.fruit, tint: st.canopy }));
        out.push({ parts: [...rowPost(-1.88, z), ...rowPost(1.88, z)], ao: [] });
      }
    } else {
      for (const z of ROWZ) for (const x of [-1.5, -0.5, 0.5, 1.5]) out.push(treeC(x, z, { seed: (r() * 1e9) | 0, fruit: st.fruit === 'heavy' ? 'few' : 'none', tint: st.canopy }));
    }
    return out;
  }

  /** coverage bands painted so far (mockCoverage bandCells): row 0 full, row 1 from the east edge to the hitch */
  function coverage(color, head, op) {
    const out = [quad(X0, X1, Z0, Z0 + 1, 0.032, color, op)];
    if (head < X1) out.push(quad(head, X1, Z0 + 1, Z0 + 2, 0.032, color, op));
    return out;
  }
  const abLine = (color, z, edge = true) => {
    const c = mix(color, '#FFFFFF', 0.45);
    return [...(edge ? [quad(X0, X1, z - 0.045, z + 0.045, 0.07, '#1C1C1E', 0.55)] : []), quad(X0, X1, z - 0.025, z + 0.025, 0.07, c, 0.95), disc(X0, z, 0.08, 0.08, 16, 0.07, '#FFFFFF', 0.95), disc(X1, z, 0.08, 0.08, 16, 0.07, '#FFFFFF', 0.95)];
  };

  // tractor A working row 1 (lane z -0.5), heading west, 45 % along: sweepPos x = b.x + 3 - 0.45 * 3
  const TRX = 1.5 - 0.45 * 3, TRZ = -0.5;
  const tractorAt = (x, z) => tractor.parts.map((p) => placePart(p, { s: 0.85, ry: -Math.PI / 2, x, z }));

  /**
   * Scene spec for build.mjs renderScene(). kind 'block' = iso sample with roads + Fleet hub,
   * 'map' = top-down Map view vocabulary, 'tile' = block only (state sheets).
   */
  function blockSpec(dir, { state = 'ripe', color = '#0A84FF', kind = 'block', progress = 0.45, abEdge = true } = {}) {
    const bare = kind === 'tile' || kind === 'maptile', isMap = kind === 'map' || kind === 'maptile';
    const trx = 1.5 - progress * 3;
    const head = trx + 0.45; // painted up to just behind the hitch
    const covOp = isMap ? 0.62 : 0.6;
    const groundL = [];
    if (!bare) {
      groundL.push(quad(-3.2, 3.6, -4.3, 2.2, 0, P.island));
      groundL.push(quad(-3.2, 3.6, -2.4, -1.6, 0.01, P.road), quad(2.1, 2.9, -2.4, 2.2, 0.012, P.road));
      groundL.push(quad(-3.2, 2.1, 1.6, 2.2, 0.01, P.road));
    } else {
      groundL.push(quad(X0 - 0.35, X1 + 0.35, Z0 - 0.35, Z1 + 0.35, 0, P.island));
    }
    groundL.push(...ground(dir, state));
    const trees = orchard(dir, state);
    const groups = trees.map((t) => ({ parts: t.parts, shadow: true }));
    if (dir === 'A' || dir === 'AB') groups.push({ parts: tufts(77), shadow: false });
    const trk = tractorAt(trx, TRZ);
    groups.push({ parts: trk, shadow: true, style: `--body:${color}`, late: isMap });
    if (!bare) groups.push({ parts: hub.parts.map((p) => placePart(p, { x: 0.25, z: -3.3 })), shadow: true });
    const ao = trees.flatMap((t) => t.ao);
    const cov = coverage(color, head, covOp), ab = abLine(color, TRZ, abEdge);
    if (isMap) {
      // the top view draws +z (south) up, like the tractor sheets; turn the block 180 degrees so the Map reads north-up, east-right
      const N = (p) => placePart(p, { ry: Math.PI });
      return { ground: groundL.map(N), ao: ao.map(N), groups: groups.map((g) => ({ ...g, parts: g.parts.map(N) })), post: [...cov, ...ab].map(N),
        mapIcon: { x: -trx, z: -TRZ, color }, outline: { w: BW + 0.12, h: BH + 0.12, t: 0.07 } };
    }
    return { ground: [...groundL, ...cov], ao, overlays: ab, groups };
  }

  // ---------- budgets: three.js r128 triangles per instance (CylinderGeometry with caps = 4n) ----------
  const budgets = {
    current: { label: 'Current', perBlock: 12, parts: [
      { part: 'Canopy', geo: 'Icosahedron(0.34, 0)', tris: 20, per: 1 },
      { part: 'Trunk', geo: 'Cylinder 6', tris: 24, per: 1 },
    ], fruit: { geo: 'Sphere(8, 6)', tris: 80, few: 1, heavy: 2 }, ao: null, ground: 'flat colour + emissive', draws: 3, shadowDraws: 2, statics: 0 },
    A: { label: 'A · Refined citrus', perBlock: 18, parts: [
      { part: 'Canopy lobes', geo: 'Icosahedron(1, 0) ×3 (one InstancedMesh, 3 instances per tree)', tris: 20, per: 3 },
      { part: 'Trunk', geo: 'Cylinder 5', tris: 20, per: 1 },
      { part: 'Contact AO', geo: 'Circle 10', tris: 10, per: 1 },
    ], fruit: { geo: 'Octahedron', tris: 8, few: 3, heavy: 9 }, ground: 'one shared CanvasTexture (stripes, berms, wet strip, drip line, tracks) + emissive', draws: 4, shadowDraws: 2, statics: 0 },
    AB: { label: 'A + B touches', perBlock: 18, parts: [
      { part: 'Canopy lobes', geo: 'Icosahedron(1, 0) ×3', tris: 20, per: 3 },
      { part: 'Trunk', geo: 'Cylinder 5', tris: 20, per: 1 },
      { part: 'Contact AO', geo: 'Circle 10', tris: 10, per: 1 },
    ], fruit: { geo: 'Octahedron', tris: 8, few: 3, heavy: 9 }, ground: 'one shared CanvasTexture (stripes, berms, wet strip, drip line, tram lines) + emissive', draws: 4, shadowDraws: 2, statics: 8 * 3 * 2 * 24 },
    B: { label: 'B · Orchard rows', perBlock: 12, parts: [
      { part: 'Hedge segment', geo: '8-sided prism (Extrude)', tris: 28, per: 1 },
      { part: 'Top lobes', geo: 'Icosahedron(1, 0) ×2', tris: 20, per: 2 },
      { part: 'Trunks', geo: 'Cylinder 5 ×2 (optional, mostly hidden)', tris: 20, per: 2 },
      { part: 'Contact AO', geo: 'Plane', tris: 2, per: 1 },
    ], fruit: { geo: 'Octahedron', tris: 8, few: 2, heavy: 6 }, ground: 'one shared CanvasTexture (stripes, tilled berms, tram lines)', draws: 5, shadowDraws: 3, statics: 8 * 3 * 2 * 24 },
    C: { label: 'C · Soft minimal', perBlock: 12, parts: [
      { part: 'Canopy blob', geo: 'Icosahedron(1, 1)', tris: 80, per: 1 },
      { part: 'Trunk stub', geo: 'Cylinder 5', tris: 20, per: 1 },
      { part: 'Contact AO', geo: 'Circle 16', tris: 16, per: 1 },
    ], fruit: { geo: 'Octahedron', tris: 8, few: 0, heavy: 2 }, ground: 'flat colour + faint lane stripes', draws: 4, shadowDraws: 2, statics: 0 },
  };

  // ---------- depot strip: Fleet hub in its real spot (mock scenario, grid coords: x = grid x, z = grid y) ----------
  // Grid 20 x 14, road rows 0/6/13, cols 0/5/10/15, depot cell (1, 6). hubPlacement() (depotHub.js) picks the north
  // strip between block A's soil bed (y 4.58) and road 6 (edge 5.6): 1.02 deep for a 1.5-deep pad.
  const DEPOT_OPTS = {
    a: { label: 'Depth squashed', sw: 0.85, sz: 0.6, hx: 1.8625, hz: 5.072, ay: 2 },
    b: { label: 'Uniform 0.66', sw: 0.66, sz: 0.66, hx: 1.62, hz: 5.07, ay: 2 },
    c: { label: 'Full 0.85, block A one row north', sw: 0.85, sz: 0.85, hx: 1.8625, hz: 4.565, ay: 1 },
  };
  function depotSpec(opt, { top = false } = {}) {
    const o = DEPOT_OPTS[opt];
    const at = (bx, by) => (p) => placePart(p, { x: bx + 1.5, z: by + 1 });
    const groundL = [quad(-0.9, 10.45, -0.9, 7.3, 0, P.island)];
    for (const r of [0, 6]) groundL.push(quad(-0.9, 10.45, r - 0.4, r + 0.4, 0.01, P.road));
    for (const c of [0, 5, 10]) groundL.push(quad(c - 0.4, Math.min(c + 0.4, 10.45), -0.9, 7.3, 0.012, P.road));
    const groups = [], ao = [];
    for (const [bx, by, seed] of [[1, o.ay, 1337], [6, 2, 4242]]) {
      groundL.push(...ground('AB', 'normal').map(at(bx, by)));
      for (const t of orchard('AB', 'normal', seed)) { groups.push({ parts: t.parts.map(at(bx, by)), shadow: true }); ao.push(...t.ao.map(at(bx, by))); }
      groups.push({ parts: tufts(bx * 7 + by).map(at(bx, by)), shadow: false });
    }
    const H = (p) => ({ ...p, faces: p.faces.map((f) => ({ ...f, pts: f.pts.map(([x, y, z]) => [x * o.sw + o.hx, y * o.sw, z * o.sz + o.hz]), decals: f.decals.map((d) => ({ ...d, pts: d.pts.map(([x, y, z]) => [x * o.sw + o.hx, y * o.sw, z * o.sz + o.hz]) })) })) });
    groups.push({ parts: hub.parts.map(H), shadow: true });
    // tractor A (0.85) nosed into the refuel bay, 0.05 short of the pump
    const tz = o.hz - 0.52 * o.sz + 0.05 + 0.52 * 0.85, tx = o.hx - 0.94 * o.sw;
    groups.push({ parts: tractor.parts.map((p) => placePart(p, { s: 0.85, ry: Math.PI, x: tx, z: tz })), shadow: true, style: '--body:#0A84FF' });
    const rear = tz + 0.6 * 0.85, padFront = o.hz + 0.78 * o.sz, canopyFront = o.hz + 0.68 * o.sz;
    const info = { ...o, rear, padFront, canopyFront, roadEdge: 5.6, overhang: Math.max(0, rear - 5.6), canopyH: 0.88 * o.sw, stripDepth: o.ay === 1 ? 2.02 : 1.02 };
    let spec = { ground: groundL, ao, groups };
    if (top) { const N = (p) => placePart(p, { ry: Math.PI }); spec = { ground: groundL.map(N), ao: ao.map(N), groups: groups.map((g) => ({ ...g, parts: g.parts.map(N) })) }; }
    return { spec, info };
  }

  /** whole farm (grid coords) for the E-H layout thumbnails: lite A trees (dome only), berms, roads, hub at its placement */
  function farmSpec(blocks, pl, G) {
    const groundL = [quad(-0.9, G.w - 0.1, -0.9, G.h - 0.1, 0, P.island)];
    for (const r of G.rows) groundL.push(quad(-0.9, G.w - 0.1, r - 0.4, r + 0.4, 0.01, P.road));
    for (const c of G.cols) groundL.push(quad(c - 0.4, c + 0.4, -0.9, G.h - 0.1, 0.012, P.road));
    const groups = [], r = rng(99);
    for (const b of blocks) {
      const x0 = b.x - 0.5, x1 = x0 + b.w, z0 = b.y - 0.5, z1 = z0 + b.h;
      groundL.push(quad(x0 - BED, x1 + BED, z0 - BED, z1 + BED, 0.02, P.soil), quad(x0 + INSET, x1 - INSET, z0 + INSET, z1 - INSET, 0.02, P.grass));
      for (let i = 0; i < b.h; i++) {
        const z = b.y + i;
        groundL.push(quad(x0 + 0.14, x1 - 0.14, z - 0.25, z + 0.25, 0.02, P.berm));
        for (let k = 0; k < 6; k++) groups.push({ parts: treeA(x0 + 0.5 + k * 0.6, z, { seed: (r() * 1e9) | 0, lite: true }).parts, shadow: true });
      }
    }
    const c = Math.cos(pl.ry), sn = Math.sin(pl.ry);
    const T = ([x, y, z]) => { const sx = x * pl.sw, sz = z * pl.sz; return [pl.x + sx * c + sz * sn, y * pl.sw, pl.y - sx * sn + sz * c]; };
    groups.push({ parts: hub.parts.map((p) => ({ ...p, faces: p.faces.map((f) => ({ ...f, pts: f.pts.map(T), decals: f.decals.map((d) => ({ ...d, pts: d.pts.map(T) })) })) })), shadow: true });
    return { ground: groundL, groups };
  }

  return { trees, blockSpec, depotSpec, farmSpec, budgets, P, STATE };
}

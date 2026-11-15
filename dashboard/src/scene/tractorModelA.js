// Tractor direction A ("modern cab tractor") as three.js geometry.
// Part list and dimensions are copied 1:1 from textures/_build/build.mjs (models.A), so the scene renders
// what the concept SVGs show. Every part is emitted as flat-shaded, non-indexed triangles with a vertex
// colour, then split into three shared geometries:
//   paint   - fleet-coloured faces (hood, cab base, roof, fenders). Vertex colour is a MULTIPLIER on the
//             per-tractor paint colour (white = pure paint, grey = louvres / seams).
//   neutral - every fixed-colour face (tyres, rims, chassis, glass, grille, lights, exhaust, hitch...).
//   beacon  - the amber roof beacon alone, so its material can switch to red per tractor.
// LOD hook: buildTractorA({ wheelSeg, rims, decals }) - pass fewer wheel segments / no rims / no decals for
// a cheaper far version (~500 tris, see textures/_build/stats.json "lod").
import * as THREE from 'three';

// palette-independent materials (same table as build.mjs)
export const M = {
  tire: '#2A2A2D', chassis: '#3A3A3C', dark: '#2C2C2E', metal: '#636366', rim: '#AEAEB2', hub: '#D1D1D6',
  glass: '#33444F', light: '#F5F5F7', amber: '#FF9F0A', red: '#FF453A', grille: '#1C1C1E',
};
const BODY = 'body';

// model is authored nose toward +z, hitch toward -z; bbox z = -0.60..0.52 -> centre it on the pose point
const Z_SHIFT = 0.04;
/** Model-space anchors (after centring), unscaled. */
export const A_ANCHORS = {
  exhaustTop: [0.09, 0.87, 0.3 + Z_SHIFT],
  hitch: [0, 0.165, -0.6 + Z_SHIFT],
  halfLength: 0.56,
};

// ---------- tiny vector helpers (build time only) ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => mul(a, 1 / Math.hypot(...a));
const avg = (ps) => mul(ps.reduce(add, [0, 0, 0]), 1 / ps.length);
const lerp = (a, b, t) => add(a, mul(sub(b, a), t));
const deg = (d) => (d * Math.PI) / 180;
const both = (fn) => [fn(1), fn(-1)];
const _c = new THREE.Color();
const rgb = (hex) => { _c.set(hex); return [_c.r, _c.g, _c.b]; };
const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---------- primitives (same signatures as build.mjs; faces = {pts, mat, decals}) ----------
function hexa(v, mat, o = {}) {
  const F = { front: [4, 5, 6, 7], back: [1, 0, 3, 2], left: [0, 4, 7, 3], right: [5, 1, 2, 6], top: [7, 6, 2, 3], bottom: [0, 1, 5, 4] };
  const faces = Object.entries(F).map(([name, idx]) => {
    const q = idx.map((i) => v[i]);
    const face = { pts: q, mat, decals: [] };
    for (const d of o.decals || []) {
      if (d.face !== name) continue;
      const bl = (u, w) => lerp(lerp(q[0], q[1], u), lerp(q[3], q[2], u), w);
      face.decals.push({ pts: d.uv.map(([u, w]) => bl(u, w)), fill: d.fill, op: d.op ?? 1 });
    }
    return face;
  });
  return { faces, name: o.name };
}
function loft(b, z0, f, z1, mat, o) {
  return hexa([
    [b[0], b[2], z0], [b[1], b[2], z0], [b[1], b[3], z0], [b[0], b[3], z0],
    [f[0], f[2], z1], [f[1], f[2], z1], [f[1], f[3], z1], [f[0], f[3], z1],
  ], mat, o);
}
const box = (x0, x1, y0, y1, z0, z1, mat, o) => loft([x0, x1, y0, y1], z0, [x0, x1, y0, y1], z1, mat, o);
function beam(p0, p1, w, h, mat, o) {
  const d = norm(sub(p1, p0));
  let s = cross(d, [0, 1, 0]);
  if (Math.hypot(...s) < 1e-6) s = [1, 0, 0];
  s = mul(norm(s), w / 2);
  const u = mul(norm(cross(s, d)), h / 2);
  const c = (p, a, b) => add(add(p, mul(s, a)), mul(u, b));
  return hexa([c(p0, -1, -1), c(p0, 1, -1), c(p0, 1, 1), c(p0, -1, 1), c(p1, -1, -1), c(p1, 1, -1), c(p1, 1, 1), c(p1, -1, 1)], mat, o);
}
// n-gon cylinder; axis 'x' (wheels) or 'y' (stack, beacon). Rims only on the OUTER cap (sign of c.x).
function cyl(axis, c, r, len, n, mat, o = {}) {
  const ring = (t) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return axis === 'x' ? [c[0] + t, c[1] + Math.cos(a) * r, c[2] + Math.sin(a) * r] : [c[0] + Math.cos(a) * r, c[1] + t, c[2] + Math.sin(a) * r];
  });
  const A = ring(-len / 2), B = ring(len / 2);
  const faces = [];
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; faces.push({ pts: [A[i], A[j], B[j], B[i]], mat: o.tread && i % 2 ? o.tread : mat, decals: [] }); }
  const outer = axis === 'x' ? Math.sign(c[0]) || 1 : 1;
  const capDecals = (sign) => (sign !== outer ? [] : (o.rims || []).map(([fr, fill]) => ({ fill, op: 1, pts: Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return axis === 'x' ? [c[0] + sign * len / 2, c[1] + Math.cos(a) * r * fr, c[2] + Math.sin(a) * r * fr] : [c[0] + Math.cos(a) * r * fr, c[1] + sign * len / 2, c[2] + Math.sin(a) * r * fr];
  }) })));
  faces.push({ pts: [...A].reverse(), mat: o.cap || mat, decals: capDecals(-1) });
  faces.push({ pts: B, mat: o.cap || mat, decals: capDecals(1) });
  return { faces, name: o.name };
}
function fender(x0, x1, cy, cz, rIn, rOut, a0, a1, segs, mat) {
  const parts = [];
  for (let i = 0; i < segs; i++) {
    const t0 = a0 + ((a1 - a0) * i) / segs, t1 = a0 + ((a1 - a0) * (i + 1)) / segs;
    const P = (r, t, x) => [x, cy + Math.sin(t) * r, cz + Math.cos(t) * r];
    parts.push(hexa([P(rIn, t1, x0), P(rIn, t1, x1), P(rOut, t1, x1), P(rOut, t1, x0), P(rIn, t0, x0), P(rIn, t0, x1), P(rOut, t0, x1), P(rOut, t0, x0)], mat, { name: 'fender' }));
  }
  return parts;
}
const shade = (hex, k) => '#' + rgb(hex).map((v) => Math.round(Math.max(0, Math.min(1, v * k)) * 255).toString(16).padStart(2, '0')).join('');
function wheel(x, y, z, r, w, n, rims) {
  return cyl('x', [x, y, z], r, w, n, M.tire, { tread: shade(M.tire, 0.65), rims: rims ? [[0.66, M.rim], [0.5, M.metal], [0.24, M.hub]] : [], name: 'wheel' });
}
function hitch(zb, y, len) {
  return [
    ...both((s) => beam([0.1 * s, y, zb], [0.12 * s, y - 0.03, zb - len], 0.035, 0.035, M.metal, { name: 'hitch' })),
    beam([0, y + 0.17, zb + 0.02], [0, y + 0.12, zb - len + 0.02], 0.035, 0.035, M.metal, { name: 'hitch' }),
    box(-0.15, 0.15, y - 0.045, y - 0.015, zb - len - 0.02, zb - len + 0.015, M.metal, { name: 'hitch' }),
  ];
}

// models.A from build.mjs (beacon kept, tagged so it goes to its own geometry)
function partsA({ wheelSeg = 16, frontSeg = 14, rims = true, decals = true } = {}) {
  const D = (list) => (decals ? list : []);
  return [
    box(-0.11, 0.11, 0.12, 0.25, -0.46, 0.46, M.chassis, { name: 'chassis' }),
    box(-0.22, 0.22, 0.12, 0.17, 0.3, 0.36, M.chassis, { name: 'axle' }),
    box(-0.15, 0.15, 0.13, 0.3, 0.45, 0.52, M.dark, { name: 'ballast', decals: D([
      { face: 'front', uv: [[0.1, 0.62], [0.9, 0.62], [0.9, 0.68], [0.1, 0.68]], fill: '#000', op: 0.35 },
      { face: 'front', uv: [[0.1, 0.32], [0.9, 0.32], [0.9, 0.38], [0.1, 0.38]], fill: '#000', op: 0.35 },
    ]) }),
    loft([-0.155, 0.155, 0.24, 0.5], -0.04, [-0.12, 0.12, 0.25, 0.43], 0.46, BODY, { name: 'hood', decals: D([
      { face: 'front', uv: [[0.14, 0.14], [0.86, 0.14], [0.86, 0.66], [0.14, 0.66]], fill: M.grille },
      { face: 'front', uv: [[0.06, 0.74], [0.32, 0.74], [0.32, 0.9], [0.06, 0.9]], fill: M.light },
      { face: 'front', uv: [[0.68, 0.74], [0.94, 0.74], [0.94, 0.9], [0.68, 0.9]], fill: M.light },
      ...['left', 'right'].flatMap((f) => [0.64, 0.5, 0.36].map((v) => ({ face: f, uv: f === 'left'
        ? [[0.66, v], [0.9, v], [0.9, v + 0.07], [0.66, v + 0.07]] : [[0.1, v], [0.34, v], [0.34, v + 0.07], [0.1, v + 0.07]], fill: '#000', op: 0.32 }))),
      { face: 'left', uv: [[0.42, 0.06], [0.43, 0.06], [0.43, 0.96], [0.42, 0.96]], fill: '#000', op: 0.2 },
      { face: 'right', uv: [[0.57, 0.06], [0.58, 0.06], [0.58, 0.96], [0.57, 0.96]], fill: '#000', op: 0.2 },
      { face: 'top', uv: [[0.49, 0.05], [0.51, 0.05], [0.51, 0.95], [0.49, 0.95]], fill: '#000', op: 0.14 },
    ]) }),
    box(-0.17, 0.17, 0.24, 0.45, -0.4, -0.03, BODY, { name: 'cabbase', decals: D([
      { face: 'back', uv: [[0.08, 0.62], [0.22, 0.62], [0.22, 0.8], [0.08, 0.8]], fill: M.red },
      { face: 'back', uv: [[0.78, 0.62], [0.92, 0.62], [0.92, 0.8], [0.78, 0.8]], fill: M.red },
    ]) }),
    hexa([[-0.18, 0.45, -0.4], [0.18, 0.45, -0.4], [0.17, 0.8, -0.38], [-0.17, 0.8, -0.38],
      [-0.18, 0.45, 0.0], [0.18, 0.45, 0.0], [0.17, 0.8, -0.07], [-0.17, 0.8, -0.07]], M.glass, { name: 'cab', decals: D([
      { face: 'front', uv: [[0.12, 0.08], [0.3, 0.08], [0.52, 0.92], [0.34, 0.92]], fill: '#fff', op: 0.22 },
      { face: 'left', uv: [[0.52, 0.08], [0.62, 0.08], [0.8, 0.92], [0.7, 0.92]], fill: '#fff', op: 0.18 },
      { face: 'right', uv: [[0.2, 0.08], [0.3, 0.08], [0.48, 0.92], [0.38, 0.92]], fill: '#fff', op: 0.18 },
      { face: 'left', uv: [[0.47, 0], [0.5, 0], [0.5, 1], [0.47, 1]], fill: M.grille },
      { face: 'right', uv: [[0.5, 0], [0.53, 0], [0.53, 1], [0.5, 1]], fill: M.grille },
    ]) }),
    box(-0.2, 0.2, 0.8, 0.85, -0.43, -0.03, BODY, { name: 'roof', decals: D([
      { face: 'front', uv: [[0.18, 0.25], [0.36, 0.25], [0.36, 0.75], [0.18, 0.75]], fill: M.light },
      { face: 'front', uv: [[0.64, 0.25], [0.82, 0.25], [0.82, 0.75], [0.64, 0.75]], fill: M.light },
    ]) }),
    cyl('y', [-0.13, 0.875, -0.37], 0.026, 0.05, 8, M.amber, { name: 'beacon' }),
    cyl('y', [0.09, 0.66, 0.3], 0.019, 0.42, 8, M.chassis, { name: 'exhaust' }),
    ...both((s) => beam([0.18 * s, 0.7, -0.02], [0.25 * s, 0.68, 0.0], 0.012, 0.012, M.dark, { name: 'mirror' })),
    ...both((s) => box(0.245 * s - 0.006, 0.245 * s + 0.006, 0.62, 0.7, -0.01, 0.03, M.dark, { name: 'mirror' })),
    ...both((s) => fender(Math.min(0.232 * s, 0.328 * s), Math.max(0.232 * s, 0.328 * s), 0.24, -0.2, 0.265, 0.29, deg(54), deg(132), 5, BODY)).flat(),
    ...both((s) => wheel(0.28 * s, 0.24, -0.2, 0.24, 0.14, wheelSeg, rims)),
    ...both((s) => wheel(0.245 * s, 0.15, 0.33, 0.15, 0.1, frontSeg, rims)),
    ...hitch(-0.44, 0.2, 0.14),
  ];
}

// ---------- triangulation into three buckets ----------
const WHITE = [1, 1, 1];
function bucket() { return { pos: [], nrm: [], col: [] }; }
function pushPoly(b, pts, n, col, off) {
  const o = mul(n, off);
  const p = pts.map((q) => add(q, o));
  for (let i = 1; i < p.length - 1; i++) {
    for (const v of [p[0], p[i], p[i + 1]]) { b.pos.push(v[0], v[1], v[2] + Z_SHIFT); b.nrm.push(n[0], n[1], n[2]); b.col.push(col[0], col[1], col[2]); }
  }
}
function toGeo(b) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  g.computeBoundingSphere();
  return g;
}

/** @returns {{ paint: BufferGeometry, neutral: BufferGeometry, beacon: BufferGeometry, tris: {paint, neutral, beacon, total} }} */
export function buildTractorA(opts) {
  const B = { paint: bucket(), neutral: bucket(), beacon: bucket() };
  for (const part of partsA(opts)) {
    const pc = avg(part.faces.flatMap((f) => f.pts));
    const isBeacon = part.name === 'beacon';
    for (const face of part.faces) {
      // Newell normal, flipped outward (convex parts), winding fixed to match the normal
      let n = [0, 0, 0];
      for (let i = 0; i < face.pts.length; i++) {
        const a = face.pts[i], b = face.pts[(i + 1) % face.pts.length];
        n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
      }
      if (Math.hypot(...n) < 1e-12) continue;
      n = norm(n);
      let pts = face.pts;
      if (dot(n, sub(avg(pts), pc)) < 0) n = mul(n, -1);
      // three.js front faces are CCW seen from outside: check the first triangle's winding
      const wn = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
      if (dot(wn, n) < 0) pts = pts.slice().reverse();
      const body = face.mat === BODY;
      const baseRgb = body ? WHITE : rgb(face.mat);
      pushPoly(isBeacon ? B.beacon : body ? B.paint : B.neutral, pts, n, isBeacon ? WHITE : baseRgb, 0);
      face.decals.forEach((d, k) => {
        let dp = d.pts;
        const dw = cross(sub(dp[1], dp[0]), sub(dp[2], dp[0]));
        if (dot(dw, n) < 0) dp = dp.slice().reverse();
        const off = 0.0015 * (k + 1); // stacked rims never z-fight
        if (d.op < 1) { // translucent decal: pre-blend over its face (body faces stay paint multipliers)
          pushPoly(body ? B.paint : B.neutral, dp, n, mixRgb(baseRgb, rgb(d.fill), d.op), off);
        } else {
          pushPoly(B.neutral, dp, n, rgb(d.fill), off);
        }
      });
    }
  }
  const tri = (b) => b.pos.length / 9;
  const tris = { paint: tri(B.paint), neutral: tri(B.neutral), beacon: tri(B.beacon) };
  tris.total = tris.paint + tris.neutral + tris.beacon;
  return { paint: toGeo(B.paint), neutral: toGeo(B.neutral), beacon: toGeo(B.beacon), tris };
}

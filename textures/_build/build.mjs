// Tractor concept generator.
// Every SVG in ../ is an orthographic, flat-shaded projection of the SAME low-poly
// part list you would build in three.js (boxes, tapered boxes, n-gon cylinders),
// so what you see here is what the scene would render. Run: node build.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeHouses, placePart } from './houses.mjs';
import { makeOrchard } from './trees.mjs';
import { LAYOUTS, GRID, layoutSvg } from './layout.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SC = 400; // svg units per scene unit
const FLEET = ['#0A84FF', '#BF5AF2', '#FF9F0A', '#30D158', '#FF375F', '#5E5CE6', '#64D2FF', '#FFD60A'];

// ---------- vector math ----------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => mul(a, 1 / Math.hypot(...a));
const avg = (ps) => mul(ps.reduce(add, [0, 0, 0]), 1 / ps.length);
const lerp = (a, b, t) => add(a, mul(sub(b, a), t));
const r1 = (n) => Math.round(n * 10) / 10;

// ---------- colour ----------
const hex2 = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb2 = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const mix = (h, h2, t) => { const a = hex2(h), b = hex2(h2); return rgb2(a.map((v, i) => v + (b[i] - v) * t)); };
// four flat tones: lit top, base, turned away, shadow side
const TONE = [(h) => mix(h, '#FFFFFF', 0.22), (h) => h, (h) => mix(h, '#000000', 0.2), (h) => mix(h, '#000000', 0.38)];
const BODY_CSS = [
  'color-mix(in srgb,var(--body,#0A84FF) 78%,#fff)',
  'var(--body,#0A84FF)',
  'color-mix(in srgb,var(--body,#0A84FF) 80%,#000)',
  'color-mix(in srgb,var(--body,#0A84FF) 62%,#000)',
];

// palette-independent materials
const M = {
  tire: '#2A2A2D', chassis: '#3A3A3C', dark: '#2C2C2E', metal: '#636366', rim: '#AEAEB2', hub: '#D1D1D6',
  glass: '#33444F', light: '#F5F5F7', amber: '#FF9F0A', red: '#FF453A', tank: '#E5E5EA', grille: '#1C1C1E',
  cabOld: '#2C2C2E', tireOld: '#1C1C1E', lidar: '#5A6B76',
};

// ---------- primitives (each is one convex mesh) ----------
// faces: { pts, mat, op?, stroke?, sw?, tread?, decals: [{pts, fill, op}] }
function hexa(v, mat, o = {}) {
  // v: 0 LBB,1 RBB,2 RTB,3 LTB (back z) 4 LBF,5 RBF,6 RTF,7 LTF (front z)
  const F = { front: [4, 5, 6, 7], back: [1, 0, 3, 2], left: [0, 4, 7, 3], right: [5, 1, 2, 6], top: [7, 6, 2, 3], bottom: [0, 1, 5, 4] };
  const faces = Object.entries(F).map(([name, idx]) => {
    const q = idx.map((i) => v[i]);
    const m = (o.mats && o.mats[name]) || mat;
    const face = { name, pts: q, mat: m, decals: [], stroke: o.stroke, sw: o.sw, op: o.op };
    for (const d of o.decals || []) {
      if (d.face !== name) continue;
      const bl = (u, w) => lerp(lerp(q[0], q[1], u), lerp(q[3], q[2], u), w);
      face.decals.push({ pts: d.uv.map(([u, w]) => bl(u, w)), fill: d.fill, op: d.op ?? 1 });
    }
    return face;
  });
  return { faces, bias: o.bias || 0, tris: 12, name: o.name };
}
// box from two cross-sections (x0,x1,y0,y1) at z0 (back) and z1 (front)
function loft(b, z0, f, z1, mat, o) {
  return hexa([
    [b[0], b[2], z0], [b[1], b[2], z0], [b[1], b[3], z0], [b[0], b[3], z0],
    [f[0], f[2], z1], [f[1], f[2], z1], [f[1], f[3], z1], [f[0], f[3], z1],
  ], mat, o);
}
const box = (x0, x1, y0, y1, z0, z1, mat, o) => loft([x0, x1, y0, y1], z0, [x0, x1, y0, y1], z1, mat, o);
// rectangular beam between two points
function beam(p0, p1, w, h, mat, o) {
  const d = norm(sub(p1, p0));
  let s = cross(d, [0, 1, 0]);
  if (Math.hypot(...s) < 1e-6) s = [1, 0, 0];
  s = mul(norm(s), w / 2);
  const u = mul(norm(cross(s, d)), h / 2);
  const c = (p, a, b) => add(add(p, mul(s, a)), mul(u, b));
  return hexa([c(p0, -1, -1), c(p0, 1, -1), c(p0, 1, 1), c(p0, -1, 1), c(p1, -1, -1), c(p1, 1, -1), c(p1, 1, 1), c(p1, -1, 1)], mat, o);
}
// n-gon cylinder along an axis; axis 'x' (wheels) or 'y' (stacks, mast, lidar)
function cyl(axis, c, r, len, n, mat, o = {}) {
  const ring = (t) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + (o.phase || 0);
    return axis === 'x' ? [c[0] + t, c[1] + Math.cos(a) * r, c[2] + Math.sin(a) * r] : [c[0] + Math.cos(a) * r, c[1] + t, c[2] + Math.sin(a) * r];
  });
  const A = ring(-len / 2), B = ring(len / 2);
  const faces = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push({ pts: [A[i], A[j], B[j], B[i]], mat: o.tread && i % 2 ? o.tread : mat, decals: [], op: o.op });
  }
  const capDecals = (sign) => {
    const out = [];
    for (const [fr, fill] of o.rims || []) {
      out.push({ fill, op: 1, rim: true, pts: Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2 + (o.phase || 0);
        return axis === 'x' ? [c[0] + sign * len / 2, c[1] + Math.cos(a) * r * fr, c[2] + Math.sin(a) * r * fr]
          : [c[0] + Math.cos(a) * r * fr, c[1] + sign * len / 2, c[2] + Math.sin(a) * r * fr];
      }) });
    }
    return out;
  };
  faces.push({ pts: [...A].reverse(), mat: o.cap || mat, decals: capDecals(-1), op: o.op });
  faces.push({ pts: B, mat: o.cap || mat, decals: capDecals(1), op: o.op });
  return { faces, bias: o.bias || 0, tris: 4 * n - 4, n, name: o.name };
}
// fender: arc of short lofted segments over a wheel (axis x)
function fender(x0, x1, cy, cz, rIn, rOut, a0, a1, segs, mat) {
  const parts = [];
  for (let i = 0; i < segs; i++) {
    const t0 = a0 + ((a1 - a0) * i) / segs, t1 = a0 + ((a1 - a0) * (i + 1)) / segs;
    const P = (r, t, x) => [x, cy + Math.sin(t) * r, cz + Math.cos(t) * r];
    parts.push(hexa([P(rIn, t1, x0), P(rIn, t1, x1), P(rOut, t1, x1), P(rOut, t1, x0), P(rIn, t0, x0), P(rIn, t0, x1), P(rOut, t0, x1), P(rOut, t0, x0)], mat, { name: 'fender' }));
  }
  return parts;
}
const both = (fn) => [fn(1), fn(-1)];
const deg = (d) => (d * Math.PI) / 180;

// ---------- models ----------
function wheel(x, y, z, r, w, n, o = {}) {
  const s = Math.sign(x);
  return cyl('x', [x, y, z], r, w, n, o.mat || M.tire, {
    tread: o.flat ? null : mix(o.mat || M.tire, '#000000', 0.35),
    rims: o.flat ? [] : [[0.66, M.rim], [0.5, M.metal], [0.24, M.hub]], name: 'wheel', bias: 0.001 * s,
  });
}
function hitch(zb, y, len) {
  return [
    ...both((s) => beam([0.1 * s, y, zb], [0.12 * s, y - 0.03, zb - len], 0.035, 0.035, M.metal, { name: 'hitch' })),
    beam([0, y + 0.17, zb + 0.02], [0, y + 0.12, zb - len + 0.02], 0.035, 0.035, M.metal, { name: 'hitch' }),
    box(-0.15, 0.15, y - 0.045, y - 0.015, zb - len - 0.02, zb - len + 0.015, M.metal, { name: 'hitch' }),
  ];
}

const models = {};

models.current = {
  title: 'Current box tractor',
  parts: [
    box(-0.25, 0.25, 0.18, 0.46, -0.4, 0.4, 'body'),
    box(-0.21, 0.21, 0.44, 0.76, -0.34, 0.02, M.cabOld),
    box(-0.24, 0.24, 0.765, 0.815, -0.37, 0.05, 'body'),
    ...both((s) => cyl('x', [0.3 * s, 0.22, -0.2], 0.22, 0.12, 14, M.tireOld, { name: 'wheel' })),
    ...both((s) => cyl('x', [0.27 * s, 0.14, 0.27], 0.14, 0.12, 14, M.tireOld, { name: 'wheel' })),
  ],
  ring: [0.62, 0.76],
  hitch: [0, 0.18, -0.4],
  exhaust: [0, 0.82, -0.16],
};

// A: modern cab tractor
models.A = {
  title: 'A. Modern cab tractor',
  parts: [
    box(-0.11, 0.11, 0.12, 0.25, -0.46, 0.46, M.chassis, { name: 'chassis' }),
    box(-0.22, 0.22, 0.12, 0.17, 0.3, 0.36, M.chassis, { name: 'axle' }),
    box(-0.15, 0.15, 0.13, 0.3, 0.45, 0.52, M.dark, { name: 'ballast', decals: [
      { face: 'front', uv: [[0.1, 0.62], [0.9, 0.62], [0.9, 0.68], [0.1, 0.68]], fill: '#000', op: 0.35 },
      { face: 'front', uv: [[0.1, 0.32], [0.9, 0.32], [0.9, 0.38], [0.1, 0.38]], fill: '#000', op: 0.35 },
    ] }),
    // hood: tapers down and in toward the nose
    loft([-0.155, 0.155, 0.24, 0.5], -0.04, [-0.12, 0.12, 0.25, 0.43], 0.46, 'body', { name: 'hood', decals: [
      { face: 'front', uv: [[0.14, 0.14], [0.86, 0.14], [0.86, 0.66], [0.14, 0.66]], fill: M.grille },
      { face: 'front', uv: [[0.06, 0.74], [0.32, 0.74], [0.32, 0.9], [0.06, 0.9]], fill: M.light },
      { face: 'front', uv: [[0.68, 0.74], [0.94, 0.74], [0.94, 0.9], [0.68, 0.9]], fill: M.light },
      ...['left', 'right'].flatMap((f) => [0.64, 0.5, 0.36].map((v) => ({ face: f, uv: f === 'left'
        ? [[0.66, v], [0.9, v], [0.9, v + 0.07], [0.66, v + 0.07]] : [[0.1, v], [0.34, v], [0.34, v + 0.07], [0.1, v + 0.07]], fill: '#000', op: 0.32 }))),
      { face: 'left', uv: [[0.42, 0.06], [0.43, 0.06], [0.43, 0.96], [0.42, 0.96]], fill: '#000', op: 0.2 },
      { face: 'right', uv: [[0.57, 0.06], [0.58, 0.06], [0.58, 0.96], [0.57, 0.96]], fill: '#000', op: 0.2 },
      { face: 'top', uv: [[0.49, 0.05], [0.51, 0.05], [0.51, 0.95], [0.49, 0.95]], fill: '#000', op: 0.14 },
    ] }),
    box(-0.17, 0.17, 0.24, 0.45, -0.4, -0.03, 'body', { name: 'cabbase', decals: [
      { face: 'back', uv: [[0.08, 0.62], [0.22, 0.62], [0.22, 0.8], [0.08, 0.8]], fill: M.red },
      { face: 'back', uv: [[0.78, 0.62], [0.92, 0.62], [0.92, 0.8], [0.78, 0.8]], fill: M.red },
    ] }),
    // glass cab, raked windscreen
    hexa([[-0.18, 0.45, -0.4], [0.18, 0.45, -0.4], [0.17, 0.8, -0.38], [-0.17, 0.8, -0.38],
      [-0.18, 0.45, 0.0], [0.18, 0.45, 0.0], [0.17, 0.8, -0.07], [-0.17, 0.8, -0.07]], M.glass, {
      name: 'cab', stroke: M.grille, sw: 2.4, decals: [
        { face: 'front', uv: [[0.12, 0.08], [0.3, 0.08], [0.52, 0.92], [0.34, 0.92]], fill: '#fff', op: 0.22 },
        { face: 'left', uv: [[0.52, 0.08], [0.62, 0.08], [0.8, 0.92], [0.7, 0.92]], fill: '#fff', op: 0.18 },
        { face: 'right', uv: [[0.2, 0.08], [0.3, 0.08], [0.48, 0.92], [0.38, 0.92]], fill: '#fff', op: 0.18 },
        { face: 'left', uv: [[0.47, 0], [0.5, 0], [0.5, 1], [0.47, 1]], fill: M.grille },
        { face: 'right', uv: [[0.5, 0], [0.53, 0], [0.53, 1], [0.5, 1]], fill: M.grille },
      ] }),
    box(-0.2, 0.2, 0.8, 0.85, -0.43, -0.03, 'body', { name: 'roof', decals: [
      { face: 'front', uv: [[0.18, 0.25], [0.36, 0.25], [0.36, 0.75], [0.18, 0.75]], fill: M.light },
      { face: 'front', uv: [[0.64, 0.25], [0.82, 0.25], [0.82, 0.75], [0.64, 0.75]], fill: M.light },
    ] }),
    cyl('y', [-0.13, 0.875, -0.37], 0.026, 0.05, 8, M.amber, { name: 'beacon' }),
    cyl('y', [0.09, 0.66, 0.3], 0.019, 0.42, 8, M.chassis, { name: 'exhaust' }),
    ...both((s) => beam([0.18 * s, 0.7, -0.02], [0.25 * s, 0.68, 0.0], 0.012, 0.012, M.dark, { name: 'mirror' })),
    ...both((s) => box(0.245 * s - 0.006, 0.245 * s + 0.006, 0.62, 0.7, -0.01, 0.03, M.dark, { name: 'mirror' })),
    ...both((s) => fender(Math.min(0.232 * s, 0.328 * s), Math.max(0.232 * s, 0.328 * s), 0.24, -0.2, 0.265, 0.29, deg(54), deg(132), 5, 'body')).flat(),
    ...both((s) => wheel(0.28 * s, 0.24, -0.2, 0.24, 0.14, 16)),
    ...both((s) => wheel(0.245 * s, 0.15, 0.33, 0.15, 0.1, 14)),
    ...hitch(-0.44, 0.2, 0.14),
  ],
  ring: [0.62, 0.72],
  hitch: [0, 0.165, -0.6],
  exhaust: [0.09, 0.9, 0.3],
};

// B: autonomous orchard tractor (electric, no cab)
models.B = {
  title: 'B. Autonomous orchard tractor',
  parts: [
    box(-0.11, 0.11, 0.1, 0.21, -0.46, 0.44, M.chassis, { name: 'chassis' }),
    box(-0.22, 0.22, 0.11, 0.16, 0.27, 0.33, M.chassis, { name: 'axle' }),
    box(-0.16, 0.16, 0.13, 0.22, 0.5, 0.56, M.dark, { name: 'bumper', decals: [
      { face: 'front', uv: [[0.36, 0.25], [0.64, 0.25], [0.64, 0.75], [0.36, 0.75]], fill: '#48484A' },
    ] }),
    // one long low body: rear deck rises gently to a chamfered nose
    loft([-0.17, 0.17, 0.2, 0.47], -0.44, [-0.145, 0.145, 0.2, 0.4], 0.4, 'body', { name: 'body', decals: [
      { face: 'top', uv: [[0.12, 0.52], [0.88, 0.52], [0.88, 0.92], [0.12, 0.92]], fill: M.glass },
      { face: 'top', uv: [[0.14, 0.54], [0.86, 0.54], [0.86, 0.6], [0.14, 0.6]], fill: '#fff', op: 0.16 },
      { face: 'left', uv: [[0.0, 0.0], [1, 0.0], [1, 0.14], [0, 0.14]], fill: '#000', op: 0.22 },
      { face: 'right', uv: [[0.0, 0.0], [1, 0.0], [1, 0.14], [0, 0.14]], fill: '#000', op: 0.22 },
      { face: 'left', uv: [[0.5, 0.14], [0.51, 0.14], [0.51, 0.97], [0.5, 0.97]], fill: '#000', op: 0.2 },
      { face: 'right', uv: [[0.49, 0.14], [0.5, 0.14], [0.5, 0.97], [0.49, 0.97]], fill: '#000', op: 0.2 },
      { face: 'left', uv: [[0.82, 0.58], [0.9, 0.58], [0.9, 0.7], [0.82, 0.7]], fill: M.grille },
      { face: 'right', uv: [[0.1, 0.58], [0.18, 0.58], [0.18, 0.7], [0.1, 0.7]], fill: M.grille },
      { face: 'back', uv: [[0.06, 0.6], [0.24, 0.6], [0.24, 0.78], [0.06, 0.78]], fill: M.red },
      { face: 'back', uv: [[0.76, 0.6], [0.94, 0.6], [0.94, 0.78], [0.76, 0.78]], fill: M.red },
    ] }),
    loft([-0.145, 0.145, 0.2, 0.4], 0.4, [-0.115, 0.115, 0.22, 0.33], 0.5, 'body', { name: 'nose', decals: [
      { face: 'front', uv: [[0.06, 0.6], [0.94, 0.6], [0.94, 0.82], [0.06, 0.82]], fill: M.light },
      { face: 'front', uv: [[0.3, 0.14], [0.7, 0.14], [0.7, 0.44], [0.3, 0.44]], fill: M.grille },
    ] }),
    box(-0.155, -0.115, 0.455, 0.48, -0.42, -0.38, M.red, { name: 'estop' }),
    box(-0.025, 0.025, 0.42, 0.7, -0.15, -0.1, M.chassis, { name: 'mast' }),
    beam([-0.12, 0.66, -0.125], [0.12, 0.66, -0.125], 0.03, 0.025, M.chassis, { name: 'crossbar' }),
    ...both((s) => box(0.12 * s - 0.025, 0.12 * s + 0.025, 0.64, 0.685, -0.155, -0.075, M.dark, { name: 'camera', decals: [
      { face: 'front', uv: [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]], fill: M.glass },
    ] })),
    cyl('y', [0, 0.722, -0.125], 0.06, 0.035, 14, M.dark, { name: 'lidar' }),
    cyl('y', [0, 0.752, -0.125], 0.056, 0.026, 14, M.lidar, { name: 'lidar' }),
    cyl('y', [0, 0.775, -0.125], 0.05, 0.02, 14, M.dark, { name: 'lidar' }),
    ...both((s) => fender(Math.min(0.222 * s, 0.318 * s), Math.max(0.222 * s, 0.318 * s), 0.2, -0.22, 0.225, 0.25, deg(56), deg(130), 4, 'body')).flat(),
    ...both((s) => wheel(0.27 * s, 0.2, -0.22, 0.2, 0.14, 16)),
    ...both((s) => wheel(0.25 * s, 0.15, 0.3, 0.15, 0.11, 14)),
    ...hitch(-0.44, 0.18, 0.14),
  ],
  ring: [0.62, 0.72],
  hitch: [0, 0.145, -0.6],
  exhaust: [0, 0.5, 0.1],
};

// C: compact utility (open station, roll-over frame with canopy)
models.C = {
  title: 'C. Compact utility',
  parts: [
    box(-0.1, 0.1, 0.11, 0.22, -0.4, 0.42, M.chassis, { name: 'chassis' }),
    box(-0.2, 0.2, 0.1, 0.15, 0.27, 0.33, M.chassis, { name: 'axle' }),
    box(-0.13, 0.13, 0.12, 0.27, 0.42, 0.48, M.dark, { name: 'bumper' }),
    loft([-0.135, 0.135, 0.22, 0.45], 0.0, [-0.11, 0.11, 0.23, 0.39], 0.44, 'body', { name: 'hood', decals: [
      { face: 'front', uv: [[0.14, 0.12], [0.86, 0.12], [0.86, 0.62], [0.14, 0.62]], fill: M.grille },
      { face: 'front', uv: [[0.08, 0.72], [0.32, 0.72], [0.32, 0.88], [0.08, 0.88]], fill: M.light },
      { face: 'front', uv: [[0.68, 0.72], [0.92, 0.72], [0.92, 0.88], [0.68, 0.88]], fill: M.light },
      ...['left', 'right'].flatMap((f) => [0.6, 0.46].map((v) => ({ face: f, uv: f === 'left'
        ? [[0.64, v], [0.9, v], [0.9, v + 0.08], [0.64, v + 0.08]] : [[0.1, v], [0.36, v], [0.36, v + 0.08], [0.1, v + 0.08]], fill: '#000', op: 0.3 }))),
    ] }),
    box(-0.16, 0.16, 0.22, 0.36, -0.38, 0.0, 'body', { name: 'deck' }),
    box(-0.08, 0.08, 0.36, 0.42, -0.3, -0.16, M.dark, { name: 'seat' }),
    box(-0.08, 0.08, 0.36, 0.55, -0.31, -0.28, M.dark, { name: 'seatback' }),
    beam([0, 0.42, -0.02], [0, 0.55, -0.08], 0.02, 0.02, M.dark, { name: 'column' }),
    beam([-0.06, 0.56, -0.08], [0.06, 0.56, -0.08], 0.02, 0.012, M.dark, { name: 'steer' }),
    ...both((s) => box(0.165 * s - 0.018, 0.165 * s + 0.018, 0.3, 0.82, -0.37, -0.33, M.chassis, { name: 'rops' })),
    box(-0.2, 0.2, 0.82, 0.86, -0.42, 0.04, 'body', { name: 'canopy', decals: [
      { face: 'front', uv: [[0.2, 0.25], [0.38, 0.25], [0.38, 0.75], [0.2, 0.75]], fill: M.light },
      { face: 'front', uv: [[0.62, 0.25], [0.8, 0.25], [0.8, 0.75], [0.62, 0.75]], fill: M.light },
    ] }),
    cyl('y', [-0.13, 0.885, -0.36], 0.024, 0.05, 8, M.amber, { name: 'beacon' }),
    cyl('y', [0.08, 0.58, 0.3], 0.017, 0.3, 8, M.chassis, { name: 'exhaust' }),
    ...both((s) => box(Math.min(0.2 * s, 0.32 * s), Math.max(0.2 * s, 0.32 * s), 0.43, 0.46, -0.37, -0.07, 'body', { name: 'fender' })),
    ...both((s) => wheel(0.26 * s, 0.2, -0.22, 0.2, 0.13, 16)),
    ...both((s) => wheel(0.22 * s, 0.13, 0.3, 0.13, 0.09, 14)),
    ...hitch(-0.4, 0.18, 0.13),
  ],
  ring: [0.62, 0.72],
  hitch: [0, 0.145, -0.55],
  exhaust: [0.08, 0.74, 0.3],
};

// working implement: sprayer tank on the hitch + folding boom with mist curtain
function sprayer(m) {
  const z = m.hitch[2];
  const parts = [
    box(-0.16, 0.16, 0.2, 0.44, z - 0.2, z - 0.02, M.tank, { name: 'tank', decals: [
      { face: 'top', uv: [[0.35, 0.3], [0.65, 0.3], [0.65, 0.7], [0.35, 0.7]], fill: M.chassis },
    ] }),
    box(-0.17, 0.17, 0.18, 0.21, z - 0.21, z - 0.01, M.metal, { name: 'frame' }),
    beam([-0.62, 0.3, z - 0.24], [0.62, 0.3, z - 0.24], 0.025, 0.03, M.chassis, { name: 'boom' }),
    ...both((s) => beam([0.1 * s, 0.42, z - 0.2], [0.5 * s, 0.31, z - 0.24], 0.015, 0.015, M.chassis, { name: 'stay' })),
  ];
  // mist curtain: thin translucent slabs under the boom
  for (let i = -3; i < 3; i++) {
    const x0 = i * 0.2 + 0.02, x1 = x0 + 0.16;
    parts.push(loft([x0 + 0.04, x1 - 0.04, 0.285, 0.29], z - 0.245, [x0, x1, 0.02, 0.025], z - 0.3, '#D6F1FF', { name: 'mist', op: 0.42 }));
  }
  return parts;
}

// ---------- views ----------
function view(kind) {
  let f, up = [0, 1, 0], w;
  if (kind === 'iso') {
    const az = deg(52), el = deg(30);
    f = mul([-Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)], -1);
    w = [-0.5, 0.8, 0.5];
  } else if (kind === 'side') { f = [1, 0, 0]; w = [-0.55, 0.75, 0.55]; }
  else { f = [0, -1, 0]; up = [0, 0, 1]; w = [-0.45, 0.45, 0.85]; }
  const right = norm(cross(f, up)), u = cross(right, f), c = mul(f, -1);
  const L = norm(add(add(mul(right, w[0]), mul(u, w[1])), mul(c, w[2])));
  const P = (p) => [dot(p, right) * SC, -dot(p, u) * SC];
  return { kind, f, right, u, c, L, P };
}

function shadeIdx(n, L) {
  const k = dot(n, L);
  return k > 0.78 ? 0 : k > 0.42 ? 1 : k > 0.08 ? 2 : 3;
}
const pts2 = (P, ps) => ps.map((p) => { const q = P(p); return r1(q[0]) + ',' + r1(q[1]); }).join(' ');

function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

// returns {ground, body, bounds}
function render(model, kind, opt = {}) {
  const V = view(kind);
  const parts = [...model.parts, ...(opt.working ? sprayer(model) : [])];
  const allPts = parts.flatMap((p) => p.faces.flatMap((f) => f.pts));
  const bounds = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
  const grow = ([x, y]) => { bounds.x0 = Math.min(bounds.x0, x); bounds.x1 = Math.max(bounds.x1, x); bounds.y0 = Math.min(bounds.y0, y); bounds.y1 = Math.max(bounds.y1, y); };
  allPts.forEach((p) => grow(V.P(p)));

  // ground: soft cast shadow (hull of vertices projected along the sun) + tight contact pads
  const Ls = norm([V.L[0] * 0.55, Math.abs(V.L[1]) + 0.6, V.L[2] * 0.55]);
  const solid = parts.filter((p) => p.name !== 'mist').flatMap((p) => p.faces.flatMap((f) => f.pts));
  const gp = solid.map((p) => V.P(sub(p, mul(Ls, p[1] / Ls[1]))));
  let ground = '';
  if (opt.ring !== false && model.ring && kind === 'iso') {
    const circ = (r) => Array.from({ length: 64 }, (_, i) => { const a = (i / 64) * Math.PI * 2; return V.P([Math.cos(a) * r, 0.004, Math.sin(a) * r]); });
    const d = (ps) => 'M' + ps.map((q) => r1(q[0]) + ' ' + r1(q[1])).join('L') + 'Z';
    const [ri, ro] = model.ring;
    circ(ro).forEach(grow);
    const ringFill = opt.broken ? M.red : null;
    if (opt.broken) {
      ground += `<path class="pulse" d="${d(circ(ro))}${d(circ(ri).reverse())}" fill="${M.red}" fill-rule="evenodd"/>`;
    }
    opt._ring = `<path d="${d(circ(ro))}${d(circ(ri).reverse())}" fill-rule="evenodd" ${ringFill ? `fill="${ringFill}"` : 'class="ring" fill="#0A84FF"'} opacity=".85"/>`;
  }
  ground += `<polygon points="${hull(gp).map((q) => r1(q[0]) + ',' + r1(q[1])).join(' ')}" fill="#000" opacity=".2" filter="url(#soft)"/>`;
  // contact pads under every tyre
  for (const p of parts.filter((p) => p.name === 'wheel')) {
    const c = avg(p.faces.flatMap((f) => f.pts));
    const ys = p.faces.flatMap((f) => f.pts.map((q) => q[1]));
    const r = (Math.max(...ys) - Math.min(...ys)) / 2;
    const xs = p.faces.flatMap((f) => f.pts.map((q) => q[0]));
    const hw = (Math.max(...xs) - Math.min(...xs)) / 2;
    const pad = [[-hw, -r * 0.5], [hw, -r * 0.5], [hw, r * 0.5], [-hw, r * 0.5]].map(([dx, dz]) => V.P([c[0] + dx * 1.1, 0.002, c[2] + dz]));
    ground += `<polygon points="${pad.map((q) => r1(q[0]) + ',' + r1(q[1])).join(' ')}" fill="#000" opacity=".35" filter="url(#tight)"/>`;
  }
  if (opt._ring) ground += opt._ring;

  // painter's sort by part centroid depth (convex parts, back-face culled)
  const order = parts.map((p) => ({ p, d: dot(avg(p.faces.flatMap((f) => f.pts)), V.f) - p.bias })).sort((a, b) => b.d - a.d);
  let body = '';
  for (const { p } of order) {
    const pc = avg(p.faces.flatMap((f) => f.pts));
    const start = body.length;
    for (const face of p.faces) {
      const fc = avg(face.pts);
      let n = [0, 0, 0];
      for (let i = 0; i < face.pts.length; i++) {
        const a = face.pts[i], b = face.pts[(i + 1) % face.pts.length];
        n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
      }
      if (Math.hypot(...n) < 1e-12) continue;
      n = norm(n);
      if (dot(n, sub(fc, pc)) < 0) n = mul(n, -1);
      if (dot(n, V.f) > -1e-4) continue; // back face
      const t = shadeIdx(n, V.L);
      const pts = pts2(V.P, face.pts);
      const opA = face.op != null ? ` opacity="${face.op}"` : '';
      if (face.mat === 'body') {
        body += `<polygon class="b${t}" points="${pts}" fill="${TONE[t]('#0A84FF')}" stroke="${TONE[t]('#0A84FF')}"/>`;
      } else {
        const c = TONE[t](face.mat);
        const st = face.stroke ? ` stroke="${face.stroke}" stroke-width="${face.sw}"` : face.op != null ? ' stroke="none"' : ` stroke="${c}"`;
        body += `<polygon points="${pts}" fill="${c}"${st}${opA}/>`;
      }
      for (const d of face.decals) {
        body += `<polygon points="${pts2(V.P, d.pts)}" fill="${d.fill}" stroke="none"${d.op !== 1 ? ` opacity="${d.op}"` : ''}/>`;
      }
    }
    if (body.length > start) body = body.slice(0, start) + `\n<g data-part="${p.name || 'body'}">` + body.slice(start) + '</g>';
  }
  // overlays: hitch point (top view, for the Live feed implement bar), smoke (broken)
  let over = '';
  if (kind === 'top' && model.hitch && !opt.noHitch) {
    const [hx, hy] = V.P(model.hitch);
    over += `<g id="hitch-point"><circle cx="${r1(hx)}" cy="${r1(hy)}" r="9" fill="#fff" stroke="${M.grille}" stroke-width="3"/><circle cx="${r1(hx)}" cy="${r1(hy)}" r="3" fill="${M.grille}"/></g>`;
    grow([hx, hy + 12]);
  }
  if (opt.broken) {
    const [ex, ey] = V.P(model.exhaust);
    const puffs = [[0, -18, 20, 0.55], [22, -58, 28, 0.42], [52, -104, 36, 0.28]];
    over += `<g filter="url(#puff)">` + puffs.map(([dx, dy, r, o]) => `<circle cx="${r1(ex + dx)}" cy="${r1(ey + dy)}" r="${r}" fill="#8E8E93" opacity="${o}"/>`).join('') + '</g>';
    grow([ex + 90, ey - 145]);
  }
  return { ground, body, over, bounds, tris: parts.reduce((s, p) => s + p.tris, 0), parts: parts.length };
}

// ---------- svg writers ----------
const STYLE = (anim) => `<style>
.b0{fill:${BODY_CSS[0]};stroke:${BODY_CSS[0]}}.b1{fill:${BODY_CSS[1]};stroke:${BODY_CSS[1]}}
.b2{fill:${BODY_CSS[2]};stroke:${BODY_CSS[2]}}.b3{fill:${BODY_CSS[3]};stroke:${BODY_CSS[3]}}
.ring{fill:var(--body,#0A84FF)}${anim ? `
.pulse{transform-box:fill-box;transform-origin:center;animation:pulse 1.6s cubic-bezier(.2,.7,.3,1) infinite}
@keyframes pulse{from{transform:scale(1);opacity:.7}to{transform:scale(1.35);opacity:0}}
@media (prefers-reduced-motion:reduce){.pulse{animation:none;opacity:.25;transform:scale(1.12)}}` : ''}
</style>`;
const FILTERS = `<filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
<filter id="tight" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
<filter id="puff" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="6"/></filter>`;

function vb(b, pad = 24) { return [b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + 2 * pad, b.y1 - b.y0 + 2 * pad].map(r1); }
function union(bs) { return bs.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) })); }

function single(key, kind, box) { return singleModel(models[key], kind, box); }
function singleModel(m, kind, box) {
  const r = render(m, kind);
  const v = vb(box);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${v.join(' ')}" width="${v[2]}" height="${v[3]}" role="img">
<title>${m.title}, ${kind} view</title>
<desc>Flat-shaded orthographic projection of the three.js part list. Recolour by setting the CSS custom property --body on the svg element.</desc>
<defs>${STYLE(false)}
${FILTERS}</defs>
<g id="ground">${r.ground}</g>
<g id="tractor" stroke-width=".8" stroke-linejoin="round">${r.body}</g>${r.over ? `\n<g id="overlay">${r.over}</g>` : ''}
</svg>
`;
}

function palette(key) {
  const m = models[key];
  const cells = [
    ...FLEET.map((c, i) => ({ c, label: 'T' + (i + 1) })),
    { c: FLEET[0], broken: true },
    { c: FLEET[2], working: true },
  ];
  const rs = cells.map((cell) => render(m, 'iso', { broken: cell.broken, working: cell.working }));
  const box = union(rs.map((r) => r.bounds));
  const v = vb(box, 30);
  const [cw, ch] = [v[2], v[3]];
  const cols = 5, rows = 2, gap = 24;
  const W = cols * cw + (cols - 1) * gap, H = rows * ch + (rows - 1) * gap;
  let body = '';
  rs.forEach((r, i) => {
    const x = (i % cols) * (cw + gap) - v[0], y = Math.floor(i / cols) * (ch + gap) - v[1];
    body += `<g transform="translate(${r1(x)} ${r1(y)})" style="--body:${cells[i].c}">${r.ground}<g stroke-width=".8" stroke-linejoin="round">${r.body}</g>${r.over}</g>\n`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r1(W)} ${r1(H)}" width="${r1(W)}" height="${r1(H)}" role="img">
<title>${m.title}, fleet palette sheet</title>
<desc>Iso view in all eight fleet colours (T1 to T8), then T1 broken (pulsing red ring, smoke) and T3 working (sprayer attached).</desc>
<defs>${STYLE(true)}
${FILTERS}</defs>
${body}</svg>
`;
}

// shared framing per view so every direction lines up at the same scale
const keys = ['current', 'A', 'B', 'C'];
const frames = {};
for (const kind of ['iso', 'side', 'top']) frames[kind] = union(keys.map((k) => render(models[k], kind).bounds));

const files = {};
files['tractor-current.svg'] = single('current', 'iso', frames.iso);
for (const kind of ['side', 'top']) files[`tractor-current-${kind}.svg`] = single('current', kind, frames[kind]);
for (const k of ['A', 'B', 'C']) for (const kind of ['iso', 'side', 'top']) files[`tractor-${k}-${kind}.svg`] = single(k, kind, frames[kind]);
for (const k of ['A', 'B', 'C']) files[`tractor-palette-${k}.svg`] = palette(k);

// ---------- depot house concepts (same renderer, scene units) ----------
const { houses } = makeHouses({ hexa, box, loft, beam, cyl, M, mix });
const hKeys = ['current', 'A', 'B', 'C'];
const hFrames = {};
for (const kind of ['iso', 'side', 'top']) hFrames[kind] = union(hKeys.map((k) => render(houses[k], kind).bounds));
for (const k of hKeys) for (const kind of ['iso', 'side', 'top']) files[`house-${k}-${kind}.svg`] = singleModel(houses[k], kind, hFrames[kind]);
// in-scene size check: each house with tractor A parked beside it at its scene scale (0.85), nose toward the door
const sceneModel = (k) => {
  const xs = houses[k].parts.flatMap((p) => p.faces.flatMap((f) => f.pts.map((q) => q[0])));
  const x = Math.max(...xs) + 0.62;
  return { title: `${houses[k].title} with tractor A at scene scale`, parts: [...houses[k].parts, ...models.A.parts.map((p) => placePart(p, { s: 0.85, ry: -Math.PI / 2, x, z: 0.42 }))] };
};
const sFrame = union(hKeys.map((k) => render(sceneModel(k), 'iso').bounds));
for (const k of hKeys) files[`house-${k}-scene.svg`] = singleModel(sceneModel(k), 'iso', sFrame);

// ---------- orchard trees + block plots (trees.mjs), multi-object scenes ----------
// render() casts ONE shadow hull per model, which would grey out a whole block, so scenes are drawn here in layers:
// ground quads (list order) -> blurred contact AO -> one cast shadow per group -> overlays (AB line) ->
// every group's parts sorted back to front -> post layers (Map view: coverage + AB above the aerial) -> map marks.
const { trees, blockSpec, depotSpec, farmSpec, budgets: treeBudgets } = makeOrchard({ box, beam, cyl, M, mix, placePart, tractor: models.A, hub: houses.B });
function drawPart(p, V) {
  const pc = avg(p.faces.flatMap((f) => f.pts));
  let out = '';
  for (const face of p.faces) {
    const fc = avg(face.pts);
    let n = [0, 0, 0];
    for (let i = 0; i < face.pts.length; i++) {
      const a = face.pts[i], b = face.pts[(i + 1) % face.pts.length];
      n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
    }
    if (Math.hypot(...n) < 1e-12) continue;
    n = norm(n);
    if (p.faces.length > 1 && dot(n, sub(fc, pc)) < 0) n = mul(n, -1);
    if (p.faces.length === 1 && n[1] < 0) n = mul(n, -1); // flat ground quads face up
    if (dot(n, V.f) > -1e-4) continue;
    const t = shadeIdx(n, V.L), pts = pts2(V.P, face.pts);
    if (face.mat === 'body') { out += `<polygon class="b${t}" points="${pts}"/>`; continue; }
    const c = p.name === 'ground' || p.name === 'disc' ? face.mat : TONE[t](face.mat);
    out += face.op != null ? `<polygon points="${pts}" fill="${c}" opacity="${face.op}"/>` : `<polygon points="${pts}" fill="${c}" stroke="${c}"/>`;
    for (const d of face.decals) out += `<polygon points="${pts2(V.P, d.pts)}" fill="${d.fill}" stroke="none"${d.op !== 1 ? ` opacity="${d.op}"` : ''}/>`;
  }
  return out;
}
function renderScene(spec, kind) {
  const V = view(kind);
  const bounds = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
  const grow = ([x, y]) => { bounds.x0 = Math.min(bounds.x0, x); bounds.x1 = Math.max(bounds.x1, x); bounds.y0 = Math.min(bounds.y0, y); bounds.y1 = Math.max(bounds.y1, y); };
  const all = [...(spec.ground || []), ...spec.groups.flatMap((g) => g.parts)];
  all.forEach((p) => p.faces.forEach((f) => f.pts.forEach((q) => grow(V.P(q)))));
  let s = `<g id="ground">${(spec.ground || []).map((p) => drawPart(p, V)).join('')}</g>`;
  if (spec.ao && spec.ao.length) s += `\n<g id="contact-ao" filter="url(#ao)">${spec.ao.map((p) => drawPart(p, V)).join('')}</g>`;
  const Ls = norm([V.L[0] * 0.55, Math.abs(V.L[1]) + 0.6, V.L[2] * 0.55]);
  s += '\n<g id="shadows" filter="url(#soft)">';
  for (const g of spec.groups) {
    if (!g.shadow) continue;
    const gp = g.parts.flatMap((p) => p.faces.flatMap((f) => f.pts)).map((p) => V.P(sub(p, mul(Ls, p[1] / Ls[1]))));
    s += `<polygon points="${hull(gp).map((q) => r1(q[0]) + ',' + r1(q[1])).join(' ')}" fill="#000" opacity=".2"/>`;
  }
  s += '</g>';
  if (spec.overlays) s += `\n<g id="guidance">${spec.overlays.map((p) => drawPart(p, V)).join('')}</g>`;
  const draw = (groups) => groups.flatMap((g) => g.parts.map((p) => ({ p, g, d: dot(avg(p.faces.flatMap((f) => f.pts)), V.f) - p.bias })))
    .sort((a, b) => b.d - a.d)
    .map(({ p, g }) => { const b = drawPart(p, V); return b ? `<g data-part="${p.name || 'part'}"${g.style ? ` style="${g.style}"` : ''}>${b}</g>` : ''; }).join('\n');
  s += `\n<g id="objects" stroke-width=".8" stroke-linejoin="round">\n${draw(spec.groups.filter((g) => !g.late))}</g>`;
  if (spec.post) s += `\n<g id="coverage-and-guidance">${spec.post.map((p) => drawPart(p, V)).join('')}</g>`;
  const late = spec.groups.filter((g) => g.late);
  if (late.length) s += `\n<g id="tractor-icon" stroke-width=".8" stroke-linejoin="round">${draw(late)}</g>`;
  if (spec.outline) {
    const { w, h, t } = spec.outline;
    const rect = (a, b) => 'M' + [[-a, -b], [a, -b], [a, b], [-a, b]].map(([x, z]) => V.P([x, 0.08, z]).map(r1).join(' ')).join('L') + 'Z';
    s += `\n<path d="${rect(w / 2, h / 2)}${rect(w / 2 - t, h / 2 - t)}" fill="#fff" fill-rule="evenodd" opacity=".85"/>`;
  }
  if (spec.mapIcon) {
    const { x, z, color } = spec.mapIcon;
    const circ = (r) => 'M' + Array.from({ length: 56 }, (_, i) => { const a = (i / 56) * Math.PI * 2; return V.P([x + Math.cos(a) * r, 0.1, z + Math.sin(a) * r]).map(r1).join(' '); }).join('L') + 'Z';
    s += `\n<path d="${circ(0.53)}${circ(0.47)}" fill="${color}" fill-rule="evenodd" opacity=".9"/>`;
  }
  return { svg: s, bounds };
}
const SCENE_FILTERS = `${FILTERS}\n<filter id="ao" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7"/></filter>`;
function sceneSvg(title, desc, r, box, pad = 24) {
  const v = vb(box, pad);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${v.join(' ')}" width="${v[2]}" height="${v[3]}" role="img">
<title>${title}</title>
<desc>${desc}</desc>
<defs>${STYLE(false)}
${SCENE_FILTERS}</defs>
${r.svg}
</svg>
`;
}
const tKeys = ['current', 'A', 'B', 'C'];
const treeScene = (k) => ({ ao: trees[k].ao, groups: [{ parts: trees[k].parts, shadow: true }] });
for (const kind of ['iso', 'side', 'top']) {
  const rs = tKeys.map((k) => renderScene(treeScene(k), kind));
  const fr = union(rs.map((r) => r.bounds));
  tKeys.forEach((k, i) => { files[`trees-${k}-${kind}.svg`] = sceneSvg(`${trees[k].title}, ${kind} view`, 'Flat-shaded orthographic projection of the three.js part list (scene units, light from the top left).', rs[i], fr); });
}
const blockR = Object.fromEntries(tKeys.map((k) => [k, renderScene(blockSpec(k, { state: 'ripe' }), 'iso')]));
const blockFrame = union(tKeys.map((k) => blockR[k].bounds));
for (const k of tKeys) files[`plots-${k}-block.svg`] = sceneSvg(`${trees[k].title}: block sample`, 'One 4 x 3 block at scene scale (ripe state): soil frame, grass treatment, trees, tractor A working lane 2 with coverage painted behind it and its AB line, the Fleet hub across the road.', blockR[k], blockFrame);
const mapR = Object.fromEntries(tKeys.map((k) => [k, renderScene(blockSpec(k, { state: 'ripe', kind: 'map' }), 'top')]));
const mapFrame = union(tKeys.map((k) => mapR[k].bounds));
for (const k of tKeys) files[`plots-${k}-map.svg`] = sceneSvg(`${trees[k].title}: Map view`, 'Top-down: the same block in the Map vocabulary (coverage at 0.62 and AB line above the canopy, white block outline, tractor icon with status ring).', mapR[k], mapFrame);
const STATES = [['normal', 'Normal', '#30D158'], ['ripe', 'Ripe', '#FFD60A'], ['heat', 'Heat-stressed', '#FF375F']];
const tileFrame = union(tKeys.flatMap((k) => STATES.map(([st, , c]) => renderScene(blockSpec(k, { state: st, color: c, kind: 'tile' }), 'iso').bounds)));
for (const k of tKeys) {
  const tv = vb(tileFrame, 16), gap = 60, lab = 90;
  const W = 3 * tv[2] + 2 * gap, H = tv[3] + lab;
  const body = STATES.map(([st, name, c], i) => {
    const r = renderScene(blockSpec(k, { state: st, color: c, kind: 'tile' }), 'iso');
    const svg = r.svg.replace(/id="[^"]+"/g, '');
    return `<g transform="translate(${r1(i * (tv[2] + gap) - tv[0])} ${r1(-tv[1])})">${svg}</g>
<text x="${r1(i * (tv[2] + gap) + tv[2] / 2)}" y="${r1(tv[3] + 66)}" text-anchor="middle" font-family="-apple-system,system-ui,sans-serif" font-size="56" font-weight="600" fill="#6E6E73">${name}</text>`;
  }).join('\n');
  files[`plots-${k}-states.svg`] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r1(W)} ${r1(H)}" width="${r1(W)}" height="${r1(H)}" role="img">
<title>${trees[k].title}: block states</title>
<desc>Normal (green coverage), ripe (yellow coverage) and heat-stressed (pink coverage) block tints. Tints are Lambert base plus the emissive farm.js can set; coverage colours are the hardest fleet colours for each tint.</desc>
<defs>${STYLE(false)}
${SCENE_FILTERS}</defs>
${body}
</svg>
`;
}
// ---------- decisions: A + B touches, AB-line edge, hub depth ----------
files['plots-AB-block.svg'] = sceneSvg('A + B touches: block sample', 'Direction A with B’s twin tram lines and white-tagged row-end posts, ripe, tractor A working lane 2, Fleet hub across the road.', renderScene(blockSpec('AB', { state: 'ripe' }), 'iso'), blockFrame);
files['plots-AB-map.svg'] = sceneSvg('A + B touches: Map view', 'Top-down, north up, Map vocabulary.', renderScene(blockSpec('AB', { state: 'ripe', kind: 'map' }), 'top'), mapFrame);
/** grid sheet of scene renders sharing one frame; labels under each cell, optional row labels on the left */
function sheet(cells, cols, title, desc, { rowLabels = null, pad = 16, gap = 60, left = 0 } = {}) {
  const rs = cells.map((c) => renderScene(c.spec, c.kind));
  const tv = vb(union(rs.map((r) => r.bounds)), pad);
  const lab = Math.max(90, tv[2] * 0.055);
  const rows = Math.ceil(cells.length / cols);
  const W = left + cols * tv[2] + (cols - 1) * gap, Ht = rows * (tv[3] + lab) + (rows - 1) * gap * 0.5;
  const T = (x, y, t, a = 'middle', fs = Math.max(56, Math.round(tv[2] * 0.03))) => `<text x="${r1(x)}" y="${r1(y)}" text-anchor="${a}" font-family="-apple-system,system-ui,sans-serif" font-size="${fs}" font-weight="600" fill="#6E6E73">${t}</text>`;
  const body = rs.map((r, i) => {
    const cx = left + (i % cols) * (tv[2] + gap), cy = Math.floor(i / cols) * (tv[3] + lab + gap * 0.5);
    return `<g transform="translate(${r1(cx - tv[0])} ${r1(cy - tv[1])})">${r.svg.replace(/id="[^"]+"/g, '')}</g>\n${cells[i].label ? T(cx + tv[2] / 2, cy + tv[3] + Math.max(66, tv[2] * 0.04), cells[i].label) : ''}`;
  }).join('\n') + (rowLabels ? rowLabels.map((t, j) => T(0, j * (tv[3] + lab + gap * 0.5) + tv[3] / 2, t, 'start', 52)).join('') : '');
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r1(W)} ${r1(Ht)}" width="${r1(W)}" height="${r1(Ht)}" role="img">
<title>${title}</title>
<desc>${desc}</desc>
<defs>${STYLE(false)}
${SCENE_FILTERS}</defs>
${body}
</svg>
`, cell: tv };
}
files['plots-AB-states.svg'] = sheet(STATES.map(([st, name, c]) => ({ spec: blockSpec('AB', { state: st, color: c, kind: 'tile' }), kind: 'iso', label: name })), 3,
  'A + B touches: block states', 'Normal (green coverage), ripe (yellow) and heat-stressed (pink).').svg;
const AB_CASES = [['ripe', '#FFD60A', 'Ripe + yellow'], ['normal', '#0A84FF', 'Normal + blue']];
const abCells = (kind) => AB_CASES.flatMap(([st, c, n]) => [false, true].map((edge) => ({ spec: blockSpec('AB', { state: st, color: c, kind, abEdge: edge }), kind: kind === 'tile' ? 'iso' : 'top', label: `${n} · ${edge ? 'dark edge' : 'today'}` })));
files['decide-abline-iso.svg'] = sheet(abCells('tile'), 2, 'AB line: today vs dark edge (3/4 view)', 'A + B block, tractor A on lane 2 with coverage painted behind it. Left: today’s 0.05 line (fleet colour + 45% white). Right: the same line over a 0.09-wide #1C1C1E underlay at 0.55.').svg;
files['decide-abline-map.svg'] = sheet(abCells('maptile'), 2, 'AB line: today vs dark edge (Map view)', 'Top-down, north up, coverage at 0.62 above the canopy. Left: today. Right: with the dark edge.').svg;
const hubOpts = ['a', 'b', 'c'];
const hubR = Object.fromEntries(hubOpts.map((o) => [o, renderScene(depotSpec(o).spec, 'iso')]));
const hubFrame = union(hubOpts.map((o) => hubR[o].bounds));
const hubInfo = Object.fromEntries(hubOpts.map((o) => [o, depotSpec(o).info]));
for (const o of hubOpts) files[`decide-hub-${o}.svg`] = sceneSvg(`Fleet hub depth, option ${o}: ${hubInfo[o].label}`, 'Depot strip of the mock scenario at scene scale: road rows 0 and 6, column roads 0/5/10, blocks A and B (A + B touches), the Fleet hub north of road 6 with tractor A nosed into the refuel bay.', hubR[o], hubFrame);
files['decide-hub-top.svg'] = sheet(hubOpts.map((o) => ({ spec: depotSpec(o, { top: true }).spec, kind: 'top', label: `${o} · ${hubInfo[o].label}` })), 3, 'Fleet hub depth options, top-down', 'North up. Same strip as the 3/4 views.').svg;
const layoutInfo = {};
const farmR = {};
for (const k of ['a', 'b', 'c']) {
  const L = LAYOUTS[k], d = layoutSvg(L);
  files[`decide-layout-${k}.svg`] = d.svg;
  layoutInfo[k] = { name: L.name, sub: L.sub, gapA: d.gapA, gapB: d.gapB, hub: d.placement };
  farmR[k] = renderScene(farmSpec(L.blocks, d.placement, GRID), 'iso');
}
const farmFrame = union(Object.values(farmR).map((r) => r.bounds));
for (const k of ['a', 'b', 'c']) files[`decide-layout-${k}-iso.svg`] = sceneSvg(`Farm layout ${k}: ${LAYOUTS[k].name}, 3/4 view`, 'Whole farm from the default camera direction: roads, eight blocks with tree rows (one-lobe A trees for the thumbnail), the Fleet hub at the scale hubPlacement() picks.', farmR[k], farmFrame);
const decideFrames = { hub: vb(hubFrame), farm: vb(farmFrame) };
// orchard budget: 8 blocks, mocked ripeness (mockSource BLOCKS) and worst case (every block heavy)
const RIPE = [0.4, 0.5, 0.72, 0.3, 0.55, 0.6, 0.45, 0.35];
const level = (k, rp) => (k === 'current' ? (rp >= 0.6 ? Math.min(4, Math.round((rp - 0.45) * 8)) : 0) : rp >= 0.7 ? 'heavy' : rp >= 0.5 ? 'few' : 0);
const orchardStats = {};
for (const k of [...tKeys, 'AB']) {
  const b = treeBudgets[k], n = b.perBlock * 8;
  const perTree = b.parts.reduce((s, p) => s + p.tris * p.per, 0);
  const fruitPerBlock = (rp) => { const l = level(k, rp); return k === 'current' ? l * b.perBlock : l ? b.fruit[l] * b.perBlock : 0; };
  const fruitN = RIPE.reduce((s, rp) => s + fruitPerBlock(rp), 0);
  const fruitMax = k === 'current' ? 4 * n : b.fruit.heavy * n;
  const spec = blockSpec(k, { state: 'ripe' });
  const statics = (k === 'A' || k === 'AB' ? spec.groups.flatMap((g) => g.parts).filter((p) => p.name === 'tuft').length * 4 * 8 : 0) + (b.statics || 0);
  const trees = n * perTree;
  orchardStats[k] = { label: b.label, perBlock: b.perBlock, n, perTree, parts: b.parts, fruit: b.fruit, trees, statics, fruitN, fruitTris: fruitN * b.fruit.tris, fruitMax, fruitMaxTris: fruitMax * b.fruit.tris,
    total: trees + statics + fruitN * b.fruit.tris, worst: trees + statics + fruitMax * b.fruit.tris, draws: b.draws + (statics ? 1 : 0), shadowDraws: b.shadowDraws, ground: b.ground };
}
{ // like-for-like: A at the brief's 12 trees per block (4 x 3, one per cell, as farm.js lays them out)
  const o = orchardStats.A, n = 96, b = treeBudgets.A;
  const fruitN = RIPE.reduce((s, rp) => { const l = level('A', rp); return s + (l ? b.fruit[l] * 12 : 0); }, 0);
  orchardStats.A12 = { ...o, label: 'A at 12 per block', perBlock: 12, n, trees: n * o.perTree, fruitN, fruitTris: fruitN * b.fruit.tris, fruitMax: 9 * n, fruitMaxTris: 9 * n * b.fruit.tris,
    total: n * o.perTree + o.statics + fruitN * b.fruit.tris, worst: n * o.perTree + o.statics + 9 * n * b.fruit.tris };
}
const orchardFrames = { block: vb(blockFrame), map: vb(mapFrame), tile: vb(tileFrame, 16) };
for (const [n, s] of Object.entries(files)) writeFileSync(join(OUT, n), s);
const houseStats = {};
for (const k of hKeys) {
  const m = houses[k];
  const tris = m.parts.reduce((s, p) => s + p.tris, 0);
  const decals = m.parts.reduce((s, p) => s + p.faces.reduce((t, f) => t + f.decals.filter((d) => !d.rim).length, 0), 0);
  const rimTris = m.parts.reduce((s, p) => s + p.faces.reduce((t, f) => t + f.decals.filter((d) => d.rim).length * (p.n || 0), 0), 0);
  const pts = m.parts.flatMap((p) => p.faces.flatMap((f) => f.pts));
  const ext = (i) => r1(Math.max(...pts.map((q) => q[i])) - Math.min(...pts.map((q) => q[i])));
  houseStats[k] = { title: m.title, meshes: m.parts.length, tris, decals, decalTris: decals * 2 + rimTris, total: tris + decals * 2 + rimTris, w: ext(0), d: ext(2), h: ext(1) };
}
const sceneVb = vb(sFrame);

// stats for the preview captions
const stats = {};
for (const k of keys) {
  const m = models[k];
  const tris = m.parts.reduce((s, p) => s + p.tris, 0);
  const decals = m.parts.reduce((s, p) => s + p.faces.reduce((t, f) => t + f.decals.filter((d) => !d.rim).length, 0), 0);
  const wheels = m.parts.filter((p) => p.name === 'wheel');
  const rimN = wheels[0] ? wheels[0].faces[wheels[0].faces.length - 1].decals.length : 0;
  const rimTris = wheels.reduce((s, p) => s + rimN * p.n, 0); // CircleGeometry(n) per ring, outer cap only
  const lodRim = wheels.reduce((s, p) => s + (rimN ? 2 * (p.n >= 16 ? 10 : 8) : 0), 0); // LOD: rim + hub disc
  const wheelSave = m.parts.filter((p) => p.name === 'wheel').reduce((s, p) => s + (p.n - (p.n >= 16 ? 10 : 8)) * 4, 0);
  const fen = m.parts.filter((p) => p.name === 'fender' && p.faces.length === 6).length;
  const fenSave = fen > 6 ? (fen - 6) * 12 : 0;
  const isoT = render(m, 'iso', { ring: false }).bounds;
  stats[k] = { meshes: m.parts.length, tris, decals, decalTris: decals * 2, rimTris, total: tris + decals * 2 + rimTris, lod: tris - wheelSave - fenSave + lodRim, tractorH: r1(isoT.y1 - isoT.y0) };
}
const isoFrame = vb(frames.iso);
const pal = {};
for (const k of ['A', 'B', 'C']) { const m = files[`tractor-palette-${k}.svg`].match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/); pal[k] = { w: +m[1], h: +m[2] }; }
writeFileSync(join(OUT, '_build', 'stats.json'), JSON.stringify({ stats, isoFrame, pal, houses: houseStats, houseSceneFrame: sceneVb, orchard: orchardStats, orchardFrames, hubInfo, decideFrames, layoutInfo }, null, 2));
writeFileSync(join(OUT, 'index.html'), (await import('./page.mjs')).page({ stats, isoFrame, pal, models, houseStats, sceneVb, orchardStats, orchardFrames, hubInfo, decideFrames, layoutInfo }));
console.log(Object.keys(files).join('\n'));
console.log(JSON.stringify(stats));
console.log(JSON.stringify(houseStats));

// Shared low-poly part-list toolkit: the same primitives as textures/_build/build.mjs (hexa/box/loft/beam/
// n-gon cylinder with uv decals and per-face `mats`), plus a triangulator that turns a part list into ONE
// flat-shaded, non-indexed BufferGeometry with vertex colours (translucent decals pre-blended onto their face).
// Used by depotHub.js (Fleet hub) and machineShed.js (neighbour houses). Build time only; no per-frame work.
import * as THREE from 'three';

export const M = { chassis: '#3A3A3C', metal: '#636366', glass: '#33444F', light: '#F5F5F7', amber: '#FF9F0A', grille: '#1C1C1E', red: '#FF453A' };

// ---------- vector helpers ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => mul(a, 1 / Math.hypot(...a));
const avg = (ps) => mul(ps.reduce(add, [0, 0, 0]), 1 / ps.length);
const lerp = (a, b, t) => add(a, mul(sub(b, a), t));
const _c = new THREE.Color();
const rgb = (hex) => { _c.set(hex); return [_c.r, _c.g, _c.b]; };
const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---------- primitives (signatures as in build.mjs) ----------
/** v: 0 LBB,1 RBB,2 RTB,3 LTB (back z) 4 LBF,5 RBF,6 RTF,7 LTF (front z). Decal uv: u left->right, w bottom->top (top face: front->back). */
export function hexa(v, mat, o = {}) {
  const F = { front: [4, 5, 6, 7], back: [1, 0, 3, 2], left: [0, 4, 7, 3], right: [5, 1, 2, 6], top: [7, 6, 2, 3], bottom: [0, 1, 5, 4] };
  const faces = Object.entries(F).map(([name, idx]) => {
    const q = idx.map((i) => v[i]);
    const face = { name, pts: q, mat: (o.mats && o.mats[name]) || mat, decals: [] };
    for (const d of o.decals || []) {
      if (d.face !== name) continue;
      const bl = (u, w) => lerp(lerp(q[0], q[1], u), lerp(q[3], q[2], u), w);
      face.decals.push({ pts: d.uv.map(([u, w]) => bl(u, w)), fill: d.fill, op: d.op ?? 1 });
    }
    return face;
  });
  return { faces, name: o.name };
}
export function loft(b, z0, f, z1, mat, o) {
  return hexa([
    [b[0], b[2], z0], [b[1], b[2], z0], [b[1], b[3], z0], [b[0], b[3], z0],
    [f[0], f[2], z1], [f[1], f[2], z1], [f[1], f[3], z1], [f[0], f[3], z1],
  ], mat, o);
}
export const box = (x0, x1, y0, y1, z0, z1, mat, o) => loft([x0, x1, y0, y1], z0, [x0, x1, y0, y1], z1, mat, o);
export function beam(p0, p1, w, h, mat, o) {
  const d = norm(sub(p1, p0));
  let s = cross(d, [0, 1, 0]);
  if (Math.hypot(...s) < 1e-6) s = [1, 0, 0];
  s = mul(norm(s), w / 2);
  const u = mul(norm(cross(s, d)), h / 2);
  const c = (p, a, b) => add(add(p, mul(s, a)), mul(u, b));
  return hexa([c(p0, -1, -1), c(p0, 1, -1), c(p0, 1, 1), c(p0, -1, 1), c(p1, -1, -1), c(p1, 1, -1), c(p1, 1, 1), c(p1, -1, 1)], mat, o);
}
/** Vertical n-gon cylinder (stacks, masts, downpipes). */
export function cylY(c, r, len, n, mat, o = {}) {
  const ring = (t) => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [c[0] + Math.cos(a) * r, c[1] + t, c[2] + Math.sin(a) * r]; });
  const A = ring(-len / 2), B = ring(len / 2), faces = [];
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; faces.push({ pts: [A[i], A[j], B[j], B[i]], mat, decals: [] }); }
  faces.push({ pts: [...A].reverse(), mat, decals: [] }, { pts: B, mat, decals: [] });
  return { faces, name: o.name };
}
/** Window with a diagonal glint (houses.mjs `glass`). */
export const glass = (face, u0, u1, w0, w1) => [
  { face, uv: [[u0, w0], [u1, w0], [u1, w1], [u0, w1]], fill: M.glass },
  { face, uv: [[u0 + (u1 - u0) * 0.12, w0 + 0.05], [u0 + (u1 - u0) * 0.24, w0 + 0.05], [u0 + (u1 - u0) * 0.44, w1 - 0.05], [u0 + (u1 - u0) * 0.32, w1 - 0.05]], fill: '#fff', op: 0.2 },
];
/** Solar panel field with cell lines (houses.mjs `panels`). */
export const panels = (face, u0, u1, w0, w1, cols, rows, solar = '#1F3550', line = '#4A6A8C') => {
  const out = [{ face, uv: [[u0, w0], [u1, w0], [u1, w1], [u0, w1]], fill: solar }];
  for (let i = 1; i < cols; i++) { const u = u0 + ((u1 - u0) * i) / cols; out.push({ face, uv: [[u - 0.003, w0], [u + 0.003, w0], [u + 0.003, w1], [u - 0.003, w1]], fill: line }); }
  for (let j = 1; j < rows; j++) { const w = w0 + ((w1 - w0) * j) / rows; out.push({ face, uv: [[u0, w - 0.01], [u1, w - 0.01], [u1, w + 0.01], [u0, w + 0.01]], fill: line }); }
  return out;
};

// ---------- triangulation ----------
function pushPoly(b, pts, n, col, off, m) {
  const o = mul(n, off);
  const p = pts.map((q) => add(q, o));
  for (let i = 1; i < p.length - 1; i++) {
    for (const v of [p[0], p[i], p[i + 1]]) {
      let x = v[0], y = v[1], z = v[2], nx = n[0], ny = n[1], nz = n[2];
      if (m) { // rigid transform (rotation about y + uniform scale + translation)
        x = (v[0] * m.c + v[2] * m.s) * m.k + m.x; y = v[1] * m.k; z = (-v[0] * m.s + v[2] * m.c) * m.k + m.z;
        nx = n[0] * m.c + n[2] * m.s; nz = -n[0] * m.s + n[2] * m.c;
      }
      b.pos.push(x, y, z); b.nrm.push(nx, ny, nz); b.col.push(col[0], col[1], col[2]);
    }
  }
}

/** Accumulator: add part lists (optionally placed by {x, z, ry, k}), then toGeometry() once. */
export function createBuilder() {
  const b = { pos: [], nrm: [], col: [] };
  return {
    add(parts, place) {
      const m = place ? { c: Math.cos(place.ry || 0), s: Math.sin(place.ry || 0), k: place.k ?? 1, x: place.x || 0, z: place.z || 0 } : null;
      for (const part of parts) {
        const pc = avg(part.faces.flatMap((f) => f.pts));
        for (const face of part.faces) {
          let n = [0, 0, 0];
          for (let i = 0; i < face.pts.length; i++) {
            const a = face.pts[i], c = face.pts[(i + 1) % face.pts.length];
            n = add(n, [(a[1] - c[1]) * (a[2] + c[2]), (a[2] - c[2]) * (a[0] + c[0]), (a[0] - c[0]) * (a[1] + c[1])]);
          }
          if (Math.hypot(...n) < 1e-12) continue; // degenerate (e.g. a gable's collapsed ridge face)
          n = norm(n);
          if (dot(n, sub(avg(face.pts), pc)) < 0) n = mul(n, -1);
          if (n[1] < -0.99 && Math.max(...face.pts.map((q) => q[1])) <= 0.021) continue; // bottom at ground level: never seen
          let pts = face.pts;
          if (dot(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])), n) < 0) pts = pts.slice().reverse();
          const base = rgb(face.mat);
          pushPoly(b, pts, n, base, 0, m);
          face.decals.forEach((d, k) => {
            let dp = d.pts;
            if (dot(cross(sub(dp[1], dp[0]), sub(dp[2], dp[0])), n) < 0) dp = dp.slice().reverse();
            pushPoly(b, dp, n, d.op < 1 ? mixRgb(base, rgb(d.fill), d.op) : rgb(d.fill), (0.0015 * (k + 1)) / (m ? m.k : 1), m); // same world offset at any scale
          });
        }
      }
      return this;
    },
    get tris() { return b.pos.length / 9; },
    toGeometry() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      g.computeBoundingSphere();
      return g;
    },
  };
}

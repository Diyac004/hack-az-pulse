// Live feed tractors: top-down icon (status ring, tractor A from above in fleet color, nose = heading, implement bar
// of tool.width_m at the hitch point),
// smooth interpolation between ~5 Hz poses, breadcrumb trails, AB guidance lines, ripples.
// sync() is cheap and runs on every pose message (also while hidden, so trails keep accumulating);
// frame() runs only while the Live feed is visible.
import * as THREE from 'three';
import { tractorColor, statusInfo } from '../lib/format.js';
import { poseToGrid } from '../lib/geo.js';
import { createTrail } from './liveTrails.js';
import { iconLayout, acquireTractorTexture, releaseTractorTexture } from './liveTractorIcon.js';

export const ICON_LEN = 0.84;   // drawn tractor length in local units (= grid cells at scale 1); exaggerated like a map marker
const LAY = iconLayout(ICON_LEN);
const MIN_ICON_PX = 30;         // screen-size floor for the tractor length
const FALLBACK_WIDTH_M = 3;

let G = null; // shared geometries
function shared() {
  if (G) return G;
  G = {
    disc: new THREE.CircleGeometry(1, 40),
    ring: new THREE.RingGeometry(0.47, 0.53, 56),
    halo: new THREE.RingGeometry(0.57, 0.62, 56),
    quad: new THREE.PlaneGeometry(1, 1),
    rip: new THREE.RingGeometry(0.9, 1, 64),
  };
  return G;
}
export function disposeShared() { if (!G) return; Object.values(G).forEach((g) => g.dispose()); G = null; }

const mat = (color, opacity = 1, order) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
function flat(geo, m, order) { const o = new THREE.Mesh(geo, m); o.rotation.x = -Math.PI / 2; o.renderOrder = order; return o; }

// Icon: status ring + selection halo (unrotated) and, in the heading-rotated group, tractor A seen from above
// (nose = heading) with the implement bar attached at the SVG's hitch point.
function mkIcon(color) {
  const g = shared();
  const root = new THREE.Group(), rotor = new THREE.Group();
  const M = {
    ring: mat(color, 0.9), halo: mat('#ffffff', 0), bar: mat(color, 1), barEdge: mat('#1c1c1e', 0.7),
    body: new THREE.MeshBasicMaterial({ map: acquireTractorTexture(color), transparent: true, depthTest: false, depthWrite: false }),
  };
  const ring = flat(g.ring, M.ring, 9);
  const halo = flat(g.halo, M.halo, 9);
  const body = flat(g.quad, M.body, 12); body.scale.set(LAY.w, LAY.h, 1); body.position.z = LAY.z;
  const bar = flat(g.quad, M.bar, 10.5); bar.position.z = LAY.hitchZ + 0.04;
  const barEdge = flat(g.quad, M.barEdge, 10); barEdge.position.z = bar.position.z; // dark edge: bar stays visible over its own coverage color
  rotor.add(barEdge, bar, body);
  root.add(ring, halo, rotor);
  return { root, rotor, ring, halo, bar, barEdge, body, M, color };
}

// --- AB line helpers (grid coords) ---
/** Clip the infinite line p + t*d to rect; returns [t0, t1] or null. */
function clip(px, py, dx, dy, r) {
  let t0 = -1e9, t1 = 1e9;
  for (const [p, d, lo, hi] of [[px, dx, r.x0, r.x1], [py, dy, r.y0, r.y1]]) {
    if (Math.abs(d) < 1e-9) { if (p < lo || p > hi) return null; continue; }
    let a = (lo - p) / d, b = (hi - p) / d; if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
  }
  return t1 > t0 ? [t0, t1] : null;
}
const angDiff = (a, b) => { let d = ((a - b) % 360 + 540) % 360 - 180; return Math.abs(d); };

/** hooks.onCreate(rec) / hooks.onRemove(rec): let another view (the diorama) attach to each tractor record. */
export function createLiveTractors(scene, hooks = {}) {
  const map = new Map();
  const ripples = [];
  const P = { x: 0, y: 0 }, T = { x: 0, y: 0 };
  let selected = null;

  function remove(rec) {
    if (hooks.onRemove) hooks.onRemove(rec);
    scene.remove(rec.icon.root); scene.remove(rec.ab);
    Object.values(rec.icon.M).forEach((m) => m.dispose());
    releaseTractorTexture(rec.icon.color);
    rec.abMat.dispose(); rec.abDotMat.dispose(); rec.abEdgeMat.dispose();
    rec.trail.dispose();
    map.delete(rec.id);
  }

  function setAB(rec, grid, ax, ay, bx, by) {
    const ox = (grid.w - 1) / 2, oy = (grid.h - 1) / 2;
    rec.abSeg = { ax: ax - ox, az: ay - oy, bx: bx - ox, bz: by - oy };
  }

  /** Guidance line: AgOpenWeb's own AB (log detail.ab) if the backend sent one, else derived from heading. */
  function updateAB(rec, tr, state, grid, geo) {
    // AgOpenWeb's own AB line (newest log detail.ab for this tractor): shown in ANY status, so a line the operator
    // just set from the Tractor Control Panel appears at once in both views. detail.ab = null clears it.
    const log = state.log || [];
    for (let i = 0; i < log.length && i < 200; i++) {
      const e = log[i];
      if (e && e.kind === 'agopenweb' && e.tractor === tr.id && e.detail && 'ab' in e.detail) {
        if (!Array.isArray(e.detail.ab)) break; // cleared: fall back to the derived guidance line
        if (e.detail.ab.length < 4 || !geo) continue;
        const [la1, lo1, la2, lo2] = e.detail.ab.map(Number);
        if ([la1, lo1, la2, lo2].every(isFinite)) {
          const a = geo.toGrid(la1, lo1), b = geo.toGrid(la2, lo2);
          // extend the A-B segment across the field like AgOpenWeb draws it (clip to the farm)
          const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
          const t = clip(a.x, a.y, dx / L, dy / L, { x0: -0.5, x1: grid.w - 0.5, y0: -0.5, y1: grid.h - 0.5 });
          if (t) setAB(rec, grid, a.x + (dx / L) * Math.max(t[0], -L * 0.25), a.y + (dy / L) * Math.max(t[0], -L * 0.25), a.x + (dx / L) * Math.min(t[1], L * 1.25), a.y + (dy / L) * Math.min(t[1], L * 1.25));
          else setAB(rec, grid, a.x, a.y, b.x, b.y);
          rec.abSrc = 'agopenweb'; return;
        }
      }
    }
    if (tr.status !== 'working') { rec.abSeg = null; rec.abHd = null; return; }
    const hd = tr.pose && isFinite(tr.pose.heading_deg) ? +tr.pose.heading_deg : null;
    if (hd == null) return;
    const prev = rec.prevHd; rec.prevHd = hd;
    const dx = Math.sin((hd * Math.PI) / 180), dy = -Math.cos((hd * Math.PI) / 180);
    // keep the current line while the tractor stays on it (no jitter from noisy live headings)
    if (rec.abSeg && rec.abHd != null && angDiff(hd, rec.abHd) < 8) {
      const L = rec.abLine, cross = Math.abs((P.x - L.px) * L.dy - (P.y - L.py) * L.dx);
      if (cross < 0.35) return;
    }
    if (prev == null || angDiff(hd, prev) > 6) return; // wait for a stable heading (skips U-turn frames)
    const job = (state.jobs || []).find((j) => j.id === tr.current_job);
    const b = job && grid.blockById[job.block];
    const r = b ? { x0: b.x - 0.8, x1: b.x + b.w - 0.2, y0: b.y - 0.8, y1: b.y + b.h - 0.2 } : { x0: P.x - 2.5, x1: P.x + 2.5, y0: P.y - 2.5, y1: P.y + 2.5 };
    const t = clip(P.x, P.y, dx, dy, r);
    if (!t) { rec.abSeg = null; return; }
    rec.abHd = hd; rec.abLine = { px: P.x, py: P.y, dx, dy }; rec.abSrc = 'derived';
    setAB(rec, grid, P.x + dx * t[0], P.y + dy * t[0], P.x + dx * t[1], P.y + dy * t[1]);
  }

  return {
    get(id) { return map.get(id); },
    ids() { return [...map.keys()]; },
    /** live iterator over tractor records (no copy) */
    records() { return map.values(); },
    /** displayed world position {x, z} */
    worldPos(id, out) { const r = map.get(id); if (!r) return null; out = out || { x: 0, z: 0 }; out.x = r.icon.root.position.x; out.z = r.icon.root.position.z; return out; },
    setSelected(id) { selected = id; },

    /** Reconcile with state.fleet; record trail samples + AB. Cheap; safe while hidden. */
    sync(state, grid, geo, initial) {
      if (!grid) return;
      const now = performance.now(), seen = new Set();
      const ox = (grid.w - 1) / 2, oy = (grid.h - 1) / 2;
      (state.fleet || []).forEach((tr, i) => {
        if (!tr || !tr.id) return;
        seen.add(tr.id);
        const color = tractorColor(tr, i);
        let rec = map.get(tr.id);
        const has = poseToGrid(geo, tr.pose, P);
        if (!has) { P.x = grid.depot.x; P.y = grid.depot.y; }
        const wx = P.x - ox, wz = P.y - oy;
        if (!rec) {
          const icon = mkIcon(color); scene.add(icon.root);
          icon.root.position.set(wx, 0, wz);
          const ab = new THREE.Group();
          const abMat = mat(new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.45), 0.95), abDotMat = mat('#ffffff', 1);
          const abEdgeMat = mat('#1c1c1e', 0.55); // dark edge under the line, like the implement bar's
          const edge = flat(shared().quad, abEdgeMat, 4.9), line = flat(shared().quad, abMat, 5), da = flat(shared().disc, abDotMat, 5), db = flat(shared().disc, abDotMat, 5);
          ab.add(edge, line, da, db); ab.visible = false; scene.add(ab);
          const trail = createTrail(color); scene.add(trail.mesh);
          rec = { id: tr.id, icon, ab, abLine: null, abMat, abDotMat, abEdgeMat, abParts: { edge, line, da, db }, trail, color, from: { x: wx, z: wz }, to: { x: wx, z: wz }, t0: now, dur: 200, lastUpd: now, hd: 0, born: initial ? 0 : now, lastRip: 0 };
          rec.icon.rotor.rotation.y = -((+(tr.pose && tr.pose.heading_deg) || 0) * Math.PI) / 180;
          map.set(tr.id, rec);
          if (hooks.onCreate) hooks.onCreate(rec);
          if (!initial) this.ripple(wx, wz, '#30D158');
        }
        if (rec.color !== color) {
          rec.color = color; rec.icon.M.bar.color.set(color); rec.trail.setColor(color);
          const old = rec.icon.color; rec.icon.M.body.map = acquireTractorTexture(color); rec.icon.color = color; releaseTractorTexture(old);
          rec.abMat.color.set(color).lerp(new THREE.Color('#ffffff'), 0.45);
        }
        if (has && (Math.abs(wx - rec.to.x) > 1e-5 || Math.abs(wz - rec.to.z) > 1e-5)) {
          const gap = now - rec.lastUpd; rec.lastUpd = now;
          rec.from.x = rec.icon.root.position.x; rec.from.z = rec.icon.root.position.z;
          rec.to.x = wx; rec.to.z = wz; rec.t0 = now; rec.dur = Math.max(120, Math.min(600, gap || 200));
          rec.trail.add(wx, wz);
        }
        if (tr.pose && isFinite(tr.pose.heading_deg)) rec.hd = +tr.pose.heading_deg;
        rec.tr = tr; rec.status = tr.status;
        updateAB(rec, tr, state, grid, geo);
      });
      for (const rec of [...map.values()]) if (!seen.has(rec.id)) remove(rec);
    },

    /** Per visible frame. wpp = world units per screen pixel at the ground. */
    frame(now, dt, wpp) {
      const s = Math.max(1, (MIN_ICON_PX * wpp) / ICON_LEN);
      const pulse = 0.5 + 0.5 * Math.sin(now / 180);
      const k = 1 - Math.pow(0.0005, dt); // heading smoothing, frame-rate independent
      for (const rec of map.values()) {
        const { root, rotor, ring, halo, bar, barEdge, M } = rec.icon;
        const f = Math.min(1, (now - rec.t0) / rec.dur);
        root.position.x = rec.from.x + (rec.to.x - rec.from.x) * f;
        root.position.z = rec.from.z + (rec.to.z - rec.from.z) * f;
        const target = -(rec.hd * Math.PI) / 180;
        let d = target - rotor.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); rotor.rotation.y += d * k;
        let sc = s;
        if (rec.born) { const a = Math.min(1, (now - rec.born) / 600); sc *= a < 1 ? Math.max(0.01, a * (1 + Math.sin(a * Math.PI * 1.5) * 0.3 * (1 - a))) : 1; if (a >= 1) rec.born = 0; }
        root.scale.setScalar(sc);
        // implement bar at tool.width_m (same exaggeration as the icon)
        const wm = rec.tr && rec.tr.tool && rec.tr.tool.width_m > 0 ? +rec.tr.tool.width_m : FALLBACK_WIDTH_M;
        const bw = Math.max(0.3, wm * LAY.perM);
        bar.scale.set(bw, 0.07, 1); barEdge.scale.set(bw + 0.05, 0.12, 1);
        // status ring
        const info = statusInfo(rec.status);
        M.body.opacity = 1; M.bar.opacity = 1; M.barEdge.opacity = 0.7;
        if (info.ring === 'broken') {
          M.ring.color.set('#FF453A'); ring.scale.setScalar(1 + 0.22 * pulse); M.ring.opacity = 0.55 + 0.45 * pulse;
          if (now - rec.lastRip > 1500) { rec.lastRip = now; this.ripple(root.position.x, root.position.z, '#FF453A', sc * 0.6); }
        } else if (info.ring === 'repair') { M.ring.color.set('#FF9F0A'); ring.scale.setScalar(1 + 0.12 * pulse); M.ring.opacity = 0.9; }
        else if (info.ring === 'fade') { M.ring.color.set('#8e8e93'); ring.scale.setScalar(1); M.ring.opacity = 0.6; M.body.opacity = 0.5; M.bar.opacity = 0.4; M.barEdge.opacity = 0.3; }
        else if (info.ring === 'spin') { M.ring.color.set('#0A84FF'); ring.scale.setScalar(1); M.ring.opacity = 0.35 + 0.55 * pulse; }
        else { M.ring.color.set(rec.color); ring.scale.setScalar(info.ring === 'pulse' ? 1 + 0.06 * pulse : 1); M.ring.opacity = 0.9; }
        M.halo.opacity = rec.id === selected ? 0.95 : 0;
        // trail tip follows the icon
        rec.trail.frame(root.position.x, root.position.z, 0.85);
        // AB line
        const seg = rec.abSeg;
        rec.ab.visible = !!seg;
        if (seg) {
          const { edge, line, da, db } = rec.abParts;
          const L = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az), th = Math.max(0.03, 1.6 * wpp), dot = Math.max(0.06, 3.5 * wpp);
          line.position.set((seg.ax + seg.bx) / 2, 0, (seg.az + seg.bz) / 2);
          line.rotation.z = Math.atan2(-(seg.bz - seg.az), seg.bx - seg.ax); // flat mesh: rotation.z spins in the ground plane
          line.scale.set(L, th, 1);
          edge.position.copy(line.position); edge.rotation.z = line.rotation.z; edge.scale.set(L, Math.max(th * 1.8, th + 2.4 * wpp), 1); // 0.09 : 0.05 as in 3D, at least ~1.2 px each side
          da.position.set(seg.ax, 0, seg.az); db.position.set(seg.bx, 0, seg.bz); da.scale.setScalar(dot); db.scale.setScalar(dot);
        }
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i], a = (now - r.born) / 1200;
        r.m.scale.setScalar(r.s * (0.4 + a * 1.6)); r.m.material.opacity = Math.max(0, 0.85 * (1 - a));
        if (a >= 1) { scene.remove(r.m); r.m.material.dispose(); ripples.splice(i, 1); }
      }
    },

    ripple(x, z, color, s = 1) {
      if (ripples.length > 24) return;
      const m = flat(shared().rip, mat(color, 0.85), 14); m.position.set(x, 0, z); scene.add(m);
      ripples.push({ m, born: performance.now(), s: Math.max(0.6, s) });
    },

    /** Screen-space hit test: project(x, z) -> {x, y} px. Returns nearest tractor id within radius. */
    pick(px, py, project, radius = 26) {
      let best = null, bd = radius * radius;
      for (const rec of map.values()) {
        const p = project(rec.icon.root.position.x, rec.icon.root.position.z);
        const d = (p.x - px) ** 2 + (p.y - py) ** 2;
        if (d < bd) { bd = d; best = rec.id; }
      }
      return best;
    },

    /** Drop trails/AB (snapshot/new run) but keep icons. */
    resetHistory() { for (const r of map.values()) { r.trail.clear(); r.abSeg = null; r.abHd = null; } },
    clear() { [...map.values()].forEach(remove); ripples.splice(0).forEach((r) => { scene.remove(r.m); r.m.material.dispose(); }); },
    get size() { return map.size; },
  };
}

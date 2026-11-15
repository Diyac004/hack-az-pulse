// Tractor meshes keyed by id: pose interpolation (5 Hz -> 60 fps), status rings, pop-in/out, route ribbons.
import * as THREE from 'three';
import { lm } from './world.js';
import { headingToRotY, activeRoute } from '../lib/derive.js';
import { tractorColor, statusInfo, isDown } from '../lib/format.js';

const stripe = (() => {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = 64; c.height = 4; const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 64, 0); gr.addColorStop(0, 'rgba(255,255,255,.2)'); gr.addColorStop(0.5, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,.2)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 4); return c;
})();

function mkTractor(c) {
  const g = new THREE.Group();
  const paint = lm(c);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 0.8), paint); body.position.y = 0.32;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.32, 0.36), lm('#2c2c2e')); cab.position.set(0, 0.6, -0.16);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.05, 0.42), paint); roof.position.set(0, 0.79, -0.16);
  g.add(body, cab, roof);
  const wm = lm('#1c1c1e');
  [[0.3, 0.22, -0.2], [-0.3, 0.22, -0.2], [0.27, 0.14, 0.27], [-0.27, 0.14, 0.27]].forEach(([x, r, z]) => {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.12, 14), wm); w.rotation.z = Math.PI / 2; w.position.set(x, r, z); g.add(w);
  });
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.76, 40), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; g.add(ring);
  // dashed spinner ring for `starting`
  const spin = new THREE.Mesh(new THREE.RingGeometry(0.82, 0.9, 40, 1, 0, Math.PI * 1.3), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  spin.rotation.x = -Math.PI / 2; spin.position.y = 0.035; spin.visible = false; g.add(spin);
  g.userData = { ring, spin, paint };
  return g;
}

const dispose = (o) => o.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });

export function createTractors(world, farm, fx) {
  const { S } = world;
  const map = new Map(); // id -> rec
  let lastSmoke = 0, lastRib = 0;

  const W = (x, y) => { const p = farm.grid.toWorld(x, y); return new THREE.Vector3(p.x, 0, p.z); };

  function ribbon(rec, pts) {
    if (rec.rib) { S.remove(rec.rib); rec.rib.geometry.dispose(); rec.rib = null; }
    if (!pts || pts.length < 2) return;
    const v = pts.map(([x, y]) => { const w = W(x, y); w.y = 0.13; return w; });
    const cv = new THREE.CatmullRomCurve3(v, false, 'catmullrom', 0.02); const L = cv.getLength(); if (L < 0.2) return;
    rec.rib = new THREE.Mesh(new THREE.TubeGeometry(cv, Math.max(8, v.length * 5), 0.07, 6, false), rec.rm);
    rec.rm.map.repeat.set(L / 1.1, 1); S.add(rec.rib);
  }

  function remove(rec, animate) {
    if (rec.rib) { S.remove(rec.rib); rec.rib.geometry.dispose(); rec.rib = null; }
    if (animate) { rec.leaving = performance.now(); return; }
    S.remove(rec.g); dispose(rec.g); if (rec.rm) { rec.rm.map.dispose(); rec.rm.dispose(); }
    map.delete(rec.id);
  }

  return {
    get(id) { return map.get(id); },
    worldPos(id) { const r = map.get(id); return r ? r.g.position.clone() : null; },
    clear() { [...map.values()].forEach((r) => remove(r, false)); },
    /** Reconcile with state.fleet. `initial` = true for snapshots (no pop-in fanfare). */
    sync(state, initial) {
      if (!farm.grid) return;
      const fleet = state.fleet || [];
      const seen = new Set();
      const now = performance.now();
      fleet.forEach((tr, i) => {
        if (!tr || !tr.id) return;
        seen.add(tr.id);
        let rec = map.get(tr.id);
        const color = tractorColor(tr, i);
        const pose = tr.pose || farm.grid.depot;
        if (!rec || rec.leaving) {
          if (rec) remove(rec, false);
          const g = mkTractor(color);
          const p = W(+pose.x || 0, +pose.y || 0);
          g.position.copy(p); g.rotation.y = headingToRotY(tr.pose ? tr.pose.heading_deg : 0);
          g.scale.setScalar(initial ? 0.85 : 0.01);
          S.add(g);
          const tx = new THREE.CanvasTexture(stripe); tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
          const rm = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).offsetHSL(0, 0, 0.08), map: tx, transparent: true, opacity: 0.95 });
          rec = { id: tr.id, g, rm, rib: null, color, born: initial ? 0 : now, from: p.clone(), to: p.clone(), t0: now, dur: 200, lastUpd: now, rot: g.rotation.y, status: tr.status };
          map.set(tr.id, rec);
          if (!initial) fx.ripple(p, '#30D158');
        }
        if (rec.color !== color) { rec.color = color; rec.g.userData.paint.color.set(color); rec.rm.color.set(color).offsetHSL(0, 0, 0.08); }
        // pose interpolation target
        if (tr.pose && isFinite(tr.pose.x) && isFinite(tr.pose.y)) {
          const to = W(tr.pose.x, tr.pose.y);
          if (to.distanceToSquared(rec.to) > 1e-6) {
            const gap = now - rec.lastUpd; rec.lastUpd = now;
            rec.from.copy(rec.g.position); rec.to.copy(to); rec.t0 = now;
            rec.dur = Math.max(120, Math.min(600, gap || 200));
          }
          if (tr.pose.heading_deg != null && isFinite(tr.pose.heading_deg)) rec.rot = headingToRotY(tr.pose.heading_deg);
        }
        rec.status = tr.status; rec.tr = tr;
      });
      for (const rec of [...map.values()]) if (!seen.has(rec.id) && !rec.leaving) remove(rec, !initial);
    },
    tick(state, now, dt) {
      if (!farm.grid) return;
      const doSmoke = now - lastSmoke > 140; if (doSmoke) lastSmoke = now;
      const doRib = now - lastRib > 250; if (doRib) lastRib = now;
      const pulse = 0.5 + 0.5 * Math.sin(now / 180);
      for (const rec of [...map.values()]) {
        const g = rec.g, ud = g.userData;
        if (rec.leaving) {
          const a = Math.min(1, (now - rec.leaving) / 400); g.scale.setScalar(0.85 * (1 - a) + 0.001);
          if (a >= 1) { rec.leaving = null; remove(rec, false); }
          continue;
        }
        // position: linear interp over the measured update interval
        const f = Math.min(1, (now - rec.t0) / rec.dur);
        g.position.lerpVectors(rec.from, rec.to, f);
        let d = rec.rot - g.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); g.rotation.y += d * 0.2;
        // pop-in with overshoot
        if (rec.born) {
          const a = Math.min(1, (now - rec.born) / 600), e = a === 1 ? 1 : 1 + Math.sin(a * Math.PI * 1.5) * 0.3 * (1 - a);
          g.scale.setScalar(Math.max(0.01, 0.85 * a * e)); if (a >= 1) rec.born = 0;
        }
        const info = statusInfo(rec.status), ring = ud.ring;
        ud.spin.visible = info.ring === 'spin';
        if (ud.spin.visible) ud.spin.rotation.z = -now / 250;
        if (info.ring === 'broken') {
          ring.material.color.set('#FF453A'); ring.scale.setScalar(1 + 0.25 * pulse); ring.material.opacity = 0.5 + 0.5 * pulse;
          if (doSmoke && (rec.status === 'broken' || rec.status === 'awaiting_mechanic')) fx.smoke(g.position);
        } else if (info.ring === 'repair') {
          ring.material.color.set('#FF9F0A'); ring.scale.setScalar(1 + 0.15 * pulse); ring.material.opacity = 0.85;
        } else if (info.ring === 'fade') {
          ring.material.color.set('#8e8e93'); ring.scale.setScalar(1); ring.material.opacity = 0.5;
        } else {
          ring.material.color.set(rec.color); ring.scale.setScalar(info.ring === 'pulse' ? 1 + 0.08 * pulse : 1); ring.material.opacity = info.ring === 'spin' ? 0.4 : 0.85;
        }
        if (doRib) ribbon(rec, rec.tr && !isDown(rec.status) ? activeRoute(state, rec.tr) : null);
        if (rec.rib) rec.rm.map.offset.x -= dt * 1.6;
      }
    },
  };
}

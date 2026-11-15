// Mechanic service van, animated client-side in FARM time from the booking result
// (arrival_t) and tractor status changes (repair_scheduled -> repairing -> back in service).
import * as THREE from 'three';
import { lm } from './world.js';
import { gridPath, alongPath, blockedCells } from '../lib/derive.js';

const DOWN = new Set(['broken', 'awaiting_mechanic', 'repair_scheduled', 'repairing']);

export function createVans(world, farm) {
  const { S } = world;
  const vans = new Map(); // tractorId -> van

  function mesh() {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.85), lm('#F5F5F7')); b.position.y = 0.3;
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.08, 0.86), lm('#0A84FF')); s.position.y = 0.25;
    const lt = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.1), new THREE.MeshBasicMaterial({ color: '#FF9F0A' })); lt.position.y = 0.54;
    g.add(b, s, lt); g.traverse((o) => { if (o.isMesh) o.castShadow = true; }); g.scale.setScalar(0.85);
    g.userData.light = lt; S.add(g); return g;
  }
  const kill = (id) => { const v = vans.get(id); if (!v) return; S.remove(v.g); v.g.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); }); vans.delete(id); };
  const W = (x, y) => { const p = farm.grid.toWorld(x, y); return new THREE.Vector3(p.x, 0, p.z); };

  function dispatch(state, tractorId, bookT, arrivalT, opts = {}) {
    if (!farm.grid) return;
    const tr = (state.fleet || []).find((x) => x.id === tractorId);
    if (!tr || !tr.pose) return;
    kill(tractorId);
    const d = (opts.from && isFinite(opts.from.x) && isFinite(opts.from.y)) ? opts.from : farm.grid.depot, blocked = blockedCells(state);
    const path = gridPath(farm.grid, blocked, d.x, d.y, tr.pose.x, tr.pose.y);
    path.push([tr.pose.x, tr.pose.y]);
    const v = { id: tractorId, g: mesh(), path, bookT, arrivalT: Math.max(bookT + 1, arrivalT ?? bookT + 45), phase: opts.parked ? 'there' : 'in', outT: null, outPath: null, home: { x: d.x, y: d.y } };
    const p0 = opts.parked ? path[path.length - 1] : path[0];
    v.g.position.copy(W(p0[0], p0[1]));
    vans.set(tractorId, v);
  }

  return {
    dispatch,
    clear() { [...vans.keys()].forEach(kill); },
    has: (id) => vans.has(id),
    /** state-driven: decide phases; spawn a parked van for a tractor already `repairing` (e.g. after a snapshot). */
    sync(state) {
      const fleet = state.fleet || [];
      for (const tr of fleet) if (tr.status === 'repairing' && !vans.has(tr.id) && state.clock) dispatch(state, tr.id, state.clock.t, state.clock.t, { parked: true });
      const t = state.clock ? state.clock.t : 0;
      for (const v of vans.values()) {
        const tr = fleet.find((x) => x.id === v.id);
        if (v.phase === 'in' && tr && tr.status === 'repairing') v.phase = 'there';
        if ((v.phase === 'in' || v.phase === 'there') && (!tr || !DOWN.has(tr.status))) {
          const pos = v.g.position, g = farm.grid, ox = (g.w - 1) / 2, oy = (g.h - 1) / 2;
          v.phase = 'out'; v.outT = t;
          const home = v.home || g.depot; // back to where it came from (the hub's service bay)
          v.outPath = gridPath(g, blockedCells(state), pos.x + ox, pos.z + oy, home.x, home.y);
          v.outPath.push([home.x, home.y]);
        }
      }
    },
    tick(state, now) {
      const t = state.clock ? state.clock.t : 0;
      for (const v of [...vans.values()]) {
        let p = null;
        if (v.phase === 'in') {
          p = alongPath(v.path, (t - v.bookT) / (v.arrivalT - v.bookT));
          if (t >= v.arrivalT) v.phase = 'there';
        } else if (v.phase === 'there') {
          p = alongPath(v.path, 1); p.hd = null;
        } else if (v.phase === 'out') {
          const f = (t - v.outT) / 25; // drive home over ~25 farm minutes
          p = alongPath(v.outPath, f);
          if (f >= 1) { kill(v.id); continue; }
        }
        if (p) {
          const target = W(p.x, p.y);
          v.g.position.lerp(target, 0.35);
          if (p.hd != null) v.g.rotation.y = p.hd;
        }
        v.g.userData.light.material.color.set(Math.sin(now / 120) > 0 ? '#FF9F0A' : '#FFD60A');
      }
    },
  };
}

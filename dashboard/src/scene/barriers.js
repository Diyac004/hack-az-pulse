// Road barriers on blocked cells, keyed by "x,y". Pop in with overshoot; removed when unblocked.
import * as THREE from 'three';
import { lm } from './world.js';
import { cellKey } from '../lib/derive.js';

export function createBarriers(world, farm) {
  const { S } = world;
  const map = new Map();
  function make(x, y, animate) {
    const g = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.22, 0.08), lm('#FF453A')); a.position.y = 0.35;
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.085), lm('#ffffff')); b.position.y = 0.35;
    const l1 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.45, 0.06), lm('#3a3a3c')); l1.position.set(-0.3, 0.22, 0);
    const l2 = l1.clone(); l2.position.x = 0.3;
    g.add(a, b, l1, l2); g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    const p = farm.grid.toWorld(x, y);
    g.position.set(p.x, 0, p.z);
    if (farm.grid.rows.includes(y) && !farm.grid.cols.includes(x)) g.rotation.y = Math.PI / 2;
    g.scale.setScalar(animate ? 0.01 : 1);
    const rd = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshBasicMaterial({ color: '#FF453A', transparent: true, opacity: 0.55 }));
    rd.rotation.x = -Math.PI / 2; rd.position.set(p.x, 0.03, p.z);
    S.add(g, rd);
    return { g, rd, born: animate ? performance.now() : 0 };
  }
  const drop = (k) => { const r = map.get(k); if (!r) return; [r.g, r.rd].forEach((o) => { S.remove(o); o.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); }); }); map.delete(k); };
  return {
    /** cells: [[x,y]...]; returns newly added cells */
    sync(cells, initial) {
      if (!farm.grid) return [];
      const want = new Map(cells.map((c) => [cellKey(c[0], c[1]), c]));
      const added = [];
      for (const [k, c] of want) if (!map.has(k)) { map.set(k, make(c[0], c[1], !initial)); added.push(c); }
      for (const k of [...map.keys()]) if (!want.has(k)) drop(k);
      return added;
    },
    clear() { [...map.keys()].forEach(drop); },
    tick(now) {
      for (const r of map.values()) {
        if (!r.born) continue;
        const a = Math.min(1, (now - r.born) / 500), e = a === 1 ? 1 : 1 + Math.sin(a * Math.PI * 1.5) * 0.3 * (1 - a);
        r.g.scale.setScalar(Math.max(0.01, a * e)); if (a >= 1) r.born = 0;
      }
    },
  };
}

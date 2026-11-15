// Transient effects: ripple rings and smoke puffs.
// Pooled: every puff/ripple slot is a Mesh created once (shared geometry, one material per slot so
// opacity can differ) and recycled; nothing is allocated or disposed while the scene runs.
import * as THREE from 'three';

const MAX_SMOKE = 96, MAX_RIP = 24;

export function createFx(world) {
  const { S } = world;
  const smokeGeo = new THREE.SphereGeometry(0.12, 8, 6);
  const ripGeo = new THREE.RingGeometry(0.6, 0.75, 48);
  const smoke = [], rips = []; // slots: { m, born, live }

  function slot(pool, max, make) {
    let oldest = null;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (!s.live) return s;
      if (!oldest || s.born < oldest.born) oldest = s;
    }
    if (pool.length < max) { const s = { m: make(), born: 0, live: false }; s.m.visible = false; S.add(s.m); pool.push(s); return s; }
    return oldest; // pool full: recycle the oldest
  }
  const mkRip = () => { const m = new THREE.Mesh(ripGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, side: THREE.DoubleSide })); m.rotation.x = -Math.PI / 2; return m; };
  const mkSmoke = () => new THREE.Mesh(smokeGeo, new THREE.MeshLambertMaterial({ color: '#6e6e73', transparent: true, opacity: 0.7 }));
  const kill = (s) => { s.live = false; s.m.visible = false; };

  return {
    ripple(v, color) {
      const s = slot(rips, MAX_RIP, mkRip);
      s.m.material.color.set(color); s.m.material.opacity = 0.9; s.m.scale.setScalar(1);
      s.m.position.set(v.x, 0.05, v.z); s.m.visible = true; s.live = true; s.born = performance.now();
    },
    smoke(v) {
      const s = slot(smoke, MAX_SMOKE, mkSmoke);
      s.m.material.opacity = 0.7; s.m.scale.setScalar(1);
      s.m.position.set(v.x + (Math.random() - 0.5) * 0.2, 0.9, v.z + (Math.random() - 0.5) * 0.2); s.m.visible = true; s.live = true; s.born = performance.now();
    },
    /** Hide everything; the pool (and its GPU buffers) is kept for reuse. */
    clear() { rips.forEach(kill); smoke.forEach(kill); },
    tick(now, dt) {
      for (let i = 0; i < rips.length; i++) {
        const s = rips[i]; if (!s.live) continue;
        const a = (now - s.born) / 1000;
        s.m.scale.setScalar(1 + a * 5); s.m.material.opacity = Math.max(0, 0.9 - a * 0.75);
        if (a > 1.2) kill(s);
      }
      for (let i = 0; i < smoke.length; i++) {
        const s = smoke[i]; if (!s.live) continue;
        const a = (now - s.born) / 1000;
        s.m.position.y += dt * 0.7; s.m.scale.setScalar(1 + a * 1.6); s.m.material.opacity = Math.max(0, 0.7 - a * 0.35);
        if (a > 2) kill(s);
      }
    },
  };
}

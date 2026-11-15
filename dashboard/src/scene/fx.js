// Transient effects: ripple rings and smoke puffs.
import * as THREE from 'three';

export function createFx(world) {
  const { S } = world;
  const list = [];
  const smokeGeo = new THREE.SphereGeometry(0.12, 8, 6);
  return {
    ripple(v, color) {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.75, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2; m.position.set(v.x, 0.05, v.z); S.add(m); list.push({ m, born: performance.now(), type: 'rip' });
    },
    smoke(v) {
      const m = new THREE.Mesh(smokeGeo, new THREE.MeshLambertMaterial({ color: '#6e6e73', transparent: true, opacity: 0.7 }));
      m.position.set(v.x + (Math.random() - 0.5) * 0.2, 0.9, v.z + (Math.random() - 0.5) * 0.2); S.add(m); list.push({ m, born: performance.now(), type: 'smoke' });
    },
    clear() { list.splice(0).forEach((o) => { S.remove(o.m); if (o.type === 'rip') o.m.geometry.dispose(); o.m.material.dispose(); }); },
    tick(now, dt) {
      for (let i = list.length - 1; i >= 0; i--) {
        const o = list[i], a = (now - o.born) / 1000;
        if (o.type === 'rip') {
          o.m.scale.setScalar(1 + a * 5); o.m.material.opacity = Math.max(0, 0.9 - a * 0.75);
          if (a > 1.2) { S.remove(o.m); o.m.geometry.dispose(); o.m.material.dispose(); list.splice(i, 1); }
        } else {
          o.m.position.y += dt * 0.7; o.m.scale.setScalar(1 + a * 1.6); o.m.material.opacity = Math.max(0, 0.7 - a * 0.35);
          if (a > 2) { S.remove(o.m); o.m.material.dispose(); list.splice(i, 1); }
        }
      }
    },
  };
}

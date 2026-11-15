// Sensitive areas next to blocks (scenario.sensitive: canal, houses, apiary) with a soft red downwind glow.
// Built once per scenario layout from shared geometries; each area owns one glow material + one label texture,
// all disposed on rebuild. tick() only changes material opacity/colour (no allocation).
import * as THREE from 'three';
import { bearingVec } from '../lib/derive.js';

const RED = new THREE.Color('#FF453A');
const NAME = { canal: 'Canal', houses: 'Houses', apiary: 'Apiary' };

function labelCanvas(text) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(160,24,18,.86)';
  g.beginPath(); g.roundRect ? g.roundRect(4, 8, 248, 48, 24) : g.rect(4, 8, 248, 48); g.fill();
  g.fillStyle = '#fff'; g.font = '600 26px -apple-system,BlinkMacSystemFont,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 33);
  return c;
}

export function createSensitive(world) {
  const { S } = world;
  let group = null, recs = [], sig = '';
  // shared, created once
  const plane = new THREE.PlaneGeometry(1, 1);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const roof = new THREE.ConeGeometry(0.72, 0.4, 4).rotateY(Math.PI / 4);
  const mats = {
    water: new THREE.MeshLambertMaterial({ color: '#4FA3D9', emissive: '#0b3a5c', emissiveIntensity: 0.35 }),
    bank: new THREE.MeshLambertMaterial({ color: '#C8B48A' }),
    wall: new THREE.MeshLambertMaterial({ color: '#F2EDE4' }),
    roof: new THREE.MeshLambertMaterial({ color: '#B4553F' }),
    hive: new THREE.MeshLambertMaterial({ color: '#F2C14E' }),
  };

  function clear() {
    if (!group) return;
    S.remove(group);
    for (const r of recs) { r.glowMat.dispose(); r.label.material.map.dispose(); r.label.material.dispose(); }
    group = null; recs = [];
  }

  function build(grid, areas) {
    clear();
    group = new THREE.Group();
    for (const a of areas) {
      const b = grid.blockById[a.block]; if (!b) continue;
      const c = grid.blockCenter(b), wc = grid.toWorld(c.x, c.y), v = bearingVec(a.dir_deg);
      const ew = Math.abs(v.x) > Math.abs(v.z); // east/west side: the strip runs north-south
      const halfOut = ew ? b.w / 2 + 0.2 : b.h / 2 + 0.2;
      const len = ew ? b.h + 0.4 : b.w + 0.4;
      const ox = wc.x + v.x * (halfOut + 0.32), oz = wc.z + v.z * (halfOut + 0.32);
      const g = new THREE.Group(); g.position.set(ox, 0, oz); if (ew) g.rotation.y = Math.PI / 2;
      // glow: soft red wash over the downwind edge of the block, faded by opacity
      const glowMat = new THREE.MeshBasicMaterial({ color: RED, transparent: true, opacity: 0, depthWrite: false });
      const glow = new THREE.Mesh(plane, glowMat); // world-placed: straddles the block's downwind edge
      glow.rotation.x = -Math.PI / 2; glow.scale.set(ew ? 1.7 : len, ew ? len : 1.7, 1);
      glow.position.set(wc.x + v.x * (halfOut - 0.1), 0.045, wc.z + v.z * (halfOut - 0.1)); glow.renderOrder = 2;
      group.add(glow);
      const what = String(a.what || '').toLowerCase();
      if (what.includes('canal')) {
        const bank = new THREE.Mesh(plane, mats.bank); bank.rotation.x = -Math.PI / 2; bank.scale.set(len, 0.5, 1); bank.position.y = 0.025; g.add(bank);
        const water = new THREE.Mesh(plane, mats.water); water.rotation.x = -Math.PI / 2; water.scale.set(len, 0.3, 1); water.position.y = 0.03; g.add(water);
      } else if (what.includes('house')) {
        for (let i = -1; i <= 1; i++) {
          const h = new THREE.Group(); h.position.set(i * 1.25, 0, 0);
          const wall = new THREE.Mesh(box, mats.wall); wall.scale.set(0.6, 0.38, 0.5); wall.position.y = 0.19;
          const rf = new THREE.Mesh(roof, mats.roof); rf.scale.set(0.62, 0.7, 0.52); rf.position.y = 0.52;
          wall.castShadow = rf.castShadow = true; h.add(wall, rf); g.add(h);
        }
      } else {
        for (let i = -1; i <= 1; i++) { const hv = new THREE.Mesh(box, mats.hive); hv.scale.set(0.22, 0.26, 0.22); hv.position.set(i * 0.5, 0.13, 0); hv.castShadow = true; g.add(hv); }
      }
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(labelCanvas((NAME[what] || a.what) + ' · downwind')), depthTest: false, transparent: true, opacity: 0 }));
      label.center.set(0.5, 0); label.scale.set(1.6, 0.4, 1); label.position.y = 0.9; label.renderOrder = 11; label.visible = false;
      g.add(label);
      group.add(g);
      recs.push({ key: a.block + '|' + a.what, glowMat, label, level: 0, goal: 0 });
    }
    S.add(group);
  }

  return {
    clear() { clear(); sig = ''; },
    /** areas: derive.sensitiveState(state) */
    sync(grid, areas) {
      if (!grid) return;
      const s = grid.w + 'x' + grid.h + JSON.stringify((areas || []).map((a) => [a.block, a.what, a.dir_deg])) + JSON.stringify(grid.blocks.map((b) => [b.id, b.x, b.y, b.w, b.h]));
      if (s !== sig) { sig = s; build(grid, areas || []); }
      for (const r of recs) {
        const a = (areas || []).find((x) => x.block + '|' + x.what === r.key);
        r.goal = !a ? 0 : a.active ? 1 : a.toward ? 0.45 : 0;
      }
    },
    tick(now, dt) {
      for (const r of recs) {
        r.level += (r.goal - r.level) * (1 - Math.exp(-dt * 4));
        const pulse = r.goal >= 1 ? 0.75 + 0.25 * Math.sin(now / 320) : 1;
        r.glowMat.opacity = 0.42 * r.level * pulse;
        r.label.visible = r.level > 0.6;
        r.label.material.opacity = Math.max(0, (r.level - 0.6) / 0.4);
      }
    },
  };
}

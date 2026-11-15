// Island diorama built from scenario: ground, roads, block patches, instanced trees + fruit, depot shed.
import * as THREE from 'three';
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { lm } from './world.js';

// One footprint per block, in grid cells: cells b.x..b.x+w-1 -> world edges toWorld(b.x-0.5) .. toWorld(b.x+w-0.5).
// Soil bed, grass, trees and the label all derive from it (blockCenter + b.w/b.h), never from the road layout.
// Blocks sit flush between column roads (road half-width 0.4 -> 0.1 of gap), so every layer stays inside +0.08.
// The soil bed is a flat FRAME around the grass (no overlap), both at the old patch height (0.02 over the
// island), so nothing new stacks coplanar and no other ground layer gets buried.
const BED_PAD = 0.08, GROUND_Y = 0.02, GRASS_INSET = 0.1;
function frameGeo(cx, cz, ow, oh, iw, ih) { // rectangle ring in the XZ plane, facing up
  const sh = new THREE.Shape(); sh.moveTo(-ow / 2, -oh / 2); sh.lineTo(ow / 2, -oh / 2); sh.lineTo(ow / 2, oh / 2); sh.lineTo(-ow / 2, oh / 2); sh.closePath();
  const hole = new THREE.Path(); hole.moveTo(-iw / 2, -ih / 2); hole.lineTo(-iw / 2, ih / 2); hole.lineTo(iw / 2, ih / 2); hole.lineTo(iw / 2, -ih / 2); hole.closePath();
  sh.holes.push(hole);
  return new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2).translate(cx, GROUND_Y, cz);
}

function rng(seed) { // mulberry32, deterministic trees
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const disposeTree = (o) => o.traverse((c) => {
  if (c.geometry) c.geometry.dispose();
  if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
});

export function createFarm(world) {
  const { S } = world;
  let group = null, patches = {}, ripe = {}, grid = null;
  let heat = new Set();

  function build(g) {
    if (group) { S.remove(group); disposeTree(group); }
    grid = g; patches = {}; ripe = {};
    group = new THREE.Group();
    const W = (x, y) => { const p = g.toWorld(x, y); return new THREE.Vector3(p.x, 0, p.z); };

    const side = lm('#A3865C');
    const isl = new THREE.Mesh(new THREE.BoxGeometry(g.w + 1, 1.4, g.h + 1), [side, side, lm('#D9C49B'), side, side, side]);
    isl.position.y = -0.7; isl.receiveShadow = true; group.add(isl);

    const rdm = lm('#EEE2C6');
    g.rows.forEach((y) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(g.w, 0.8), rdm); m.rotation.x = -Math.PI / 2; m.position.set(0, 0.01, W(0, y).z); m.receiveShadow = true; group.add(m); });
    g.cols.forEach((x) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(0.8, g.h), rdm); m.rotation.x = -Math.PI / 2; m.position.set(W(x, 0).x, 0.012, 0); m.receiveShadow = true; group.add(m); });

    const cells = [], beds = [];
    g.blocks.forEach((b) => {
      const c = g.blockCenter(b), cw = W(c.x, c.y);
      // tilled soil rim = the block's imprint, framing the grass on the same footprint
      beds.push(frameGeo(cw.x, cw.z, b.w + BED_PAD * 2, b.h + BED_PAD * 2, b.w - GRASS_INSET * 2, b.h - GRASS_INSET * 2));
      const m = new THREE.Mesh(new THREE.PlaneGeometry(b.w - GRASS_INSET * 2, b.h - GRASS_INSET * 2), new THREE.MeshLambertMaterial({ color: '#86A257', emissive: '#000000' }));
      m.rotation.x = -Math.PI / 2; m.position.set(cw.x, GROUND_Y, cw.z); m.receiveShadow = true; group.add(m); patches[b.id] = m;
      ripe[b.id] = b.ripeness;
      for (let i = 0; i < b.w; i++) for (let j = 0; j < b.h; j++) cells.push([b, b.x + i, b.y + j]);
    });
    if (beds.length) {
      // all beds: one draw
      const bm = lm('#9C7A52');
      const bed = new THREE.Mesh(BufferGeometryUtils.mergeBufferGeometries(beds), bm);
      beds.forEach((x) => x.dispose());
      bed.receiveShadow = true; bed.name = 'soilBeds'; group.add(bed);
    }

    const rnd = rng(1337 + g.w * 31 + g.h);
    const fruitPer = (b) => (b.ripeness >= 0.6 ? Math.min(4, Math.round((b.ripeness - 0.45) * 8)) : 0);
    const fruitCount = cells.reduce((a, [b]) => a + fruitPer(b), 0);
    const can = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.34, 0), new THREE.MeshLambertMaterial({ color: '#ffffff' }), Math.max(1, cells.length));
    const trk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.07, 0.4, 6), lm('#6B4F33'), Math.max(1, cells.length));
    const fru = new THREE.InstancedMesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshLambertMaterial({ color: '#FF8A1F', emissive: '#7a2e00' }), Math.max(1, fruitCount));
    can.count = cells.length; trk.count = cells.length; fru.count = fruitCount;
    const dm = new THREE.Object3D(), col = new THREE.Color(); let fi = 0;
    cells.forEach(([b, x, y], i) => {
      const p = W(x, y), s = 0.85 + rnd() * 0.3;
      dm.position.set(p.x, 0.2, p.z); dm.scale.set(1, 1, 1); dm.rotation.set(0, 0, 0); dm.updateMatrix(); trk.setMatrixAt(i, dm.matrix);
      dm.position.y = 0.58; dm.scale.set(s, s * 0.9, s); dm.rotation.y = rnd() * 3; dm.updateMatrix(); can.setMatrixAt(i, dm.matrix);
      col.set('#4E7A2C').offsetHSL((rnd() - 0.5) * 0.04, 0, (rnd() - 0.5) * 0.08); can.setColorAt(i, col);
      for (let f = 0; f < fruitPer(b); f++) {
        const a = rnd() * 6.28, e = rnd() * 1.2 - 0.3;
        dm.position.set(p.x + Math.cos(a) * 0.3 * s, 0.58 + Math.sin(e) * 0.28, p.z + Math.sin(a) * 0.3 * s);
        dm.scale.set(1, 1, 1); dm.rotation.set(0, 0, 0); dm.updateMatrix(); fru.setMatrixAt(fi++, dm.matrix);
      }
    });
    can.castShadow = trk.castShadow = true; can.receiveShadow = true;
    group.add(can, trk, fru);

    // Depot shed next to the depot cell (south-east of it, off the road)
    const shed = new THREE.Group();
    const sb = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 1), lm('#E9E4DA')); sb.position.y = 0.4;
    const rf = new THREE.Mesh(new THREE.ConeGeometry(1.15, 0.5, 4), lm('#C2463A')); rf.position.y = 1.05; rf.rotation.y = Math.PI / 4; rf.scale.z = 0.7;
    shed.add(sb, rf); shed.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const sp = W(g.depot.x + 1.5, g.depot.y + 1.8); shed.position.set(sp.x, 0, sp.z); group.add(shed);

    S.add(group);
    world.setSpan(g.span);
  }

  return {
    build,
    get grid() { return grid; },
    setHeat(blocks) { heat = new Set(blocks || []); },
    tick(now) {
      for (const id in patches) {
        const m = patches[id].material;
        if (heat.has(id)) { m.emissive.set('#FF4A10'); m.emissiveIntensity = 0.18 + 0.18 * Math.sin(now / 260); }
        else if (ripe[id] >= 0.7) { m.emissive.set('#FF7A1A'); m.emissiveIntensity = 0.22 * Math.min(1, (ripe[id] - 0.6) * 3.3); }
        else { m.emissive.set('#000000'); m.emissiveIntensity = 1; }
      }
    },
  };
}

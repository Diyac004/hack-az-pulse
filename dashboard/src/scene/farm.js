// Island diorama built from scenario: ground, roads, block patches (shared ground textures), orchard (orchard.js), depot fleet hub.
import * as THREE from 'three';
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { lm } from './world.js';
import { createDepotHub } from './depotHub.js';
import { createOrchard, GRASS_INSET } from './orchard.js';
import { createGroundTextures } from './groundTexture.js';

// One footprint per block, in grid cells: cells b.x..b.x+w-1 -> world edges toWorld(b.x-0.5) .. toWorld(b.x+w-0.5).
// Soil bed, grass, trees and the label all derive from it (blockCenter + b.w/b.h), never from the road layout.
// Blocks sit flush between column roads (road half-width 0.4 -> 0.1 of gap), so every layer stays inside +0.08.
// The soil bed is a flat FRAME around the grass (no overlap), both at the old patch height (0.02 over the
// island), so nothing new stacks coplanar and no other ground layer gets buried.
const BED_PAD = 0.08, GROUND_Y = 0.02; // GRASS_INSET (0.1) lives in orchard.js
function frameGeo(cx, cz, ow, oh, iw, ih) { // rectangle ring in the XZ plane, facing up
  const sh = new THREE.Shape(); sh.moveTo(-ow / 2, -oh / 2); sh.lineTo(ow / 2, -oh / 2); sh.lineTo(ow / 2, oh / 2); sh.lineTo(-ow / 2, oh / 2); sh.closePath();
  const hole = new THREE.Path(); hole.moveTo(-iw / 2, -ih / 2); hole.lineTo(-iw / 2, ih / 2); hole.lineTo(iw / 2, ih / 2); hole.lineTo(iw / 2, -ih / 2); hole.closePath();
  sh.holes.push(hole);
  return new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2).translate(cx, GROUND_Y, cz);
}

const disposeTree = (o) => o.traverse((c) => {
  if (c.geometry) c.geometry.dispose();
  if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); }); // shared ground maps: disposed again by tex.dispose(), harmless
});

export function createFarm(world) {
  const { S } = world;
  let group = null, patches = {}, ripe = {}, grid = null, orchard = null, heatKey = null;
  let heat = new Set();
  const tex = createGroundTextures(); // shared ground textures, one per block size + variant

  // heat variant of the ground texture (drier grass, paler berms) swapped in only when the heat set changes;
  // both variants have a map, so the swap needs no shader rebuild
  function applyGround() {
    const key = [...heat].sort().join(',');
    if (key === heatKey) return; heatKey = key;
    for (const id in patches) { const p = patches[id], [w, h] = p.userData.size; p.material.map = tex.get(w, h, heat.has(id) ? 'heat' : 'normal'); }
  }

  function build(g) {
    if (group) { S.remove(group); disposeTree(group); tex.dispose(); }
    grid = g; patches = {}; ripe = {}; orchard = null; heatKey = null;
    group = new THREE.Group();
    const W = (x, y) => { const p = g.toWorld(x, y); return new THREE.Vector3(p.x, 0, p.z); };

    const side = lm('#A3865C');
    const isl = new THREE.Mesh(new THREE.BoxGeometry(g.w + 1, 1.4, g.h + 1), [side, side, lm('#D9C49B'), side, side, side]);
    isl.position.y = -0.7; isl.receiveShadow = true; group.add(isl);

    const rdm = lm('#EEE2C6');
    g.rows.forEach((y) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(g.w, 0.8), rdm); m.rotation.x = -Math.PI / 2; m.position.set(0, 0.01, W(0, y).z); m.receiveShadow = true; group.add(m); });
    g.cols.forEach((x) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(0.8, g.h), rdm); m.rotation.x = -Math.PI / 2; m.position.set(W(x, 0).x, 0.012, 0); m.receiveShadow = true; group.add(m); });

    const beds = [];
    g.blocks.forEach((b) => {
      const c = g.blockCenter(b), cw = W(c.x, c.y);
      // tilled soil rim = the block's imprint, framing the grass on the same footprint
      beds.push(frameGeo(cw.x, cw.z, b.w + BED_PAD * 2, b.h + BED_PAD * 2, b.w - GRASS_INSET * 2, b.h - GRASS_INSET * 2));
      // grass plane carries the shared ground texture (stripes, berms, wet strips, drip lines, AO, tram lines)
      const m = new THREE.Mesh(new THREE.PlaneGeometry(b.w - GRASS_INSET * 2, b.h - GRASS_INSET * 2), new THREE.MeshLambertMaterial({ map: tex.get(b.w, b.h), emissive: '#000000' }));
      m.rotation.x = -Math.PI / 2; m.position.set(cw.x, GROUND_Y, cw.z); m.receiveShadow = true; group.add(m); patches[b.id] = m;
      m.userData.size = [b.w, b.h];
      ripe[b.id] = b.ripeness;
    });
    if (beds.length) {
      // all beds: one draw
      const bm = lm('#9C7A52');
      const bed = new THREE.Mesh(BufferGeometryUtils.mergeBufferGeometries(beds), bm);
      beds.forEach((x) => x.dispose());
      bed.receiveShadow = true; bed.name = 'soilBeds'; group.add(bed);
    }

    // Orchard (direction A + B's touches): instanced trees + one static mesh of tufts and row-end posts.
    orchard = createOrchard(g);
    orchard.meshes.forEach((m) => group.add(m));
    orchard.setHeat(heat); applyGround();

    // Depot: "Fleet hub" (refuel + service bays under a solar canopy, control building, mast) in the
    // off-road strip beside the depot's road row, facing that road; placement is derived from the scenario.
    group.add(createDepotHub(g));

    S.add(group);
    world.setSpan(g.span);
  }

  return {
    build,
    get grid() { return grid; },
    setHeat(blocks) { heat = new Set(blocks || []); if (orchard) orchard.setHeat(heat); applyGround(); },
    tick(now) {
      for (const id in patches) {
        const m = patches[id].material;
        if (heat.has(id)) { m.emissive.set('#FF4A10'); m.emissiveIntensity = 0.18 + 0.18 * Math.sin(now / 260); }
        else if (ripe[id] >= 0.7) { m.emissive.set('#FF7A1A'); m.emissiveIntensity = 0.15; } // index.html states: ripe at 0.15
        else { m.emissive.set('#000000'); m.emissiveIntensity = 1; }
      }
    },
  };
}

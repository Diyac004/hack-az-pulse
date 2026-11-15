// Block ground texture, direction A + B's touches (trees.mjs ground('AB', state)): mowed grass middles striped
// along the work direction, bare berms under the tree rows with a dark wet strip and the drip line, soft
// contact shadows under every tree, and B's bare twin tram lines in every sweep lane (lane +-0.24, tractor A's
// wheel track at scene scale 0.85). One CanvasTexture per block size and variant ('normal' | 'heat'), shared by
// every block of that size and mapped onto the block's existing grass plane (which covers the footprint minus
// GRASS_INSET); ripe and the heat pulse stay emissive on the grass material (farm.js tick()).
// Colours are written as-is: the renderer has no output encoding, like every lm() colour in the scene.
import * as THREE from 'three';
import { blockLayout, GRASS_INSET, P, mix } from './orchard.js';

const TEX = 512; // POT, any block size (stretched)
const hex = (c) => '#' + c.getHexString();

/** Paint one block-size variant into a canvas. Pure 2D canvas; coordinates are block-local cells. */
export function paintBlockGround(w, h, variant = 'normal') {
  const cv = document.createElement('canvas'); cv.width = TEX; cv.height = TEX;
  const c = cv.getContext('2d');
  const L = blockLayout(w, h), gi = GRASS_INSET, gw = w - 2 * gi, gh = h - 2 * gi;
  const kx = TEX / gw, kz = TEX / gh;
  const X = (x) => (x - gi) * kx, Z = (z) => (z - gi) * kz; // canvas top = north edge (flipY maps it to -z)
  const rect = (x0, x1, z0, z1, fill, op = 1) => { c.globalAlpha = op; c.fillStyle = fill; c.fillRect(X(x0), Z(z0), (x1 - x0) * kx, (z1 - z0) * kz); c.globalAlpha = 1; };
  const heat = variant === 'heat';
  // heat: drier grass (trees.mjs STATE.heat mixes 30 % #B5A35A in; the orange glow is emissive), paler berms
  const G = heat ? hex(mix(P.grass, '#B5A35A', 0.3)) : P.grass, GL = heat ? hex(mix(P.grassLight, '#B5A35A', 0.3)) : P.grassLight;
  const berm = heat ? hex(mix(P.berm, '#B89A6A', 0.4)) : P.berm, wet = heat ? hex(mix(P.wet, P.berm, 0.6)) : P.wet;
  const x0 = gi, x1 = w - gi, z0 = gi, z1 = h - gi;

  rect(x0, x1, z0, z1, G);
  // mowed stripes: the north half of every alley is the light pass; headland and south margin light too
  L.lanes.forEach((ln, k) => {
    const from = k === 0 ? z0 : L.rows[k - 1] + 0.25;
    rect(x0, x1, Math.max(z0, from), k === 0 ? Math.max(z0, L.rows[0] - 0.25) : ln, GL);
  });
  const last = L.rows[L.rows.length - 1] + 0.25;
  if (last < z1) rect(x0, x1, last, z1, GL);
  // berms (bare herbicide strip), dark wet band under the drip line, the drip line itself
  for (const rz of L.rows) {
    rect(x0 + 0.04, x1 - 0.04, rz - 0.25, rz + 0.25, berm);
    rect(x0 + 0.06, x1 - 0.06, rz - 0.12, rz + 0.16, wet, 0.85);
    rect(x0 + 0.06, x1 - 0.06, rz + 0.11, rz + 0.122, P.drip, 0.8);
  }
  // soft contact shadows (trees.mjs AO disc 0.36 x 0.27, #1A1A0E at 0.42), radial falloff
  L.rows.forEach((rz, ri) => L.xs.forEach((tx, i) => {
    const s = ri === L.young.row && i === L.young.i ? 0.55 : 1;
    c.save(); c.translate(X(tx), Z(rz)); c.scale(0.36 * s * kx, 0.27 * s * kz);
    const gr = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    gr.addColorStop(0, 'rgba(26,26,14,0.5)'); gr.addColorStop(0.55, 'rgba(26,26,14,0.36)'); gr.addColorStop(1, 'rgba(26,26,14,0)');
    c.fillStyle = gr; c.beginPath(); c.arc(0, 0, 1, 0, Math.PI * 2); c.fill(); c.restore();
  }));
  // B's twin tram lines along every sweep lane, full grass length; the one outside the grass is dropped
  for (const ln of L.lanes) for (const d of [-0.24, 0.24]) {
    const z = ln + d; if (z < z0 + 0.02 || z > z1 - 0.02) continue;
    rect(x0, x1, z - 0.035, z + 0.035, P.tilledDark, 0.85);
  }
  return cv;
}

/** Texture cache for one farm build: get(w, h, variant) -> shared CanvasTexture; dispose() frees them all. */
export function createGroundTextures() {
  const cache = new Map();
  return {
    get(w, h, variant = 'normal') {
      const key = `${w}x${h}:${variant}`;
      let t = cache.get(key);
      if (!t) {
        t = new THREE.CanvasTexture(paintBlockGround(w, h, variant));
        t.anisotropy = 8; // clamped to the GPU max by the renderer
        cache.set(key, t);
      }
      return t;
    },
    get size() { return cache.size; },
    dispose() { cache.forEach((t) => t.dispose()); cache.clear(); },
  };
}

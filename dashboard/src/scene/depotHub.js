// Depot "Fleet hub" (direction B from textures/index.html#house): solar canopy over two bays, a small
// control building and a comms mast. Part list and dimensions are copied 1:1 from
// textures/_build/houses.mjs (houses.B), with one deliberate change: tractor A is diesel, so the two bays are
// a REFUEL bay (fuel pump bollard + hose, amber bay stripe) and a SERVICE bay (tool chest + air/oil reel,
// grey stripe) instead of EV chargers. The canopy, control building and mast are unchanged.
// Model space: 1 unit = 1 grid cell, x east, y up, +z = front (bays open toward +z).
// Every face is emitted as flat, non-indexed triangles with a vertex colour (decals pre-blended) into ONE
// geometry, drawn with one Lambert material: 1 draw call (+1 in the shadow pass).
import * as THREE from 'three';
import { M, hexa, box, beam, cylY, glass, panels, createBuilder } from './lowpoly.js';

const H = { wall: '#ECEAE5', concrete: '#D6D2C9', roof: '#4A4D52', soffit: '#F2F2F7', pump: '#E5E5EA', fuel: '#FF9F0A', service: '#8E8E93', chest: '#C2463A' };
const BODY = '#0A84FF'; // concept 'body' (fleet colour) -> fixed fleet blue on the canopy fascia and roof trim

// ---------- houses.B part list ----------
const PAD = { x0: -1.65, x1: 1.55, z0: -0.72, z1: 0.78 }; // footprint, used by hubPlacement
/** Top-down footprint in model space (same numbers as partsB), for the Map view's aerial (liveBasemap.js). */
export const HUB_PLAN = {
  pad: PAD,
  canopy: { x0: -1.58, x1: 0.78, z0: -0.7, z1: 0.68 },
  control: { x0: 0.83, x1: 1.51, z0: -0.53, z1: 0.45 }, // control roof
  mast: { x: 1.32, z: -0.28, r: 0.05 },
  bays: [{ x0: -1.426, x1: -0.45, fill: H.fuel }, { x0: -0.338, x1: 0.622, fill: H.service }], // front apron stripes
  colors: { concrete: H.concrete, roof: H.roof, solar: '#1F3550', solarLine: '#4A6A8C', fascia: BODY, light: M.light },
};
const lineU = (x) => { const u = (x - PAD.x0) / (PAD.x1 - PAD.x0); return { face: 'top', uv: [[u - 0.004, 0.08], [u + 0.004, 0.08], [u + 0.004, 0.9], [u - 0.004, 0.9]], fill: '#fff', op: 0.85 }; };
const post = (x, z) => box(x - 0.025, x + 0.025, 0.02, 0.82, z - 0.025, z + 0.025, M.chassis, { name: 'post' });

// Decision 3 (index.html): keep the depth squash (a) and push the pump and the service gear to the back of the
// pad so a tractor nosed in sits further from road 6. The pad's back edge (z -0.72) allows 0.09 model
// (0.054 world at sz 0.6), not the full 0.16 world the decision asks for; that would leave the pad.
const BACK = 0.09;
// refuel bay (x = -0.94): pump bollard where the concept's charger stood, hose to the bay
const refuel = (x) => [
  box(x - 0.07, x + 0.07, 0.02, 0.44, -0.62 - BACK, -0.52 - BACK, H.pump, { name: 'pump', decals: [
    { face: 'front', uv: [[0.18, 0.58], [0.82, 0.58], [0.82, 0.85], [0.18, 0.85]], fill: M.glass }, // price display
    { face: 'front', uv: [[0, 0.9], [1, 0.9], [1, 1], [0, 1]], fill: H.fuel }, // fuel band
    { face: 'front', uv: [[0.3, 0.3], [0.7, 0.3], [0.7, 0.46], [0.3, 0.46]], fill: M.grille }, // nozzle holster
  ] }),
  beam([x + 0.05, 0.3, -0.52 - BACK], [x + 0.12, 0.03, -0.38 - BACK], 0.02, 0.02, M.grille, { name: 'hose' }),
];
// service bay (x = 0.14): red tool chest + an air/oil hose reel post in the charger's place
const service = (x) => [
  box(x - 0.09, x + 0.09, 0.02, 0.3, -0.71, -0.59, H.chest, { name: 'toolchest', decals: [
    { face: 'front', uv: [[0.08, 0.3], [0.92, 0.3], [0.92, 0.34], [0.08, 0.34]], fill: '#000', op: 0.35 },
    { face: 'front', uv: [[0.08, 0.6], [0.92, 0.6], [0.92, 0.64], [0.08, 0.64]], fill: '#000', op: 0.35 },
  ] }),
  box(x + 0.14, x + 0.18, 0.02, 0.46, -0.62 - BACK, -0.58 - BACK, M.metal, { name: 'reelpost' }),
  cylY([x + 0.16, 0.38, -0.55 - BACK], 0.045, 0.04, 8, H.service, { name: 'reel' }),
];

function partsB() {
  return [
    box(PAD.x0, PAD.x1, 0, 0.02, PAD.z0, PAD.z1, H.concrete, { name: 'pad', decals: [lineU(-1.48), lineU(-0.4), lineU(0.68),
      { face: 'top', uv: [[0.06, 0.82], [0.36, 0.82], [0.36, 0.9], [0.06, 0.9]], fill: H.fuel, op: 0.6 }, // refuel bay stripe
      { face: 'top', uv: [[0.4, 0.82], [0.7, 0.82], [0.7, 0.9], [0.4, 0.9]], fill: H.service, op: 0.6 }, // service bay stripe
      // bay-entry stripes on the front apron: the pump/chest sit under the canopy, these read from the home camera
      { face: 'top', uv: [[0.07, 0.02], [0.375, 0.02], [0.375, 0.09], [0.07, 0.09]], fill: H.fuel, op: 0.9 },
      { face: 'top', uv: [[0.41, 0.02], [0.71, 0.02], [0.71, 0.09], [0.41, 0.09]], fill: H.service, op: 0.9 },
    ] }),
    ...[-1.48, -0.4, 0.68].flatMap((x) => [post(x, -0.62), post(x, 0.6)]),
    box(-1.58, 0.78, 0.82, 0.88, -0.7, 0.68, H.roof, { name: 'canopy', mats: { front: BODY, bottom: H.soffit }, decals: [...panels('top', 0.04, 0.96, 0.08, 0.92, 6, 3),
      // bay signs on the fleet-blue fascia: amber = refuel (left bay), white-grey = service (right bay)
      { face: 'front', uv: [[0.17, 0.12], [0.37, 0.12], [0.37, 0.88], [0.17, 0.88]], fill: H.fuel },
      { face: 'front', uv: [[0.63, 0.12], [0.83, 0.12], [0.83, 0.88], [0.63, 0.88]], fill: '#E5E5EA' },
    ] }),
    ...refuel(-0.94), ...service(0.14),
    box(0.86, 1.48, 0.02, 0.62, -0.5, 0.42, H.wall, { name: 'control', decals: [
      ...glass('front', 0.08, 0.92, 0.48, 0.86),
      { face: 'front', uv: [[0.62, 0], [0.82, 0], [0.82, 0.42], [0.62, 0.42]], fill: M.chassis },
      ...glass('right', 0.1, 0.9, 0.48, 0.86),
      ...glass('left', 0.1, 0.9, 0.48, 0.86),
    ] }),
    box(0.83, 1.51, 0.62, 0.68, -0.53, 0.45, H.roof, { name: 'controlRoof', mats: { front: BODY, right: BODY } }),
    box(1.3, 1.34, 0.68, 1.22, -0.3, -0.26, M.metal, { name: 'mast' }),
    cylY([1.32, 1.25, -0.28], 0.05, 0.05, 10, M.light, { name: 'mastTop' }),
    cylY([1.32, 1.29, -0.28], 0.018, 0.03, 6, M.amber, { name: 'mastLamp' }),
  ];
}

/** One merged, vertex-coloured, flat-shaded geometry (~300 tris). */
export function buildHubGeometry() { return createBuilder().add(partsB()).toGeometry(); }

/**
 * Where the hub goes, from scenario data only (grid units; pure, Node-safe).
 * It sits in the off-road strip beside the depot's road row, between the column roads around the depot,
 * facing that road. North of the road it faces +z (road and camera); south of it, it is turned 180 deg.
 * Full size (1:1 with the concept) when the strip is deep enough. When it is too shallow, only the DEPTH is
 * compressed (sz); width/height stay at >= 0.85 (tractor A's scene scale) so the canopy never ends up
 * lower than a tractor parked in front of it.
 * @returns {{x:number, y:number, ry:number, sw:number, sz:number, side:'north'|'south', depth:number}} x,y = grid coords of the model origin
 */
export function hubPlacement(g, { roadHalf = 0.4, bedPad = 0.08, margin = 0.06 } = {}) {
  const d = g.depot;
  const row = g.rows.length ? g.rows.reduce((a, r) => (Math.abs(r - d.y) < Math.abs(a - d.y) ? r : a), g.rows[0]) : d.y;
  const left = g.cols.filter((c) => c <= d.x), right = g.cols.filter((c) => c > d.x);
  const segL = left.length ? Math.max(...left) + roadHalf : -1, segR = right.length ? Math.min(...right) - roadHalf : g.w;
  const inSeg = (b) => b.x - 0.5 < segR && b.x + b.w - 0.5 > segL;
  const otherRows = (dir) => g.rows.filter((r) => (dir < 0 ? r < row : r > row));
  // north strip: from the nearest block bed / road / island edge above the road down to the road edge
  const nTop = Math.max(-1, ...g.blocks.filter((b) => inSeg(b) && b.y + b.h - 0.5 <= row).map((b) => b.y + b.h - 0.5 + bedPad), ...otherRows(-1).map((r) => r + roadHalf));
  const sBot = Math.min(g.h, ...g.blocks.filter((b) => inSeg(b) && b.y - 0.5 >= row).map((b) => b.y - 0.5 - bedPad), ...otherRows(1).map((r) => r - roadHalf));
  const north = { side: 'north', a: nTop, b: row - roadHalf, ry: 0 };
  const south = { side: 'south', a: row + roadHalf, b: sBot, ry: Math.PI };
  const dn = north.b - north.a, ds = south.b - south.a;
  const pick = dn >= ds * 0.9 ? north : south; // prefer the side that faces the camera unless clearly shallower
  const depth = pick.b - pick.a, padD = PAD.z1 - PAD.z0, padW = PAD.x1 - PAD.x0;
  const widthFit = Math.min(1, (segR - segL - 2 * margin) / padW);
  const sz = Math.max(0.4, Math.min(1, (depth - 2 * margin) / padD, widthFit));
  const sw = Math.min(widthFit, Math.max(sz, 0.85));
  const flip = pick.ry ? -1 : 1;
  // x: put the refuel bay (model x -0.94) in front of the depot cell, clamped inside the column segment
  const lo = flip > 0 ? -PAD.x0 * sw : PAD.x1 * sw, hi = flip > 0 ? PAD.x1 * sw : -PAD.x0 * sw;
  const x = Math.min(segR - margin - hi, Math.max(segL + margin + lo, d.x + 0.94 * sw * flip));
  const y = (pick.a + pick.b) / 2 - flip * ((PAD.z0 + PAD.z1) / 2) * sz;
  return { x, y, ry: pick.ry, sw, sz, side: pick.side, depth };
}

/** Mesh for the scene (caller adds it to a group that disposes geometry/material on rebuild). */
export function createDepotHub(g) {
  const p = hubPlacement(g), w = g.toWorld(p.x, p.y);
  const mesh = new THREE.Mesh(buildHubGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = 'depotHub';
  mesh.position.set(w.x, 0, w.z); mesh.rotation.y = p.ry; mesh.scale.set(p.sw, p.sw, p.sz);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false; mesh.updateMatrix();
  mesh.userData.placement = p;
  return mesh;
}

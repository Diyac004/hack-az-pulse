// Neighbour houses: house direction A "Modern machine shed" from textures/_build/houses.mjs (houses.A), part list
// copied 1:1 (standing-seam gable roof with solar, roll-up door, glass office annex, downpipe). Built small
// (~0.38x) so they read as neighbouring buildings next to a block. At that size the finest decals would only
// shimmer, so the roof has 6 seams instead of 12 and the roll-up door 4 slats instead of 7; everything else matches.
// The concept's fleet-colour 'body' trim (eave fascia, office roof edge) becomes a per-house trim colour.
import { M, hexa, box, cylY, glass, panels } from './lowpoly.js';

const H = { wall: '#ECEAE5', wallDark: '#D9D6CF', concrete: '#D6D2C9', roof: '#4A4D52', seam: '#6F747B', door: '#9A9AA0' };

/** Model-space footprint (pad), for spacing: x -1.55..1.35, z -0.7..0.78, height 1.05. */
export const SHED_FOOTPRINT = { x0: -1.55, x1: 1.35, z0: -0.7, z1: 0.78, h: 1.05 };

export function shedParts(trim = '#B4553F', wall = H.wall) {
  const pad = (x0, x1, z0, z1, decals = []) => box(x0, x1, 0, 0.02, z0, z1, H.concrete, { name: 'pad', decals });
  // gable prism along x: eave at y0 between z0..z1, ridge at y1 over zr
  const gable = (x0, x1, y0, y1, z0, z1, zr, mat) => hexa([
    [x0, y0, z0], [x1, y0, z0], [x1, y1, zr], [x0, y1, zr],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, zr], [x0, y1, zr],
  ], mat, { name: 'gable' });
  // roof slope slab from eave (ye at ze) to ridge (yr at zr), thickness t
  const slope = (x0, x1, ye, ze, yr, zr, t, mat, o = {}) => hexa([
    [x0, yr, zr], [x1, yr, zr], [x1, yr + t, zr], [x0, yr + t, zr],
    [x0, ye, ze], [x1, ye, ze], [x1, ye + t, ze], [x0, ye + t, ze],
  ], mat, { name: 'roof', ...o });
  const seams = (n, fill, w = 0.01) => Array.from({ length: n }, (_, i) => { const u = (i + 0.5) / n; return { face: 'top', uv: [[u - w, 0], [u + w, 0], [u + w, 1], [u - w, 1]], fill }; });
  const slats = (face, u0, u1, w0, w1, n) => Array.from({ length: n }, (_, i) => { const w = w0 + ((w1 - w0) * (i + 1)) / (n + 1); return { face, uv: [[u0, w - 0.01], [u1, w - 0.01], [u1, w + 0.01], [u0, w + 0.01]], fill: '#000000', op: 0.22 }; });
  return [
    pad(-1.55, 1.35, -0.7, 0.78, [{ face: 'top', uv: [[0.1, 0.0], [0.42, 0.0], [0.42, 0.12], [0.1, 0.12]], fill: '#000000', op: 0.06 }]),
    box(-1.4, 0.5, 0.02, 0.75, -0.6, 0.55, wall, { name: 'shed', decals: [
      { face: 'front', uv: [[0.1, 0], [0.66, 0], [0.66, 0.84], [0.1, 0.84]], fill: H.door },
      ...slats('front', 0.1, 0.66, 0.02, 0.84, 4),
      { face: 'front', uv: [[0.1, 0.84], [0.66, 0.84], [0.66, 0.9], [0.1, 0.9]], fill: M.chassis },
      { face: 'front', uv: [[0.76, 0], [0.86, 0], [0.86, 0.62], [0.76, 0.62]], fill: M.chassis },
      { face: 'front', uv: [[0.36, 0.92], [0.4, 0.92], [0.4, 0.97], [0.36, 0.97]], fill: M.light },
      { face: 'left', uv: [[0.15, 0.5], [0.85, 0.5], [0.85, 0.62], [0.15, 0.62]], fill: M.glass },
    ] }),
    gable(-1.4, 0.5, 0.75, 1.02, -0.6, 0.55, -0.025, wall),
    slope(-1.48, 0.58, 0.72, 0.64, 1.02, -0.025, 0.03, H.roof, { decals: [...seams(6, H.seam), ...panels('top', 0.08, 0.62, 0.12, 0.88, 4, 2)] }),
    slope(-1.48, 0.58, 0.72, -0.69, 1.02, -0.025, 0.03, H.roof, { decals: seams(6, H.seam) }),
    box(-1.42, 0.52, 0.7, 0.75, 0.55, 0.58, trim, { name: 'fascia' }),
    box(0.5, 1.22, 0.02, 0.58, -0.4, 0.42, H.wallDark, { name: 'office', decals: [
      ...glass('front', 0.06, 0.94, 0.12, 0.88),
      { face: 'front', uv: [[0.5, 0.12], [0.52, 0.12], [0.52, 0.88], [0.5, 0.88]], fill: M.grille },
      ...glass('right', 0.2, 0.8, 0.3, 0.8),
    ] }),
    box(0.47, 1.26, 0.58, 0.64, -0.44, 0.47, H.roof, { name: 'officeRoof', mats: { front: trim, right: trim } }),
    cylY([-1.36, 0.36, 0.57], 0.018, 0.7, 6, M.metal, { name: 'downpipe' }),
  ];
}

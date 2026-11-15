// Depot "house" concepts. Same approach as the tractors: each direction is a low-poly part list
// (boxes, lofts, n-gon cylinders) in SCENE units (1 unit = 1 grid cell; x east, y up, z south = toward
// the default camera). build.mjs projects them with the same renderer, light and tones as the tractors.
// Fit: the shed sits in the free strip between the depot road (row 6) and block E's soil bed, about
// 4.2 wide x 2.0 deep, centred at grid (2.5, 7.8). Every direction stays inside 3.4 x 1.6.
export function makeHouses({ hexa, box, beam, cyl, M, mix }) {
  const H = {
    wall: '#ECEAE5', wallDark: '#D9D6CF', concrete: '#D6D2C9', roof: '#4A4D52', seam: '#6F747B',
    solar: '#1F3550', solarLine: '#4A6A8C', soffit: '#F2F2F7', door: '#9A9AA0', slat: '#000000',
    shedWall: '#E9E4DA', shedRoof: '#C2463A', container: '#C7C7CC', tank: '#E5E5EA', go: '#30D158',
  };
  const pad = (x0, x1, z0, z1, decals = []) => box(x0, x1, 0, 0.02, z0, z1, H.concrete, { name: 'pad', bias: -50, decals });
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
  // decal helpers (uv on a hexa face: u left->right, w bottom->top / front->back on top faces)
  const seams = (n, fill, w = 0.006) => Array.from({ length: n }, (_, i) => { const u = (i + 0.5) / n; return { face: 'top', uv: [[u - w, 0], [u + w, 0], [u + w, 1], [u - w, 1]], fill }; });
  const panels = (face, u0, u1, w0, w1, cols, rows) => {
    const out = [{ face, uv: [[u0, w0], [u1, w0], [u1, w1], [u0, w1]], fill: H.solar }];
    for (let i = 1; i < cols; i++) { const u = u0 + ((u1 - u0) * i) / cols; out.push({ face, uv: [[u - 0.003, w0], [u + 0.003, w0], [u + 0.003, w1], [u - 0.003, w1]], fill: H.solarLine }); }
    for (let j = 1; j < rows; j++) { const w = w0 + ((w1 - w0) * j) / rows; out.push({ face, uv: [[u0, w - 0.01], [u1, w - 0.01], [u1, w + 0.01], [u0, w + 0.01]], fill: H.solarLine }); }
    return out;
  };
  const slats = (face, u0, u1, w0, w1, n) => Array.from({ length: n }, (_, i) => { const w = w0 + ((w1 - w0) * (i + 1)) / (n + 1); return { face, uv: [[u0, w - 0.008], [u1, w - 0.008], [u1, w + 0.008], [u0, w + 0.008]], fill: H.slat, op: 0.22 }; });
  const glass = (face, u0, u1, w0, w1) => [
    { face, uv: [[u0, w0], [u1, w0], [u1, w1], [u0, w1]], fill: M.glass },
    { face, uv: [[u0 + (u1 - u0) * 0.12, w0 + 0.05], [u0 + (u1 - u0) * 0.24, w0 + 0.05], [u0 + (u1 - u0) * 0.44, w1 - 0.05], [u0 + (u1 - u0) * 0.32, w1 - 0.05]], fill: '#fff', op: 0.2 },
  ];

  const houses = {};

  // today's shed (farm.js): 1.6 x 0.8 x 1 box + 4-sided cone roof (r 1.15, h 0.5, rotated 45deg, z scaled 0.7)
  houses.current = {
    title: 'Current depot shed',
    parts: [
      box(-0.8, 0.8, 0, 0.8, -0.5, 0.5, H.shedWall, { name: 'walls' }),
      hexa([[-0.813, 0.8, -0.569], [0.813, 0.8, -0.569], [0, 1.3, 0], [0, 1.3, 0],
        [-0.813, 0.8, 0.569], [0.813, 0.8, 0.569], [0, 1.3, 0], [0, 1.3, 0]], H.shedRoof, { name: 'roof' }),
    ],
  };

  // A: modern machine shed - standing-seam gable roof with solar, big roll-up door, glass office annex
  houses.A = {
    title: 'A. Modern machine shed',
    parts: [
      pad(-1.55, 1.35, -0.7, 0.78, [
        { face: 'top', uv: [[0.1, 0.0], [0.42, 0.0], [0.42, 0.12], [0.1, 0.12]], fill: '#000', op: 0.06 }, // tyre-worn apron
      ]),
      box(-1.4, 0.5, 0.02, 0.75, -0.6, 0.55, H.wall, { name: 'shed', decals: [
        { face: 'front', uv: [[0.1, 0], [0.66, 0], [0.66, 0.84], [0.1, 0.84]], fill: H.door },
        ...slats('front', 0.1, 0.66, 0.02, 0.84, 7),
        { face: 'front', uv: [[0.1, 0.84], [0.66, 0.84], [0.66, 0.9], [0.1, 0.9]], fill: M.chassis },
        { face: 'front', uv: [[0.76, 0], [0.86, 0], [0.86, 0.62], [0.76, 0.62]], fill: M.chassis }, // man door
        { face: 'front', uv: [[0.36, 0.92], [0.4, 0.92], [0.4, 0.97], [0.36, 0.97]], fill: M.light }, // flood light
        { face: 'left', uv: [[0.15, 0.5], [0.85, 0.5], [0.85, 0.62], [0.15, 0.62]], fill: M.glass }, // clerestory
      ] }),
      gable(-1.4, 0.5, 0.75, 1.02, -0.6, 0.55, -0.025, H.wall),
      slope(-1.48, 0.58, 0.72, 0.64, 1.02, -0.025, 0.03, H.roof, { decals: [...seams(12, H.seam), ...panels('top', 0.08, 0.62, 0.12, 0.88, 4, 2)] }),
      slope(-1.48, 0.58, 0.72, -0.69, 1.02, -0.025, 0.03, H.roof, { decals: seams(12, H.seam) }),
      box(-1.42, 0.52, 0.7, 0.75, 0.55, 0.58, 'body', { name: 'fascia' }), // fleet-colour band under the eave
      // office annex: glass front, flat roof with fleet-colour fascia
      box(0.5, 1.22, 0.02, 0.58, -0.4, 0.42, H.wallDark, { name: 'office', decals: [
        ...glass('front', 0.06, 0.94, 0.12, 0.88),
        { face: 'front', uv: [[0.5, 0.12], [0.52, 0.12], [0.52, 0.88], [0.5, 0.88]], fill: M.grille },
        ...glass('right', 0.2, 0.8, 0.3, 0.8),
      ] }),
      box(0.47, 1.26, 0.58, 0.64, -0.44, 0.47, H.roof, { name: 'officeRoof', mats: { front: 'body', right: 'body' } }),
      cyl('y', [-1.36, 0.36, 0.57], 0.018, 0.7, 6, M.metal, { name: 'downpipe' }),
    ],
  };

  // B: autonomous fleet hub - solar canopy over two charging bays + small control building with comms mast
  const bay = (x) => [
    box(x - 0.07, x + 0.07, 0.02, 0.44, -0.62, -0.52, '#E5E5EA', { name: 'charger', decals: [
      { face: 'front', uv: [[0.18, 0.55], [0.82, 0.55], [0.82, 0.85], [0.18, 0.85]], fill: M.glass },
      { face: 'front', uv: [[0.35, 0.4], [0.65, 0.4], [0.65, 0.46], [0.35, 0.46]], fill: H.go },
    ] }),
    beam([x + 0.05, 0.3, -0.52], [x + 0.12, 0.03, -0.38], 0.02, 0.02, M.grille, { name: 'cable' }),
  ];
  const post = (x, z) => box(x - 0.025, x + 0.025, 0.02, 0.82, z - 0.025, z + 0.025, M.chassis, { name: 'post' });
  const lineU = (x) => { const u = (x + 1.65) / 3.2; return { face: 'top', uv: [[u - 0.004, 0.08], [u + 0.004, 0.08], [u + 0.004, 0.9], [u - 0.004, 0.9]], fill: '#fff', op: 0.85 }; };
  houses.B = {
    title: 'B. Autonomous fleet hub',
    parts: [
      pad(-1.65, 1.55, -0.72, 0.78, [lineU(-1.48), lineU(-0.4), lineU(0.68),
        { face: 'top', uv: [[0.06, 0.82], [0.36, 0.82], [0.36, 0.9], [0.06, 0.9]], fill: '#0A84FF', op: 0.55 },
        { face: 'top', uv: [[0.4, 0.82], [0.7, 0.82], [0.7, 0.9], [0.4, 0.9]], fill: '#0A84FF', op: 0.55 },
      ]),
      ...[-1.48, -0.4, 0.68].flatMap((x) => [post(x, -0.62), post(x, 0.6)]),
      box(-1.58, 0.78, 0.82, 0.88, -0.7, 0.68, H.roof, { name: 'canopy', mats: { front: 'body', bottom: H.soffit },
        decals: panels('top', 0.04, 0.96, 0.08, 0.92, 6, 3) }),
      ...bay(-0.94), ...bay(0.14),
      // control building
      box(0.86, 1.48, 0.02, 0.62, -0.5, 0.42, H.wall, { name: 'control', decals: [
        ...glass('front', 0.08, 0.92, 0.48, 0.86),
        { face: 'front', uv: [[0.62, 0], [0.82, 0], [0.82, 0.42], [0.62, 0.42]], fill: M.chassis },
        ...glass('right', 0.1, 0.9, 0.48, 0.86),
        ...glass('left', 0.1, 0.9, 0.48, 0.86),
      ] }),
      box(0.83, 1.51, 0.62, 0.68, -0.53, 0.45, H.roof, { name: 'controlRoof', mats: { front: 'body', right: 'body' } }),
      box(1.3, 1.34, 0.68, 1.22, -0.3, -0.26, M.metal, { name: 'mast' }),
      cyl('y', [1.32, 1.25, -0.28], 0.05, 0.05, 10, M.light, { name: 'mastTop' }),
      cyl('y', [1.32, 1.29, -0.28], 0.018, 0.03, 6, M.amber, { name: 'mastLamp' }),
    ],
  };

  // C: container yard - fleet-colour container workshop, office container on top with stairs, fuel tank
  const corr = (face, n) => Array.from({ length: n }, (_, i) => { const u = (i + 0.5) / n; return { face, uv: [[u - 0.006, 0.04], [u + 0.006, 0.04], [u + 0.006, 0.96], [u - 0.006, 0.96]], fill: '#000', op: 0.14 }; });
  houses.C = {
    title: 'C. Container yard',
    parts: [
      pad(-1.5, 1.4, -0.66, 0.72),
      box(-1.3, 0.3, 0.02, 0.46, -0.55, -0.05, 'body', { name: 'container', decals: [...corr('front', 18),
        { face: 'left', uv: [[0.08, 0.06], [0.92, 0.06], [0.92, 0.94], [0.08, 0.94]], fill: M.chassis },
        { face: 'left', uv: [[0.49, 0.06], [0.51, 0.06], [0.51, 0.94], [0.49, 0.94]], fill: '#000', op: 0.4 }] }),
      box(-1.2, 0.2, 0.46, 0.88, -0.52, -0.08, H.container, { name: 'office', decals: [...corr('front', 16),
        ...glass('front', 0.12, 0.62, 0.3, 0.78),
        { face: 'front', uv: [[0.74, 0.04], [0.88, 0.04], [0.88, 0.8], [0.74, 0.8]], fill: M.chassis }] }),
      // stairs + landing
      beam([0.62, 0.03, 0.18], [0.24, 0.46, 0.0], 0.16, 0.03, M.metal, { name: 'stairs' }),
      box(0.2, 0.42, 0.44, 0.47, -0.08, 0.04, M.metal, { name: 'landing' }),
      beam([0.62, 0.25, 0.24], [0.24, 0.68, 0.06], 0.012, 0.012, M.chassis, { name: 'rail' }),
      // shade lean-to on the front
      slope(-1.34, 0.34, 0.56, 0.42, 0.62, -0.05, 0.025, H.roof),
      ...[-1.3, 0.3].map((x) => box(x - 0.02, x + 0.02, 0.02, 0.56, 0.38, 0.42, M.chassis, { name: 'post' })),
      // fuel tank on saddles with a pump
      cyl('x', [0.95, 0.26, -0.25], 0.2, 0.75, 12, H.tank, { name: 'tank', rims: [[0.35, M.metal]] }),
      ...[0.7, 1.2].map((x) => box(x - 0.04, x + 0.04, 0.02, 0.1, -0.42, -0.08, M.chassis, { name: 'saddle' })),
      box(0.86, 1.04, 0.02, 0.36, 0.08, 0.2, '#E5E5EA', { name: 'pump', decals: [
        { face: 'front', uv: [[0.2, 0.6], [0.8, 0.6], [0.8, 0.85], [0.2, 0.85]], fill: M.glass },
        { face: 'front', uv: [[0.0, 0.0], [1, 0.0], [1, 0.12], [0, 0.12]], fill: '#0A84FF' },
      ] }),
    ],
  };
  return { houses, H };
}

/** Rigid transform of a part: scale s, rotate ry about y, then translate. Decals follow. */
export function placePart(part, { s = 1, ry = 0, x = 0, z = 0 } = {}) {
  const c = Math.cos(ry), sn = Math.sin(ry);
  const f = ([px, py, pz]) => [(px * c + pz * sn) * s + x, py * s, (-px * sn + pz * c) * s + z];
  return { ...part, faces: part.faces.map((fc) => ({ ...fc, pts: fc.pts.map(f), decals: fc.decals.map((d) => ({ ...d, pts: d.pts.map(f) })) })) };
}

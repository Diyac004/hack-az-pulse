// CPU raster behind the Live feed coverage DataTexture. Pure (no DOM, no three.js), testable in Node.
//
// One RGBA8 buffer covers the farm grid plus a 1-cell margin, PX_PER_CELL pixels per grid cell
// (40 m cells -> 2.5 m pixels). It is allocated once per scenario and never per paint.
// Row 0 is the SOUTH edge (DataTexture row 0 = bottom of the plane).
// Every `coverage` message (real or mock) is decoded here: cells [x, y, rgb_int] relative to `origin`,
// size `cell_m`, axes per lib/geo.js coverageYSign (contract gap), rgb_int = 0xRRGGBB.

import { coverageYSign, coverageCellRect, decodeRgb } from './geo.js';

export const PX_PER_CELL = 16;
const MAX_DIM = 2048;

export function createCoverageGrid(gridW, gridH, geo, pxPerCell = PX_PER_CELL) {
  const P = Math.max(1, Math.min(pxPerCell, Math.floor(MAX_DIM / (Math.max(gridW, gridH) + 2))));
  const ex0 = -1.5, ey0 = -1.5, ex1 = gridW + 0.5, ey1 = gridH + 0.5; // grid edge coords
  const width = Math.round((ex1 - ex0) * P), height = Math.round((ey1 - ey0) * P);
  const data = new Uint8Array(width * height * 4);
  const rect = { x: 0, y: 0, x0: 0, x1: 0, y0: 0, y1: 0 };
  const rgb = [0, 0, 0];
  const signCache = new Map();
  let dirty = false, painted = 0, outside = 0, version = 0; // version: bumped on every change; each renderer uploads when it differs

  function fill(x0, x1, y0, y1, r, g, b) {
    let px0 = Math.round((x0 - ex0) * P), px1 = Math.round((x1 - ex0) * P);
    let r0 = Math.round((ey1 - y1) * P), r1 = Math.round((ey1 - y0) * P);
    if (px1 <= px0) px1 = px0 + 1;
    if (r1 <= r0) r1 = r0 + 1;
    if (px0 < 0) px0 = 0; if (r0 < 0) r0 = 0; if (px1 > width) px1 = width; if (r1 > height) r1 = height;
    if (px1 <= px0 || r1 <= r0) { outside++; return; }
    for (let row = r0; row < r1; row++) {
      let i = (row * width + px0) * 4;
      for (let px = px0; px < px1; px++, i += 4) {
        if (data[i + 3] === 0) painted++;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      }
    }
  }

  return {
    data, width, height, P, ex0, ey0, ex1, ey1,
    get dirty() { return dirty; }, set dirty(v) { dirty = !!v; },
    get painted() { return painted; },
    get version() { return version; },
    /** cells that fell entirely outside the farm (+1 cell margin): usually an origin/axis mismatch */
    get outside() { return outside; },
    /** Paint one coverage payload {tractor, cell_m, origin, cells}. Returns number of cells applied. */
    paint(cov) {
      if (!geo || !cov || !(cov.cell_m > 0) || !cov.origin || !Array.isArray(cov.cells)) return 0;
      const key = cov.origin.lat + ',' + cov.origin.lon;
      let ys = signCache.get(key);
      if (ys === undefined) { ys = coverageYSign(geo, cov.origin, gridH); signCache.set(key, ys); }
      let n = 0;
      for (const c of cov.cells) {
        if (!Array.isArray(c) || c.length < 3) continue;
        coverageCellRect(geo, +cov.cell_m, cov.origin, ys, +c[0], +c[1], rect);
        decodeRgb(c[2], rgb);
        fill(rect.x0, rect.x1, rect.y0, rect.y1, rgb[0], rgb[1], rgb[2]);
        n++;
      }
      if (n) { dirty = true; version++; }
      return n;
    },
    clear() { data.fill(0); painted = 0; dirty = true; version++; },
    /** [r,g,b,a] at grid point (x, y), for tests / debugging. */
    at(x, y) {
      const px = Math.floor((x - ex0) * P), row = Math.floor((ey1 - y) * P);
      if (px < 0 || row < 0 || px >= width || row >= height) return null;
      const i = (row * width + px) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    },
  };
}

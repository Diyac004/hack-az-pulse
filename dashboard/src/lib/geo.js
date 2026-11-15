// Grid <-> lat/lon for the Live feed. Pure (no DOM, no three.js), safe in Node.
//
// Mirrors the backend/mock conversion exactly (mockSource.toGeo, ARCHITECTURE.md Scenario.geo):
//   lat = origin_lat - y * cell_m / 111320
//   lon = origin_lon + x * cell_m / (111320 * cos(origin_lat))
// i.e. geo.origin is the CENTER of grid cell (0,0) (contract gap: the contract does not say center vs corner).
// Grid x grows east, y grows south; grid units are cells. World (three.js) = grid.toWorld(x, y).

export const M_PER_DEG_LAT = 111320;

/** @returns geo helper, or null when the scenario has no usable `geo` block. */
export function makeGeo(scenario) {
  const g = scenario && scenario.geo;
  if (!g || !isFinite(g.origin_lat) || !isFinite(g.origin_lon) || !(g.cell_m > 0)) return null;
  const lat0 = +g.origin_lat, lon0 = +g.origin_lon, cellM = +g.cell_m;
  const mLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return {
    lat0, lon0, cellM, mLat: M_PER_DEG_LAT, mLon,
    /** lat/lon -> grid {x, y} (floats, cells) */
    toGrid(lat, lon, out = { x: 0, y: 0 }) {
      out.x = ((lon - lon0) * mLon) / cellM;
      out.y = ((lat0 - lat) * M_PER_DEG_LAT) / cellM;
      return out;
    },
    /** grid {x, y} -> {lat, lon} */
    toLatLon(x, y) {
      return { lat: lat0 - (y * cellM) / M_PER_DEG_LAT, lon: lon0 + (x * cellM) / mLon };
    },
  };
}

/**
 * Grid position of a pose-like object. Prefers real lat/lon (the Live feed is the "proof" view), falls back
 * to the pose's grid x/y. Returns false when nothing usable.
 */
export function poseToGrid(geo, p, out) {
  if (!p) return false;
  if (geo && isFinite(p.lat) && isFinite(p.lon) && p.lat !== null && p.lon !== null) { geo.toGrid(+p.lat, +p.lon, out); return true; }
  if (isFinite(p.x) && isFinite(p.y) && p.x !== null && p.y !== null) { out.x = +p.x; out.y = +p.y; return true; }
  return false;
}

/** 0xRRGGBB int -> [r, g, b] bytes. (Contract: `rgb_int`; we assume 24-bit RGB with R in the high byte.) */
export function decodeRgb(v, out = [0, 0, 0]) {
  v = (+v) >>> 0;
  out[0] = (v >> 16) & 255; out[1] = (v >> 8) & 255; out[2] = v & 255;
  return out;
}

/** '#0A84FF' -> 0x0A84FF */
export function hexToInt(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return isFinite(n) ? n : 0x8e8e93;
}

/**
 * Coverage message axes (contract gap). `coverage.cells` are [x, y, rgb] indices of `cell_m` squares measured
 * from `origin` {lat, lon}. The contract does not say which corner `origin` is or which way y grows.
 * AgOpenWeb's coverage grid is field-local East/North, and the contract example puts `origin` on the basemap's
 * SOUTH-west corner, so the default is: x grows east, y grows NORTH, origin = south-west corner of cell (0,0).
 * If the origin sits in the northern half of the farm we instead assume grid convention (y grows south).
 * @returns +1 when y grows north, -1 when y grows south.
 */
export function coverageYSign(geo, origin, gridH) {
  if (!geo || !origin) return 1;
  const p = geo.toGrid(+origin.lat, +origin.lon);
  return p.y > (gridH - 1) / 2 ? 1 : -1;
}

/**
 * Grid-space rectangle (cell-edge coords, x0<x1, y0<y1) covered by coverage cell (cx, cy).
 * `ySign` from coverageYSign. Grid y of a cell edge = geo y of that latitude.
 */
export function coverageCellRect(geo, cellM, origin, ySign, cx, cy, out) {
  const s = cellM / geo.cellM; // coverage cell size in grid cells
  const o = geo.toGrid(+origin.lat, +origin.lon, out);
  const ox = o.x, oy = o.y;
  out.x0 = ox + cx * s; out.x1 = out.x0 + s;
  if (ySign > 0) { out.y1 = oy - cy * s; out.y0 = out.y1 - s; } // north = smaller grid y
  else { out.y0 = oy + cy * s; out.y1 = out.y0 + s; }
  return out;
}

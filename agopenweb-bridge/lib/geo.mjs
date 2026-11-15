// Coordinate conversions used by the bridge. Pure.
//
// 1. AgOpenWeb field-local E/N (metres) <-> WGS84 lat/lon. AgOpenWeb's own web client uses this flat-earth
//    approximation around the field origin (wwwroot/js/map-layers.js: MPD_LAT = 111320, lon scaled by
//    cos(originLat)). Sub-metre at field scale; the host itself uses a LocalPlane projection, and we measured
//    the difference live (README "Calibration").
// 2. lat/lon <-> our dashboard grid (ARCHITECTURE.md Scenario.geo; dashboard/src/lib/geo.js):
//      x = (lon - origin_lon) * mLon / cell_m,  y = (origin_lat - lat) * 111320 / cell_m   (y grows SOUTH)
//    geo.origin is the CENTRE of grid cell (0, 0).
// 3. AgOpenWeb heading (radians, 0 = north, clockwise) -> contract heading_deg (degrees, 0 = north, clockwise).

export const M_PER_DEG_LAT = 111320;
export const mPerDegLon = (lat) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

export function enToLatLon(originLat, originLon, e, n) {
  return { lat: originLat + n / M_PER_DEG_LAT, lon: originLon + e / mPerDegLon(originLat) };
}
export function latLonToEn(originLat, originLon, lat, lon) {
  return { e: (lon - originLon) * mPerDegLon(originLat), n: (lat - originLat) * M_PER_DEG_LAT };
}

export function makeGridGeo(geo) {
  const lat0 = +geo.origin_lat, lon0 = +geo.origin_lon, cellM = +geo.cell_m, mLon = mPerDegLon(lat0);
  return {
    lat0, lon0, cellM, mLon,
    toGrid: (lat, lon) => ({ x: ((lon - lon0) * mLon) / cellM, y: ((lat0 - lat) * M_PER_DEG_LAT) / cellM }),
    toLatLon: (x, y) => ({ lat: lat0 - (y * cellM) / M_PER_DEG_LAT, lon: lon0 + (x * cellM) / mLon }),
    /** farm metres: east of / south of the grid origin */
    toFarmM: (lat, lon) => ({ fx: (lon - lon0) * mLon, fy: (lat0 - lat) * M_PER_DEG_LAT }),
    fromFarmM: (fx, fy) => ({ lat: lat0 - fy / M_PER_DEG_LAT, lon: lon0 + fx / mLon }),
  };
}

export const radToHeadingDeg = (rad) => (((rad * 180) / Math.PI) % 360 + 360) % 360;
export const MPS_TO_MPH = 2.2369362920544;

// Farm geometry shared by demo.mjs and server.mjs: one AgOpenWeb field per orchard block.
//
// Block (scenario.blocks[i]: x, y, w, h in grid cells) occupies grid cells x..x+w-1, y..y+h-1; since
// geo.origin is the CENTRE of cell (0,0), the block's edges are x-0.5 .. x+w-0.5 and y-0.5 .. y+h-0.5.
// Field "Block_<id>": origin = the block's SOUTH-WEST corner (so field E/N are >= 0 inside the block),
// boundary = the block rectangle. Passes run north-south, the first one `inset` metres inside the west edge.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeGridGeo } from './geo.mjs';

export function loadScenario(path = fileURLToPath(new URL('../scenario.json', import.meta.url))) {
  const s = JSON.parse(fs.readFileSync(path, 'utf8'));
  delete s._source;
  return s;
}

export function blockGeom(scenario, blockId, { toolWidth = 6, headland = 8 } = {}) {
  const g = makeGridGeo(scenario.geo);
  const b = scenario.blocks.find((x) => x.id === blockId);
  if (!b) throw new Error(`no block ${blockId}`);
  const x0 = b.x - 0.5, x1 = b.x + b.w - 0.5, y0 = b.y - 0.5, y1 = b.y + b.h - 0.5;
  const sw = g.toLatLon(x0, y1), se = g.toLatLon(x1, y1), ne = g.toLatLon(x1, y0), nw = g.toLatLon(x0, y0);
  const widthM = (x1 - x0) * g.cellM, heightM = (y1 - y0) * g.cellM;
  const swF = g.toFarmM(sw.lat, sw.lon);
  /** lat/lon at field-local (e, n) metres from the SW corner */
  const at = (e, n) => g.fromFarmM(swF.fx + e, swF.fy - n);
  const passes = Math.max(1, Math.floor(widthM / toolWidth));
  // AgOpenWeb treats a typed AB line (track.latLonAB) as the EDGE between passes and drives pass centres at
  // +-(m + 1/2) x toolWidth from it (MainViewModel RefSideOffset / PassGeometry; verified live: an AB laid on a
  // pass centre made the tractor drive half a width beside it). So we send the line along a pass EDGE
  // (e = k x toolWidth); the whole pass lattice then lines up with our pass centres, in either direction.
  const lineAt = (e) => { const a = at(e, headland), bb = at(e, heightM - headland); return [a.lat, a.lon, bb.lat, bb.lon]; };
  /** Reference AB to SEND for pass k (its west edge), A at the south headland, B at the north headland. */
  const passAB = (k) => lineAt(k * toolWidth);
  /** Centre line of pass k (where the tractor actually drives; what we draw as the guidance line). */
  const passCenter = (k) => lineAt(toolWidth / 2 + k * toolWidth);
  return {
    id: blockId, field: `Block_${blockId}`, origin: sw, widthM, heightM, passes, at, passAB, passCenter,
    boundary: [[sw.lat, sw.lon], [se.lat, se.lon], [ne.lat, ne.lon], [nw.lat, nw.lon]],
    gridRect: { x0, x1, y0, y1 },
  };
}

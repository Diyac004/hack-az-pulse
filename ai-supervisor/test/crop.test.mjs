// Crop math (grid -> lat/lon -> NAIP pixels) and the dependency-free PNG codec.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gridToLatLon, latLonToPx, blockPixelRect, decodePng, encodePng, cropImage, loadBasemap, cropPlots } from '../crop.mjs';
import { plotFindings } from '../reviewers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, '../../dashboard/public/static');
const GEO = { origin_lat: 33.46126, origin_lon: -111.7443, cell_m: 40 };

test('cell (0,0) centre is the geo origin; +x east, +y south', () => {
  const o = gridToLatLon(GEO, 0, 0);
  assert.equal(o.lat, GEO.origin_lat); assert.equal(o.lon, GEO.origin_lon);
  const e = gridToLatLon(GEO, 1, 1);
  assert.ok(e.lat < o.lat && e.lon > o.lon);
  assert.ok(Math.abs((o.lat - e.lat) * 111320 - 40) < 1e-6, 'one cell = 40 m north-south');
});

test('naip.json box: 0.5 m/px, 80 px per cell, image left/top edge at grid -5.5', () => {
  const { meta } = loadBasemap(path.join(STATIC, 'naip.png'), path.join(STATIC, 'naip.json'));
  const c00 = latLonToPx(meta, GEO.origin_lat, GEO.origin_lon);
  assert.ok(Math.abs(c00.px - 440) < 1 && Math.abs(c00.py - 440) < 1, `cell (0,0) centre at ~(440,440) px, got ${c00.px},${c00.py}`);
  // blocks A (1,2,4x3) and E (1,8,4x4), depot cell (1,6)
  assert.deepEqual(blockPixelRect(meta, GEO, { x: 1, y: 2, w: 4, h: 3 }), { x0: 480, y0: 560, x1: 800, y1: 800 });
  assert.deepEqual(blockPixelRect(meta, GEO, { x: 1, y: 8, w: 4, h: 4 }), { x0: 480, y0: 1040, x1: 800, y1: 1360 });
  assert.deepEqual(blockPixelRect(meta, GEO, { x: 1, y: 6, w: 1, h: 1 }), { x0: 480, y0: 880, x1: 560, y1: 960 });
  assert.deepEqual(blockPixelRect(meta, GEO, { x: 1, y: 2, w: 4, h: 3 }, 1), { x0: 400, y0: 480, x1: 880, y1: 880 }, 'one cell of context');
  // clamped to the image
  assert.deepEqual(blockPixelRect(meta, GEO, { x: -10, y: -10, w: 2, h: 2 }), { x0: 0, y0: 0, x1: 0, y1: 0 });
});

test('PNG encode/decode round trip and crop copies the right pixels', () => {
  const w = 5, h = 4, data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 3; data[i] = x * 40; data[i + 1] = y * 60; data[i + 2] = (x + y) * 10; }
  const img = { width: w, height: h, channels: 3, data };
  const back = decodePng(encodePng(img));
  assert.equal(back.width, w); assert.equal(back.height, h); assert.ok(back.data.equals(data));
  const c = cropImage(back, { x0: 1, y0: 2, x1: 4, y1: 4 });
  assert.equal(c.width, 3); assert.equal(c.height, 2);
  assert.deepEqual([...c.data.subarray(0, 3)], [40, 120, 30], 'crop (0,0) = source (1,2)');
});

test('cropPlots: one PNG per block + depot, block rectangle with one cell of context', () => {
  const bm = loadBasemap(path.join(STATIC, 'naip.png'), path.join(STATIC, 'naip.json'));
  assert.equal(bm.img.width, 2400); assert.equal(bm.img.height, 1920);
  const scenario = { geo: GEO, depot: { x: 1, y: 6 }, blocks: [{ id: 'A', x: 1, y: 2, w: 4, h: 3 }, { id: 'E', x: 1, y: 8, w: 4, h: 4 }] };
  const crops = cropPlots(bm, scenario);
  assert.deepEqual(crops.map((c) => c.id), ['A', 'E', 'depot']);
  const a = decodePng(crops[0].png);
  assert.equal(a.width, 480); assert.equal(a.height, 400);
  const px = (x, y) => [...a.data.subarray((y * a.width + x) * a.channels, (y * a.width + x) * a.channels + 3)];
  assert.deepEqual(px(80, 80), [255, 200, 0], 'amber outline at the block corner (80 px = one cell in)');
});

test('plot answers -> findings: non-orchard blocks become disable_block proposals, depot advisory', () => {
  const sc = { blocks: [{ id: 'A' }, { id: 'B' }, { id: 'E' }] };
  const f = plotFindings([
    { id: 'A', land_use: 'houses', orchard_pct: 3, confidence: 'high', evidence: 'Roofs, pools and a cul-de-sac.' },
    { id: 'B', land_use: 'orchard', orchard_pct: 85, confidence: 'high', evidence: 'Rows of trees.' },
    { id: 'E', land_use: 'mixed', orchard_pct: 70, confidence: 'medium', evidence: 'Mostly trees.' },
    { id: 'depot', land_use: 'roads_or_paved', orchard_pct: 0, confidence: 'high', evidence: 'A paved road.' },
  ], sc);
  assert.deepEqual(f.map((x) => [x.title, x.action.kind, x.action.block ?? null]), [['Block A is houses, not orchard', 'disable_block', 'A'], ['Depot sits on roads / paving, not a yard', 'none', null]]);
  assert.match(f[0].why, /shows roofs, pools and a cul-de-sac \(about 3% orchard\)/);
});

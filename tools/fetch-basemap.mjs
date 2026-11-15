#!/usr/bin/env node
// Pre-bake the Map view's satellite basemap (run once, commit the output; the demo then works offline).
//
//   node tools/fetch-basemap.mjs                          # origin from dashboard/public/static/naip.json (or the mock's)
//   node tools/fetch-basemap.mjs --origin 33.2283,-111.5996 --margin 5 --mpp 0.4
//
// Writes dashboard/public/static/naip.png (contract path, scenario.basemap.image_url), naip.jpg (same pixels,
// ~6x lighter, what the dashboard loads when the scenario has no image_url) and naip.json (bounds + attribution).
//
// Imagery: USGS The National Map "USGSNAIPPlus" ImageServer (NAIP + high-resolution orthoimagery, public domain,
// no key). Fallback: the "USGSImageryOnly" MapServer export (same source, cached tiles, coarser past z16).
// Privacy: the ONLY thing sent to USGS is the farm's bounding box (plus image size/format). No ids, no headers.
//
// Geometry (must match dashboard/src/lib/geo.js and the backend's Scenario.geo):
//   origin = CENTRE of grid cell (0,0); x grows east, y grows south; cell_m metres per cell;
//   lat = lat0 - y*cell_m/111320, lon = lon0 + x*cell_m/(111320*cos lat0).
// The farm's outer edges are grid -0.5 .. W-0.5 / -0.5 .. H-0.5; we add `margin` cells all round.
// The image is requested in Web Mercator (square pixels) and its true extent is converted back to lat/lon; across
// ~1 km Mercator's y-stretch is linear to well under a centimetre, so placing the image by its lat/lon bounds on our
// flat-earth grid is exact enough for drawing.
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DEFAULT = resolve(ROOT, 'dashboard/public/static');
const IMAGE_SERVER = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage';
const MAP_SERVER = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export';
const ATTRIBUTION = 'Imagery: USGS The National Map / NAIP, public domain';
const M_PER_DEG_LAT = 111320;
const R = 6378137; // Web Mercator sphere

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    o[k] = v;
  }
  return o;
}

async function defaultOrigin(outDir) {
  try {
    const j = JSON.parse(await readFile(resolve(outDir, 'naip.json'), 'utf8'));
    if (j.origin && isFinite(j.origin.lat) && isFinite(j.origin.lon)) return { lat: +j.origin.lat, lon: +j.origin.lon, from: 'naip.json' };
  } catch (e) { /* none yet */ }
  return { lat: 33.212, lon: -111.62, from: 'mock default' };
}

const toMerc = (lat, lon) => ({ x: (R * lon * Math.PI) / 180, y: R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) });
const fromMerc = (x, y) => ({ lon: (x / R) * (180 / Math.PI), lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI) });

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'fetch-basemap/1.0' } });
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText + ' for ' + url.split('?')[0]);
  const j = await r.json();
  if (j.error) throw new Error('service error: ' + JSON.stringify(j.error));
  return j;
}
async function getBytes(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'fetch-basemap/1.0' } });
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  const ct = r.headers.get('content-type') || '';
  if (!ct.startsWith('image/')) throw new Error('not an image: ' + ct + ' ' + (await r.text()).slice(0, 200));
  return Buffer.from(await r.arrayBuffer());
}

/** One export: returns { bytes, extent (Mercator), width, height }. */
async function exportOnce(service, bbox, w, h, format) {
  // the ImageServer sometimes answers 502/504 under load: retry a few times before the caller falls back
  for (let i = 0; ; i++) {
    try { return await exportOnceRaw(service, bbox, w, h, format); }
    catch (e) { if (i >= 3) throw e; console.warn(`  ${service} ${format} attempt ${i + 1} failed (${e.message}); retrying`); await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
}
async function exportOnceRaw(service, bbox, w, h, format) {
  const bb = [bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax].map((v) => v.toFixed(3)).join(',');
  const common = `bbox=${bb}&bboxSR=3857&imageSR=3857&size=${w},${h}`;
  const url = service === 'imageserver'
    ? `${IMAGE_SERVER}?${common}&format=${format}&compressionQuality=88&interpolation=RSP_BilinearInterpolation&f=json`
    : `${MAP_SERVER}?${common}&format=${format === 'jpg' ? 'jpg' : 'png24'}&f=json`;
  const meta = await getJson(url);
  if (!meta.href || !meta.extent) throw new Error('no href/extent in ' + JSON.stringify(meta).slice(0, 200));
  const bytes = await getBytes(meta.href);
  return { bytes, extent: meta.extent, width: meta.width || w, height: meta.height || h };
}

async function main() {
  const a = args(process.argv.slice(2));
  const outDir = resolve(a.out || OUT_DEFAULT);
  let origin;
  if (a.origin) { const [lat, lon] = a.origin.split(',').map(Number); origin = { lat, lon, from: '--origin' }; }
  else origin = await defaultOrigin(outDir);
  if (!isFinite(origin.lat) || !isFinite(origin.lon)) throw new Error('bad --origin (want lat,lon)');
  const cellM = +(a.cell || 40), [gw, gh] = String(a.grid || '20x14').split('x').map(Number);
  const margin = +(a.margin || 5), mpp = +(a.mpp || 0.4), service = a.service || 'imageserver';

  const mLon = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  const want = {
    north: origin.lat + ((0.5 + margin) * cellM) / M_PER_DEG_LAT,
    south: origin.lat - ((gh - 0.5 + margin) * cellM) / M_PER_DEG_LAT,
    west: origin.lon - ((0.5 + margin) * cellM) / mLon,
    east: origin.lon + ((gw - 0.5 + margin) * cellM) / mLon,
  };
  const widthM = (gw + 2 * margin) * cellM, heightM = (gh + 2 * margin) * cellM;
  let w = Math.round(widthM / mpp), h = Math.round(heightM / mpp);
  const s = Math.min(1, 4000 / Math.max(w, h)); w = Math.round(w * s); h = Math.round(h * s);
  const sw = toMerc(want.south, want.west), ne = toMerc(want.north, want.east);
  const bbox = { xmin: sw.x, ymin: sw.y, xmax: ne.x, ymax: ne.y };
  console.log(`origin ${origin.lat},${origin.lon} (${origin.from}); farm ${gw}x${gh} x ${cellM} m + ${margin} cells margin = ${widthM} x ${heightM} m -> ${w} x ${h} px (${(widthM / w).toFixed(2)} m/px)`);
  console.log('sending to USGS: bbox only ->', [want.west, want.south, want.east, want.north].map((v) => v.toFixed(6)).join(','));

  let png, jpg, used = service;
  try {
    png = await exportOnce(service, bbox, w, h, 'png');
    jpg = await exportOnce(service, bbox, w, h, 'jpg');
  } catch (e) {
    if (service !== 'imageserver') throw e;
    console.warn('ImageServer failed (' + e.message + '); falling back to the USGSImageryOnly MapServer');
    used = 'mapserver';
    png = await exportOnce('mapserver', bbox, w, h, 'png');
    jpg = await exportOnce('mapserver', bbox, w, h, 'jpg');
  }
  const ex = png.extent, a0 = fromMerc(ex.xmin, ex.ymin), a1 = fromMerc(ex.xmax, ex.ymax);
  const bounds = { west: a0.lon, south: a0.lat, east: a1.lon, north: a1.lat };
  const cover = bounds.west <= want.west + 1e-7 && bounds.east >= want.east - 1e-7 && bounds.south <= want.south + 1e-7 && bounds.north >= want.north - 1e-7;
  if (!cover) console.warn('warning: returned extent does not fully cover the requested box', bounds, want);

  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'naip.png'), png.bytes);
  await writeFile(resolve(outDir, 'naip.jpg'), jpg.bytes);
  const meta = {
    image: 'naip.jpg', image_png: 'naip.png',
    west: +bounds.west.toFixed(8), east: +bounds.east.toFixed(8), south: +bounds.south.toFixed(8), north: +bounds.north.toFixed(8),
    width: png.width, height: png.height, m_per_px: +(widthM / png.width).toFixed(3),
    origin: { lat: origin.lat, lon: origin.lon, cell_m: cellM, note: 'centre of grid cell (0,0); = scenario.geo origin_lat/origin_lon' },
    grid: { w: gw, h: gh, margin_cells: margin },
    farm_bounds: { west: +(origin.lon - (0.5 * cellM) / mLon).toFixed(8), east: +(origin.lon + ((gw - 0.5) * cellM) / mLon).toFixed(8), north: +(origin.lat + (0.5 * cellM) / M_PER_DEG_LAT).toFixed(8), south: +(origin.lat - ((gh - 0.5) * cellM) / M_PER_DEG_LAT).toFixed(8) },
    source: used === 'imageserver' ? 'USGS The National Map, USGSNAIPPlus ImageServer (NAIP + HRO orthoimagery)' : 'USGS The National Map, USGSImageryOnly MapServer',
    service: used === 'imageserver' ? IMAGE_SERVER : MAP_SERVER,
    attribution: ATTRIBUTION,
    license: 'Public domain (US Government work, USGS/USDA)',
    fetched_at: new Date().toISOString(),
    tool: 'tools/fetch-basemap.mjs',
  };
  await writeFile(resolve(outDir, 'naip.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log(`wrote ${outDir}/naip.png (${(png.bytes.length / 1e6).toFixed(1)} MB), naip.jpg (${(jpg.bytes.length / 1e6).toFixed(1)} MB), naip.json`);
}

main().catch((e) => { console.error('fetch-basemap failed:', e.message); process.exit(1); });

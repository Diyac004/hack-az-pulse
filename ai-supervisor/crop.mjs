// Satellite crops for the plot reviewer. Dependency-free: decodes the NAIP PNG (8-bit RGB/RGBA, non-interlaced)
// with node:zlib, crops a pixel rectangle and re-encodes it as PNG. (naip.jpg and naip.png are the same image and
// extent per public/static/naip.json; we decode the PNG because JPEG needs a codec dependency.)
//
// Geo math (ARCHITECTURE scenario.geo): the origin is the CENTRE of grid cell (0,0); +x = east, +y = south;
// cell_m metres per cell. A block {x,y,w,h} covers cells x..x+w-1, y..y+h-1, so its edges are at
// x-0.5 .. x+w-0.5 and y-0.5 .. y+h-0.5 in grid units. The image is an equirectangular lat/lon box.
import zlib from 'node:zlib';
import fs from 'node:fs';

const M_PER_DEG_LAT = 111320;

/** grid point (continuous, cell units) -> {lat, lon} (same formula as mockSource toGeo). */
export function gridToLatLon(geo, gx, gy) {
  const lat = geo.origin_lat - (gy * geo.cell_m) / M_PER_DEG_LAT;
  const lon = geo.origin_lon + (gx * geo.cell_m) / (M_PER_DEG_LAT * Math.cos((geo.origin_lat * Math.PI) / 180));
  return { lat, lon };
}

/** {lat, lon} -> image pixel {px, py} (float) inside the naip.json box. */
export function latLonToPx(meta, lat, lon) {
  return {
    px: ((lon - meta.west) / (meta.east - meta.west)) * meta.width,
    py: ((meta.north - lat) / (meta.north - meta.south)) * meta.height,
  };
}

/**
 * Pixel rectangle of a block (or any grid rect {x,y,w,h}), optionally grown by `marginCells` on each side,
 * clamped to the image. Integers: {x0, y0, x1, y1} with x1/y1 exclusive.
 */
export function blockPixelRect(meta, geo, b, marginCells = 0) {
  const nw = gridToLatLon(geo, b.x - 0.5 - marginCells, b.y - 0.5 - marginCells);
  const se = gridToLatLon(geo, b.x + b.w - 0.5 + marginCells, b.y + b.h - 0.5 + marginCells);
  const a = latLonToPx(meta, nw.lat, nw.lon), c = latLonToPx(meta, se.lat, se.lon);
  const clamp = (v, hi) => Math.max(0, Math.min(hi, Math.round(v)));
  return { x0: clamp(a.px, meta.width), y0: clamp(a.py, meta.height), x1: clamp(c.px, meta.width), y1: clamp(c.py, meta.height) };
}

// ---------------------------------------------------------------- PNG codec (minimal)
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** Decode an 8-bit, non-interlaced RGB (2) / RGBA (6) / grey (0) PNG -> {width, height, channels, data: Buffer (rows, no filter bytes)}. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 6: 4 }[ctype];
  if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG (depth ${depth}, color type ${ctype}, interlace ${interlace})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels, stride = width * bpp, out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride), up = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = up ? up[i] : 0, c = up && i >= bpp ? up[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode {width, height, channels, data} as PNG (filter 0 rows). */
export function encodePng(img) {
  const { width, height, channels, data } = img;
  const ctype = { 1: 0, 3: 2, 4: 6 }[channels];
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = ctype; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * channels, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Crop rect {x0,y0,x1,y1} out of a decoded image. */
export function cropImage(img, r) {
  const w = Math.max(0, r.x1 - r.x0), h = Math.max(0, r.y1 - r.y0), c = img.channels, out = Buffer.alloc(w * h * c);
  for (let y = 0; y < h; y++) img.data.copy(out, y * w * c, ((r.y0 + y) * img.width + r.x0) * c, ((r.y0 + y) * img.width + r.x1) * c);
  return { width: w, height: h, channels: c, data: out };
}

/** Draw a 2-px rectangle outline (crop coordinates) in place, e.g. to mark the block inside a context crop. */
export function strokeRect(img, r, rgb = [255, 200, 0]) {
  const c = img.channels;
  const put = (x, y) => { if (x < 0 || y < 0 || x >= img.width || y >= img.height) return; const i = (y * img.width + x) * c; img.data[i] = rgb[0]; if (c >= 3) { img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; } };
  for (let t = 0; t < 2; t++) {
    for (let x = r.x0; x < r.x1; x++) { put(x, r.y0 + t); put(x, r.y1 - 1 - t); }
    for (let y = r.y0; y < r.y1; y++) { put(r.x0 + t, y); put(r.x1 - 1 - t, y); }
  }
  return img;
}

let cache = null;
/** Load + decode the basemap once. */
export function loadBasemap(pngPath, metaPath) {
  if (cache && cache.pngPath === pngPath) return cache;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const img = decodePng(fs.readFileSync(pngPath));
  if (img.width !== meta.width || img.height !== meta.height) throw new Error(`basemap is ${img.width}x${img.height}, naip.json says ${meta.width}x${meta.height}`);
  cache = { pngPath, meta, img };
  return cache;
}

/**
 * PNG crops for every block (and the depot cell), each with one cell of context and the target outlined in amber.
 * @returns {Array<{id, kind:'block'|'depot', rect, png: Buffer}>}
 */
export function cropPlots(basemap, scenario, { marginCells = 1 } = {}) {
  const { meta, img } = basemap, geo = scenario.geo;
  const targets = (scenario.blocks || []).map((b) => ({ id: b.id, kind: 'block', b }));
  if (scenario.depot) targets.push({ id: 'depot', kind: 'depot', b: { x: scenario.depot.x, y: scenario.depot.y, w: 1, h: 1 } });
  return targets.map(({ id, kind, b }) => {
    const outer = blockPixelRect(meta, geo, b, marginCells), inner = blockPixelRect(meta, geo, b, 0);
    const crop = cropImage(img, outer);
    strokeRect(crop, { x0: inner.x0 - outer.x0, y0: inner.y0 - outer.y0, x1: inner.x1 - outer.x0, y1: inner.y1 - outer.y0 });
    return { id, kind, rect: inner, png: encodePng(crop) };
  });
}

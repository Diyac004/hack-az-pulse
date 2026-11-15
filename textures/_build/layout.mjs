// Whole-farm layout diagrams for the "Decisions" section: where blocks E-H sit between road rows 6 and 13.
// Grid facts come from dashboard/src/data/mockSource.js (read-only): 20 x 14 cells, road rows 0/6/13,
// road columns 0/5/10/15, depot (1, 6), blocks A-D at x 1/6/11/16, y 2, 4 x 3. Cell k spans k-0.5 .. k+0.5.
export const GRID = { w: 20, h: 14, rows: [0, 6, 13], cols: [0, 5, 10, 15], depot: { x: 1, y: 6 } };
const TOP = [['A', 1], ['B', 6], ['C', 11], ['D', 16]].map(([id, x]) => ({ id, x, y: 2, w: 4, h: 3 }));
const BOTTOM = (y, h) => [['E', 1], ['F', 6], ['G', 11], ['H', 16]].map(([id, x]) => ({ id, x, y, w: 4, h }));
export const LAYOUTS = {
  a: { key: 'a', name: 'Original', sub: 'E–H at y 9, 3 rows', blocks: [...TOP, ...BOTTOM(9, 3)] },
  b: { key: 'b', name: 'Current', sub: 'E–H at y 8, 4 rows', blocks: [...TOP, ...BOTTOM(8, 4)] },
  c: { key: 'c', name: 'Alternative', sub: 'E–H at y 8.5, 3 rows', blocks: [...TOP, ...BOTTOM(8.5, 3)] },
};

// hubPlacement() copied from dashboard/src/scene/depotHub.js (pure; same defaults)
const PAD = { x0: -1.65, x1: 1.55, z0: -0.72, z1: 0.78 };
export function hubPlacement(g, { roadHalf = 0.4, bedPad = 0.08, margin = 0.06 } = {}) {
  const d = g.depot;
  const row = g.rows.length ? g.rows.reduce((a, r) => (Math.abs(r - d.y) < Math.abs(a - d.y) ? r : a), g.rows[0]) : d.y;
  const left = g.cols.filter((c) => c <= d.x), right = g.cols.filter((c) => c > d.x);
  const segL = left.length ? Math.max(...left) + roadHalf : -1, segR = right.length ? Math.min(...right) - roadHalf : g.w;
  const inSeg = (b) => b.x - 0.5 < segR && b.x + b.w - 0.5 > segL;
  const otherRows = (dir) => g.rows.filter((r) => (dir < 0 ? r < row : r > row));
  const nTop = Math.max(-1, ...g.blocks.filter((b) => inSeg(b) && b.y + b.h - 0.5 <= row).map((b) => b.y + b.h - 0.5 + bedPad), ...otherRows(-1).map((r) => r + roadHalf));
  const sBot = Math.min(g.h, ...g.blocks.filter((b) => inSeg(b) && b.y - 0.5 >= row).map((b) => b.y - 0.5 - bedPad), ...otherRows(1).map((r) => r - roadHalf));
  const north = { side: 'north', a: nTop, b: row - roadHalf, ry: 0 };
  const south = { side: 'south', a: row + roadHalf, b: sBot, ry: Math.PI };
  const dn = north.b - north.a, ds = south.b - south.a;
  const pick = dn >= ds * 0.9 ? north : south;
  const depth = pick.b - pick.a, padD = PAD.z1 - PAD.z0, padW = PAD.x1 - PAD.x0;
  const widthFit = Math.min(1, (segR - segL - 2 * margin) / padW);
  const sz = Math.max(0.4, Math.min(1, (depth - 2 * margin) / padD, widthFit));
  const sw = Math.min(widthFit, Math.max(sz, 0.85));
  const flip = pick.ry ? -1 : 1;
  const lo = flip > 0 ? -PAD.x0 * sw : PAD.x1 * sw, hi = flip > 0 ? PAD.x1 * sw : -PAD.x0 * sw;
  const x = Math.min(segR - margin - hi, Math.max(segL + margin + lo, d.x + 0.94 * sw * flip));
  const y = (pick.a + pick.b) / 2 - flip * ((PAD.z0 + PAD.z1) / 2) * sz;
  return { x, y, ry: pick.ry, sw, sz, side: pick.side, depth, dn, ds, strip: [pick.a, pick.b] };
}
export const placementFor = (L) => hubPlacement({ ...GRID, blocks: L.blocks });

const f1 = (n) => (Math.round(n * 100) / 100).toString();
const CELL = 36, LM = 64, TM = 44, RM = 300, BM = 112;
const X = (gx) => LM + (gx + 0.5) * CELL, Y = (gy) => TM + (gy + 0.5) * CELL; // grid coord -> px (cell centres on integers)

/** Plain 2D diagram: grid lines + numbers, roads, blocks, empty-row bands, dimension callouts, hub footprint + strip. */
export function layoutSvg(L) {
  const p = placementFor(L);
  const W = LM + GRID.w * CELL + RM, H = TM + GRID.h * CELL + BM;
  const ink = '#1D1D1F', mute = '#6E6E73', warn = '#E8590C';
  let s = '';
  s += `<rect x="${X(-0.5)}" y="${Y(-0.5)}" width="${GRID.w * CELL}" height="${GRID.h * CELL}" fill="#E6D7B5"/>`;
  for (const r of GRID.rows) s += `<rect x="${X(-0.5)}" y="${Y(r - 0.4)}" width="${GRID.w * CELL}" height="${0.8 * CELL}" fill="#F4ECDA"/>`;
  for (const c of GRID.cols) s += `<rect x="${X(c - 0.4)}" y="${Y(-0.5)}" width="${0.8 * CELL}" height="${GRID.h * CELL}" fill="#F4ECDA"/>`;
  // empty rows between the road and the blocks, per tier (only whole rows count; half rows shown as half bands)
  const bands = [];
  const tierGap = (a, b) => { if (b - a > 0.01) bands.push([a, b]); };
  const top = L.blocks.filter((b) => b.y < 6), bot = L.blocks.filter((b) => b.y > 6);
  tierGap(0.5, top[0].y - 0.5); tierGap(top[0].y + top[0].h - 0.5, 5.5);
  tierGap(6.5, bot[0].y - 0.5); tierGap(bot[0].y + bot[0].h - 0.5, 12.5);
  for (const [a, b] of bands) for (const c of [[0.5, 4.5], [5.5, 9.5], [10.5, 14.5], [15.5, 19.5]]) s += `<rect x="${X(c[0] - 0.5) + 2}" y="${Y(a - 0.5)}" width="${(c[1] - c[0]) * CELL - 4}" height="${(b - a) * CELL}" fill="url(#hatch)"/>`;
  for (const b of L.blocks) {
    const x0 = X(b.x - 0.5), y0 = Y(b.y - 0.5);
    s += `<rect x="${x0 - 0.08 * CELL}" y="${y0 - 0.08 * CELL}" width="${(b.w + 0.16) * CELL}" height="${(b.h + 0.16) * CELL}" fill="#9C7A52" rx="2"/>`;
    s += `<rect x="${x0 + 0.1 * CELL}" y="${y0 + 0.1 * CELL}" width="${(b.w - 0.2) * CELL}" height="${(b.h - 0.2) * CELL}" fill="#7E9A4E"/>`;
    for (let i = 0; i < b.h; i++) s += `<line x1="${x0 + 0.25 * CELL}" x2="${x0 + (b.w - 0.25) * CELL}" y1="${Y(b.y + i)}" y2="${Y(b.y + i)}" stroke="#3E6A2C" stroke-width="7" stroke-linecap="round" opacity=".8"/>`;
    s += `<text x="${x0 + (b.w / 2) * CELL}" y="${y0 + (b.h / 2) * CELL + 9}" text-anchor="middle" font-size="26" font-weight="700" fill="#fff">${b.id}</text>`;
  }
  // half-cell warning (c): block edges in the middle of a cell
  if (bot[0].y % 1) for (const b of bot) for (const e of [b.y - 0.5, b.y + b.h - 0.5]) s += `<line x1="${X(b.x - 0.5)}" x2="${X(b.x + b.w - 0.5)}" y1="${Y(e)}" y2="${Y(e)}" stroke="${warn}" stroke-width="3" stroke-dasharray="6 4"/>`;
  // grid lines + numbers
  for (let i = 0; i <= GRID.w; i++) s += `<line x1="${X(i - 0.5)}" x2="${X(i - 0.5)}" y1="${Y(-0.5)}" y2="${Y(GRID.h - 0.5)}" stroke="#000" stroke-opacity=".12"/>`;
  for (let j = 0; j <= GRID.h; j++) s += `<line x1="${X(-0.5)}" x2="${X(GRID.w - 0.5)}" y1="${Y(j - 0.5)}" y2="${Y(j - 0.5)}" stroke="#000" stroke-opacity=".12"/>`;
  for (let j = 0; j < GRID.h; j++) s += `<text x="${LM - 10}" y="${Y(j) + 5}" text-anchor="end" font-size="14" fill="${GRID.rows.includes(j) ? ink : mute}" font-weight="${GRID.rows.includes(j) ? 700 : 400}">${j}</text>`;
  for (let i = 0; i < GRID.w; i++) s += `<text x="${X(i)}" y="${TM - 12}" text-anchor="middle" font-size="12" fill="${mute}">${i}</text>`;
  s += `<text x="${LM - 10}" y="${TM - 12}" text-anchor="end" font-size="12" fill="${mute}">row</text>`;
  // hub footprint + its strip
  const fx = (mx, mz) => { const c = Math.cos(p.ry), sn = Math.sin(p.ry); const sx = mx * p.sw, sz = mz * p.sz; return [X(p.x + sx * c + sz * sn), Y(p.y - sx * sn + sz * c)]; };
  const corners = [[PAD.x0, PAD.z0], [PAD.x1, PAD.z0], [PAD.x1, PAD.z1], [PAD.x0, PAD.z1]].map(([a, b]) => fx(a, b));
  const xs = corners.map((q) => q[0]), ys = corners.map((q) => q[1]);
  s += `<rect x="${X(0.4)}" y="${Y(p.strip[0])}" width="${(4.2) * CELL}" height="${(p.strip[1] - p.strip[0]) * CELL}" fill="#0A84FF" opacity=".14"/>`;
  s += `<rect x="${Math.min(...xs)}" y="${Math.min(...ys)}" width="${Math.max(...xs) - Math.min(...xs)}" height="${Math.max(...ys) - Math.min(...ys)}" fill="#1F3550" stroke="#fff" stroke-width="1.5" rx="2"/>`;
  s += `<text x="${(Math.min(...xs) + Math.max(...xs)) / 2}" y="${(Math.min(...ys) + Math.max(...ys)) / 2 + 5}" text-anchor="middle" font-size="12" font-weight="600" fill="#fff">Fleet hub</text>`;
  // callouts on the right: vertical dimensions for the bottom tier + block height
  const cx = X(GRID.w - 0.5) + 18;
  const dim = (a, b, label, color = ink) => {
    const y0 = Y(a), y1 = Y(b), m = (y0 + y1) / 2;
    return `<path d="M${cx} ${y0}h10M${cx} ${y1}h10M${cx + 5} ${y0 + 1}V${y1 - 1}" stroke="${color}" stroke-width="2" fill="none"/><path d="M${cx + 5} ${y0}l-4 7h8zM${cx + 5} ${y1}l-4 -7h8z" fill="${color}"/><text x="${cx + 20}" y="${m + 5}" font-size="15" font-weight="600" fill="${color}">${label}</text>`;
  };
  const rowsTxt = (n) => `${f1(n)} empty row${Math.abs(n - 1) < 0.01 ? '' : 's'}`;
  const gapA = bot[0].y - 0.5 - 6.5, gapB = 12.5 - (bot[0].y + bot[0].h - 0.5);
  s += dim(0.5, 1.5, rowsTxt(1), mute) + dim(4.5, 5.5, rowsTxt(1), mute);
  s += dim(2 - 0.5, 4.5, 'A–D: 3 rows', mute).replace(new RegExp(`M${cx} `, 'g'), `M${cx + 120} `).replace(new RegExp(`M${cx + 5} `, 'g'), `M${cx + 125} `).replace(`x="${cx + 20}"`, `x="${cx + 140}"`);
  const uneven = Math.abs(gapA - gapB) > 0.01;
  s += dim(6.5, bot[0].y - 0.5, rowsTxt(gapA), uneven ? warn : ink);
  s += dim(bot[0].y + bot[0].h - 0.5, 12.5, rowsTxt(gapB), uneven ? warn : ink);
  const tall = bot[0].h !== 3;
  const hb = dim(bot[0].y - 0.5, bot[0].y + bot[0].h - 0.5, `E–H: ${bot[0].h} rows${tall ? ' (taller)' : ''}`, tall ? warn : ink);
  s += hb.replace(new RegExp(`M${cx} `, 'g'), `M${cx + 120} `).replace(new RegExp(`M${cx + 5} `, 'g'), `M${cx + 125} `).replace(`x="${cx + 20}"`, `x="${cx + 140}"`);
  const notes = [];
  if (uneven) notes.push(['Gap above E–H ≠ gap below', warn]);
  if (tall) notes.push(['E–H 4 rows tall vs 3 for A–D', warn]);
  if (bot[0].y % 1) notes.push(['Dashed: block edges cut cells 8 and 11 in half', warn], ['Tree rows sit on cell lines, not in cells', warn]);
  if (!notes.length) notes.push(['Even gaps, same size as A–D', ink]);
  if (notes.length % 2) notes.push(['', ink]);
  notes.push([`Hub (blue strip): ${p.side} of road 6, strip ${f1(p.depth)} deep`, '#0A63C9'], [`Hub scale ${f1(p.sw)} wide × ${f1(p.sz)} deep${p.side === 'south' ? ', back to the camera' : ''}`, '#0A63C9']);
  notes.forEach(([t, c], i) => { s += `<text x="${LM + (i % 2) * 440}" y="${Y(13.5) + 26 + Math.floor(i / 2) * 22}" font-size="15" font-weight="600" fill="${c}">${t}</text>`; });
  s += `<text x="${cx + 120}" y="${Y(-0.2)}" font-size="20" font-weight="700" fill="${ink}">${L.key} · ${L.name}</text><text x="${cx + 120}" y="${Y(-0.2) + 22}" font-size="14" fill="${mute}">${L.sub}</text>`;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" font-family="-apple-system,BlinkMacSystemFont,system-ui,sans-serif">
<title>Farm layout ${L.key}: ${L.name} (${L.sub})</title>
<desc>Top-down farm grid, 20 x 14 cells with row and column numbers. Roads at rows 0, 6, 13 and columns 0, 5, 10, 15. Hatched bands are empty rows between a road and a block tier. Blue band: the strip the Fleet hub is fitted into.</desc>
<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#E6D7B5"/><line x1="0" y1="0" x2="0" y2="8" stroke="#C9A86E" stroke-width="3"/></pattern></defs>
${s}
</svg>
`, placement: p, gapA, gapB };
}

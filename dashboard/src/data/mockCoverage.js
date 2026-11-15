// Synthetic coverage for the MOCK source only. Pure module (no DOM, no three.js).
//
// The live backend forwards AgOpenWeb's real coverage as WS `coverage` messages. The in-browser mock has no
// coverage, so the Live feed calls this generator ONLY when sourceInfo.kind === 'mock' and no real `coverage`
// message has arrived. It emits the exact contract shape
//   { tractor, cell_m, origin: {lat, lon}, cells: [[x, y, rgb_int], ...] }
// so both paths go through the same painter (and the same axis assumptions, see lib/geo.js coverageYSign):
// origin = south-west corner of the farm, x east, y NORTH, rgb_int = 0xRRGGBB of the painting tractor.
//
// What gets painted (mock-only geometry):
// - Paint is keyed by JOB, not tractor: each job keeps a "paint head" (0..1). Only the tractor that is
//   `working` on that job advances it, in its own color. After a breakdown the job keeps its head, so the
//   backup tractor continues exactly where the broken one stopped.
// - Only implements that apply something paint (spray, mow, hedge); haul_bins does not.
// - The mock sweeps a block in 3 boustrophedon rows (mockSource.sweepPos: rows at block.y - 0.5 + r, x from
//   block.x to block.x + 3). Its tool is 6 m wide on 40 m cells, which would paint hairlines, so the mock swath
//   is one row pitch (block.h / 3) and is laid over the block outline (row r = r-th third of the block). The
//   tractor icon therefore runs along the top edge of the band it paints. Real coverage has no such fudge.

import { makeGeo, hexToInt } from '../lib/geo.js';
import { tractorColor } from '../lib/format.js';

export const MOCK_COVERAGE_PER_CELL = 16; // coverage cells per grid cell (40 m / 16 = 2.5 m)
const ROWS = 3;

/** Inverse of mockSource.sweepPos: pose (grid x, y) on block b -> progress 0..1, or null if off the sweep. */
export function sweepProgress(b, x, y) {
  const ry = y - (b.y - 0.5);
  const row = Math.round(ry);
  if (row < 0 || row >= ROWS || Math.abs(ry - row) > 0.2) return null;
  const span = 3; // mockSource sweeps 3 cells regardless of block width
  let f = (row % 2 ? b.x + span - x : x - b.x) / span;
  if (f < -0.05 || f > 1.05) return null;
  f = Math.max(0, Math.min(1, f));
  return (row + f) / ROWS;
}

export function createMockCoverage() {
  let heads = new Map(); // jobId -> painted progress
  let primed = false;
  let sig = null, geo = null, H = 14, origin = null, cellM = 2.5, blocks = {};
  const K = MOCK_COVERAGE_PER_CELL;

  function ensureScenario(sc) {
    const s = sc ? JSON.stringify([sc.geo, sc.grid, sc.blocks]) : null;
    if (s === sig) return !!geo;
    sig = s; geo = makeGeo(sc);
    if (!geo) return false;
    H = (sc.grid && sc.grid.height) || 14;
    blocks = Object.fromEntries((sc.blocks || []).map((b) => [String(b.id), { x: +b.x, y: +b.y, w: +b.w || 4, h: +b.h || 3 }]));
    origin = geo.toLatLon(-0.5, H - 0.5); // SW corner of the grid
    cellM = geo.cellM / K;
    return true;
  }

  /** Append cells whose centers fall in the grid rect [x0,x1) x (y0,y1]. */
  function rectCells(x0, x1, y0, y1, rgb, out) {
    const cx0 = Math.ceil((x0 + 0.5) * K - 0.5), cx1 = Math.ceil((x1 + 0.5) * K - 0.5) - 1;
    const cy0 = Math.floor((H - 0.5 - y1) * K - 0.5) + 1, cy1 = Math.floor((H - 0.5 - y0) * K - 0.5);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) out.push([cx, cy, rgb]);
  }

  /** Cells for progress interval [p0, p1] of block b. */
  function bandCells(b, p0, p1, rgb, out) {
    const s0 = p0 * ROWS, s1 = p1 * ROWS;
    const X0 = b.x - 0.5, X1 = X0 + b.w, Y0 = b.y - 0.5, bh = b.h / ROWS;
    for (let r = 0; r < ROWS; r++) {
      const a = Math.max(s0, r), c = Math.min(s1, r + 1);
      if (c <= a) continue;
      const f0 = a - r, f1 = c - r;
      const xa = r % 2 ? X1 - f1 * b.w : X0 + f0 * b.w, xb = r % 2 ? X1 - f0 * b.w : X0 + f1 * b.w;
      rectCells(xa, xb, Y0 + r * bh, Y0 + (r + 1) * bh, rgb, out);
    }
  }

  return {
    /** Forget all paint (call on every snapshot / run). The next update() backfills from job progress. */
    reset() { heads = new Map(); primed = false; },
    /**
     * Advance paint from the current State. Returns contract-shaped coverage payloads (maybe empty).
     * Call it on poses/jobs/fleet/snapshot messages.
     */
    update(state) {
      if (!state || !ensureScenario(state.scenario)) return [];
      const fleet = state.fleet || [], jobs = state.jobs || [];
      const color = new Map(fleet.map((t, i) => [t.id, hexToInt(tractorColor(t, i))]));
      const byTractor = new Map();
      const cellsFor = (id) => { let a = byTractor.get(id || '?'); if (!a) byTractor.set(id || '?', (a = [])); return a; };
      const rgbOf = (id) => color.get(id) ?? 0x8e8e93;
      for (const j of jobs) {
        if (!j || !j.block || !blocks[j.block] || j.type === 'haul_bins') continue; // hauling bins paints no coverage
        const b = blocks[j.block];
        const head = heads.get(j.id) || 0;
        let target = head, painter = j.tractor;
        if (!primed) { target = Math.max(0, Math.min(1, +j.progress || 0)); }
        else {
          const w = fleet.find((t) => t.current_job === j.id && t.status === 'working' && t.pose);
          if (w) {
            painter = w.id;
            const pp = sweepProgress(b, +w.pose.x, +w.pose.y);
            if (pp != null && pp >= head - 0.02 && pp <= head + 0.34) target = Math.max(target, pp);
            const jp = +j.progress || 0;
            if (jp > target && jp <= head + 0.34) target = jp;
          } else if (j.status === 'done') target = 1;
          else if ((+j.progress || 0) > head + 1e-4) target = +j.progress; // missed the working poses
        }
        if (target > head + 1e-5) {
          bandCells(b, head, target, rgbOf(painter), cellsFor(painter));
          heads.set(j.id, target);
        }
      }
      primed = true;
      const out = [];
      for (const [tractor, cells] of byTractor) if (cells.length) out.push({ tractor, cell_m: cellM, origin: { lat: origin.lat, lon: origin.lon }, cells });
      return out;
    },
    /** debug: painted head per job */
    heads: () => new Map(heads),
  };
}

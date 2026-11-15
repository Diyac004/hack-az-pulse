// The work path for one block: the same boustrophedon AgOpenWeb drives (north-south passes one tool width
// apart, first pass toolWidth/2 inside the west edge, semicircle U-turns of radius toolWidth/2 that turn
// INTO the block). Used by (a) the bridge's lightweight simulation of tractors that are not currently in an
// AgOpenWeb container, and (b) handoff: projecting a real pose onto the path (demote) and picking the pass /
// AB line / heading / turn direction from a simulated position (promote).
//
// Coordinates are field-local metres of the block field: e east of, n north of the block's SW corner.

export function makeBlockPath(geom, toolWidth, headland = 8) {
  const H = geom.heightM, n0 = headland, n1 = H - headland, r = toolWidth / 2;
  const passes = geom.passes;
  const pts = []; // {e, n, pass, kind: 'pass'|'turn'}
  for (let k = 0; k < passes; k++) {
    const e = toolWidth / 2 + k * toolWidth, north = k % 2 === 0;
    pts.push({ e, n: north ? n0 : n1, pass: k, kind: 'pass' });
    pts.push({ e, n: north ? n1 : n0, pass: k, kind: 'pass' });
    if (k < passes - 1) { // semicircle to pass k+1 (east), bulging beyond the pass end
      const ce = e + r, cn = north ? n1 : n0;
      for (let i = 1; i < 12; i++) {
        const a = Math.PI - (i * Math.PI) / 12; // from west point (angle pi) to east point (0)
        pts.push({ e: ce + r * Math.cos(a), n: cn + (north ? 1 : -1) * r * Math.sin(a), pass: k, kind: 'turn' });
      }
    }
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].e - pts[i - 1].e, pts[i].n - pts[i - 1].n));
  const total = cum[cum.length - 1];

  /** Position + heading (deg, 0 = north, clockwise) at distance s along the path. */
  function at(s) {
    s = Math.max(0, Math.min(total, s));
    let i = 1;
    while (i < pts.length - 1 && cum[i] < s) i++;
    const a = pts[i - 1], b = pts[i], seg = cum[i] - cum[i - 1] || 1, f = (s - cum[i - 1]) / seg;
    const heading = ((Math.atan2(b.e - a.e, b.n - a.n) * 180) / Math.PI + 360) % 360;
    return { e: a.e + (b.e - a.e) * f, n: a.n + (b.n - a.n) * f, heading, pass: a.pass, onPass: a.kind === 'pass' && b.kind === 'pass' && a.pass === b.pass };
  }

  /** Nearest path distance to field-local (e, n); with sHint, prefers the match nearest sHint (no jumps). */
  function project(e, n, sHint = null) {
    let best = null;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dx = b.e - a.e, dy = b.n - a.n, L2 = dx * dx + dy * dy || 1;
      const f = Math.max(0, Math.min(1, ((e - a.e) * dx + (n - a.n) * dy) / L2));
      const d = Math.hypot(a.e + dx * f - e, a.n + dy * f - n);
      const s = cum[i - 1] + f * Math.sqrt(L2);
      const score = d + (sHint == null ? 0 : Math.abs(s - sHint) * 0.02);
      if (!best || score < best.score) best = { s, d, score };
    }
    return best;
  }

  /** Handoff plan at distance s: the pass to put AgOpenWeb on, its AB (south->north), heading, turn side. */
  function handoff(s) {
    let p = at(s);
    if (!p.onPass) { // mid-turn: hand over at the start of the next pass
      const k = Math.min(passes - 1, p.pass + 1);
      s = cum[k * 13]; p = at(s + 0.01);
    }
    const k = p.pass, north = k % 2 === 0;
    return { s, k, e: p.e, n: p.n, north, headingDeg: north ? 0 : 180, ab: geom.passAB(k), center: geom.passCenter(k), turn: north ? 'right' : 'left', lastPass: k === passes - 1 };
  }

  return { pts, cum, total, at, project, handoff, passes, toolWidth };
}

// AI Supervisor marks on the farm (Map view and 3D diorama): a DOM/SVG overlay, no scene objects.
//  - block flagged by the plot reviewer (open finding): dashed amber outline + "AI: houses, not orchard" tag
//  - block excluded from planning (scenario.disabled_blocks): grey hatch + "Excluded: <reason>" tag
// Projection: Map view via live.pickView().groundToScreen; 3D via the diorama camera (ground plane y = 0).
// Grid -> ground: x - (w-1)/2, z = y - (h-1)/2 (same as derive.makeGrid().toWorld). Block edges at x-0.5 .. x+w-0.5.
const SVGNS = 'http://www.w3.org/2000/svg';

export function createAiMapMarks({ stage, store, world, live }) {
  const host = document.createElement('div'); host.className = 'aimarks';
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.innerHTML = '<defs><pattern id="aihatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="9" height="9" fill="rgba(60,60,67,.38)"/><line x1="0" y1="0" x2="0" y2="9" stroke="rgba(255,255,255,.55)" stroke-width="3"/></pattern></defs>';
  host.appendChild(svg); stage.appendChild(host);
  const marks = new Map(); // key -> {poly, tag}
  const THREE = world && world.THREE;
  const v3 = THREE ? new THREE.Vector3() : null;

  function want(state) {
    const sc = state.scenario; if (!sc || !sc.grid) return [];
    const byId = Object.fromEntries((sc.blocks || []).map((b) => [b.id, b]));
    const out = [];
    const off = new Set();
    for (const d of sc.disabled_blocks || []) {
      const b = byId[d.block]; if (!b) continue; off.add(b.id);
      out.push({ key: 'off:' + b.id, b, kind: 'off', text: `Excluded: ${shortReason(d.reason)}` });
    }
    const ai = state.ai;
    for (const f of (ai && ai.findings) || []) {
      if (f.reviewer !== 'plots' || !f.action || !f.action.block || off.has(f.action.block)) continue;
      if (!['open', 'applying', 'failed', 'stale', 'rejected'].includes(f.status)) continue;
      const b = byId[f.action.block]; if (!b) continue;
      const lu = f.plot && f.plot.land_use ? f.plot.land_use.replace(/_/g, ' ').replace('roads or paved', 'roads') : 'not orchard';
      out.push({ key: 'flag:' + b.id, b, kind: 'flag', text: `AI: ${lu}, not orchard` });
    }
    return out;
  }
  const shortReason = (r) => { const s = String(r || 'not an orchard').replace(/^Aerial photo shows /i, '').replace(/\.$/, ''); return s.length > 42 ? s.slice(0, 40) + '…' : s; };

  function projector(state) {
    const g = state.scenario.grid, ox = (g.width - 1) / 2, oy = (g.height - 1) / 2;
    const pv = live && live.pickView ? live.pickView() : null;
    if (pv) return (gx, gy) => pv.groundToScreen(gx - ox, gy - oy);
    if (!(live && live.simVisible) || !world || !world.cam || !v3) return null;
    const el = world.R && world.R.domElement; const W = (el && el.clientWidth) || stage.clientWidth, H = (el && el.clientHeight) || stage.clientHeight;
    return (gx, gy) => { v3.set(gx - ox, 0.02, gy - oy).project(world.cam); return v3.z > 1 ? null : { x: (v3.x * 0.5 + 0.5) * W, y: (-v3.y * 0.5 + 0.5) * H }; };
  }

  function el(kind) {
    const poly = document.createElementNS(SVGNS, 'polygon');
    if (kind === 'off') { poly.setAttribute('fill', 'url(#aihatch)'); poly.setAttribute('stroke', 'rgba(255,255,255,.9)'); poly.setAttribute('stroke-width', '1.5'); }
    else { poly.setAttribute('fill', 'rgba(255,159,10,.10)'); poly.setAttribute('stroke', '#FF9F0A'); poly.setAttribute('stroke-width', '2.5'); poly.setAttribute('stroke-dasharray', '8 6'); }
    svg.appendChild(poly);
    const tag = document.createElement('div'); tag.className = 'aitag ' + kind; host.appendChild(tag);
    return { poly, tag };
  }

  let t0 = 0;
  return {
    /** per animation frame (cheap; skips work when there is nothing to draw) */
    tick(now) {
      if (now - t0 < 33) return; t0 = now;
      const state = store.get() || {};
      const list = want(state);
      const keys = new Set(list.map((m) => m.key));
      for (const [k, m] of marks) if (!keys.has(k)) { m.poly.remove(); m.tag.remove(); marks.delete(k); }
      if (!list.length) return;
      const P = projector(state);
      for (const m of list) {
        let e = marks.get(m.key); if (!e) { e = el(m.kind); marks.set(m.key, e); }
        const b = m.b, x0 = b.x - 0.5, x1 = b.x + b.w - 0.5, y0 = b.y - 0.5, y1 = b.y + b.h - 0.5;
        const pts = P ? [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)] : [];
        const okp = pts.length === 4 && pts.every((p) => p && isFinite(p.x) && isFinite(p.y));
        e.poly.style.display = okp ? '' : 'none'; e.tag.style.display = okp ? '' : 'none';
        if (!okp) continue;
        e.poly.setAttribute('points', pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
        const top = pts.reduce((a, p) => (p.y < a.y ? p : a), pts[0]);
        const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
        e.tag.textContent = m.text; e.tag.style.left = cx.toFixed(1) + 'px'; e.tag.style.top = (top.y - 4).toFixed(1) + 'px';
      }
    },
  };
}

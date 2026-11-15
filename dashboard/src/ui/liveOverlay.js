// DOM layer of the Live feed: block labels, tractor name tags and the tap readout card.
// Positions are pushed every visible frame (transform only); text updates are throttled by the caller.
import './livefeed.css';
import { esc, tractorColor, statusInfo, implName, isDown } from '../lib/format.js';

const CARD_W = 232;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (d) => COMPASS[Math.round((((d % 360) + 360) % 360) / 45) % 8];

export function createLiveOverlay(stage, { onFollow, onClose }) {
  const ovl = document.createElement('div'); ovl.className = 'lf-ovl'; ovl.setAttribute('aria-hidden', 'true');
  stage.appendChild(ovl);
  const blocks = new Map(); // id -> el
  const tags = new Map();   // id -> el

  // ---- card (built once; only text nodes / attributes change)
  const card = document.createElement('div');
  card.className = 'lf-card gl'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Tractor readout');
  card.innerHTML =
    '<div class="hd"><i></i><b></b><span class="st"></span><button type="button" class="x" aria-label="Close">×</button></div>' +
    '<dl><div><dt>Speed</dt><dd data-k="spd"></dd></div><div><dt>Heading</dt><dd data-k="hd"></dd></div>' +
    '<div><dt>Fuel</dt><dd data-k="fuel"></dd></div><div><dt>Tool</dt><dd data-k="tool"></dd></div></dl>' +
    '<div class="job"><p><span data-k="job"></span><span data-k="pct"></span></p><div class="bar"><u></u></div></div>' +
    '<div class="aow"><i></i><span></span></div>' +
    '<button type="button" class="fol" aria-pressed="false"></button>';
  stage.appendChild(card);
  const q = (s) => card.querySelector(s);
  const el = {
    dot: q('.hd i'), name: q('.hd b'), st: q('.hd .st'), x: q('.x'),
    spd: q('[data-k=spd]'), hd: q('[data-k=hd]'), fuel: q('[data-k=fuel]'), tool: q('[data-k=tool]'),
    job: q('[data-k=job]'), pct: q('[data-k=pct]'), bar: q('.bar u'), jobRow: q('.job'),
    aow: q('.aow'), aowTxt: q('.aow span'), fol: q('.fol'),
  };
  let cardId = null, following = false;
  const set = (node, v) => { if (node.textContent !== v) node.textContent = v; };
  el.x.addEventListener('click', () => onClose && onClose());
  el.fol.addEventListener('click', () => onFollow && onFollow(!following));
  card.addEventListener('pointerdown', (e) => e.stopPropagation());

  function blockEls(grid, scenario) {
    for (const e of blocks.values()) e.remove();
    blocks.clear();
    if (!grid) return;
    const variety = Object.fromEntries(((scenario && scenario.blocks) || []).map((b) => [String(b.id), b.variety]));
    for (const b of grid.blocks) {
      const d = document.createElement('div'); d.className = 'lf-blk';
      d.innerHTML = '<b>' + esc(b.id) + '</b>' + (variety[b.id] ? '<span>' + esc(variety[b.id]) + '</span>' : '');
      ovl.appendChild(d); blocks.set(b.id, d);
    }
  }

  return {
    /** Opacity of the map labels layer (the card is shared by both views and is not affected). */
    setOpacity(a) { const v = a.toFixed(3); if (ovl.style.opacity !== v) ovl.style.opacity = v; },
    rebuild: blockEls,
    setHeat(ids) { for (const [id, d] of blocks) d.classList.toggle('heat', ids.has(id)); },
    /** blockPos: id -> {x, y} px (label anchored at its top-left corner); tagPos: id -> {x, y} px of icon */
    place(blockPos, tagPos, iconPx) {
      for (const [id, d] of blocks) { const p = blockPos(id); if (p) d.style.transform = 'translate3d(' + (p.x + 6).toFixed(1) + 'px,' + (p.y + 6).toFixed(1) + 'px,0)'; }
      for (const [id, d] of tags) {
        const p = tagPos(id);
        if (!p) { d.style.display = 'none'; continue; }
        d.style.display = '';
        d.style.transform = 'translate3d(' + (p.x + iconPx * 0.45).toFixed(1) + 'px,' + (p.y - iconPx * 0.45 - 16).toFixed(1) + 'px,0)';
      }
    },
    /** Anchor the card next to a tractor at screen point p ({x, y} px). Used by both views. */
    placeCard(p, iconPx) {
      if (!cardId || !p) return;
      {
        const W = stage.clientWidth, H = stage.clientHeight, ch = card.offsetHeight || 220;
        let x = p.x + iconPx * 0.7 + 10, y = p.y - ch / 2;
        if (x + CARD_W > W - 10) x = p.x - iconPx * 0.7 - 10 - CARD_W; // flip to the left side
        card.style.transformOrigin = (x < p.x ? '100%' : '0') + ' 50%';
        x = Math.max(10, Math.min(W - CARD_W - 10, x)); y = Math.max(56, Math.min(H - ch - 10, y));
        card.style.left = x.toFixed(1) + 'px'; card.style.top = y.toFixed(1) + 'px';
      }
    },
    /** Text refresh (throttled by caller). */
    sync(state) {
      const fleet = state.fleet || [];
      const ids = new Set();
      fleet.forEach((tr, i) => {
        if (!tr || !tr.id) return; ids.add(tr.id);
        let d = tags.get(tr.id);
        if (!d) { d = document.createElement('div'); d.className = 'lf-tag'; ovl.appendChild(d); tags.set(tr.id, d); }
        set(d, tr.id);
        d.classList.toggle('down', isDown(tr.status));
        d.style.boxShadow = 'inset 3px 0 0 ' + tractorColor(tr, i) + ',0 1px 3px rgba(0,0,0,.18)';
      });
      for (const [id, d] of tags) if (!ids.has(id)) { d.remove(); tags.delete(id); }
      if (!cardId) return;
      const i = fleet.findIndex((t) => t.id === cardId);
      if (i < 0) { onClose && onClose(); return; }
      const tr = fleet[i], p = tr.pose || {}, info = statusInfo(tr.status), color = tractorColor(tr, i);
      el.dot.style.background = color;
      set(el.name, tr.name || tr.id);
      set(el.st, info.label); el.st.style.color = info.color || '#6e6e73';
      set(el.spd, isFinite(p.speed_mph) && p.speed_mph !== null ? (+p.speed_mph).toFixed(1) + ' mph' : '—');
      set(el.hd, isFinite(p.heading_deg) && p.heading_deg !== null ? Math.round(((+p.heading_deg % 360) + 360) % 360) + '° ' + compass(+p.heading_deg) : '—');
      set(el.fuel, isFinite(tr.fuel_pct) && tr.fuel_pct !== null ? Math.round(tr.fuel_pct) + '%' : '—');
      el.fuel.style.color = tr.fuel_pct != null && tr.fuel_pct < 20 ? '#C2261C' : '';
      const job = tr.current_job ? (state.jobs || []).find((j) => j.id === tr.current_job) : null;
      const impl = job && job.implement && (tr.implements || []).includes(job.implement) ? job.implement : (tr.implements || [])[0];
      const wm = tr.tool && tr.tool.width_m > 0 ? tr.tool.width_m : null;
      set(el.tool, (impl ? implName(impl) : 'tool') + (wm ? ' · ' + (+wm).toFixed(1) + ' m' : ''));
      el.tool.title = el.tool.textContent;
      if (job) {
        const pr = Math.max(0, Math.min(1, +job.progress || 0));
        set(el.job, job.label || job.id); set(el.pct, Math.round(pr * 100) + '%');
        el.bar.style.width = (pr * 100).toFixed(1) + '%'; el.bar.style.background = color;
      } else { set(el.job, 'No current job'); set(el.pct, ''); el.bar.style.width = '0'; }
      const a = tr.agopenweb;
      if (a) {
        el.aow.className = 'aow ' + (a.connected ? 'on' : 'off');
        const hb = a.heartbeat_age_ms != null ? ' · ' + Math.round(a.heartbeat_age_ms) + ' ms' : '';
        set(el.aowTxt, 'AgOpenWeb ' + (a.endpoint || '') + hb + ' · autosteer ' + (a.autosteer ? 'on' : 'off'));
        el.aow.title = el.aowTxt.textContent;
      } else { el.aow.className = 'aow'; set(el.aowTxt, 'Simulated · no AgOpenWeb link'); el.aow.title = 'MockGateway tractor (agopenweb is null)'; }
      el.fol.setAttribute('aria-pressed', following ? 'true' : 'false');
      set(el.fol, following ? 'Following · drag to stop' : 'Follow');
    },
    openCard(id) { cardId = id; card.classList.add('on'); },
    closeCard() { cardId = null; card.classList.remove('on'); },
    setFollowing(v) { following = !!v; el.fol.setAttribute('aria-pressed', following ? 'true' : 'false'); set(el.fol, following ? 'Following · drag to stop' : 'Follow'); },
    get cardId() { return cardId; },
    clear() { for (const d of tags.values()) d.remove(); tags.clear(); },
    dispose() { ovl.remove(); card.remove(); },
  };
}

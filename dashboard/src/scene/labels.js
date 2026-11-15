// Per-block floating label: block letter bubble + a short list of its open jobs (priority dot, % done).
import * as THREE from 'three';
import { priColor } from '../lib/format.js';

const MAXROWS = 3;
const short = (j) => {
  const ty = { spray: 'Spray', mow: 'Mow', hedge: 'Hedge', haul_bins: 'Haul' }[j.type] || (j.label || j.id).split(' ')[0];
  return ty + (j.progress > 0.005 ? ' ' + Math.round(j.progress * 100) + '%' : '');
};

function draw(cv, block, jobs, unassigned) {
  const rows = jobs.slice(0, MAXROWS), more = jobs.length - rows.length;
  const g = cv.getContext('2d');
  const RW = 132, RH = 30, top = 70;
  const n = rows.length + (more > 0 ? 1 : 0);
  cv.width = 160; cv.height = top + n * (RH + 4) + 4;
  g.clearRect(0, 0, cv.width, cv.height);
  // letter bubble
  g.fillStyle = 'rgba(255,255,255,.92)'; g.beginPath(); g.arc(80, 32, 28, 0, 7); g.fill();
  g.fillStyle = '#1d1d1f'; g.font = '600 32px -apple-system,BlinkMacSystemFont,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(block, 80, 34);
  rows.forEach((j, i) => {
    const y = top + i * (RH + 4), x = (160 - RW) / 2;
    const un = unassigned.has(j.id);
    // dark glass rows stay under the bloom threshold so text stays crisp
    g.fillStyle = un ? 'rgba(90,20,16,.78)' : 'rgba(22,22,24,.68)';
    g.beginPath(); g.roundRect ? g.roundRect(x, y, RW, RH, 15) : g.rect(x, y, RW, RH); g.fill();
    if (un) { g.strokeStyle = '#FF453A'; g.lineWidth = 2; g.setLineDash([5, 4]); g.stroke(); g.setLineDash([]); }
    g.fillStyle = priColor(j.priority); g.beginPath(); g.arc(x + 16, y + RH / 2, 7, 0, 7); g.fill();
    g.fillStyle = '#C8C8CE'; g.font = '600 19px -apple-system,BlinkMacSystemFont,sans-serif'; g.textAlign = 'left';
    g.fillText(un ? short(j) + ' · ?' : short(j), x + 30, y + RH / 2 + 1);
  });
  if (more > 0) { g.fillStyle = 'rgba(22,22,24,.75)'; g.font = '600 16px -apple-system,sans-serif'; g.textAlign = 'center'; g.fillText('+' + more + ' more', 80, top + rows.length * (RH + 4) + RH / 2); }
}

export function createLabels(world, farm) {
  const { S } = world;
  const map = new Map(); // block -> { sp, cv, sig }
  return {
    clear() { for (const r of map.values()) { S.remove(r.sp); r.sp.material.map.dispose(); r.sp.material.dispose(); } map.clear(); },
    sync(state, unassignedIds) {
      const g = farm.grid; if (!g) return;
      const open = {};
      for (const j of state.jobs || []) if (j && j.status !== 'done' && j.status !== 'dropped' && j.block) (open[j.block] = open[j.block] || []).push(j);
      const un = new Set(unassignedIds || []);
      for (const b of g.blocks) {
        const js = (open[b.id] || []).slice().sort((a, c) => (c.priority || 0) - (a.priority || 0) || (a.deadline_t || 0) - (c.deadline_t || 0));
        const sig = js.map((j) => j.id + j.priority + Math.round((j.progress || 0) * 100) + (un.has(j.id) ? 'u' : '')).join('|');
        let r = map.get(b.id);
        if (!r) {
          const cv = document.createElement('canvas');
          const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
          sp.center.set(0.5, 0); sp.renderOrder = 10;
          const c = g.blockCenter(b), w = g.toWorld(c.x, c.y);
          sp.position.set(w.x, 1.25, w.z); S.add(sp);
          r = { sp, cv, sig: null }; map.set(b.id, r);
        }
        if (r.sig === sig) continue;
        r.sig = sig;
        draw(r.cv, b.id, js, un);
        r.sp.material.map.dispose(); r.sp.material.map = new THREE.CanvasTexture(r.cv); r.sp.material.needsUpdate = true;
        const s = 0.75 / 56; // keep the letter bubble at the prototype's size
        r.sp.scale.set(r.cv.width * s, r.cv.height * s, 1);
      }
      for (const id of [...map.keys()]) if (!g.blockById[id]) { const r = map.get(id); S.remove(r.sp); r.sp.material.dispose(); map.delete(id); }
    },
  };
}

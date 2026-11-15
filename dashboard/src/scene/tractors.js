// Tractor meshes keyed by id: pose interpolation (5 Hz -> 60 fps), status rings, pop-in/out, route ribbons.
// Perf notes: paint/neutral/beacon/ring geometries and the neutral + beacon materials are shared by every
// tractor (module-level, never disposed per tractor). Each tractor owns only its paint, ring, spin and ribbon
// materials plus one fixed-capacity ribbon geometry that is rewritten in place, never re-created.
import * as THREE from 'three';
import { buildTractorA, A_ANCHORS, M } from './tractorModelA.js';
import { headingToRotY, activeRoute } from '../lib/derive.js';
import { tractorColor, statusInfo, isDown } from '../lib/format.js';

const stripe = (() => {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = 64; c.height = 4; const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 64, 0); gr.addColorStop(0, 'rgba(255,255,255,.2)'); gr.addColorStop(0.5, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,.2)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 4); return c;
})();

// ---- shared, created once ----
// Model: direction A (textures/_build/build.mjs). Geometry lives in tractorModelA.js; here it is split into
// one paint mesh (per-tractor colour x vertex-colour multiplier), one neutral mesh (vertex colours) and a
// tiny beacon mesh that swaps between two shared materials. 3 draws per tractor (+ ring), 2 shadow casters.
export const TR_SCALE = 0.85; // model -> world; A is 1.12 long incl. hitch -> 0.95 world
let SH = null;
function shared() {
  if (SH) return SH;
  const A = buildTractorA();
  const tex = new THREE.CanvasTexture(stripe); tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  SH = {
    paintGeo: A.paint, neutralGeo: A.neutral, beaconGeo: A.beacon, tris: A.tris,
    ringGeo: new THREE.RingGeometry(0.62, 0.76, 40), // inner radius clears A's 0.56 half-length
    spinGeo: new THREE.RingGeometry(0.82, 0.9, 40, 1, 0, Math.PI * 1.3),
    neutralMat: new THREE.MeshLambertMaterial({ color: '#ffffff', vertexColors: true }),
    beaconOk: new THREE.MeshLambertMaterial({ color: M.amber, emissive: M.amber, emissiveIntensity: 0.55 }),
    beaconBad: new THREE.MeshLambertMaterial({ color: M.red, emissive: M.red, emissiveIntensity: 0.6 }),
    stripe: tex, // shared; ribbon UVs carry arc length so one texture/offset serves every tractor
  };
  return SH;
}

const C_RED = new THREE.Color('#FF453A'), C_ORANGE = new THREE.Color('#FF9F0A'), C_GREY = new THREE.Color('#8e8e93');
const EXHAUST = new THREE.Vector3().fromArray(A_ANCHORS.exhaustTop), _EX = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0);
/** World position of the exhaust stack top (reuses one vector; copy it if you keep it). */
const exhaustWorld = (g) => _EX.copy(EXHAUST).multiplyScalar(g.scale.x).applyAxisAngle(_Y, g.rotation.y).add(g.position);

function mkTractor(c) {
  const sh = shared();
  const g = new THREE.Group();
  const paint = new THREE.MeshLambertMaterial({ color: c, vertexColors: true });
  const hull = new THREE.Mesh(sh.paintGeo, paint);
  const kit = new THREE.Mesh(sh.neutralGeo, sh.neutralMat);
  const beacon = new THREE.Mesh(sh.beaconGeo, sh.beaconOk);
  hull.castShadow = kit.castShadow = true;
  g.add(hull, kit, beacon);
  // ring sits clearly above the grass + soil rim (0.02) so it never z-fights while sweeping a block
  const ring = new THREE.Mesh(sh.ringGeo, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.09; g.add(ring);
  // dashed spinner ring for `starting`
  const spin = new THREE.Mesh(sh.spinGeo, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  spin.rotation.x = -Math.PI / 2; spin.position.y = 0.095; spin.visible = false; g.add(spin);
  g.userData = { ring, spin, paint, beacon };
  return g;
}

// ---- route ribbon: fixed-capacity tube rewritten in place ----
const RAD = 6, RV = RAD + 1, TUBE_R = 0.07, RIB_Y = 0.13, STRIPE_LEN = 1.1;
function makeRibGeo(segCap) {
  const nv = (segCap + 1) * RV;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(nv * 2), 2).setUsage(THREE.DynamicDrawUsage));
  const idx = new (nv > 65535 ? Uint32Array : Uint16Array)(segCap * RAD * 6);
  let k = 0;
  for (let j = 1; j <= segCap; j++) for (let i = 1; i <= RAD; i++) { // same winding as TubeGeometry
    const a = RV * (j - 1) + (i - 1), b = RV * j + (i - 1), c = RV * j + i, d = RV * (j - 1) + i;
    idx[k++] = a; idx[k++] = b; idx[k++] = d; idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.userData.segCap = segCap;
  g.setDrawRange(0, 0);
  return g;
}

const _P = new THREE.Vector3(), _T = new THREE.Vector3(), _B = new THREE.Vector3(), _UP = new THREE.Vector3(0, 1, 0);
let samples = new Float32Array(3 * 64);

function routeHash(pts) {
  let h = pts.length;
  for (let i = 0; i < pts.length; i++) h = (h * 31 + Math.round(pts[i][0] * 1000)) * 31 + Math.round(pts[i][1] * 1000) | 0;
  return h;
}

export function createTractors(world, farm, fx) {
  const { S } = world;
  const map = new Map(); // id -> rec
  let lastSmoke = 0, lastRib = 0;

  const W = (x, y, out) => { const p = farm.grid.toWorld(x, y); return (out || new THREE.Vector3()).set(p.x, 0, p.z); };
  const _to = new THREE.Vector3();

  function hideRib(rec) { if (rec.rib) rec.rib.visible = false; rec.ribHash = null; }

  function ribbon(rec, pts) {
    if (!pts || pts.length < 2) { hideRib(rec); return; }
    const h = routeHash(pts);
    if (h === rec.ribHash && rec.rib && rec.rib.visible) return; // unchanged route: keep the buffers
    // control points (pooled per tractor)
    const cp = rec.cpts;
    while (cp.length < pts.length) cp.push(new THREE.Vector3());
    const used = rec.cused; used.length = pts.length;
    for (let i = 0; i < pts.length; i++) { W(pts[i][0], pts[i][1], cp[i]); cp[i].y = RIB_Y; used[i] = cp[i]; }
    const cv = rec.curve; cv.points = used; cv.updateArcLengths();
    const L = cv.getLength();
    if (L < 0.2) { hideRib(rec); return; }
    const segs = Math.max(8, pts.length * 5);
    if (!rec.rib) {
      rec.rib = new THREE.Mesh(makeRibGeo(Math.max(64, segs)), rec.rm);
      rec.rib.frustumCulled = false; // buffers are rewritten in place; skip stale bounding spheres
      S.add(rec.rib);
    } else if (segs > rec.rib.geometry.userData.segCap) {
      let cap = rec.rib.geometry.userData.segCap; while (cap < segs) cap *= 2;
      rec.rib.geometry.dispose(); rec.rib.geometry = makeRibGeo(cap);
    }
    if (samples.length < (segs + 1) * 3) samples = new Float32Array((segs + 1) * 3 * 2);
    for (let i = 0; i <= segs; i++) { cv.getPointAt(i / segs, _P); samples[i * 3] = _P.x; samples[i * 3 + 1] = _P.y; samples[i * 3 + 2] = _P.z; }
    const geo = rec.rib.geometry, pos = geo.attributes.position.array, uv = geo.attributes.uv.array;
    const uScale = L / STRIPE_LEN;
    for (let i = 0; i <= segs; i++) {
      const i0 = Math.max(0, i - 1) * 3, i1 = Math.min(segs, i + 1) * 3;
      _T.set(samples[i1] - samples[i0], 0, samples[i1 + 2] - samples[i0 + 2]);
      if (_T.lengthSq() > 1e-12) { _T.normalize(); _B.crossVectors(_T, _UP); } // N = up, B = T x N (Frenet handedness)
      const px = samples[i * 3], py = samples[i * 3 + 1], pz = samples[i * 3 + 2];
      for (let j = 0; j <= RAD; j++) {
        const v = (j / RAD) * Math.PI * 2, sn = Math.sin(v), cs = -Math.cos(v);
        const o = (i * RV + j) * 3;
        pos[o] = px + TUBE_R * (cs * _UP.x + sn * _B.x);
        pos[o + 1] = py + TUBE_R * (cs * _UP.y + sn * _B.y);
        pos[o + 2] = pz + TUBE_R * (cs * _UP.z + sn * _B.z);
        const q = (i * RV + j) * 2; uv[q] = (i / segs) * uScale; uv[q + 1] = j / RAD;
      }
    }
    geo.attributes.position.needsUpdate = true; geo.attributes.uv.needsUpdate = true;
    geo.setDrawRange(0, segs * RAD * 6);
    rec.rib.visible = true; rec.ribHash = h;
  }

  function remove(rec, animate) {
    hideRib(rec);
    if (animate) { rec.leaving = performance.now(); return; }
    S.remove(rec.g);
    const ud = rec.g.userData; ud.paint.dispose(); ud.ring.material.dispose(); ud.spin.material.dispose(); // shared geometries stay
    if (rec.rib) { S.remove(rec.rib); rec.rib.geometry.dispose(); rec.rib = null; }
    rec.rm.dispose(); // stripe texture is shared
    map.delete(rec.id);
  }

  return {
    get(id) { return map.get(id); },
    worldPos(id) { const r = map.get(id); return r ? r.g.position.clone() : null; },
    /** Non-allocating: writes the tractor's current world position into `out` and returns it, or null if unknown. */
    positionOf(id, out) { const r = map.get(id); return r ? out.copy(r.g.position) : null; },
    clear() { for (const r of map.values()) remove(r, false); },
    /** Reconcile with state.fleet. `initial` = true for snapshots (no pop-in fanfare). */
    sync(state, initial) {
      if (!farm.grid) return;
      const fleet = state.fleet || [];
      const seen = new Set();
      const now = performance.now();
      fleet.forEach((tr, i) => {
        if (!tr || !tr.id) return;
        seen.add(tr.id);
        let rec = map.get(tr.id);
        const color = tractorColor(tr, i);
        const pose = tr.pose || farm.grid.depot;
        if (!rec || rec.leaving) {
          if (rec) remove(rec, false);
          const g = mkTractor(color);
          const p = W(+pose.x || 0, +pose.y || 0);
          g.position.copy(p); g.rotation.y = headingToRotY(tr.pose ? tr.pose.heading_deg : 0);
          g.scale.setScalar(initial ? TR_SCALE : 0.01);
          S.add(g);
          const rm = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).offsetHSL(0, 0, 0.08), map: shared().stripe, transparent: true, opacity: 0.95 });
          rec = { id: tr.id, g, rm, rib: null, ribHash: null, curve: new THREE.CatmullRomCurve3([], false, 'catmullrom', 0.02), cpts: [], cused: [],
            color, col: new THREE.Color(color), born: initial ? 0 : now, from: p.clone(), to: p.clone(), t0: now, dur: 200, lastUpd: now, rot: g.rotation.y, status: tr.status };
          map.set(tr.id, rec);
          if (!initial) fx.ripple(p, '#30D158');
        }
        if (rec.color !== color) { rec.color = color; rec.col.set(color); rec.g.userData.paint.color.set(color); rec.rm.color.set(color).offsetHSL(0, 0, 0.08); }
        // pose interpolation target
        if (tr.pose && isFinite(tr.pose.x) && isFinite(tr.pose.y)) {
          const to = W(tr.pose.x, tr.pose.y, _to);
          if (to.distanceToSquared(rec.to) > 1e-6) {
            const gap = now - rec.lastUpd; rec.lastUpd = now;
            rec.from.copy(rec.g.position); rec.to.copy(to); rec.t0 = now;
            rec.dur = Math.max(120, Math.min(600, gap || 200));
          }
          if (tr.pose.heading_deg != null && isFinite(tr.pose.heading_deg)) rec.rot = headingToRotY(tr.pose.heading_deg);
        }
        rec.status = tr.status; rec.tr = tr;
      });
      for (const rec of map.values()) if (!seen.has(rec.id) && !rec.leaving) remove(rec, !initial);
    },
    tick(state, now, dt) {
      if (!farm.grid) return;
      const doSmoke = now - lastSmoke > 140; if (doSmoke) lastSmoke = now;
      const doRib = now - lastRib > 250; if (doRib) lastRib = now;
      const pulse = 0.5 + 0.5 * Math.sin(now / 180);
      if (SH) { SH.stripe.offset.x = (SH.stripe.offset.x - dt * 1.6) % 1; SH.beaconBad.emissiveIntensity = 0.3 + 0.7 * pulse; }
      for (const rec of map.values()) { // deleting the current entry during for-of is safe for Map
        const g = rec.g, ud = g.userData;
        if (rec.leaving) {
          const a = Math.min(1, (now - rec.leaving) / 400); g.scale.setScalar(TR_SCALE * (1 - a) + 0.001);
          if (a >= 1) { rec.leaving = null; remove(rec, false); }
          continue;
        }
        // position: linear interp over the measured update interval
        const f = Math.min(1, (now - rec.t0) / rec.dur);
        g.position.lerpVectors(rec.from, rec.to, f);
        let d = rec.rot - g.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); g.rotation.y += d * 0.2;
        // pop-in with overshoot
        if (rec.born) {
          const a = Math.min(1, (now - rec.born) / 600), e = a === 1 ? 1 : 1 + Math.sin(a * Math.PI * 1.5) * 0.3 * (1 - a);
          g.scale.setScalar(Math.max(0.01, TR_SCALE * a * e)); if (a >= 1) rec.born = 0;
        }
        const info = statusInfo(rec.status), ring = ud.ring;
        ud.beacon.material = info.ring === 'broken' ? SH.beaconBad : SH.beaconOk; // shared materials: nothing to dispose
        ud.spin.visible = info.ring === 'spin';
        if (ud.spin.visible) ud.spin.rotation.z = -now / 250;
        if (info.ring === 'broken') {
          ring.material.color.copy(C_RED); ring.scale.setScalar(1 + 0.25 * pulse); ring.material.opacity = 0.5 + 0.5 * pulse;
          if (doSmoke && (rec.status === 'broken' || rec.status === 'awaiting_mechanic')) { const e = exhaustWorld(g); fx.smoke(e, e.y); } // puffs start at the stack top
        } else if (info.ring === 'repair') {
          ring.material.color.copy(C_ORANGE); ring.scale.setScalar(1 + 0.15 * pulse); ring.material.opacity = 0.85;
        } else if (info.ring === 'fade') {
          ring.material.color.copy(C_GREY); ring.scale.setScalar(1); ring.material.opacity = 0.5;
        } else {
          ring.material.color.copy(rec.col); ring.scale.setScalar(info.ring === 'pulse' ? 1 + 0.08 * pulse : 1); ring.material.opacity = info.ring === 'spin' ? 0.4 : 0.85;
        }
        if (doRib) ribbon(rec, rec.tr && !isDown(rec.status) ? activeRoute(state, rec.tr) : null);
      }
    },
  };
}

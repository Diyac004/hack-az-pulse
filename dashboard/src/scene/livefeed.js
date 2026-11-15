// Live feed view: top-down map of the same fleet (PROJECT.md Change 7, FEATURES.md step 15).
//
// Own WebGL canvas + scene stacked right above the diorama canvas, in the SAME world units (1 unit = 1 grid
// cell, world = grid.toWorld), so the two views line up. Switching animates one progress value p in [0,1]:
// the diorama camera tilts to straight overhead while the map canvas (rendered through a copy of that camera)
// cross-fades in; at p = 1 the map swaps to an orthographic camera with the same framing and the diorama is no
// longer rendered. Switching back reverses it from the current map framing.
//
// Hidden (p = 0) cost: no rendering, no per-frame work. Pose/coverage messages still accumulate trails and
// coverage on the CPU so nothing is missing when the view opens.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeGrid, blockedCells, cellKey } from '../lib/derive.js';
import { isDown } from '../lib/format.js';
import { makeGeo } from '../lib/geo.js';
import { createCoverageGrid } from '../lib/coverageGrid.js';
import { createMockCoverage } from '../data/mockCoverage.js';
import { buildGround, LAND } from './liveBasemap.js';
import { createLiveTractors, disposeShared, ICON_LEN } from './liveTractors.js';
import { createLiveOverlay } from '../ui/liveOverlay.js';
import { createViewState } from '../lib/viewState.js';
import { createSimOverlay } from './simOverlay.js';

const DUR = 1150;                         // ms for the camera tilt + cross-fade
const OVERHEAD_PHI = 1e-4;                // polar angle for "straight down" (north stays up)
const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * @param toggle            the view toggle (ui/viewToggle.js); kept in sync when the view is restored
 * @param dioramaTractors   scene/tractors.js instance: gives the 3D positions for the Simulated-view overlays
 */
export function createLiveFeed({ stage, world, store, sourceInfo, toggle = null, dioramaTractors = null, onRepair = null, onControls = null }) {
  let pickGuard = () => false; // map_pick (scene/mapPick.js) running: taps are picks, not tractor selection
  let sessionStore = null; try { sessionStore = window.sessionStorage; } catch (e) { sessionStore = null; }
  const vs = createViewState({ storage: sessionStore, search: typeof location !== 'undefined' ? location.search : '' });
  let pendingRestore = vs.restore === 'live';
  // ---------- renderer / scene / cameras
  const R = new THREE.WebGLRenderer({ antialias: true });
  R.setPixelRatio(Math.min(devicePixelRatio, 2));
  R.domElement.className = 'lf-canvas';
  R.domElement.setAttribute('aria-label', 'Farm map');
  world.R.domElement.after(R.domElement);
  let SW = stage.clientWidth || 800, SH = stage.clientHeight || 600;
  R.setSize(SW, SH);

  const L = new THREE.Scene(); L.background = new THREE.Color(LAND);
  const O = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500);
  const PC = new THREE.PerspectiveCamera(38, SW / SH, 0.1, 400);
  const CAM_H = 100;
  O.position.set(0, CAM_H, 1e-3); O.lookAt(0, 0, 0);
  let halfH0 = 10; // ortho half-height at zoom 1 (= "fit farm")

  const ctl = new OrbitControls(O, R.domElement);
  ctl.enableRotate = false; ctl.screenSpacePanning = true; ctl.enableDamping = true; ctl.dampingFactor = 0.14;
  ctl.minZoom = 0.6; ctl.maxZoom = 12; ctl.zoomSpeed = 0.9; ctl.enabled = false;
  ctl.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  ctl.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };

  // Simulated-view parity (coverage on the ground, trails, AB lines, tap + follow) reads this module's data.
  const sim = dioramaTractors ? createSimOverlay(world, dioramaTractors) : null;
  const tractors = createLiveTractors(L, sim ? { onCreate: (r) => sim.attach(r), onRemove: (r) => sim.detach(r) } : {});
  const overlay = createLiveOverlay(stage, {
    onFollow: (on) => setFollow(on ? overlay.cardId : null),
    onClose: () => select(null),
    onRepair: (id, els) => onRepair && onRepair(id, els),
    onControls: onControls ? (id) => onControls(id) : null,
  });

  // ---------- data
  let grid = null, geo = null, ground = null, scSig = null;
  let cov = null, covTex = null, covMesh = null, lastUpload = 0, covVer = -1;
  let realCoverage = false, warnedNoGeo = false, warnedOutside = false;
  const mockCov = sourceInfo && sourceInfo.kind === 'mock' ? createMockCoverage() : null;
  const barrierMats = { fill: new THREE.MeshBasicMaterial({ color: '#FF453A', transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }), x: new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }) };
  const barrierGeo = new THREE.PlaneGeometry(1, 1);
  const barriers = new Map();
  let heat = new Set();
  const prevStatus = new Map();

  function disposeCoverage() {
    if (covMesh) { L.remove(covMesh); covMesh.geometry.dispose(); covMesh.material.dispose(); covMesh = null; }
    if (covTex) { covTex.dispose(); covTex = null; }
    cov = null;
  }
  function clearBarriers() { for (const g of barriers.values()) L.remove(g); barriers.clear(); }

  function rebuild(state) {
    const sc = state.scenario;
    const sig = JSON.stringify(sc ? { g: sc.grid, r: sc.roads, b: sc.blocks, d: sc.depot, m: sc.basemap, geo: sc.geo } : null);
    if (sig === scSig && grid) return false;
    scSig = sig;
    if (ground) ground.dispose();
    disposeCoverage(); clearBarriers(); tractors.clear(); prevStatus.clear();
    grid = makeGrid(sc); geo = makeGeo(sc);
    ground = buildGround(grid, geo, sc, sourceInfo && sourceInfo.kind === 'live' ? sourceInfo.api : null);
    L.add(ground.group);
    if (geo) {
      cov = createCoverageGrid(grid.w, grid.h, geo);
      covTex = new THREE.DataTexture(cov.data, cov.width, cov.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      covTex.magFilter = covTex.minFilter = THREE.NearestFilter; covTex.generateMipmaps = false; covTex.needsUpdate = true;
      const ox = (grid.w - 1) / 2, oy = (grid.h - 1) / 2;
      covMesh = new THREE.Mesh(new THREE.PlaneGeometry(cov.ex1 - cov.ex0, cov.ey1 - cov.ey0), new THREE.MeshBasicMaterial({ map: covTex, transparent: true, opacity: 0.62, depthTest: false, depthWrite: false }));
      covMesh.rotation.x = -Math.PI / 2; covMesh.renderOrder = 3;
      covMesh.position.set((cov.ex0 + cov.ex1) / 2 - ox, 0, (cov.ey0 + cov.ey1) / 2 - oy);
      L.add(covMesh); covVer = -1;
    } else if (!warnedNoGeo) { warnedNoGeo = true; console.warn('[livefeed] scenario.geo missing: positions use grid x/y, coverage cannot be placed'); }
    if (sim) sim.setCoverage(cov, grid);
    overlay.rebuild(grid, sc); overlay.setHeat(heat);
    computeFit(); if (p === 0 || view === 'live') applyFit(true);
    if (pendingRestore) { pendingRestore = false; console.info('[livefeed] restoring the Map view (last chosen view; survives page reloads)'); setView('live', 'restore'); }
    return true;
  }

  function syncBarriers(state) {
    if (!grid) return;
    const want = new Map(blockedCells(state).map((c) => [cellKey(c[0], c[1]), c]));
    const ox = (grid.w - 1) / 2, oy = (grid.h - 1) / 2;
    for (const [k, c] of want) {
      if (barriers.has(k)) continue;
      const g = new THREE.Group();
      const f = new THREE.Mesh(barrierGeo, barrierMats.fill); f.scale.set(0.82, 0.82, 1);
      const a = new THREE.Mesh(barrierGeo, barrierMats.x); a.scale.set(0.8, 0.09, 1); a.rotation.z = Math.PI / 4;
      const b = new THREE.Mesh(barrierGeo, barrierMats.x); b.scale.set(0.8, 0.09, 1); b.rotation.z = -Math.PI / 4;
      [f, a, b].forEach((m, i) => { m.renderOrder = 6 + (i ? 0.5 : 0); g.add(m); });
      g.rotation.x = -Math.PI / 2; g.position.set(c[0] - ox, 0, c[1] - oy);
      L.add(g); barriers.set(k, g);
      if (p > 0) tractors.ripple(c[0] - ox, c[1] - oy, '#FF9F0A');
    }
    for (const k of [...barriers.keys()]) if (!want.has(k)) { L.remove(barriers.get(k)); barriers.delete(k); }
  }

  function runMockCoverage(state) {
    if (!mockCov || realCoverage || !cov) return;
    for (const c of mockCov.update(state)) cov.paint(c);
  }

  let textDirty = true, farmT = 0;
  function onMessage(state, msg) {
    if (!msg || !state) return;
    const prevT = farmT;
    if (typeof msg.t === 'number' && isFinite(msg.t)) farmT = msg.t;
    const type = msg.type;
    if (type === 'snapshot' || (type === 'scenario' && state.scenario)) {
      const rebuilt = rebuild(state);
      // Same test as main.js: clock went backwards (or first) = new day -> drop paint/trails. A reconnect or
      // seq-gap resync of the same day keeps them, because `coverage` only ever carries NEW cells.
      const newRun = !state.clock || state.clock.t + 0.5 < prevT || prevT === 0;
      if (type === 'snapshot' && (newRun || rebuilt)) {
        if (cov) cov.clear();
        if (mockCov) mockCov.reset();
        tractors.resetHistory();
      }
      if (type === 'snapshot') {
        prevStatus.clear();
        tractors.sync(state, grid, geo, true);
        for (const t of state.fleet || []) prevStatus.set(t.id, t.status);
        runMockCoverage(state);
      } else if (rebuilt) tractors.sync(state, grid, geo, true);
      syncBarriers(state);
    }
    if (!grid) return;
    // an `agopenweb` log line can carry a new AB line (Tractor Control Panel): re-sync so both views show it now
    if (type === 'poses' || type === 'fleet' || (type === 'log' && msg.data && msg.data.kind === 'agopenweb')) {
      tractors.sync(state, grid, geo, false);
      for (const t of state.fleet || []) {
        const prev = prevStatus.get(t.id);
        if (p > 0 && prev !== undefined && prev !== t.status) {
          const w = tractors.worldPos(t.id);
          if (w && t.status === 'broken' && !isDown(prev)) { tractors.ripple(w.x, w.z, '#FF453A', 1.4); setTimeout(() => tractors.ripple(w.x, w.z, '#FF453A', 1.4), 350); }
          if (w && isDown(prev) && !isDown(t.status) && t.status !== 'repairing') tractors.ripple(w.x, w.z, '#30D158', 1.2);
        }
        prevStatus.set(t.id, t.status);
      }
      runMockCoverage(state);
    }
    if (type === 'jobs') runMockCoverage(state);
    if (type === 'coverage' && msg.data && cov) {
      if (!realCoverage) { realCoverage = true; cov.clear(); } // real data replaces any synthetic paint
      const before = cov.outside;
      cov.paint(msg.data);
      if (cov.outside > before && !warnedOutside) {
        warnedOutside = true;
        console.warn('[livefeed] coverage cells outside the farm grid (origin ' + JSON.stringify(msg.data.origin) + ', cell_m ' + msg.data.cell_m + '). Check the coverage origin / y-axis assumption (lib/geo.js coverageYSign).');
      }
    }
    if (type === 'log' || type === 'scenario') syncBarriers(state);
    textDirty = true;
  }
  store.subscribe(onMessage);

  // ---------- framing
  const fit = { tx: 0, tz: 0, halfH: 10 };
  function cssPx(name, dflt) { const v = parseFloat(getComputedStyle(stage).getPropertyValue(name)); return isFinite(v) && v > 0 ? v : dflt; }
  function computeFit() {
    if (!grid) return;
    const top = Math.min(SH * 0.35, cssPx('--chipsb', 120) + 8), bot = Math.min(SH * 0.35, cssPx('--dockh', 120) + 10);
    const bandH = Math.max(120, SH - top - bot), bandW = Math.max(160, SW - 24);
    const fw = grid.w + 1.2, fh = grid.h + 1.2;
    const wpp = Math.max(fw / bandW, fh / bandH);
    fit.halfH = (SH * wpp) / 2;
    fit.tx = 0; fit.tz = (SH / 2 - (top + bandH / 2)) * wpp;
    halfH0 = fit.halfH;
    const a = SW / SH;
    O.top = halfH0; O.bottom = -halfH0; O.left = -halfH0 * a; O.right = halfH0 * a; O.updateProjectionMatrix();
  }
  function setOrtho(tx, tz, zoom) {
    ctl.target.set(tx, 0, tz); O.position.set(tx, CAM_H, tz + 1e-3); O.zoom = zoom; O.updateProjectionMatrix(); O.lookAt(tx, 0, tz);
  }
  function applyFit(instant) {
    if (instant) { setOrtho(fit.tx, fit.tz, 1); goal = null; }
    else goal = { x: fit.tx, z: fit.tz, zoom: 1 };
  }
  let goal = null; // animated ortho pan/zoom target {x, z, zoom}

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
    if (w === SW && h === SH) return;
    SW = w; SH = h; R.setSize(SW, SH); PC.aspect = SW / SH; PC.updateProjectionMatrix();
    const z = O.zoom, tx = ctl.target.x, tz = ctl.target.z;
    computeFit(); setOrtho(tx, tz, z);
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(stage); else window.addEventListener('resize', resize);

  // ---------- view switching
  let view = 'sim', p = 0;
  const A = { pos: new THREE.Vector3(), target: new THREE.Vector3() }; // diorama camera pose to return to
  const B = { target: new THREE.Vector3(), dist: 40 };                // overhead pose matching the map framing
  const sA = new THREE.Spherical(), tmpV = new THREE.Vector3(), tmpT = new THREE.Vector3();
  let minDist0 = null;
  const orig = { focus: world.focus, home: world.home, overview: world.overview };

  function overheadFromOrtho() {
    B.target.copy(ctl.target);
    B.dist = (halfH0 / O.zoom) / Math.tan(THREE.MathUtils.degToRad(world.cam.fov / 2));
  }
  /** Only the toggle ('user') or boot restore may change the view; anything else is refused and logged. */
  function setView(v, source) {
    if (!vs.request(v, source)) {
      if (source !== 'user' && source !== 'restore' && v !== view) console.warn('[livefeed] refused view change to "' + v + '" from ' + (source || 'unknown caller'));
      return;
    }
    view = v;
    if (toggle && toggle.view !== v) toggle.set(v);
    if (v === 'live') {
      if (p === 0) {
        A.pos.copy(world.cam.position); A.target.copy(world.ctl.target);
        if (world.cancelGoal) world.cancelGoal(); else orig.overview.call(world, -1); // drop any pending diorama camera move
        if (world.follow) world.follow(null); // the transition owns the diorama camera; follow resumes on return
        computeFit(); setOrtho(fit.tx, fit.tz, 1); goal = null;
        overheadFromOrtho();
      }
      world.ctl.enabled = false;
      if (minDist0 == null) { minDist0 = world.ctl.minDistance; world.ctl.minDistance = 0.5; }
      R.domElement.classList.add('on'); ctl.enabled = true;
      textDirty = true;
    } else {
      if (p === 1) overheadFromOrtho(); // reverse from wherever the user panned/zoomed
      ctl.enabled = false; R.domElement.classList.remove('on');
      // selection + follow carry over: the 3D camera picks the follow back up when the transition ends
    }
    t0 = performance.now(); pStart = p;
  }
  let t0 = 0, pStart = 0;

  function driveDioramaCamera(e) {
    tmpV.subVectors(A.pos, A.target); sA.setFromVector3(tmpV);
    const rA = Math.max(0.5, sA.radius), r = Math.exp(Math.log(rA) + (Math.log(B.dist) - Math.log(rA)) * e);
    let dTheta = 0 - sA.theta; dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    const phi = sA.phi + (OVERHEAD_PHI - sA.phi) * e, theta = sA.theta + dTheta * e;
    tmpT.lerpVectors(A.target, B.target, e);
    tmpV.setFromSphericalCoords(r, phi, theta).add(tmpT);
    world.cam.position.copy(tmpV); world.ctl.target.copy(tmpT); world.cam.lookAt(tmpT);
  }

  // ---------- follow / select
  let followId = null, selectedId = null;
  function select(id) {
    selectedId = id; tractors.setSelected(id);
    if (id) { overlay.openCard(id); textDirty = true; } else { overlay.closeCard(); setFollow(null); }
  }
  const simFollow = () => (followId && sim ? sim.pos(followId) : null);
  function setFollow(id) {
    followId = id || null; overlay.setFollowing(!!followId);
    if (followId && view === 'live') goal = { follow: true, zoom: Math.max(O.zoom, 2.4) };
    if (world.follow) world.follow(followId && view === 'sim' && p === 0 ? simFollow : null);
    textDirty = true;
  }

  // pointer: tap a tractor = readout; drag = pan (exits follow); wheel = zoom (keeps follow)
  const el = R.domElement;
  let down = null;
  const proj = new THREE.Vector3();
  const projOut = { x: 0, y: 0 }, wp = { x: 0, z: 0 };
  function project(x, z, out = projOut) {
    proj.set(x, 0, z).project(p >= 1 || reduced ? O : PC);
    out.x = (proj.x * 0.5 + 0.5) * SW; out.y = (-proj.y * 0.5 + 0.5) * SH; return out;
  }
  const localXY = (e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  el.addEventListener('pointerdown', (e) => { down = { ...localXY(e), moved: false }; el.classList.add('drag'); goal = goal && goal.follow ? goal : null; });
  el.addEventListener('pointermove', (e) => {
    const q = localXY(e);
    if (down && (e.buttons & 7)) {
      if (!down.moved && Math.hypot(q.x - down.x, q.y - down.y) > 4) { down.moved = true; if (followId) setFollow(null); goal = null; }
      return;
    }
    if (p >= 1) el.classList.toggle('hover', !!tractors.pick(q.x, q.y, project));
  });
  const up = (e) => {
    el.classList.remove('drag');
    if (!down) return;
    const wasTap = !down.moved; down = null;
    if (!wasTap || view !== 'live' || pickGuard()) return;
    const q = localXY(e);
    const id = tractors.pick(q.x, q.y, project);
    if (id) { select(id); if (followId && followId !== id) setFollow(id); } else select(null);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', () => { down = null; el.classList.remove('drag'); });
  const onKey = (e) => { if (e.key === 'Escape' && selectedId) select(null); };

  // Simulated view: tap a 3D tractor = same readout card; drag the diorama = exit follow; wheel keeps follow.
  const wel = world.R.domElement;
  const simProj = new THREE.Vector3(), simOut = { x: 0, y: 0 };
  function projectSim(x, z) {
    simProj.set(x, 0.3, z).project(world.cam);
    simOut.x = (simProj.x * 0.5 + 0.5) * SW; simOut.y = (-simProj.y * 0.5 + 0.5) * SH; return simOut;
  }
  let sdown = null;
  const simActive = () => sim && view === 'sim' && p === 0;
  const onSimDown = (e) => { if (simActive()) sdown = { ...localXY(e), moved: false }; };
  const onSimMove = (e) => {
    if (!simActive()) return;
    const q = localXY(e);
    if (sdown && (e.buttons & 7)) {
      if (!sdown.moved && Math.hypot(q.x - sdown.x, q.y - sdown.y) > 4) { sdown.moved = true; if (followId) setFollow(null); }
      return;
    }
    wel.style.cursor = sim.pick(q.x, q.y, tractors.ids(), projectSim) ? 'pointer' : '';
  };
  const onSimUp = (e) => {
    if (!sdown) return;
    const tap = !sdown.moved; sdown = null;
    if (!tap || !simActive() || pickGuard()) return;
    const q = localXY(e);
    const id = sim.pick(q.x, q.y, tractors.ids(), projectSim);
    if (id) { select(id); if (followId && followId !== id) setFollow(id); } else if (selectedId) select(null);
  };
  wel.addEventListener('pointerdown', onSimDown);
  wel.addEventListener('pointermove', onSimMove);
  wel.addEventListener('pointerup', onSimUp);
  document.addEventListener('keydown', onKey);

  // world camera helpers route to the map while the Live feed is showing (chip focus, breakdown focus, Reset view)
  world.focus = function (v, ms, dist) {
    if (view === 'live' || p > 0) { if (v && !followId) goal = { x: v.x, z: v.z, zoom: Math.max(O.zoom, 1.6) }; return; }
    return orig.focus.call(world, v, ms, dist);
  };
  world.home = function () { if (view === 'live' || p > 0) { setFollow(null); applyFit(false); return; } return orig.home.call(world); };
  world.overview = function (ms) { if (view === 'live' || p > 0) { if (!followId) applyFit(false); return; } return orig.overview.call(world, ms); };

  // ---------- per frame
  let reduced = false, lastText = 0;
  const lastNow = { t: performance.now() };
  function tick(now) {
    const dt = Math.min(0.05, Math.max(0, (now - lastNow.t) / 1000)); lastNow.t = now;
    const target = view === 'live' ? 1 : 0;
    if (p !== target) {
      reduced = reduceMotion();
      const dur = reduced ? 260 : DUR;
      const span = Math.abs(target - pStart) || 1;
      const k = Math.min(1, (now - t0) / (dur * span));
      p = pStart + (target - pStart) * k;
      if (k >= 1) p = target;
      if (p === 0) { // fully back in the diorama
        world.ctl.enabled = true; if (minDist0 != null) { world.ctl.minDistance = minDist0; minDist0 = null; }
        world.cam.position.copy(A.pos); world.ctl.target.copy(A.target); world.cam.lookAt(A.target);
        if (followId && world.follow) world.follow(simFollow);
      }
    }
    if (p < 1 && sim) sim.frame(now, tractors.records()); // diorama (partly) visible: 3D coverage, trails, AB
    if (p === 0) {
      if (el.style.opacity !== '0') { el.style.opacity = '0'; overlay.setOpacity(0); }
      if (selectedId && sim) overlay.placeCard(simCardPos(selectedId), simIconPx());
      if (textDirty && now - lastText > 250) { lastText = now; textDirty = false; overlay.sync(store.get() || {}); }
      return;
    }

    const e = easeInOut(p);
    if (!reduced && p < 1) {
      driveDioramaCamera(e);
      PC.fov = world.cam.fov; PC.aspect = SW / SH; PC.updateProjectionMatrix();
      PC.position.copy(world.cam.position); PC.quaternion.copy(world.cam.quaternion);
    }
    const alpha = reduced ? p : smooth(0.12, 0.86, p); // map is camera-aligned, so a long, even fade reads as one surface
    el.style.opacity = alpha.toFixed(3); overlay.setOpacity(alpha);

    const cam = p >= 1 || reduced ? O : PC;
    // ortho pan/zoom goal + follow
    if (p >= 1) {
      const kk = 1 - Math.exp(-dt * 7);
      if (followId) {
        const w = tractors.worldPos(followId, wp);
        if (w) { tmpT.set(w.x - ctl.target.x, 0, w.z - ctl.target.z).multiplyScalar(kk); ctl.target.add(tmpT); O.position.add(tmpT); }
        else setFollow(null);
      } else if (goal && goal.x != null) {
        tmpT.set(goal.x - ctl.target.x, 0, goal.z - ctl.target.z).multiplyScalar(kk); ctl.target.add(tmpT); O.position.add(tmpT);
        if (tmpT.lengthSq() < 1e-8 && Math.abs(O.zoom - goal.zoom) < 1e-3) goal = null;
      }
      if (goal && goal.zoom != null) { O.zoom += (goal.zoom - O.zoom) * kk; O.updateProjectionMatrix(); if (goal.follow && Math.abs(O.zoom - goal.zoom) < 1e-3) goal = null; }
      // keep the farm reachable
      if (grid) {
        const lim = { x: grid.w / 2 + 2, z: grid.h / 2 + 2 };
        const cx = Math.max(-lim.x, Math.min(lim.x, ctl.target.x)) - ctl.target.x, cz = Math.max(-lim.z, Math.min(lim.z, ctl.target.z)) - ctl.target.z;
        if (cx || cz) { ctl.target.x += cx; ctl.target.z += cz; O.position.x += cx; O.position.z += cz; }
      }
      ctl.update();
    }
    const wpp = cam === O ? (O.top - O.bottom) / O.zoom / SH : (2 * cam.position.distanceTo(world.ctl.target) * Math.tan(THREE.MathUtils.degToRad(PC.fov / 2))) / SH;

    // heat (top-down equivalent of the diorama's glowing patches)
    if (ground) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 260);
      for (const id in ground.blocks) {
        const b = ground.blocks[id], h = heat.has(id);
        b.outline.material.color.set(h ? '#FF6A2A' : '#ffffff'); b.outline.material.opacity = h ? 0.75 + 0.25 * pulse : b.base;
        b.fill.visible = h; if (h) b.fill.material.opacity = 0.1 + 0.12 * pulse;
      }
    }
    if (cov && cov.version !== covVer && now - lastUpload > 120) { covVer = cov.version; covTex.needsUpdate = true; lastUpload = now; }
    tractors.frame(now, dt, wpp);
    R.render(L, cam);

    // DOM overlay
    const iconPx = Math.max(30, ICON_LEN / wpp);
    if (grid) overlay.place(blockPos, tagPos, iconPx);
    if (selectedId) overlay.placeCard(p >= 0.5 || !sim ? tagPos(selectedId) : simCardPos(selectedId), p >= 0.5 ? iconPx : simIconPx());
    if (textDirty && now - lastText > 250) { lastText = now; textDirty = false; overlay.sync(store.get() || {}); }
  }

  // overlay position callbacks (created once: no per-frame closures/objects)
  function blockPos(id) {
    const b = grid && grid.blockById[id]; if (!b) return null;
    return project(b.x - 0.5 - (grid.w - 1) / 2, b.y - 0.5 - (grid.h - 1) / 2);
  }
  function tagPos(id) { const w = tractors.worldPos(id, wp); return w ? project(w.x, w.z) : null; }
  /** on-screen size (px) of a ~0.9-cell 3D tractor at the diorama camera distance, for the card offset */
  function simIconPx() { const d = world.cam.position.distanceTo(world.ctl.target) || 20; return Math.max(40, (0.9 * SH) / (2 * d * Math.tan((world.cam.fov * Math.PI) / 360))); }
  function simCardPos(id) { const q = sim && sim.pos(id); return q ? projectSim(q.x, q.z) : null; }

  // late start: if the store already has a snapshot, build from it
  const s0 = store.get();
  if (s0 && s0.scenario) onMessage(s0, { type: 'snapshot' });

  return {
    tick,
    /** main loop: render the diorama only while it is (partly) visible */
    get simVisible() { return p < 1; },
    get view() { return view; },
    /** setView(v, source): only 'user' (toggle) / 'restore' are honoured */
    setView,
    get viewLog() { return vs.log.slice(); },
    setHeat(blocks) { heat = new Set(blocks || []); overlay.setHeat(heat); },
    select, follow: setFollow,
    /** map_pick support: tractor taps stand down while fn() is true */
    setPickGuard(fn) { pickGuard = typeof fn === 'function' ? fn : () => false; },
    /** Map view projection for map_pick (null while the diorama, or the transition, is showing) */
    pickView() {
      if (p < 1) return null;
      return {
        screenToGround(px, py) { const v = new THREE.Vector3((px / SW) * 2 - 1, -(py / SH) * 2 + 1, 0).unproject(O); return { x: v.x, z: v.z }; },
        groundToScreen(x, z) { const o = project(x, z, { x: 0, y: 0 }); return { x: o.x, y: o.y }; },
      };
    },
    _debug: { tractors, L, R },
    /** debug / leak checks */
    get info() { return { memory: { ...R.info.memory }, render: { ...R.info.render }, programs: R.info.programs.length, trails: Object.fromEntries(tractors.ids().map((id) => [id, tractors.get(id).trail.count])), realCoverage, painted: cov ? cov.painted : 0, coverageOutside: cov ? cov.outside : 0 }; },
    dispose() {
      if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
      document.removeEventListener('keydown', onKey);
      wel.removeEventListener('pointerdown', onSimDown); wel.removeEventListener('pointermove', onSimMove); wel.removeEventListener('pointerup', onSimUp);
      if (world.follow) world.follow(null);
      Object.assign(world, orig);
      ctl.dispose(); tractors.clear(); if (sim) sim.dispose(); disposeShared(); clearBarriers();
      barrierGeo.dispose(); barrierMats.fill.dispose(); barrierMats.x.dispose();
      if (ground) ground.dispose(); disposeCoverage(); overlay.dispose();
      R.dispose(); R.forceContextLoss(); R.domElement.remove();
    },
  };
}

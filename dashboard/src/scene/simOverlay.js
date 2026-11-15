// Live-feed parity in the Simulated (3D diorama) view: coverage painted on the ground, breadcrumb trails,
// AB guidance lines, and tap-to-pick. No new data: everything reads the Live feed's shared state
// (coverageGrid buffer, trail buffers, per-tractor AB segments), so both views always show the same thing.
//
// Positions come from the diorama's own tractors (scene/tractors.js `get(id)` / `worldPos(id)`), so the
// overlays sit exactly under the 3D models. Work happens only while the diorama is visible.
import * as THREE from 'three';

const COVER_Y = 0.032;  // just above the block soil patches (y 0.02), well under the canopy
const AB_Y = 0.07;
const AB_EDGE = 0.09; // dark underlay width (line is 0.05)
const UPLOAD_MS = 150;

export function createSimOverlay(world, dio) {
  const S = world.S;
  const quad = new THREE.PlaneGeometry(1, 1);
  const disc = new THREE.CircleGeometry(1, 24);
  const recs = new Map(); // id -> { ab, line, da, db, mat, dotMat, color }
  let covMesh = null, covTex = null, covVer = -1, lastUpload = 0;
  const tmp = { x: 0, z: 0 };

  /** Non-allocating diorama position of tractor id -> {x, z} (shared object) or null. */
  function pos(id) {
    const r = dio.get && dio.get(id);
    const g = r && (r.g || r.group || r.root);
    if (g && g.position) { tmp.x = g.position.x; tmp.z = g.position.z; return tmp; }
    const p = dio.worldPos && dio.worldPos(id); // fallback (allocates); only if tractors.js changes shape
    if (p) { tmp.x = p.x; tmp.z = p.z; return tmp; }
    return null;
  }

  function flat(geo, m, order) { const o = new THREE.Mesh(geo, m); o.rotation.x = -Math.PI / 2; o.renderOrder = order; return o; }

  return {
    pos,
    /** liveTractors onCreate: add the 3D trail view + AB line meshes. */
    attach(rec) {
      rec.trail.addView(S, { y: 0.05, opacity: 0.85 });
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(rec.color).lerp(new THREE.Color('#ffffff'), 0.45), transparent: true, opacity: 0.95, depthWrite: false });
      const dotMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95, depthWrite: false });
      // dark edge under the line (Decision 2): keeps it readable over ripe grass and its own coverage colour
      const edgeMat = new THREE.MeshBasicMaterial({ color: '#1C1C1E', transparent: true, opacity: 0.55, depthWrite: false });
      const ab = new THREE.Group(), edge = flat(quad, edgeMat, 2), line = flat(quad, mat, 3), da = flat(disc, dotMat, 3), db = flat(disc, dotMat, 3);
      ab.add(edge, line, da, db); ab.visible = false; ab.position.y = AB_Y; S.add(ab);
      recs.set(rec.id, { ab, edge, line, da, db, mat, dotMat, edgeMat, color: rec.color });
    },
    /** liveTractors onRemove (the trail's 3D mesh is disposed by the trail itself). */
    detach(rec) {
      const r = recs.get(rec.id); if (!r) return;
      S.remove(r.ab); r.mat.dispose(); r.dotMat.dispose(); r.edgeMat.dispose(); recs.delete(rec.id);
    },
    /** New scenario: coverage plane over the same grid as the Live feed (its own GPU texture, same CPU bytes). */
    setCoverage(cov, grid) {
      if (covMesh) { S.remove(covMesh); covMesh.geometry.dispose(); covMesh.material.dispose(); covMesh = null; }
      if (covTex) { covTex.dispose(); covTex = null; }
      covVer = -1;
      if (!cov || !grid) return;
      covTex = new THREE.DataTexture(cov.data, cov.width, cov.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      covTex.magFilter = covTex.minFilter = THREE.NearestFilter; covTex.generateMipmaps = false;
      const ox = (grid.w - 1) / 2, oy = (grid.h - 1) / 2;
      covMesh = new THREE.Mesh(new THREE.PlaneGeometry(cov.ex1 - cov.ex0, cov.ey1 - cov.ey0),
        new THREE.MeshLambertMaterial({ map: covTex, transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      covMesh.rotation.x = -Math.PI / 2; covMesh.receiveShadow = true; covMesh.renderOrder = 1;
      covMesh.position.set((cov.ex0 + cov.ex1) / 2 - ox, COVER_Y, (cov.ey0 + cov.ey1) / 2 - oy);
      covMesh.userData.cov = cov;
      S.add(covMesh);
    },
    /** Per visible frame (diorama at least partly shown). */
    frame(now, records) {
      if (covMesh) {
        const cov = covMesh.userData.cov;
        if (cov.version !== covVer && now - lastUpload > UPLOAD_MS) { covVer = cov.version; covTex.needsUpdate = true; lastUpload = now; }
      }
      for (const rec of records) {
        const r = recs.get(rec.id); if (!r) continue;
        const p = pos(rec.id);
        if (p) rec.trail.frame(p.x, p.z, 0.85); // tip follows the 3D model
        if (r.color !== rec.color) { r.color = rec.color; r.mat.color.set(rec.color).lerp(new THREE.Color('#ffffff'), 0.45); }
        const seg = rec.abSeg;
        r.ab.visible = !!seg;
        if (seg) {
          const L = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az);
          r.line.position.set((seg.ax + seg.bx) / 2, 0, (seg.az + seg.bz) / 2);
          r.line.rotation.z = Math.atan2(-(seg.bz - seg.az), seg.bx - seg.ax);
          r.line.scale.set(L, 0.05, 1);
          r.edge.position.copy(r.line.position); r.edge.rotation.z = r.line.rotation.z; r.edge.scale.set(L, AB_EDGE, 1);
          r.da.position.set(seg.ax, 0, seg.az); r.db.position.set(seg.bx, 0, seg.bz); r.da.scale.setScalar(0.08); r.db.scale.setScalar(0.08);
        }
      }
    },
    /** Screen-space pick against the 3D models (projected with the diorama camera). */
    pick(px, py, ids, project, radius = 30) {
      let best = null, bd = radius * radius;
      for (const id of ids) {
        const p = pos(id); if (!p) continue;
        const s = project(p.x, p.z);
        const d = (s.x - px) ** 2 + (s.y - py) ** 2;
        if (d < bd) { bd = d; best = id; }
      }
      return best;
    },
    dispose() {
      this.setCoverage(null, null);
      for (const id of [...recs.keys()]) this.detach({ id });
      quad.dispose(); disc.dispose();
    },
  };
}

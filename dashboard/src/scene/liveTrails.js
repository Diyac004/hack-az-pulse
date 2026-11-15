// Live feed breadcrumb trails: one flat ribbon per tractor in a fixed-size, preallocated buffer.
// Points are appended from pose messages (CPU only, works while the view is hidden); the GPU upload happens
// lazily on the next render. When the buffer fills, the newest half is shifted down with copyWithin.
// No per-frame allocation. A "tip" vertex pair follows the interpolated icon so the trail never lags it.
import * as THREE from 'three';

const N = 1024;            // max points per trail (incl. the tip slot)
const KEEP = N / 2;        // points kept after compaction
const FADE = 420;          // samples over which the trail fades out (< KEEP)
const MIN_STEP = 0.06;     // grid cells between samples
const BREAK = 2.5;         // a jump larger than this (cells) breaks the trail instead of drawing a streak

let sharedIndex = null;
function indexAttr() {
  if (sharedIndex) return sharedIndex;
  const idx = new Uint16Array((N - 1) * 6);
  for (let i = 0; i < N - 1; i++) {
    const a = i * 2, o = i * 6;
    idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 2; idx[o + 3] = a + 1; idx[o + 4] = a + 3; idx[o + 5] = a + 2;
  }
  return (sharedIndex = idx);
}

const VERT = `
attribute float aSeq; attribute float aK;
uniform float uHead; uniform float uLen;
varying float vA;
void main(){
  float a = clamp(1.0 - (uHead - aSeq) / uLen, 0.0, 1.0);
  vA = a * a * aK;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = `
uniform vec3 uColor; uniform float uOpacity;
varying float vA;
void main(){ gl_FragColor = vec4(uColor, vA * uOpacity); }`;

export function createTrail(color, halfWidth = 0.05) {
  const pos = new Float32Array(N * 2 * 3), seq = new Float32Array(N * 2), kk = new Float32Array(N * 2);
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aSeq = new THREE.BufferAttribute(seq, 1).setUsage(THREE.DynamicDrawUsage);
  const aK = new THREE.BufferAttribute(kk, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos); geo.setAttribute('aSeq', aSeq); geo.setAttribute('aK', aK);
  geo.setIndex(new THREE.BufferAttribute(indexAttr(), 1));
  geo.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uHead: { value: 0 }, uLen: { value: FADE }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0.9 } },
  });
  // The live tip (last sample -> current icon position) is a separate 4-vertex mesh, so the big buffer is only
  // re-uploaded when a sample is added (~5 Hz), never per frame.
  const tpos = new Float32Array(12), tseq = new Float32Array(4), tk = new Float32Array(4);
  const tipGeo = new THREE.BufferGeometry();
  const tPos = new THREE.BufferAttribute(tpos, 3).setUsage(THREE.DynamicDrawUsage);
  const tSeq = new THREE.BufferAttribute(tseq, 1).setUsage(THREE.DynamicDrawUsage);
  const tK = new THREE.BufferAttribute(tk, 1).setUsage(THREE.DynamicDrawUsage);
  tipGeo.setAttribute('position', tPos); tipGeo.setAttribute('aSeq', tSeq); tipGeo.setAttribute('aK', tK);
  tipGeo.setIndex([0, 1, 2, 1, 3, 2]); tipGeo.setDrawRange(0, 0);
  function viewGroup(m, order) {
    const g = new THREE.Group();
    for (const gg of [geo, tipGeo]) { const o = new THREE.Mesh(gg, m); o.frustumCulled = false; o.renderOrder = order; g.add(o); } // bounds go stale as buffers change
    return g;
  }
  const mesh = viewGroup(mat, 4);
  // Extra views (the 3D diorama) draw the SAME buffers through their own meshes + material: three.js keeps GPU
  // copies per renderer, so one CPU buffer feeds both canvases with no duplicated sampling.
  const views = []; // { mesh, mat }
  const mats = [mat];

  let n = 0, s = 0, lx = 0, lz = 0, nx = 0, nz = 1; // committed count, sample counter, last point, last normal

  function writePair(i, x, z, ux, uz, sq, k) {
    const o = i * 6, hw = halfWidth;
    pos[o] = x + ux * hw; pos[o + 1] = 0; pos[o + 2] = z + uz * hw;
    pos[o + 3] = x - ux * hw; pos[o + 4] = 0; pos[o + 5] = z - uz * hw;
    seq[i * 2] = seq[i * 2 + 1] = sq; kk[i * 2] = kk[i * 2 + 1] = k;
  }
  function normalTo(x, z) {
    const dx = x - lx, dz = z - lz, L = Math.hypot(dx, dz);
    if (L > 1e-6) { nx = -dz / L; nz = dx / L; }
  }
  function compact() {
    const from = n - KEEP;
    pos.copyWithin(0, from * 6, n * 6); seq.copyWithin(0, from * 2, n * 2); kk.copyWithin(0, from * 2, n * 2);
    n = KEEP;
  }
  function push(x, z, k) {
    if (n >= N - 1) compact();
    if (n > 0) normalTo(x, z);
    writePair(n, x, z, nx, nz, ++s, k);
    if (n === 1) { // first segment: give point 0 the same normal
      const o = 0; const x0 = (pos[o] + pos[o + 3]) / 2, z0 = (pos[o + 2] + pos[o + 5]) / 2;
      writePair(0, x0, z0, nx, nz, seq[0], kk[0]);
    }
    n++; lx = x; lz = z;
  }
  function dirty() { aPos.needsUpdate = true; aSeq.needsUpdate = true; aK.needsUpdate = true; geo.setDrawRange(0, Math.max(0, n - 1) * 6); }

  return {
    mesh,
    /** Add a world-space sample (x, z). Cheap; call from pose messages even when hidden. */
    add(x, z) {
      if (n === 0) { push(x, z, 1); dirty(); return; }
      const d = Math.hypot(x - lx, z - lz);
      if (d < MIN_STEP) return;
      if (d > BREAK) { const px = lx, pz = lz; push(px, pz, 0); push(x, z, 0); }
      push(x, z, 1);
      dirty();
    },
    /** Per visible frame: tip pair at the interpolated icon position, uniforms. */
    frame(x, z, opacity) {
      if (n === 0) { tipGeo.setDrawRange(0, 0); return; }
      const d = Math.hypot(x - lx, z - lz);
      const ux = d > 1e-4 ? -(z - lz) / d : nx, uz = d > 1e-4 ? (x - lx) / d : nz;
      const o = (n - 1) * 6, hw = halfWidth, k = d > BREAK ? 0 : 1;
      for (let i = 0; i < 6; i++) tpos[i] = pos[o + i];          // last committed pair
      tseq[0] = tseq[1] = seq[(n - 1) * 2]; tk[0] = tk[1] = kk[(n - 1) * 2] * k;
      tpos[6] = x + ux * hw; tpos[7] = 0; tpos[8] = z + uz * hw; // tip pair at the icon
      tpos[9] = x - ux * hw; tpos[10] = 0; tpos[11] = z - uz * hw;
      tseq[2] = tseq[3] = s + 1; tk[2] = tk[3] = k;
      tPos.needsUpdate = true; tSeq.needsUpdate = true; tK.needsUpdate = true; tipGeo.setDrawRange(0, 6);
      for (const m of mats) m.uniforms.uHead.value = s + 1;
      mat.uniforms.uOpacity.value = opacity;
    },
    /** Draw this trail in another scene too (e.g. the diorama): y lift, depth-tested so trees occlude it. */
    addView(scene, { y = 0.06, opacity = 0.8, depthTest = true } = {}) {
      const m = mat.clone(); m.depthTest = depthTest; m.uniforms.uOpacity.value = opacity;
      const v = viewGroup(m, 2); v.position.y = y;
      scene.add(v); views.push({ mesh: v, mat: m }); mats.push(m);
      return v;
    },
    setColor(c) { for (const m of mats) m.uniforms.uColor.value.set(c); },
    clear() { n = 0; geo.setDrawRange(0, 0); tipGeo.setDrawRange(0, 0); },
    get count() { return n; },
    dispose() {
      mesh.parent && mesh.parent.remove(mesh);
      for (const v of views) { v.mesh.parent && v.mesh.parent.remove(v.mesh); v.mat.dispose(); }
      views.length = 0; geo.dispose(); tipGeo.dispose(); mat.dispose();
    },
  };
}

// three.js world: renderer, camera, controls, lights, sky cycle, post FX, camera focus.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

// Banded tilt-shift: sharp across the whole island (|uv.y - focus| < band), ramping to at most `px` CSS pixels
// of blur at the very top/bottom of the canvas (sky / far background). Separable: one pass per axis.
// The stock Horizontal/VerticalTiltShiftShader blurs linearly from a single focus LINE, so the top row of
// blocks and their labels were already ~2-3 px soft; this keeps the miniature feel only at the frame edges.
const TiltBandShader = {
  uniforms: { tDiffuse: { value: null }, step: { value: new THREE.Vector2() }, focus: { value: 0.5 }, band: { value: 0.36 }, ramp: { value: 0.16 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 step; uniform float focus, band, ramp; varying vec2 vUv;
    void main(){
      float k = smoothstep(band, band + ramp, abs(vUv.y - focus));
      if (k < 0.002) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
      vec2 s = step * k;
      vec4 c = texture2D(tDiffuse, vUv) * 0.2270270270;
      c += (texture2D(tDiffuse, vUv + s * 1.3846153846) + texture2D(tDiffuse, vUv - s * 1.3846153846)) * 0.3162162162;
      c += (texture2D(tDiffuse, vUv + s * 3.2307692308) + texture2D(tDiffuse, vUv - s * 3.2307692308)) * 0.0702702703;
      gl_FragColor = c;
    }`,
};
// Max edge blur in CSS px (so it reads the same at any DPR), growing gently with the canvas height.
const tiltPx = (h) => Math.min(1.6, Math.max(0.7, h / 700));
// Overlay layer: screen-space sprites (block labels, downwind tags: any Sprite with depthTest off) are drawn
// AFTER post-processing straight to the antialiased canvas, so they are never blurred or bloomed.
const OVERLAY = 1;

export const lm = (c) => new THREE.MeshLambertMaterial({ color: c });

const SKY = [[0, '#F6C7A0'], [0.14, '#CFE6F7'], [0.5, '#A8D4F5'], [0.82, '#F2D7A6'], [1, '#EE9B78']].map(([f, c]) => [f, new THREE.Color(c)]);
function skyAt(f) {
  for (let i = 0; i < SKY.length - 1; i++) if (f <= SKY[i + 1][0]) { const a = SKY[i], b = SKY[i + 1]; return a[1].clone().lerp(b[1], (f - a[0]) / (b[0] - a[0])); }
  return SKY[SKY.length - 1][1].clone();
}

export function createWorld(stage) {
  let SW = stage.clientWidth || 800, SH = stage.clientHeight || 600;
  const R = new THREE.WebGLRenderer({ antialias: true });
  R.setPixelRatio(Math.min(devicePixelRatio, 2)); R.setSize(SW, SH);
  R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFSoftShadowMap;
  stage.insertBefore(R.domElement, stage.firstChild);
  // ?debug=perf: every 5 s log GPU memory, draw calls/triangles summed over all passes of a frame, and FPS.
  const PERF = typeof location !== 'undefined' && new URLSearchParams(location.search).get('debug') === 'perf';
  const pf = { frames: 0, calls: 0, maxCalls: 0, tris: 0, t: 0 };
  if (PERF) R.info.autoReset = false;

  const S = new THREE.Scene(); S.background = new THREE.Color('#BFDDF5');
  const cam = new THREE.PerspectiveCamera(38, SW / SH, 0.1, 400);
  let span = 20, k = Math.max(1, 1.45 / (SW / SH));
  const HOME = { p: new THREE.Vector3(), t: new THREE.Vector3(0, 0, 1) };
  const setHome = () => { const s = span / 20; HOME.p.set(0, 17 * k * s, 15 * k * s); HOME.t.set(0, 0, 1 * s); };
  setHome(); cam.position.copy(HOME.p);
  const ctl = new OrbitControls(cam, R.domElement);
  ctl.target.copy(HOME.t); ctl.enableDamping = true; ctl.enablePan = false; ctl.maxPolarAngle = 1.25; ctl.minDistance = 6; ctl.maxDistance = 120; ctl.update();

  const hemi = new THREE.HemisphereLight('#ffffff', '#b59a6e', 0.55); S.add(hemi);
  const sun = new THREE.DirectionalLight('#fff4e0', 1); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
  S.add(sun); S.add(sun.target);
  const setShadow = () => { const e = span * 0.72; Object.assign(sun.shadow.camera, { left: -e, right: e, top: e, bottom: -e, near: 1, far: span * 4 }); sun.shadow.camera.updateProjectionMatrix(); };
  setShadow();

  let comp = null, hPass = null, vPass = null, fx = true;
  const setTilt = () => {
    const px = tiltPx(SH);
    if (hPass) hPass.uniforms.step.value.set(px / 3.23 / SW, 0); // outer tap lands at ~px CSS pixels
    if (vPass) vPass.uniforms.step.value.set(0, px / 3.23 / SH);
  };
  try {
    // MSAA for the scene pass on WebGL2 (the default composer target has none, so Effects-on lost antialiasing)
    const dpr = Math.min(devicePixelRatio, 2);
    const rt = R.capabilities.isWebGL2 && THREE.WebGLMultisampleRenderTarget
      ? new THREE.WebGLMultisampleRenderTarget(SW * dpr, SH * dpr, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat })
      : undefined;
    if (rt) rt.samples = 4;
    comp = new EffectComposer(R, rt); comp.setPixelRatio(dpr); comp.setSize(SW, SH);
    comp.addPass(new RenderPass(S, cam));
    // only true highlights glow (lamps, beacons, sunlit fruit); low strength + small radius = no haze over the farm
    comp.addPass(new UnrealBloomPass(new THREE.Vector2(SW, SH), 0.22, 0.25, 0.97));
    hPass = new ShaderPass(TiltBandShader); vPass = new ShaderPass(TiltBandShader);
    comp.addPass(hPass); comp.addPass(vPass); setTilt();
  } catch (e) { comp = null; }

  // keep overlay sprites on their own layer; rescanned a few times a second (labels are created lazily)
  hemi.layers.enable(OVERLAY); sun.layers.enable(OVERLAY); // same light state in both passes (no per-frame program re-key)
  let scanN = 0;
  const toOverlay = (o) => { if (o.isSprite && o.material && o.material.depthTest === false && o.layers.mask !== 1 << OVERLAY) o.layers.set(OVERLAY); };

  let camGoal = null;
  // follow mode: camera target tracks fn() -> {x, z} (or null), keeping the current view angle; closes in to FOLLOW_DIST.
  let followFn = null, lastFollowNow = 0;
  const FOLLOW_DIST = 11, fv = new THREE.Vector3();
  const world = {
    THREE, R, S, cam, ctl, HOME,
    get fx() { return fx; }, set fx(v) { fx = !!v; },
    setSpan(s) { span = Math.max(8, s); setHome(); setShadow(); },
    focus(v, ms = 2600, dist = 1) {
      const s = 0.55 * dist;
      camGoal = { p: new THREE.Vector3(v.x, 0, v.z).add(new THREE.Vector3(3.5 * k * s, 6 * k * s, 6 * k * s)), t: new THREE.Vector3(v.x, 0, v.z), until: performance.now() + ms };
    },
    overview(ms = 4000) { camGoal = { p: HOME.p.clone().multiplyScalar(1.2), t: HOME.t.clone(), until: performance.now() + ms, ret: true }; },
    home() { camGoal = { p: HOME.p.clone(), t: HOME.t.clone(), until: performance.now() + 1600, ret: true }; },
    /** Drop any pending focus/overview/home camera move (used before another module drives the camera). */
    cancelGoal() { camGoal = null; },
    /** Follow: fn() -> {x, z} world position or null; pass null to stop. Follow wins over focus/overview moves. */
    follow(fn) { followFn = typeof fn === 'function' ? fn : null; if (followFn) camGoal = null; },
    get following() { return !!followFn; },
    /** dayFrac 0..1 drives sky + sun */
    sky(f) {
      f = Math.max(0, Math.min(1, f || 0));
      S.background = skyAt(f);
      const ang = Math.PI * (0.08 + 0.84 * f), si = Math.sin(ang), sc = span / 20;
      sun.position.set(Math.cos(ang) * 18 * sc, (Math.sin(ang) * 16 + 1) * sc, 7 * sc);
      sun.intensity = 0.45 + 0.15 * si; sun.color.set('#FFB27A').lerp(new THREE.Color('#FFF6E8'), si); hemi.intensity = 0.4 + 0.02 * si;
    },
    resize() {
      SW = stage.clientWidth; SH = stage.clientHeight; if (!SW || !SH) return;
      R.setSize(SW, SH); cam.aspect = SW / SH; cam.updateProjectionMatrix(); k = Math.max(1, 1.45 / (SW / SH)); setHome();
      if (comp) { comp.setSize(SW, SH); setTilt(); }
    },
    render(now) {
      if (followFn) {
        camGoal = null;
        const p = followFn();
        const dt = lastFollowNow ? Math.min(0.05, (now - lastFollowNow) / 1000) : 0.016; lastFollowNow = now;
        if (p) {
          const k = 1 - Math.exp(-dt * 6);
          fv.set((p.x - ctl.target.x) * k, 0, (p.z - ctl.target.z) * k);
          ctl.target.add(fv); cam.position.add(fv);
          fv.subVectors(cam.position, ctl.target); const d = fv.length();
          if (d > FOLLOW_DIST + 0.05) { fv.multiplyScalar((d + (FOLLOW_DIST - d) * k) / d); cam.position.copy(ctl.target).add(fv); }
        }
      } else lastFollowNow = 0;
      if (camGoal) {
        if (now < camGoal.until) { cam.position.lerp(camGoal.p, 0.05); ctl.target.lerp(camGoal.t, 0.06); }
        else if (!camGoal.ret) camGoal = { p: HOME.p.clone(), t: HOME.t.clone(), until: now + 1600, ret: true };
        else camGoal = null;
      }
      ctl.update();
      if (scanN-- <= 0) { scanN = 15; S.traverse(toOverlay); }
      if (fx && comp) {
        cam.layers.set(0); comp.render();
        // overlay pass: no clear, no background, no shadow-map re-render (it would use the overlay-only layer)
        const bg = S.background, au = R.autoClear, su = R.shadowMap.autoUpdate;
        S.background = null; R.autoClear = false; R.shadowMap.autoUpdate = false; cam.layers.set(OVERLAY);
        R.render(S, cam);
        S.background = bg; R.autoClear = au; R.shadowMap.autoUpdate = su; cam.layers.set(0);
      } else { cam.layers.enable(OVERLAY); R.render(S, cam); cam.layers.set(0); }
      if (PERF) {
        const c = R.info.render.calls; pf.frames++; pf.calls += c; pf.tris += R.info.render.triangles; if (c > pf.maxCalls) pf.maxCalls = c;
        R.info.reset();
        if (!pf.t) pf.t = now;
        else if (now - pf.t >= 5000) {
          const n = pf.frames;
          console.log(`[perf] geometries=${R.info.memory.geometries} textures=${R.info.memory.textures} programs=${R.info.programs.length} calls/frame=${Math.round(pf.calls / n)} (max ${pf.maxCalls}) tris/frame=${Math.round(pf.tris / n)} fps=${Math.round((n * 1000) / (now - pf.t))} objects=${S.children.length}`);
          pf.frames = pf.calls = pf.maxCalls = pf.tris = 0; pf.t = now;
        }
      }
    },
  };
  window.addEventListener('resize', () => world.resize());
  return world;
}

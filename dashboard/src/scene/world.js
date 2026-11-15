// three.js world: renderer, camera, controls, lights, sky cycle, post FX, camera focus.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { HorizontalTiltShiftShader } from 'three/examples/jsm/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/examples/jsm/shaders/VerticalTiltShiftShader.js';

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
  try {
    comp = new EffectComposer(R); comp.setPixelRatio(Math.min(devicePixelRatio, 2)); comp.setSize(SW, SH);
    comp.addPass(new RenderPass(S, cam));
    comp.addPass(new UnrealBloomPass(new THREE.Vector2(SW, SH), 0.38, 0.45, 0.95));
    hPass = new ShaderPass(HorizontalTiltShiftShader); hPass.uniforms.h.value = 1.8 / SW; hPass.uniforms.r.value = 0.5;
    vPass = new ShaderPass(VerticalTiltShiftShader); vPass.uniforms.v.value = 1.8 / SH; vPass.uniforms.r.value = 0.5;
    comp.addPass(hPass); comp.addPass(vPass);
  } catch (e) { comp = null; }

  let camGoal = null;
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
      if (comp) { comp.setSize(SW, SH); if (hPass) hPass.uniforms.h.value = 1.8 / SW; if (vPass) vPass.uniforms.v.value = 1.8 / SH; }
    },
    render(now) {
      if (camGoal) {
        if (now < camGoal.until) { cam.position.lerp(camGoal.p, 0.05); ctl.target.lerp(camGoal.t, 0.06); }
        else if (!camGoal.ret) camGoal = { p: HOME.p.clone(), t: HOME.t.clone(), until: now + 1600, ret: true };
        else camGoal = null;
      }
      ctl.update();
      if (fx && comp) comp.render(); else R.render(S, cam);
    },
  };
  window.addEventListener('resize', () => world.resize());
  return world;
}

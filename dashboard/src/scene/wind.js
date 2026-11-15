// Wind particles drifting over the diorama (PROJECT.md Change 6: "speed by wind mph").
// One THREE.Points + ShaderMaterial. Positions never change on the CPU: the flow is a uniform offset that the
// CPU integrates (offset += velocity * dt, so a weather change never teleports particles) and the vertex
// shader wraps into the farm box. Low wind: small, faint, slow motes. High wind: long, brighter streaks.
// Effects off or prefers-reduced-motion: a third of the particles (setDrawRange) at half speed.
import * as THREE from 'three';
import { windToward } from '../lib/derive.js';

const N = 900, LOW = 300;
const MPH_TO_UNITS = 0.11; // world units (grid cells) per real second per mph: 14 mph ~ 1.5 cells/s

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const VERT = `
uniform vec2 uOffset;
uniform vec3 uBox;      // half extents x, height, half z
uniform float uSize, uStretch, uTime, uPx;
uniform vec2 uDir;      // wind direction (world xz, unit)
attribute float aSeed;
varying float vFade;
varying vec2 vDir;
varying float vStretch;
void main(){
  vec3 p = position;
  vec2 q = p.xz + uOffset * (0.75 + 0.25 * floor(aSeed * 2.999)); // 3 speed lanes (0.75/1/1.25) keep the wrap exact
  q = mod(q + uBox.xz, 2.0 * uBox.xz) - uBox.xz;              // wrap inside the farm box
  p.xz = q;
  p.y += sin(uTime * (0.6 + aSeed) + aSeed * 40.0) * 0.08;    // gentle bob
  vec2 edge = 1.0 - smoothstep(0.78, 1.0, abs(q) / uBox.xz);  // fade at the wrap seam
  vFade = edge.x * edge.y;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec4 c0 = projectionMatrix * mv;
  vec4 c1 = projectionMatrix * modelViewMatrix * vec4(p + vec3(uDir.x, 0.0, uDir.y) * 0.5, 1.0);
  vec2 sd = c1.xy / c1.w - c0.xy / c0.w;
  vDir = length(sd) > 1e-5 ? normalize(vec2(sd.x, -sd.y)) : vec2(1.0, 0.0); // gl_PointCoord y points down
  vStretch = uStretch;
  gl_PointSize = uSize * (1.0 + uStretch * 3.0) * uPx * (12.0 / -mv.z);
  gl_Position = c0;
}`;
const FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;
varying vec2 vDir;
varying float vStretch;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float a = dot(c, vDir), b = dot(c, vec2(-vDir.y, vDir.x));
  float len = 0.5, wid = 0.5 / (1.0 + vStretch * 5.0);            // ellipse: round mote -> thin streak
  float d = length(vec2(a / len, b / wid));
  if (d > 1.0) discard;
  float tail = vStretch > 0.01 ? smoothstep(-0.5, 0.35, a) : 1.0;   // brighter head, fading tail
  gl_FragColor = vec4(uColor, uOpacity * vFade * (1.0 - d * d) * tail);
}`;

export function createWind(world) {
  const { S } = world;
  let pts = null, gridSig = '';
  const off = new THREE.Vector2(), vel = new THREE.Vector2(), goal = new THREE.Vector2();
  let goalMph = 0, mph = 0, t = 0;
  const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const uniforms = {
    uOffset: { value: off }, uBox: { value: new THREE.Vector3(10, 2, 7) }, uSize: { value: 1 }, uStretch: { value: 0 },
    uTime: { value: 0 }, uPx: { value: 1 }, uDir: { value: new THREE.Vector2(1, 0) },
    uColor: { value: new THREE.Color('#F4F8FF') }, uOpacity: { value: 0.3 },
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false });

  function build(grid) {
    const sig = grid.w + 'x' + grid.h;
    if (sig === gridSig && pts) return;
    gridSig = sig;
    if (pts) { S.remove(pts); pts.geometry.dispose(); }
    const hx = grid.w / 2 + 1.5, hz = grid.h / 2 + 1.5;
    uniforms.uBox.value.set(hx, 2, hz);
    const r = rng(4242), pos = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let i = 0; i < N; i++) { pos[i * 3] = (r() * 2 - 1) * hx; pos[i * 3 + 1] = 0.35 + r() * 1.9; pos[i * 3 + 2] = (r() * 2 - 1) * hz; seed[i] = r(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    pts = new THREE.Points(g, mat);
    pts.frustumCulled = false; // positions move in the shader
    pts.renderOrder = 5;
    S.add(pts);
  }

  return {
    /** current weather -> target flow */
    setWeather(cur) {
      if (!cur) return;
      goalMph = Math.max(0, +cur.wind_mph || 0);
      const v = windToward(cur.wind_from_deg);
      goal.set(v.x, v.z);
    },
    tick(grid, dt) {
      if (!grid) return;
      build(grid);
      const low = !world.fx || (reduce && reduce.matches);
      pts.geometry.setDrawRange(0, low ? LOW : N);
      // ease speed and direction (critically damped feel, ~0.6 s), never jump
      const k = 1 - Math.exp(-dt * 3);
      mph += (goalMph - mph) * k;
      const d = uniforms.uDir.value;
      d.x += (goal.x - d.x) * k; d.y += (goal.y - d.y) * k;
      const L = Math.hypot(d.x, d.y) || 1; d.x /= L; d.y /= L;
      const speed = mph * MPH_TO_UNITS * (low ? 0.5 : 1);
      vel.set(d.x * speed, d.y * speed);
      off.x += vel.x * dt; off.y += vel.y * dt;
      // keep the offset small: 4 box periods times every speed lane (0.75/1/1.25) is a whole number of periods, so no jump
      const px = 8 * uniforms.uBox.value.x, pz = 8 * uniforms.uBox.value.z;
      if (Math.abs(off.x) > px) off.x -= Math.sign(off.x) * px;
      if (Math.abs(off.y) > pz) off.y -= Math.sign(off.y) * pz;
      t += dt;
      uniforms.uTime.value = t;
      uniforms.uStretch.value = Math.max(0, Math.min(1, (mph - 6) / 8));
      uniforms.uOpacity.value = Math.min(0.8, 0.22 + mph * 0.04);
      uniforms.uSize.value = 3.2 + Math.min(1, mph / 12) * 1.6;
      uniforms.uPx.value = world.R.getPixelRatio();
    },
    get mph() { return mph; },
  };
}

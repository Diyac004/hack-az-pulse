// Light spray mist behind sprayers that are working. One THREE.Points with a fixed pool of particles whose
// typed arrays are rewritten in place each frame (no per-frame allocation). Mist drifts with the wind.
import * as THREE from 'three';

const N = 480, LIFE = 1.8, RATE = 40; // particles, seconds, per sprayer per second
const VERT = `
attribute float aAlpha;
attribute float aSize;
uniform float uPx;
varying float vA;
void main(){
  vA = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPx * (12.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
varying float vA;
void main(){
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5 || vA <= 0.0) discard;
  gl_FragColor = vec4(0.93, 0.97, 1.0, vA * smoothstep(0.5, 0.05, d));
}`;

export function createMist(world) {
  const { S } = world;
  const pos = new Float32Array(N * 3), vel = new Float32Array(N * 3), age = new Float32Array(N).fill(LIFE + 1);
  const alpha = new Float32Array(N), size = new Float32Array(N);
  const g = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aA = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
  const aS = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', aPos); g.setAttribute('aAlpha', aA); g.setAttribute('aSize', aS);
  const mat = new THREE.ShaderMaterial({ uniforms: { uPx: { value: 1 } }, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = 4; S.add(pts);
  let next = 0, seed = 7, acc = 0, live = false;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  return {
    /**
     * @param emitters array of {x, z, hd} (world position, heading radians as three rotation.y) reused by the caller
     * @param n number of valid emitters
     * @param wind {x, z, mph}
     */
    tick(emitters, n, wind, dt) {
      mat.uniforms.uPx.value = world.R.getPixelRatio();
      const low = !world.fx || (reduce && reduce.matches);
      if (n > 0) {
        acc += dt * RATE * n * (low ? 0.5 : 1);
        while (acc >= 1) {
          acc -= 1;
          const e = emitters[Math.floor(rnd() * n)];
          const i = next; next = (next + 1) % N;
          // behind the tractor: model front faces +z at rotation 0, so "back" is -forward
          const fx = Math.sin(e.hd), fz = Math.cos(e.hd), side = (rnd() - 0.5) * 0.9;
          pos[i * 3] = e.x - fx * 0.55 + fz * side; pos[i * 3 + 1] = 0.35 + rnd() * 0.2; pos[i * 3 + 2] = e.z - fz * 0.55 - fx * side;
          vel[i * 3] = -fx * 0.25 + fz * side * 0.5; vel[i * 3 + 1] = 0.08 + rnd() * 0.1; vel[i * 3 + 2] = -fz * 0.25 - fx * side * 0.5;
          age[i] = 0;
        }
      } else acc = 0;
      const wx = wind ? wind.x * Math.min(2, wind.mph * 0.09) : 0, wz = wind ? wind.z * Math.min(2, wind.mph * 0.09) : 0;
      let any = false;
      for (let i = 0; i < N; i++) {
        if (age[i] > LIFE) { if (alpha[i] !== 0) { alpha[i] = 0; any = true; } continue; }
        age[i] += dt; any = true;
        const k = age[i] / LIFE;
        pos[i * 3] += (vel[i * 3] + wx) * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += (vel[i * 3 + 2] + wz) * dt;
        alpha[i] = k >= 1 ? 0 : 0.62 * Math.sin(Math.PI * Math.min(1, k * 1.4)) * (1 - k);
        size[i] = 1.3 + k * 3.2;
      }
      if (any || live) { aPos.needsUpdate = true; aA.needsUpdate = true; aS.needsUpdate = true; }
      live = any;
    },
    clear() { age.fill(LIFE + 1); alpha.fill(0); aA.needsUpdate = true; },
  };
}

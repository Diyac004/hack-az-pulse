// Top-down tractor icon for the Live feed: Divi's "tractor A" (textures/tractor-A-top.svg, nose up), recolored
// per fleet color and rasterized once per color into a CanvasTexture (refcounted, disposed when unused).
// The SVG's --body variable and its color-mix() shades are resolved here, so the rasterized image does not
// depend on CSS support inside <img>. The "hitch-point" overlay marker is stripped; its position is exported.
import * as THREE from 'three';
import svgRaw from '../../../textures/tractor-A-top.svg?raw';

// viewBox -168 -248 336 524; tractor origin (0,0) = icon pivot (pose point); hitch point at (0, 240).
const VB = { x: -168, y: -248, w: 336, h: 524 };
const HITCH_Y = 240;
const TRACK_UNITS_PER_M = 280 / 2.5; // outer rear-tyre width (280 units) taken as ~2.5 m, for true implement widths

/** Local-unit geometry for an icon whose drawn length is `len`. */
export function iconLayout(len) {
  const u = len / VB.h;
  return {
    w: VB.w * u, h: VB.h * u,
    z: (VB.y + VB.h / 2) * u,     // plane center offset from the pivot (svg +y = behind = local +z)
    hitchZ: HITCH_Y * u,
    perM: TRACK_UNITS_PER_M * u,   // local units per metre (implement bar width)
  };
}

const PX_H = 384, PX_W = Math.round((PX_H * VB.w) / VB.h);
const cache = new Map(); // color -> { tex, refs }

function shade(color, pct, toward) {
  const c = new THREE.Color(color), t = new THREE.Color(toward);
  return '#' + c.lerp(t, 1 - pct / 100).getHexString();
}

function svgFor(color) {
  return svgRaw
    .replace(/color-mix\(in srgb,var\(--body,#[0-9A-Fa-f]{3,8}\) (\d+)%,(#fff|#000)\)/g, (_, pct, to) => shade(color, +pct, to === '#fff' ? '#ffffff' : '#000000'))
    .replace(/var\(--body,#[0-9A-Fa-f]{3,8}\)/g, color)
    .replace(/<g id="overlay">[\s\S]*?<\/g><\/g>/, '');
}

export function acquireTractorTexture(color) {
  let e = cache.get(color);
  if (e) { e.refs++; return e.tex; }
  const cv = document.createElement('canvas'); cv.width = PX_W; cv.height = PX_H;
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  e = { tex, refs: 1 }; cache.set(color, e);
  const img = new Image();
  img.onload = () => {
    if (cache.get(color) !== e) return; // released meanwhile
    cv.getContext('2d').drawImage(img, 0, 0, PX_W, PX_H);
    tex.needsUpdate = true;
  };
  img.onerror = () => console.warn('[livefeed] tractor icon SVG failed to rasterize');
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgFor(color));
  return tex;
}

export function releaseTractorTexture(color) {
  const e = cache.get(color); if (!e) return;
  if (--e.refs <= 0) { e.tex.dispose(); cache.delete(color); }
}

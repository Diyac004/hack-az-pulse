// node src/scene/mapOverlays.test.mjs
import assert from 'node:assert/strict';
import { pickScaleBar, headlandRect, sectionOn, tractorSections } from './mapOverlays.js';

// scale bar: largest of 10/20/50/100/... m that fits in 120 px
assert.equal(pickScaleBar(0.1).m, 10);     // 10 m = 100 px
assert.equal(pickScaleBar(0.15).m, 10);    // 20 m = 133 px > 120
assert.equal(pickScaleBar(0.2).m, 20);     // 20 m = 100 px
assert.equal(pickScaleBar(0.5).m, 50);
assert.equal(pickScaleBar(1).m, 100);
assert.equal(Math.round(pickScaleBar(1).px), 100);
assert.equal(pickScaleBar(0.01).m, 10);    // very zoomed in: smallest step
assert.equal(pickScaleBar(0).px, 0);

// headland inset: block cells x..x+w-1 -> edges x-0.5..x+w-0.5
assert.deepEqual(headlandRect({ x: 2, y: 3, w: 4, h: 3 }, 0.15), { x0: 1.65, y0: 2.65, x1: 5.35, y1: 5.35 });
assert.deepEqual(headlandRect({ x: 0, y: 0, w: 2, h: 2 }, 0), { x0: -0.5, y0: -0.5, x1: 1.5, y1: 1.5 });
assert.equal(headlandRect({ x: 0, y: 0, w: 1, h: 4 }, 0.5), null); // too narrow

// section flags
assert.equal(sectionOn(true), true); assert.equal(sectionOn(0), false); assert.equal(sectionOn({ isOn: true }), true);
assert.deepEqual(tractorSections({ agopenweb: { sections: [true, false] } }), [true, false]);
assert.deepEqual(tractorSections({ agopenweb: { sections: [] }, tool: { sections: [1] } }), [1]);
assert.equal(tractorSections({ tool: { width_m: 6 } }), null);
console.log('mapOverlays: ok');

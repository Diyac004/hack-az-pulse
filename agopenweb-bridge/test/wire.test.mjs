// node --test test/   (no Docker needed)
// 1. Synthetic frames built byte-for-byte from WireCodec's layout round-trip through the decoder.
// 2. If a demo capture exists, every raw_b64 frame in it (real AgOpenWeb bytes) must decode with zero
//    unread bytes, the layout-drift check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME, TICK_FIELDS, decodeTick, decodeScene, decodeCoverageInit, decodeCoverageCells, decodeFrame,
  encodeTick, encodeScene, encodeCoverageInit, encodeCoverageCells, Writer, WireError } from '../lib/wire.mjs';
import { enToLatLon, latLonToEn, makeGridGeo, radToHeadingDeg } from '../lib/geo.mjs';
import { blockGeom, loadScenario } from '../lib/farm.mjs';
import { makeBlockPath } from '../lib/blockpath.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('Tick: fixed offsets of the leading fields (as in PROJECT.md Change 2)', () => {
  const buf = encodeTick({ sceneVersion: 7, e: 12.5, n: -3.25, heading: Math.PI / 2, speed: 3.3333, fix: 4, sections: [2, 2, 0] });
  assert.equal(buf[0], FRAME.Tick);
  assert.equal(Number(buf.readBigInt64LE(1)), 7);
  assert.equal(buf.readDoubleLE(9), 12.5);
  assert.equal(buf.readDoubleLE(17), -3.25);
  assert.ok(Math.abs(buf.readFloatLE(25) - Math.PI / 2) < 1e-6);
  assert.ok(Math.abs(buf.readFloatLE(29) - 3.3333) < 1e-5);
  assert.equal(buf[33], 4);              // fix
  assert.equal(buf.readInt32LE(34), 3);  // nSections
  assert.deepEqual([...buf.subarray(38, 41)], [2, 2, 0]);
});

test('Tick: full round trip incl. strings (i32 byte-length prefix, UTF-8) and tool pose', () => {
  const src = Object.fromEntries(TICK_FIELDS.map(([k, t]) => [k, t === 'str' ? '' : t === 'sections' ? [] : t === 'bool' ? false : 0]));
  Object.assign(src, { sceneVersion: 3, e: 6.01, n: 97.5, heading: 0.1, speed: 3.33, fix: 4, sections: [2, 2, 2],
    crossTrackError: -0.02, guidanceActive: true, lineLabel: '↑1L', activeTrackName: 'AB 360°', toolE: 6.0, toolN: 95.7,
    toolHeading: 0.1, toolReady: true, autosteer: true, autosteerAvailable: true, sectionMaster: true, youturn: true,
    turnIsLeft: false, passNumber: -2, hitchE: 6, hitchN: 96, hostMs: 123456.5, youturnExecuting: true, goalE: 1, goalN: 2 });
  const t = decodeTick(encodeTick(src));
  for (const k of ['sceneVersion', 'fix', 'guidanceActive', 'lineLabel', 'activeTrackName', 'autosteer', 'sectionMaster', 'youturn', 'passNumber', 'youturnExecuting', 'hostMs', 'toolE', 'e', 'n'])
    assert.deepEqual(t[k], src[k], k);
  assert.deepEqual(t.sections, [2, 2, 2]);
  assert.ok(Math.abs(t.toolN - 95.7) < 1e-9);
});

test('Tick: a truncated or extended frame is rejected (layout drift detector)', () => {
  const buf = encodeTick({ sections: [] });
  assert.throws(() => decodeTick(buf.subarray(0, buf.length - 1)), WireError);
  assert.throws(() => decodeTick(Buffer.concat([buf, Buffer.from([0])])), /unread bytes/);
  assert.doesNotThrow(() => decodeTick(Buffer.concat([buf, Buffer.from([0])]), { strict: false }));
});

test('Scene: origin, boundary, tracks, tool sections -> width', () => {
  const s = decodeScene(encodeScene({ version: 9, originLat: 33.210383, originLon: -111.6197853, hasField: true, fieldName: 'Block_A',
    boundaries: [{ inner: false, points: [{ e: 0, n: 0 }, { e: 160, n: 0 }, { e: 160, n: 120 }, { e: 0, n: 120 }] }],
    tracks: [{ id: 't1', name: 'AB 360°', type: 0, points: [{ e: 3, n: 8 }, { e: 3, n: 112 }] }],
    guidanceLine: [{ e: 3, n: 8 }, { e: 3, n: 112 }], toolSections: [{ left: -3, right: -1 }, { left: -1, right: 1 }, { left: 1, right: 3 }] }));
  assert.equal(s.version, 9); assert.equal(s.fieldName, 'Block_A'); assert.equal(s.originLat, 33.210383);
  assert.equal(s.boundaries[0].points.length, 4); assert.equal(s.tracks[0].name, 'AB 360°');
  assert.equal(s.toolWidth, 6); assert.equal(s.headland, null); assert.equal(s.guidanceLine.length, 2);
});

test('CoverageInit / CoverageCells: layout, ARGB unpacking, multiple-of-3 check', () => {
  const init = decodeCoverageInit(encodeCoverageInit({ cellSize: 0.1, originE: -50, originN: -50, width: 2601, height: 2201, reset: true }));
  assert.deepEqual(init, { cellSize: 0.1, originE: -50, originN: -50, width: 2601, height: 2201, reset: true });
  const raw = encodeCoverageCells([[2505, 2496, 0x98c398, 255], [7, 8, 0x0a84ff, 128]]);
  assert.equal(raw.readInt32LE(1), 6); // int count, not triple count
  const c = decodeCoverageCells(raw);
  assert.equal(c.count, 2);
  assert.deepEqual(c.cells[0], [2505, 2496, 0x98c398, 255]);
  assert.deepEqual(c.cells[1], [7, 8, 0x0a84ff, 128]);
  const bad = new Writer(FRAME.CoverageCells).i32(4).i32(1).i32(2).i32(3).i32(4).done();
  assert.throws(() => decodeCoverageCells(bad), /multiple of 3/);
});

test('decodeFrame: unknown types pass through', () => {
  assert.equal(decodeFrame(Buffer.from([29, 1, 2])).name, 'WebCards');
  assert.equal(decodeFrame(Buffer.from([99])).name, 'Unknown99');
});

test('geo: E/N <-> lat/lon round trip; heading radians -> degrees', () => {
  const o = { lat: 33.210383, lon: -111.6197853 };
  const p = enToLatLon(o.lat, o.lon, 150, 100), back = latLonToEn(o.lat, o.lon, p.lat, p.lon);
  assert.ok(Math.abs(back.e - 150) < 1e-6 && Math.abs(back.n - 100) < 1e-6);
  assert.equal(radToHeadingDeg(Math.PI), 180);
  assert.ok(Math.abs(radToHeadingDeg(-0.1) - 354.27) < 0.01);
  const g = makeGridGeo({ origin_lat: 33.212, origin_lon: -111.62, cell_m: 40 });
  const ll = g.toLatLon(4.5, 2.25), gg = g.toGrid(ll.lat, ll.lon);
  assert.ok(Math.abs(gg.x - 4.5) < 1e-9 && Math.abs(gg.y - 2.25) < 1e-9);
});

test('block path: passes, handoff and projection agree', () => {
  const sc = loadScenario();
  const geom = blockGeom(sc, 'A', { toolWidth: 6 });
  const path_ = makeBlockPath(geom, 6);
  assert.equal(geom.field, 'Block_A');
  assert.ok(Math.abs(geom.widthM - 160) < 0.1 && Math.abs(geom.heightM - 120) < 0.1);
  assert.equal(path_.passes, 26);
  const h0 = path_.handoff(10);
  assert.equal(h0.k, 0); assert.equal(h0.north, true); assert.equal(h0.turn, 'right');
  const mid = path_.at(path_.cum[13] + 20); // 20 m into pass 1 (southbound)
  assert.equal(mid.pass, 1); assert.ok(Math.abs(mid.heading - 180) < 1e-6);
  const h1 = path_.handoff(path_.cum[13] + 20);
  assert.equal(h1.k, 1); assert.equal(h1.north, false); assert.equal(h1.turn, 'left');
  const pr = path_.project(mid.e + 0.3, mid.n);
  assert.ok(Math.abs(pr.s - (path_.cum[13] + 20)) < 0.5 && pr.d < 0.31);
  const inTurn = path_.handoff(path_.cum[2] + 1); // mid U-turn: hands over at the start of the next pass
  assert.equal(inTurn.k, 1);
});

test('real capture (if present): every raw frame decodes exactly', (t) => {
  const dir = path.join(HERE, '..', 'captures');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^agopenweb-.*\.jsonl$/.test(f)) : [];
  if (!files.length) { t.skip('no captures/agopenweb-*.jsonl (run demo.mjs)'); return; }
  let n = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.includes('raw_b64')) continue;
      const rec = JSON.parse(line);
      const buf = Buffer.from(rec.raw_b64, 'base64');
      const d = decodeFrame(buf); // strict: throws on any unread byte
      assert.ok(d.data, `${f}: ${rec.kind} decoded`);
      if (rec.kind === 'tick') assert.ok(Number.isFinite(d.data.e) && Number.isFinite(d.data.heading));
      n++;
    }
  }
  assert.ok(n > 0, 'at least one raw frame');
});

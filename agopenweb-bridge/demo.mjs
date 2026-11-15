// demo.mjs: drive ONE real AgOpenWeb tractor through a job on an orchard block and record what it sends.
//
//   node demo.mjs [--url=ws://localhost:5174/ws] [--block=A] [--seconds=90] [--kph=12] [--tool=6] [--deadman]
//
// Steps: connect + control.acquire + 0.4 s heartbeat -> open/create field Block_<id> (origin = block SW
// corner, boundary = block rectangle) -> implement width -> place tractor -> track.latLonAB for pass 0 ->
// section.master on -> U-turns on (turn right, into the block) -> autosteer on -> speed.
// Prints decoded poses + coverage stats every 3 s and writes captures/agopenweb-<block>-<stamp>.jsonl:
//   {"kind":"meta",...} then one line per frame of interest: {"kind":"tick"|"scene"|"coverage_init"|
//   "coverage_cells"|"control", "at_ms", "data", "raw_b64"?}. raw_b64 (the exact bytes) is kept for the
//   first Scene, the first 5 Ticks, every CoverageInit and the first 5 CoverageCells, so other decoders
//   (Anay's Python gateway) can be tested against real bytes. Ticks are thinned to 5 Hz.
// --deadman: at the end, STOP the heartbeat and measure how long AgOpenWeb takes to drop autosteer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgOpenWebClient } from './client.mjs';
import { loadScenario, blockGeom } from './lib/farm.mjs';
import { FRAME, decodeScene } from './lib/wire.mjs';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const URL_ = arg('url', 'ws://localhost:5174/ws');
const BLOCK = arg('block', 'A');
const SECONDS = +arg('seconds', 90);
const KPH = +arg('kph', 12);
const TOOL = +arg('tool', 6);
const DEADMAN = process.argv.includes('--deadman');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scenario = loadScenario();
const geom = blockGeom(scenario, BLOCK, { toolWidth: TOOL });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
fs.mkdirSync(path.join(HERE, 'captures'), { recursive: true });
const capPath = path.join(HERE, 'captures', `agopenweb-${BLOCK}-${stamp}.jsonl`);
const cap = fs.createWriteStream(capPath);
const t0 = Date.now();
const write = (o) => cap.write(JSON.stringify(o) + '\n');

const c = new AgOpenWebClient({ url: URL_, id: 'T1', name: 'FleetAI-demo', log: (s) => { if (!s.includes('presence')) console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`); } });

// ---- capture
const rawBudget = { [FRAME.Scene]: 1, [FRAME.Tick]: 5, [FRAME.CoverageInit]: 99, [FRAME.CoverageCells]: 5 };
let lastTickCap = 0;
const KIND = { [FRAME.Tick]: 'tick', [FRAME.Scene]: 'scene', [FRAME.CoverageInit]: 'coverage_init', [FRAME.CoverageCells]: 'coverage_cells', [FRAME.ControlState]: 'control' };
c.on('frame', ({ type, buf }) => {
  const kind = KIND[type];
  if (!kind) return;
  const now = Date.now();
  if (type === FRAME.Tick) { if (now - lastTickCap < 200 && rawBudget[type] <= 0) return; lastTickCap = now; }
  const rec = { kind, at_ms: now - t0, bytes: buf.length };
  if (rawBudget[type] > 0) { rec.raw_b64 = buf.toString('base64'); rawBudget[type]--; }
  queueMicrotask(() => { // decoded state is updated by the client's own 'frame' handler order; read after
    try {
      if (type === FRAME.Tick) rec.data = { ...c.tick, pose: c.pose() };
      else if (type === FRAME.Scene) { const s = decodeScene(buf); rec.data = { ...s, boundaries: s.boundaries.map((b) => ({ inner: b.inner, n: b.points.length, points: b.points })), tramLines: undefined, contourStrips: undefined }; }
      else if (type === FRAME.CoverageInit) rec.data = c.coverageInit;
      else if (type === FRAME.ControlState) rec.data = c.control;
      else if (type === FRAME.CoverageCells) { const n = buf.readInt32LE(1) / 3; const cells = []; for (let i = 0; i < n; i++) { const o = 5 + i * 12; const p = buf.readUInt32LE(o + 8); cells.push([buf.readInt32LE(o), buf.readInt32LE(o + 4), p & 0xffffff, p >>> 24]); } rec.data = { count: n, cells }; }
    } catch (e) { rec.error = e.message; }
    write(rec);
  });
});

// ---- coverage stats (field-local, deduped at AgOpenWeb's own cell size)
const painted = new Set();
c.on('coverage', ({ cells }) => { for (const [x, y] of cells) painted.add(x * 100000 + y); });

await c.connect();
write({ kind: 'meta', at_ms: 0, url: URL_, block: BLOCK, field: geom.field, field_origin: geom.origin, boundary: geom.boundary, ref_ab: geom.passAB(0), pass0_center: geom.passCenter(0), tool_width_m: TOOL, kph: KPH, agopenweb_commit: process.env.AOW_COMMIT || null, client_id: c.clientId });
console.log(`connected to ${URL_} as ${c.clientId}; control held by us: ${c.hasControl}`);

const tJob = Date.now();
const startPose = await c.startJob({ field: geom.field, originLat: geom.origin.lat, originLon: geom.origin.lon, boundary: geom.boundary,
  toolWidth: TOOL, ab: geom.passAB(0), start: geom.passCenter(0).slice(0, 2), speedKph: KPH, turn: 'right' });
console.log(`job started in ${Date.now() - tJob} ms. field=${c.scene.fieldName} origin=${c.scene.originLat.toFixed(6)},${c.scene.originLon.toFixed(6)} tool=${c.scene.toolWidth} m (${c.scene.toolSections.length} sections)`);
console.log('start pose', JSON.stringify(startPose));
write({ kind: 'event', at_ms: Date.now() - t0, what: 'job_started', ref_ab: c.lastAB, pass0_center: geom.passCenter(0), field: geom.field });

const until = Date.now() + SECONDS * 1000;
while (Date.now() < until) {
  await sleep(3000);
  const p = c.pose(), t = c.tick, cs = c.coverageInit ? c.coverageInit.cellSize : 0.1;
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] lat ${p.lat.toFixed(6)} lon ${p.lon.toFixed(6)} E ${t.e.toFixed(1)} N ${t.n.toFixed(1)} hdg ${p.heading_deg.toFixed(0)} ${(t.speed * 3.6).toFixed(1)} km/h xte ${t.crossTrackError.toFixed(2)} m pass ${t.passNumber} autosteer ${+t.autosteer} sections ${t.sections.join('')} uturn ${t.youturnExecuting ? 'TURNING' : +t.youturn} | covered ${(painted.size * cs * cs).toFixed(0)} m2 (${painted.size} cells @ ${cs} m)`);
}

if (DEADMAN) {
  console.log('deadman test: stopping heartbeat (control.presence) now');
  const tStop = Date.now();
  c.stopHeartbeat();
  const t = await c.waitForTick((x) => !x.autosteer, 5000, 'deadman disengage').catch((e) => { console.log(e.message); return null; });
  const ms = Date.now() - tStop;
  console.log(t ? `deadman: autosteer dropped ${ms} ms after the last heartbeat (sections ${t.sections.join('')}, control ${JSON.stringify(c.control)})` : 'deadman: autosteer did NOT drop');
  write({ kind: 'event', at_ms: Date.now() - t0, what: 'deadman', disengaged_after_ms: t ? ms : null, sections_after: t ? t.sections : null, control_after: c.control });
  c.startHeartbeat(); c.send('control.acquire', c.name);
  await sleep(500);
}

await c.stop();
console.log(`stopped. frames: ${JSON.stringify(c.frameCounts)} decode errors: ${c.decodeErrors}`);
write({ kind: 'summary', at_ms: Date.now() - t0, frames: c.frameCounts, decode_errors: c.decodeErrors, covered_m2: painted.size * (c.coverageInit ? c.coverageInit.cellSize ** 2 : 0.01) });
await c.close();
cap.end(() => { console.log(`capture: ${capPath} (${(fs.statSync(capPath).size / 1024).toFixed(0)} KB)`); process.exit(0); });

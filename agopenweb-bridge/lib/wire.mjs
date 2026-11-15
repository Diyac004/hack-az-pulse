// AgOpenWeb wire codec (decoder + test encoder), mirroring Shared/AgOpenWeb.RemoteServer/WireCodec.cs
// at AgOpenWeb commit 19c15c1 (2026-11-15). Pure: no I/O, works on Node Buffers / Uint8Arrays.
//
// Every server->client message is ONE binary WebSocket frame: byte 0 = frame type, then fields written
// by .NET BinaryWriter, little-endian. Strings are NOT 7-bit-length-prefixed: WireCodec.WriteStr writes
// an i32 BYTE length then UTF-8 bytes. Point lists ("pts") are i32 count then count x (f32 E, f32 N).
// "optPts" is u8 present(0/1) then pts when present.
//
// Client->server messages are TEXT frames: "command" or "command|argument" (RemoteServerWiring.cs).

export const FRAME = Object.freeze({
  Scene: 1, Tick: 2, CoverageInit: 3, CoverageCells: 4, Status: 5, ControlState: 6, Hello: 7, Config: 8,
  Profiles: 9, Wizard: 10, NtripProfiles: 11, FieldOps: 12, AgShare: 13, AppInfo: 14, FieldTools: 15,
  RecordedPath: 16, Boundary: 17, Sound: 18, Pong: 19, CoverageEdge: 20, ViewPrefs: 21, Prompt: 22,
  Toast: 23, DrivePick: 24, HardwareMessage: 25, Vt: 26, VtImage: 27, NtripMountpoints: 28, WebCards: 29,
});
export const FRAME_NAME = Object.fromEntries(Object.entries(FRAME).map(([k, v]) => [v, k]));

export class WireError extends Error {}

/** Sequential little-endian reader starting AFTER the type byte. */
export class Reader {
  constructor(buf, offset = 1) {
    this.b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer ? buf.buffer : buf, buf.byteOffset || 0, buf.byteLength);
    this.o = offset;
  }
  need(n) { if (this.o + n > this.b.length) throw new WireError(`frame type ${this.b[0]} truncated: need ${n} bytes at offset ${this.o}, have ${this.b.length}`); }
  u8() { this.need(1); return this.b.readUInt8(this.o++); }
  bool() { return this.u8() !== 0; }
  i32() { this.need(4); const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  i64() { this.need(8); const v = this.b.readBigInt64LE(this.o); this.o += 8; return Number(v); }
  f32() { this.need(4); const v = this.b.readFloatLE(this.o); this.o += 4; return v; }
  f64() { this.need(8); const v = this.b.readDoubleLE(this.o); this.o += 8; return v; }
  str() { const n = this.i32(); if (n < 0) throw new WireError(`negative string length ${n}`); this.need(n); const s = this.b.toString('utf8', this.o, this.o + n); this.o += n; return s; }
  pts() { const n = this.i32(); if (n < 0) throw new WireError(`negative point count ${n}`); this.need(n * 8); const out = new Array(n); for (let i = 0; i < n; i++) out[i] = { e: this.f32(), n: this.f32() }; return out; }
  optPts() { return this.u8() ? this.pts() : null; }
  get rest() { return this.b.length - this.o; }
  /** Layout-drift detector: a fully decoded frame must end exactly at its last byte. */
  end(strict = true) {
    if (strict && this.o !== this.b.length) throw new WireError(`frame type ${this.b[0]} (${FRAME_NAME[this.b[0]]}) has ${this.b.length - this.o} unread bytes: AgOpenWeb's WireCodec layout changed`);
  }
}

// ---------------------------------------------------------------- Tick (type 2), WireCodec.EncodeTick
// Field order is load-bearing. Units as observed live (see README "Units"):
//   e,n: field-local metres from the open field's origin (Scene.originLat/Lon); heading/toolHeading: RADIANS,
//   0 = north, clockwise; speed: METRES PER SECOND (sim.speedUp adds 0.5 km/h); crossTrackError: metres.
//   sections[i]: display state byte 0 = off, 1 = manual on?, 2 = auto on (observed 2 while painting in auto).
export const TICK_FIELDS = [
  ['sceneVersion', 'i64'], ['e', 'f64'], ['n', 'f64'], ['heading', 'f32'], ['speed', 'f32'], ['fix', 'u8'],
  ['sections', 'sections'], ['crossTrackError', 'f32'], ['guidanceActive', 'bool'], ['lineLabel', 'str'],
  ['activeTrackName', 'str'], ['toolE', 'f64'], ['toolN', 'f64'], ['toolHeading', 'f32'], ['toolReady', 'bool'],
  ['autosteer', 'bool'], ['autosteerAvailable', 'bool'], ['contour', 'bool'], ['sectionMaster', 'bool'],
  ['sectionManualAll', 'bool'], ['youturn', 'bool'], ['turnIsLeft', 'bool'], ['distanceToTrigger', 'f32'],
  ['activeTrackClosed', 'bool'], ['roll', 'f32'], ['headlandOn', 'bool'], ['sectionInHeadland', 'bool'],
  ['autoTrack', 'bool'], ['skipRows', 'u8'], ['skipMode', 'u8'], ['tramMode', 'u8'],
  ['headlandProximityDistance', 'f32'], ['headlandProximityWarning', 'bool'], ['steerAngleError', 'f32'],
  ['chartSetSteer', 'f32'], ['chartActualSteer', 'f32'], ['chartPwm', 'f32'], ['chartImuHeading', 'f32'],
  ['hitchE', 'f64'], ['hitchN', 'f64'], ['vehicleSteerAngle', 'f32'], ['hostMs', 'f64'],
  ['youturnExecuting', 'bool'], ['passNumber', 'i32'], ['nudgeOffset', 'f32'], ['refNudgeMoved', 'f32'],
  ['refNudgePending', 'bool'], ['hasGoal', 'bool'], ['goalE', 'f64'], ['goalN', 'f64'], ['reverse', 'bool'],
  ['moduleNotSteering', 'bool'], ['chartGpsHeading', 'f32'], ['tramLights', 'u8'], ['outOfBounds', 'bool'],
  ['contourAhead', 'u8'], ['contourAheadM', 'f32'],
];

const read = (r, t) => (t === 'sections' ? (() => { const n = r.i32(); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = r.u8(); return a; })() : r[t]());

export function decodeTick(buf, { strict = true } = {}) {
  const r = new Reader(buf);
  if (r.b[0] !== FRAME.Tick) throw new WireError(`not a Tick frame (type ${r.b[0]})`);
  const t = {};
  for (const [k, ty] of TICK_FIELDS) t[k] = read(r, ty);
  r.end(strict);
  return t;
}

// ---------------------------------------------------------------- Scene (type 1), WireCodec.EncodeScene
export function decodeScene(buf, { strict = true } = {}) {
  const r = new Reader(buf);
  if (r.b[0] !== FRAME.Scene) throw new WireError(`not a Scene frame (type ${r.b[0]})`);
  const s = { version: r.i64(), originLat: r.f64(), originLon: r.f64(), hasField: r.bool(), fieldName: r.str() };
  const nb = r.i32(); s.boundaries = [];
  for (let i = 0; i < nb; i++) s.boundaries.push({ inner: r.bool(), points: r.pts() });
  const nt = r.i32(); s.tracks = [];
  for (let i = 0; i < nt; i++) s.tracks.push({ id: r.str(), name: r.str(), type: r.i32(), points: r.pts() });
  s.headland = r.optPts();
  s.guidanceLine = r.optPts();
  const ns = r.i32(); s.toolSections = [];
  for (let i = 0; i < ns; i++) s.toolSections.push({ left: r.f32(), right: r.f32() });
  s.uturnPath = r.optPts();
  s.nextTrack = r.optPts();
  const nf = r.i32(); s.flags = [];
  for (let i = 0; i < nf; i++) s.flags.push({ e: r.f32(), n: r.f32(), color: r.str(), name: r.str() });
  s.imagery = r.u8() ? { minE: r.f64(), minN: r.f64(), maxE: r.f64(), maxN: r.f64(), version: r.i64() } : null;
  const ntl = r.i32(); s.trackList = [];
  for (let i = 0; i < ntl; i++) s.trackList.push({ index: r.i32(), name: r.str(), type: r.str(), active: r.bool(), visible: r.bool() });
  const nh = r.i32(); s.headlandSegs = [];
  for (let i = 0; i < nh; i++) s.headlandSegs.push({ index: r.i32(), name: r.str(), type: r.str(), offset: r.f64(), effective: r.bool(), editLine: r.pts(), endA: { e: r.f32(), n: r.f32() }, endB: { e: r.f32(), n: r.f32() } });
  const nts = r.i32(); s.tramSystems = [];
  for (let i = 0; i < nts; i++) s.tramSystems.push({ index: r.i32(), name: r.str(), refLabel: r.str(), width: r.f64(), mode: r.i32(), offset: r.f64(), direction: r.i32(), passCount: r.i32(), enabled: r.bool(), isBoundary: r.bool() });
  const lists = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(r.pts()); return out; };
  s.tramLines = lists(r.i32());
  s.recordedPaths = lists(r.i32());
  s.contourStrips = lists(r.i32());
  s.contourRef = r.optPts();
  s.contourLocked = r.bool();
  s.guideLines = lists(r.i32());
  s.toolPass = r.optPts();
  r.end(strict);
  // Derived: implement width = span of the section edges (metres, left negative).
  if (s.toolSections.length) {
    const lo = Math.min(...s.toolSections.map((x) => x.left)), hi = Math.max(...s.toolSections.map((x) => x.right));
    s.toolWidth = hi - lo;
  } else s.toolWidth = null;
  return s;
}

// ---------------------------------------------------------------- coverage (types 3, 4)
/** CoverageInit: cell grid in field-local metres. Cell (x, y) spans E = originE + x*cellSize .. +cellSize,
 *  N = originN + y*cellSize .. +cellSize (y grows NORTH; verified live by driving north). reset=true: drop all
 *  coverage, a snapshot follows; reset=false: grid grew, re-anchor existing cells (origin moved). An all-zero
 *  init with reset=true = "no field / coverage cleared". */
export function decodeCoverageInit(buf) {
  const r = new Reader(buf);
  if (r.b[0] !== FRAME.CoverageInit) throw new WireError(`not a CoverageInit frame (type ${r.b[0]})`);
  const c = { cellSize: r.f64(), originE: r.f64(), originN: r.f64(), width: r.i32(), height: r.i32(), reset: r.bool() };
  r.end();
  return c;
}

/** CoverageCells: i32 intCount then intCount x i32, flat triples [cellX, cellY, packedARGB].
 *  packed = (alpha << 24) | (R << 16) | (G << 8) | B; alpha = fraction of the cell covered (edge cells < 255),
 *  and a cell can be re-sent with rising alpha. Returns {count, cells: [[x, y, rgb, alpha], ...]}. */
export function decodeCoverageCells(buf) {
  const r = new Reader(buf);
  if (r.b[0] !== FRAME.CoverageCells) throw new WireError(`not a CoverageCells frame (type ${r.b[0]})`);
  const n = r.i32();
  if (n % 3 !== 0) throw new WireError(`CoverageCells int count ${n} is not a multiple of 3`);
  const cells = new Array(n / 3);
  for (let i = 0; i < n / 3; i++) {
    const x = r.i32(), y = r.i32(), p = r.u32();
    cells[i] = [x, y, p & 0xffffff, p >>> 24];
  }
  r.end();
  return { count: n / 3, cells };
}

export function decodeControlState(buf) { const r = new Reader(buf); const s = { held: r.bool(), holderId: r.str(), holderName: r.str() }; r.end(); return s; }
export function decodeHello(buf) { const r = new Reader(buf); const s = { clientId: r.str(), features: r.u8() }; r.end(); return s; }
/** Prompt (22): a host-side yes/no dialog (e.g. "save the job?"); answer with "prompt.answer|seq,yes(1|0),checkbox(1|0)".
 *  seq 0 / empty title = no prompt open. */
export function decodePrompt(buf) { const r = new Reader(buf); const p = { seq: r.i32(), kind: r.u8(), title: r.str(), message: r.str(), confirm: r.str(), cancel: r.str(), checkbox: r.str(), checked: r.bool() }; r.end(); return p; }
export function decodeToast(buf) { const r = new Reader(buf); return { message: r.str() }; }

/** Decode any frame we understand; others come back as {type, name, bytes}. */
export function decodeFrame(buf) {
  const type = buf[0];
  const name = FRAME_NAME[type] || `Unknown${type}`;
  switch (type) {
    case FRAME.Tick: return { type, name, data: decodeTick(buf) };
    case FRAME.Scene: return { type, name, data: decodeScene(buf) };
    case FRAME.CoverageInit: return { type, name, data: decodeCoverageInit(buf) };
    case FRAME.CoverageCells: return { type, name, data: decodeCoverageCells(buf) };
    case FRAME.ControlState: return { type, name, data: decodeControlState(buf) };
    case FRAME.Hello: return { type, name, data: decodeHello(buf) };
    case FRAME.Toast: return { type, name, data: decodeToast(buf) };
    case FRAME.Prompt: return { type, name, data: decodePrompt(buf) };
    default: return { type, name, data: null, bytes: buf.length };
  }
}

// ---------------------------------------------------------------- encoder (tests / fakes only)
/** Little-endian writer producing frames byte-identical to WireCodec (used by unit tests and fake servers). */
export class Writer {
  constructor(type) { this.parts = [Buffer.from([type])]; }
  u8(v) { this.parts.push(Buffer.from([v & 255])); return this; }
  bool(v) { return this.u8(v ? 1 : 0); }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(v); this.parts.push(b); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.parts.push(b); return this; }
  i64(v) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(Math.trunc(v))); this.parts.push(b); return this; }
  f32(v) { const b = Buffer.alloc(4); b.writeFloatLE(v); this.parts.push(b); return this; }
  f64(v) { const b = Buffer.alloc(8); b.writeDoubleLE(v); this.parts.push(b); return this; }
  str(s) { const b = Buffer.from(s ?? '', 'utf8'); this.i32(b.length); this.parts.push(b); return this; }
  pts(p) { this.i32(p.length); for (const q of p) { this.f32(q.e); this.f32(q.n); } return this; }
  optPts(p) { if (!p) return this.u8(0); this.u8(1); return this.pts(p); }
  done() { return Buffer.concat(this.parts); }
}

export function encodeTick(t) {
  const w = new Writer(FRAME.Tick);
  for (const [k, ty] of TICK_FIELDS) {
    const v = t[k];
    if (ty === 'sections') { const a = v || []; w.i32(a.length); a.forEach((x) => w.u8(x)); } else w[ty](ty === 'str' ? (v ?? '') : (v ?? 0));
  }
  return w.done();
}

export function encodeScene(s) {
  const w = new Writer(FRAME.Scene);
  w.i64(s.version ?? 1).f64(s.originLat ?? 0).f64(s.originLon ?? 0).bool(s.hasField).str(s.fieldName ?? '');
  const b = s.boundaries || []; w.i32(b.length); b.forEach((x) => { w.bool(x.inner); w.pts(x.points); });
  const t = s.tracks || []; w.i32(t.length); t.forEach((x) => { w.str(x.id).str(x.name).i32(x.type ?? 0).pts(x.points || []); });
  w.optPts(s.headland).optPts(s.guidanceLine);
  const ts = s.toolSections || []; w.i32(ts.length); ts.forEach((x) => { w.f32(x.left).f32(x.right); });
  w.optPts(s.uturnPath).optPts(s.nextTrack);
  w.i32(0); // flags
  w.u8(0); // imagery
  w.i32(0); w.i32(0); w.i32(0); // trackList, headlandSegs, tramSystems
  w.i32(0); w.i32(0); w.i32(0); // tramLines, recordedPaths, contourStrips
  w.optPts(null).bool(false).i32(0).optPts(null); // contourRef, contourLocked, guideLines, toolPass
  return w.done();
}

export function encodeCoverageInit(c) {
  return new Writer(FRAME.CoverageInit).f64(c.cellSize).f64(c.originE).f64(c.originN).i32(c.width).i32(c.height).bool(c.reset).done();
}

export function encodeCoverageCells(cells) {
  const w = new Writer(FRAME.CoverageCells).i32(cells.length * 3);
  for (const [x, y, rgb, a = 255] of cells) { w.i32(x).i32(y).u32(((a & 255) << 24) | (rgb & 0xffffff)); }
  return w.done();
}

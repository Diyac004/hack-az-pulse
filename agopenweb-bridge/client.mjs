// AgOpenWebClient: one connection to one headless AgOpenWeb instance (one tractor).
// Dependency: `ws` only. Decoding lives in lib/wire.mjs.
//
//   const c = new AgOpenWebClient({ url: 'ws://localhost:5174/ws', id: 'T1', name: 'FleetAI' });
//   await c.connect();                 // control.acquire + 0.4 s control.presence heartbeat
//   await c.startJob({ field: 'Block_A', boundary: [[lat, lon], ...], ab: [latA, lonA, latB, lonB] });
//   c.pose()  -> { lat, lon, e, n, heading_deg, speed_mps, tool: {...}, flags }
//   c.stop() / c.resume() / c.close()
//
// Method names mirror Anay's TractorGateway (backend/app/gateway/base.py) where they make sense for ONE
// tractor: pose(), stop(), resume(), status(), plus start_job/start_transit-style helpers (startJob,
// moveTo). The fleet-level parts (add_tractor/remove_tractor/assign/advance) live in server.mjs's pool.
//
// Events: 'tick'(tick), 'scene'(scene), 'coverageInit'(init), 'coverage'({cells, init}), 'control'(state),
//         'toast'(msg), 'frame'({type, name, buf}), 'open', 'close', 'error'.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { FRAME, FRAME_NAME, decodeTick, decodeScene, decodeCoverageInit, decodeCoverageCells,
  decodeControlState, decodeHello, decodeToast, decodePrompt, WireError } from './lib/wire.mjs';
import { enToLatLon, latLonToEn, radToHeadingDeg } from './lib/geo.mjs';

export const HEARTBEAT_MS = 400;   // AgOpenWeb deadman is 1500 ms (ControlAuthority.DeadmanMs)
export const KPH_PER_SPEEDUP = 0.5; // MainViewModel.Commands.Simulator: SimulatorSpeedKph += 0.5

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(7).replace(/0+$/, '').replace(/\.$/, ''));

export class AgOpenWebClient extends EventEmitter {
  constructor({ url = 'ws://localhost:5174/ws', id = 'T1', name = 'FleetAI', heartbeat = true, log = null } = {}) {
    super();
    Object.assign(this, { url, id, name, heartbeatOn: heartbeat });
    this.log = log || (() => {});
    this.ws = null;
    this.clientId = null;       // from Hello
    this.control = null;        // last ControlState {held, holderId, holderName}
    this.tick = null;           // last decoded Tick
    this.tickAt = 0;            // Date.now() of last Tick
    this.scene = null;          // last decoded Scene (origin, boundaries, tracks, tool sections)
    this.coverageInit = null;   // last CoverageInit
    this.lastPresenceAt = 0;    // Date.now() of the last control.presence we sent
    this.frameCounts = {};
    this.decodeErrors = 0;
    this.lastAB = null;         // [latA, lonA, latB, lonB] of the last track.latLonAB we sent
    this.simSpeedKph = null;    // our model of SimulatorSpeedKph (no read-back on the wire)
    this._hb = null;
    this._closing = false;
  }

  // ------------------------------------------------------------------ connection
  connect({ timeoutMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
      ws.binaryType = 'nodebuffer';
      this.ws = ws;
      const to = setTimeout(() => { reject(new Error(`${this.id}: no Tick from ${this.url} within ${timeoutMs} ms`)); try { ws.terminate(); } catch {} }, timeoutMs);
      ws.on('open', () => {
        this.emit('open');
        // Control is implicitly granted to a new connection (named "Browser"); acquire renames it to ours
        // and re-takes it if someone else holds it.
        this.send('control.acquire', this.name);
        if (this.heartbeatOn) this.startHeartbeat();
      });
      ws.on('message', (buf, isBinary) => { if (isBinary) this._onFrame(buf); });
      ws.on('close', (code) => { this.stopHeartbeat(); this.emit('close', code); });
      ws.on('error', (e) => { clearTimeout(to); if (this.listenerCount('error')) this.emit('error', e); reject(e); });
      this.once('tick', () => { clearTimeout(to); resolve(this); });
    });
  }

  async close({ release = true } = {}) {
    this._closing = true;
    this.stopHeartbeat();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (release) this.send('control.release');
      await sleep(50);
      this.ws.close();
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    const beat = () => { if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.ws.send('control.presence'); this.lastPresenceAt = Date.now(); } };
    beat();
    this._hb = setInterval(beat, HEARTBEAT_MS);
  }
  stopHeartbeat() { if (this._hb) clearInterval(this._hb); this._hb = null; }

  get connected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
  /** True when the last ControlState says WE hold actuation authority. */
  get hasControl() { return !!(this.control && this.control.held && this.control.holderId === this.clientId); }
  get heartbeatAgeMs() { return this.lastPresenceAt ? Date.now() - this.lastPresenceAt : null; }
  get tickAgeMs() { return this.tickAt ? Date.now() - this.tickAt : null; }

  send(cmd, arg) {
    if (!this.connected) throw new Error(`${this.id}: not connected`);
    const s = arg === undefined || arg === null ? cmd : `${cmd}|${arg}`;
    this.log(`${this.id} >> ${s}`);
    this.ws.send(s);
  }

  _onFrame(buf) {
    const type = buf[0];
    this.frameCounts[type] = (this.frameCounts[type] || 0) + 1;
    this.emit('frame', { type, name: FRAME_NAME[type], buf });
    try {
      switch (type) {
        case FRAME.Tick: this.tick = decodeTick(buf); this.tickAt = Date.now(); this.emit('tick', this.tick); break;
        case FRAME.Scene: this.scene = decodeScene(buf); this.emit('scene', this.scene); break;
        case FRAME.CoverageInit: this.coverageInit = decodeCoverageInit(buf); this.emit('coverageInit', this.coverageInit); break;
        case FRAME.CoverageCells: { const c = decodeCoverageCells(buf); this.emit('coverage', { cells: c.cells, init: this.coverageInit }); break; }
        case FRAME.ControlState: this.control = decodeControlState(buf); this.emit('control', this.control); break;
        case FRAME.Hello: this.clientId = decodeHello(buf).clientId; break;
        case FRAME.Prompt: { this.prompt = decodePrompt(buf); if (this.prompt.title || this.prompt.message) { this.log(`${this.id} PROMPT #${this.prompt.seq}: ${this.prompt.title} | ${this.prompt.message} [${this.prompt.confirm}/${this.prompt.cancel}]`); this.emit('prompt', this.prompt); } break; }
        case FRAME.Toast: this.emit('toast', decodeToast(buf).message); this.log(`${this.id} toast: ${decodeToast(buf).message}`); break;
        default: break;
      }
    } catch (e) {
      this.decodeErrors++;
      if (this.decodeErrors <= 3) this.log(`${this.id} decode error (${FRAME_NAME[type]}): ${e.message}`);
      this.emit('decodeError', e);
      if (!(e instanceof WireError)) throw e;
    }
  }

  // ------------------------------------------------------------------ waiting
  /** Resolve with the first Tick (current or future) for which pred(tick) is true. */
  waitForTick(pred = () => true, timeoutMs = 5000, what = 'condition') {
    if (this.tick && pred(this.tick)) return Promise.resolve(this.tick);
    return new Promise((resolve, reject) => {
      const on = (t) => { if (pred(t)) { cleanup(); resolve(t); } };
      const to = setTimeout(() => { cleanup(); reject(new Error(`${this.id}: timed out after ${timeoutMs} ms waiting for ${what}`)); }, timeoutMs);
      const cleanup = () => { clearTimeout(to); this.off('tick', on); };
      this.on('tick', on);
    });
  }
  waitForScene(pred = () => true, timeoutMs = 5000, what = 'scene') {
    if (this.scene && pred(this.scene)) return Promise.resolve(this.scene);
    return new Promise((resolve, reject) => {
      const on = (s) => { if (pred(s)) { cleanup(); resolve(s); } };
      const to = setTimeout(() => { cleanup(); reject(new Error(`${this.id}: timed out after ${timeoutMs} ms waiting for ${what}`)); }, timeoutMs);
      const cleanup = () => { clearTimeout(to); this.off('scene', on); };
      this.on('scene', on);
    });
  }

  // ------------------------------------------------------------------ geometry
  get origin() { return this.scene && this.scene.hasField ? { lat: this.scene.originLat, lon: this.scene.originLon } : null; }
  enToLatLon(e, n) { const o = this.origin; return o ? enToLatLon(o.lat, o.lon, e, n) : null; }
  latLonToEn(lat, lon) { const o = this.origin; return o ? latLonToEn(o.lat, o.lon, lat, lon) : null; }

  /** Pose in contract-friendly units. lat/lon null until a field is open (E/N are then meaningless). */
  pose() {
    const t = this.tick;
    if (!t) return null;
    const ll = this.enToLatLon(t.e, t.n), tl = this.enToLatLon(t.toolE, t.toolN);
    return {
      e: t.e, n: t.n, lat: ll ? ll.lat : null, lon: ll ? ll.lon : null,
      heading_deg: radToHeadingDeg(t.heading), speed_mps: t.speed,
      tool: { e: t.toolE, n: t.toolN, lat: tl ? tl.lat : null, lon: tl ? tl.lon : null,
        heading_deg: radToHeadingDeg(t.toolHeading), width_m: this.scene ? this.scene.toolWidth : null },
      cross_track_error_m: t.crossTrackError, sections: t.sections, line: t.activeTrackName || null,
    };
  }

  /** AgOpenWeb-side state for the contract `agopenweb` block (plus extras). */
  status() {
    const t = this.tick || {};
    return {
      endpoint: this.url, connected: this.connected, heartbeat_age_ms: this.heartbeatAgeMs,
      tick_age_ms: this.tickAgeMs, has_control: this.hasControl,
      autosteer: !!t.autosteer, section_master: !!t.sectionMaster, youturn: !!t.youturn,
      field: this.scene && this.scene.hasField ? this.scene.fieldName : null,
      fix: t.fix ?? null, youturn_executing: !!t.youturnExecuting, out_of_bounds: !!t.outOfBounds,
    };
  }

  // ------------------------------------------------------------------ toggles that track true state
  // autosteer.toggle / section.master / youturn.toggle are blind toggles: only send when the Tick flag
  // differs from what we want, then wait for the Tick to confirm.
  async _ensure(flag, want, cmd, timeoutMs = 2500) {
    if (!this.tick) await this.waitForTick(() => true, 3000, 'first tick');
    if (!!this.tick[flag] === !!want) return true;
    this.send(cmd);
    try { await this.waitForTick((t) => !!t[flag] === !!want, timeoutMs, `${flag}=${want}`); return true; }
    catch (e) { this.log(e.message); return false; }
  }
  setAutosteer(on) { return this._ensure('autosteer', on, 'autosteer.toggle'); }
  setSectionMaster(on) { return this._ensure('sectionMaster', on, 'section.master'); }
  setYouTurn(on) { return this._ensure('youturn', on, 'youturn.toggle'); }

  // ------------------------------------------------------------------ simulator commands
  /** Teleport (sim.setCoords). Waits until the pose lands within tolMeters of the target (if a field is open). */
  async setCoords(lat, lon, { tolMeters = 1.0, timeoutMs = 3000 } = {}) {
    this.send('sim.setCoords', `${fmt(lat)},${fmt(lon)}`);
    const target = this.latLonToEn(lat, lon);
    if (!target) { await sleep(400); return this.tick; }
    return this.waitForTick((t) => Math.hypot(t.e - target.e, t.n - target.n) < tolMeters, timeoutMs, `pose at ${lat},${lon}`);
  }
  /** Set sim speed in km/h: sim.stop then N x sim.speedUp (0.5 km/h each). No direct setter exists. */
  async setSpeedKph(kph) {
    this.send('sim.stop');
    const n = Math.max(0, Math.round(kph / KPH_PER_SPEEDUP));
    for (let i = 0; i < n; i++) this.send('sim.speedUp');
    this.simSpeedKph = n * KPH_PER_SPEEDUP;
    if (n > 0) await this.waitForTick((t) => t.speed > 0.05, 3000, 'moving').catch(() => {});
    return this.simSpeedKph;
  }
  speedUp() { this.send('sim.speedUp'); if (this.simSpeedKph != null) this.simSpeedKph += KPH_PER_SPEEDUP; }
  speedDown() { this.send('sim.speedDown'); if (this.simSpeedKph != null) this.simSpeedKph = Math.max(0, this.simSpeedKph - KPH_PER_SPEEDUP); }
  setSteer(deg) { this.send('sim.setSteer', fmt(+deg)); }
  steerReset() { this.send('sim.steerReset'); }
  configSet(key, value) { this.send('config.set', `${key}:${value}`); }

  /** Implement width: N equal sections (config.set tool.defaultSectionWidth is in CENTIMETRES, then
   *  tool.numSections re-applies it to every section). Waits for the Scene's section spans to match. */
  async setTool({ widthM, sections = 1 }) {
    if (this.scene && this.scene.toolWidth != null && Math.abs(this.scene.toolWidth - widthM) < 0.02 && this.scene.toolSections.length === sections) return this.scene.toolWidth;
    this.configSet('tool.defaultSectionWidth', Math.round((widthM * 100) / sections));
    this.configSet('tool.numSections', sections);
    await this.waitForScene((s) => s.toolWidth != null && Math.abs(s.toolWidth - widthM) < 0.05, 3000, `tool width ${widthM} m`).catch((e) => this.log(e.message));
    return this.scene && this.scene.toolWidth;
  }

  /** Next U-turn direction ('left' | 'right'); youturn.direction is a toggle, Tick.turnIsLeft is the truth. */
  setTurnDirection(dir) { return this._ensure('turnIsLeft', dir === 'left', 'youturn.direction'); }

  /** Quick AB line from two lat/lon points (track.latLonAB). Needs an open field. */
  async setABLine(latA, lonA, latB, lonB) {
    const before = this.scene ? this.scene.version : -1;
    this.send('track.latLonAB', [latA, lonA, latB, lonB].map(fmt).join(','));
    this.lastAB = [latA, lonA, latB, lonB];
    await this.waitForTick((t) => t.guidanceActive && t.sceneVersion > before, 3000, 'AB line active').catch((e) => this.log(e.message));
    return this.lastAB;
  }

  // ------------------------------------------------------------------ fields
  /** Open an existing field by name, or create it at (originLat, originLon) with an optional boundary
   *  (array of [lat, lon]). field.new uses the CURRENT sim position as the field origin, so we teleport
   *  there first. Returns the decoded Scene. */
  async openOrCreateField(name, { originLat, originLon, boundary = null, create = true, exists = null } = {}) {
    if (this.scene && this.scene.hasField && this.scene.fieldName === name) return this.scene;
    const prev = this.scene ? this.scene.version : -1;
    if (this.scene && this.scene.hasField) await this.closeField(); // openOnly/new are ignored while a painted field is open
    if (exists !== false) { // exists=false (caller knows): skip the open attempt and its 2.5 s timeout
      this.send('field.openOnly', name);
      try {
        return await this.waitForScene((s) => s.hasField && s.fieldName === name, exists ? 5000 : 2500, `field ${name} open`);
      } catch { if (!create) throw new Error(`${this.id}: field ${name} not found`); }
    }
    this.send('sim.setCoords', `${fmt(originLat)},${fmt(originLon)}`);
    await sleep(400);
    this.send('field.new', name);
    const s = await this.waitForScene((sc) => sc.hasField && sc.fieldName === name && sc.version > prev, 4000, `field ${name} created`);
    if (boundary && boundary.length >= 3) {
      const pts = boundary.map(([la, lo]) => { const p = latLonToEn(s.originLat, s.originLon, la, lo); return `${p.e.toFixed(2)},${p.n.toFixed(2)}`; }).join(';');
      this.send('boundary.fromMapPoints', pts);
      await this.waitForScene((sc) => sc.boundaries.length > 0, 4000, 'boundary').catch((e) => this.log(e.message));
    }
    return this.scene;
  }

  /** Close the open field. Coverage painted without an open job raises AgOpenWeb's "unsaved coverage" guard
   *  (DialogType.UnsavedCoverage; Status frame flag) and the close silently waits for an answer: we answer
   *  coverage.saveJob (keeps AgOpenWeb's own record as a job; coverage.discardClose would drop it). */
  async closeField({ save = true } = {}) {
    if (!this.scene || !this.scene.hasField) return;
    this.send('field.close');
    try { await this.waitForScene((s) => !s.hasField, 400, 'field closed'); return; } catch {}
    this.send(save ? 'coverage.saveJob' : 'coverage.discardClose');
    await this.waitForScene((s) => !s.hasField, 4000, 'field closed after unsaved-coverage guard').catch((e) => this.log(e.message));
  }

  // ------------------------------------------------------------------ high-level (TractorGateway-ish)
  /** Field work: open/create field, place tractor, AB line, sections auto, U-turns, autosteer, speed.
   *  job = { field, originLat, originLon, boundary?, start: [lat, lon]?, ab: [latA, lonA, latB, lonB],
   *          speedKph = 10, youturn = true, sections = true } */
  async startJob(job) {
    await this.openOrCreateField(job.field, { originLat: job.originLat ?? job.ab[0], originLon: job.originLon ?? job.ab[1], boundary: job.boundary, exists: job.fieldExists ?? null });
    if (job.toolWidth) await this.setTool({ widthM: job.toolWidth, sections: job.sections_n || 3 });
    // U-turn geometry: AgOpenWeb's default radius (8 m) onto a 6 m pass bulbs out toward the fence and
    // the planner refuses ("No U-turn fits inside the boundary"). Radius = half the pass spacing gives a
    // clean semicircle onto the next pass.
    const ut = job.uturn || (job.toolWidth ? { radius: Math.max(3, job.toolWidth / 2), distanceFromBoundary: 0.5 } : null);
    if (ut) { this.configSet('uturn.radius', ut.radius); this.configSet('uturn.distanceFromBoundary', ut.distanceFromBoundary); }
    await this.setAutosteer(false);
    this.send('sim.stop');
    const [sLat, sLon] = job.start || [job.ab[0], job.ab[1]];
    await this.setCoords(sLat, sLon);
    await this.setABLine(...job.ab);
    if (job.sections !== false) await this.setSectionMaster(true);
    if (job.youturn !== false) await this.setYouTurn(true);
    if (job.turn) await this.setTurnDirection(job.turn);
    await this.setAutosteer(true);
    await this.setSpeedKph(job.speedKph ?? 10);
    return this.pose();
  }

  /** Breakdown / pause: sim.stop + autosteer off + sections off. (The deadman would do the same if our
   *  heartbeat stopped.) */
  async stop() {
    this.send('sim.stop');
    this.simSpeedKph = 0;
    await this.setAutosteer(false);
    await this.setSectionMaster(false);
    return this.waitForTick((t) => t.speed < 0.05, 3000, 'stopped').catch(() => this.tick);
  }

  /** Repaired: re-engage on the current line at speedKph (default: last speed or 10). */
  async resume({ speedKph } = {}) {
    await this.setSectionMaster(true);
    if (this.tick && this.tick.guidanceActive) await this.setAutosteer(true);
    await this.setSpeedKph(speedKph ?? 10);
    return this.pose();
  }
}

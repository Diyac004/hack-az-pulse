// Tractor Control Panel, mock side (PROJECT.md Change 8, ARCHITECTURE.md §5 rows 13–16 + §13.2).
// Pure module: no DOM, no timers, no world mutation. It defines the per-tractor control schema, validates and
// applies control values to a per-tractor control state, and computes the re-plan impact of a change (Preview)
// on a CLONE of the contract-shaped fleet/jobs. The simulation (mockSource) and the harness own the world and
// carry out the `effect` that applyControl returns.
//
// Contract choices where §5 is silent (reported as gaps):
//  - map_pick value: one point = { lat, lon, x, y } (lat/lon for AgOpenWeb commands, grid x/y for Navigation);
//    the number of points comes from `min`/`max` (both 2 for an AB line), the value is then an array of points.
//  - `implements` is a `select` whose value is an ARRAY (rest.post_preview / get_controls examples); ControlType
//    has no multi-select, so the UI infers "multi" from Array.isArray(values[id]).
//  - Optional extension key `group` (section header inside a tab). Contract-only UIs work without it.
//  - 409 CONFLICT for replans:true while "running" = while a plan-producing Operation is queued/running
//    (injected `busy`), not while the clock plays.
import { planAssign, WEATHER_RULES } from './mockSource.js';
import { clockText, durText, listText } from './text.js';

export const TABS = ['Drive', 'Guidance', 'Implement', 'Vehicle', 'Fleet', 'Advanced'];
const IMPLEMENTS = ['sprayer', 'mower', 'hedger', 'bin_trailer'];
const IMPL_LABEL = { sprayer: 'Sprayer', mower: 'Mower', hedger: 'Hedger', bin_trailer: 'Bin trailer' };
const IMPL_NAME = { sprayer: 'sprayer', mower: 'mower', hedger: 'hedger', bin_trailer: 'bin trailer' };
const IMPL_TYPE = { sprayer: 'spray', mower: 'mow', hedger: 'hedge', bin_trailer: 'haul_bins' };
const TYPE_LABEL = { spray: 'Spraying', mow: 'Mowing', hedge: 'Hedging', haul_bins: 'Hauling bins' };
const PALETTE = ['#0A84FF', '#BF5AF2', '#FF9F0A', '#30D158', '#FF375F', '#5E5CE6', '#64D2FF', '#FFD60A'];
const COLOR_NAME = ['Blue', 'Purple', 'Orange', 'Green', 'Pink', 'Indigo', 'Teal', 'Yellow'];
const DOWN = new Set(['broken', 'awaiting_mechanic', 'repair_scheduled', 'repairing', 'removing', 'offline', 'starting']);
const SCHEDULABLE = new Set(['ready', 'idle', 'traveling', 'working', 'waiting_weather', 'refueling']);
const NOMINAL_MPH = 8;          // FleetEntry.speed 1.0 == 8 mph travel (mockSource poses)
const SWAP_MIN = 10;            // implement swap at the depot
const REFUEL_MIN = 15;
const SPEED_STEP = 0.5;         // sim.speedUp / speedDown, mph
const MAX_SIM_MPH = 12;
const WORK_MPH = 4;               // speed the mock sim rolls at when an AB line is set while stopped

const err = (code, message, details = {}) => ({ code, message, details });
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const unfinished = (j) => j.status !== 'done' && j.status !== 'dropped';
const tName = (tr) => (tr && (tr.name || tr.id)) || 'This tractor';
export const clockOf = clockText;
const durOf = durText;

// ---------------------------------------------------------------- control state (per tractor)
const SAVED_PROFILES = ['Default tractor', 'Orchard narrow', 'Wide sprayer'];
/** AgOpenWeb-side state we remember per tractor (config values: "remember the last value we set"). */
export function newControlState(tractor) {
  const aw = (tractor && tractor.agopenweb) || {};
  const tool = (tractor && tractor.tool) || {};
  const n = 6, width = fin(tool.width_m) ? tool.width_m : 6;
  return {
    speed_mph: 0, dir: 1, sim_10x: false, steer: 0, drive_to: null, place_here: null,
    autosteer: aw.autosteer ?? false, lines: [], ab_select: null, nudge_m: 0, youturn: aw.youturn ?? false, youturn_dir: 'left', youturn_skip: 0,
    headland: false, contour: false,
    section_master: aw.section_master === false ? 'manual' : 'auto', sections: Array(n).fill(false),
    num_sections: n, section_width: r1(width / n), overlap: 0, look_ahead: 1, tool_offset: 0,
    vehicle_type: 'tractor', wheelbase: 2.8, track_width: 1.9, antenna_height: 3, antenna_offset: 0,
    max_steer_angle: 35, gain_p: 10, steer_mode: 'pure_pursuit', uturn_radius: 6, uturn_style: 'omega', uturn_extension: 2,
    profile_load: SAVED_PROFILES[0],
    max_speed: Math.round(NOMINAL_MPH * ((tractor && tractor.speed) || 1)),
    off_duty_t: null, ban_type: 'none',
    cfg: Object.fromEntries(ADVANCED.map((a) => [a.key, a.def])),
  };
}

// ---------------------------------------------------------------- schema
const C = (id, tab, label, type, o = {}) => ({
  id, tab, label, type, min: o.min ?? null, max: o.max ?? null, step: o.step ?? null, unit: o.unit ?? null,
  options: o.options ?? null, needs_manual: !!o.manual, replans: !!o.replans, help: o.help ?? null,
  ...(o.group ? { group: o.group } : {}),
});
const opt = (value, label) => ({ value, label });

/** ~40 of the ~170 AgOpenWeb config.set keys (RemoteServerWiring.Helpers.cs), grouped by prefix. */
const ADVANCED = [
  ['autosteer.integralGain', 'number', 0, 0, 100, 1], ['autosteer.highPWM', 'number', 235, 0, 255, 1], ['autosteer.lowPWM', 'number', 30, 0, 255, 1],
  ['autosteer.minPWM', 'number', 25, 0, 255, 1], ['autosteer.countsPerDegree', 'number', 110, 1, 255, 1], ['autosteer.ackermann', 'number', 100, 1, 200, 1],
  ['autosteer.wasOffset', 'number', 0, -4000, 4000, 1], ['autosteer.isSteerInReverse', 'toggle', false],
  ['gps.headingFromSource', 'select', 'Fix', null, null, null, ['Fix', 'VTG', 'Dual']], ['gps.dualHeadingOffset', 'number', 90, -180, 180, 1],
  ['gps.minFixStepDistance', 'number', 1, 0.1, 5, 0.1], ['gps.isRTKKillAutosteer', 'toggle', false], ['gps.ageAlarm', 'number', 20, 1, 60, 1],
  ['machine.hydraulicLiftEnabled', 'toggle', false], ['machine.raiseTime', 'number', 2, 0, 10, 1], ['machine.lowerTime', 'number', 4, 0, 10, 1],
  ['roll.isInvert', 'toggle', false], ['roll.zero', 'number', 0, -10, 10, 0.1], ['roll.filter', 'number', 0.2, 0, 1, 0.05],
  ['tool.isToolTrailing', 'toggle', true], ['tool.isToolTBT', 'toggle', false], ['tool.hitchLength', 'number', -1.8, -10, 10, 0.1],
  ['tool.toolTrailingHitchLength', 'number', -2.5, -10, 10, 0.1], ['tool.turnOffDelay', 'number', 0, 0, 10, 0.1], ['tool.minCoverage', 'number', 100, 0, 100, 1],
  ['tram.isOn', 'toggle', false], ['tram.width', 'number', 24, 1, 50, 0.5], ['tram.passes', 'number', 1, 1, 10, 1],
  ['uturn.turnSmoothing', 'number', 14, 1, 50, 1], ['uturn.isUturnOn', 'toggle', false], ['uturn.distanceFromBoundary', 'number', 2, 0, 20, 0.5],
  ['vehicle.hitchLength', 'number', -1.8, -10, 10, 0.1], ['vehicle.minTurningRadius', 'number', 8.1, 1, 30, 0.1], ['vehicle.slowSpeedCutoff', 'number', 0.5, 0, 5, 0.1],
  ['vehicle.goalPointLookAhead', 'number', 3, 1, 10, 0.1], ['vehicle.goalPointLookAheadMult', 'number', 1.4, 0.5, 5, 0.1],
  ['display.isMetric', 'toggle', true], ['display.isDayMode', 'toggle', true], ['display.lightbarCmPerPixel', 'number', 2, 1, 15, 1], ['display.isKeyboardOn', 'toggle', true],
].map(([key, type, def, min, max, step, opts]) => ({ key, type, def, min, max, step, opts }));

/**
 * Control[] for one tractor (§5 Control shape; `group` is an optional extension). Depends on the control state
 * (number of sections, saved AB lines) and the jobs (pin options).
 */
export function controlSchema(tractor, cs, jobs = []) {
  const M = { manual: true };
  const out = [
    // Drive (AgOpenWeb simulator)
    C('speed_up', 'Drive', 'Faster', 'button', { ...M, group: 'Speed', help: 'Simulator speed +0.5 mph' }),
    C('speed_down', 'Drive', 'Slower', 'button', { ...M, group: 'Speed', help: 'Simulator speed −0.5 mph' }),
    C('stop', 'Drive', 'Stop', 'button', { ...M, group: 'Speed', help: 'Bring the tractor to a stop' }),
    C('sim_10x', 'Drive', '10× speed', 'toggle', { ...M, group: 'Speed', help: 'Run the simulator ten times faster' }),
    C('steer', 'Drive', 'Steering', 'slider', { ...M, group: 'Steering', min: -40, max: 40, step: 1, unit: 'deg', help: 'Steering angle of the simulated tractor' }),
    C('steer_reset', 'Drive', 'Center', 'button', { ...M, group: 'Steering', help: 'Wheels straight' }),
    C('reverse', 'Drive', 'Reverse', 'button', { ...M, group: 'Steering', help: 'Flip the driving direction' }),
    C('drive_to', 'Drive', 'Drive to…', 'map_pick', { ...M, group: 'Go somewhere', min: 1, max: 1, help: 'Tap a spot on the map. Our Navigation Agent routes it over the farm roads.' }),
    C('place_here', 'Drive', 'Place here (debug)', 'map_pick', { ...M, group: 'Go somewhere', min: 1, max: 1, help: 'Teleport the simulated tractor' }),
    // Guidance
    C('autosteer', 'Guidance', 'Autosteer', 'toggle', { ...M, group: 'Steering', help: 'AgOpenWeb follows the active line' }),
    C('ab_line', 'Guidance', 'New AB line', 'map_pick', { ...M, group: 'AB line', min: 2, max: 2, help: 'Tap point A, then point B' }),
    C('ab_select', 'Guidance', 'Active line', 'select', { ...M, group: 'AB line', options: [opt(null, 'None'), ...cs.lines.map((l) => opt(l.id, l.name))], help: 'Pick a saved line' }),
    C('ab_swap', 'Guidance', 'Swap A/B', 'button', { ...M, group: 'AB line', help: 'Drive the line the other way' }),
    C('nudge_left', 'Guidance', 'Nudge left', 'button', { ...M, group: 'Nudge', help: 'Shift the line 10 cm left' }),
    C('nudge_right', 'Guidance', 'Nudge right', 'button', { ...M, group: 'Nudge', help: 'Shift the line 10 cm right' }),
    C('fine_nudge_left', 'Guidance', 'Fine left', 'button', { ...M, group: 'Nudge', help: 'Shift the line 1 cm left' }),
    C('fine_nudge_right', 'Guidance', 'Fine right', 'button', { ...M, group: 'Nudge', help: 'Shift the line 1 cm right' }),
    C('snap_left', 'Guidance', 'Snap left', 'button', { ...M, group: 'Nudge', help: 'Snap to the pass on the left' }),
    C('snap_right', 'Guidance', 'Snap right', 'button', { ...M, group: 'Nudge', help: 'Snap to the pass on the right' }),
    C('youturn', 'Guidance', 'U-turns', 'toggle', { ...M, group: 'Turns', help: 'Turn automatically at the end of a pass' }),
    C('youturn_dir', 'Guidance', 'Turn direction', 'select', { ...M, group: 'Turns', options: [opt('left', 'Left'), opt('right', 'Right')] }),
    C('youturn_skip', 'Guidance', 'Skip passes', 'number', { ...M, group: 'Turns', min: 0, max: 5, step: 1, help: 'Passes to skip on each turn' }),
    C('headland', 'Guidance', 'Headland', 'toggle', { ...M, group: 'Modes', help: 'Stay inside the headland boundary' }),
    C('contour', 'Guidance', 'Contour', 'toggle', { ...M, group: 'Modes', help: 'Follow the last pass instead of a straight line' }),
    // Implement and sections
    C('implements', 'Implement', 'Implements', 'select', { replans: true, group: 'For planning', options: IMPLEMENTS.map((i) => opt(i, IMPL_LABEL[i])), help: 'Implements attached for planning. Changing them costs a depot visit.' }),
    C('section_master', 'Implement', 'Section control', 'select', { ...M, group: 'Sections', options: [opt('auto', 'Auto'), opt('manual', 'Manual')], help: 'Auto lets AgOpenWeb switch sections from coverage' }),
    ...cs.sections.map((_, i) => C('section_' + (i + 1), 'Implement', String(i + 1), 'toggle', { ...M, group: 'Sections', help: 'Section ' + (i + 1) })),
    C('num_sections', 'Implement', 'Sections', 'number', { group: 'Setup', min: 1, max: 16, step: 1 }),
    C('section_width', 'Implement', 'Section width', 'number', { group: 'Setup', min: 0.2, max: 6, step: 0.1, unit: 'm' }),
    C('overlap', 'Implement', 'Overlap', 'number', { group: 'Setup', min: -0.5, max: 0.5, step: 0.05, unit: 'm' }),
    C('look_ahead', 'Implement', 'Look-ahead', 'number', { group: 'Setup', min: 0.2, max: 5, step: 0.1, unit: 's', help: 'How early sections switch on' }),
    C('tool_offset', 'Implement', 'Offset', 'number', { group: 'Setup', min: -3, max: 3, step: 0.05, unit: 'm', help: 'Tool offset from the tractor centerline' }),
    // Vehicle and steering
    C('vehicle_type', 'Vehicle', 'Type', 'select', { group: 'Vehicle', options: [opt('tractor', 'Tractor'), opt('harvester', 'Harvester'), opt('4wd', '4WD articulated')] }),
    C('wheelbase', 'Vehicle', 'Wheelbase', 'number', { group: 'Vehicle', min: 1, max: 8, step: 0.05, unit: 'm' }),
    C('track_width', 'Vehicle', 'Track width', 'number', { group: 'Vehicle', min: 1, max: 4, step: 0.05, unit: 'm' }),
    C('antenna_height', 'Vehicle', 'Antenna height', 'number', { group: 'Vehicle', min: 0.5, max: 5, step: 0.05, unit: 'm' }),
    C('antenna_offset', 'Vehicle', 'Antenna offset', 'number', { group: 'Vehicle', min: -2, max: 2, step: 0.05, unit: 'm' }),
    C('max_steer_angle', 'Vehicle', 'Max steer angle', 'number', { group: 'Steering', min: 10, max: 60, step: 1, unit: 'deg' }),
    C('gain_p', 'Vehicle', 'Proportional gain', 'number', { group: 'Steering', min: 1, max: 100, step: 1 }),
    C('steer_mode', 'Vehicle', 'Steering mode', 'select', { group: 'Steering', options: [opt('pure_pursuit', 'Pure pursuit'), opt('stanley', 'Stanley')] }),
    C('uturn_radius', 'Vehicle', 'U-turn radius', 'number', { group: 'U-turn shape', min: 2, max: 30, step: 0.5, unit: 'm' }),
    C('uturn_style', 'Vehicle', 'U-turn style', 'select', { group: 'U-turn shape', options: [opt('omega', 'Omega'), opt('k', 'K-turn'), opt('wide', 'Wide')] }),
    C('uturn_extension', 'Vehicle', 'Extension', 'number', { group: 'U-turn shape', min: 0, max: 20, step: 0.5, unit: 'm' }),
    C('profile_load', 'Vehicle', 'Load profile', 'select', { group: 'Profiles', options: SAVED_PROFILES.map((p) => opt(p, p)) }),
    C('profile_save', 'Vehicle', 'Save current profile', 'button', { group: 'Profiles' }),
    // Fleet settings (ours)
    C('name', 'Fleet', 'Name', 'text', { group: 'Identity' }),
    C('color', 'Fleet', 'Color', 'select', { group: 'Identity', options: PALETTE.map((c, i) => opt(c, COLOR_NAME[i])) }),
    C('refuel', 'Fleet', 'Refuel now', 'button', { replans: true, group: 'Fuel and speed', help: 'Send it to the depot to refuel (about 15 min)' }),
    C('max_speed', 'Fleet', 'Max speed', 'slider', { replans: true, group: 'Fuel and speed', min: 4, max: 12, step: 1, unit: 'mph' }),
    C('off_duty_t', 'Fleet', 'Off duty after', 'select', { replans: true, group: 'Availability', options: [opt(null, 'Available all day'), ...[300, 360, 420, 480, 540, 600, 660].map((t) => opt(t, clockOf(t)))] }),
    C('pin_job', 'Fleet', 'Pin a job', 'select', { replans: true, group: 'Job rules', options: [opt(null, 'No pinned job'), ...jobs.filter(unfinished).map((j) => opt(j.id, j.label || j.id))], help: 'This tractor must do the pinned job' }),
    C('ban_type', 'Fleet', 'Never assign', 'select', { replans: true, group: 'Job rules', options: [opt('none', 'No restriction'), ...Object.entries(TYPE_LABEL).map(([k, v]) => opt(k, v))] }),
    // Advanced: every config.set key, raw
    ...ADVANCED.map((a) => C('cfg.' + a.key, 'Advanced', a.key, a.type, { min: a.min, max: a.max, step: a.step, group: a.key.split('.')[0], options: a.opts ? a.opts.map((o) => opt(o, o)) : null, help: 'config.set ' + a.key })),
  ];
  return out;
}

/** values map: reported state. AgOpenWeb flags come from tractor.agopenweb when present (Tick truth). */
export function controlValues(tractor, cs, jobs = []) {
  const aw = (tractor && tractor.agopenweb) || null;
  const pinned = jobs.find((j) => j.pinned_to === tractor.id && unfinished(j));
  const ab = cs.lines.find((l) => l.id === cs.ab_select);
  const v = {
    speed_up: null, speed_down: null, stop: null, sim_10x: cs.sim_10x, steer: cs.steer, steer_reset: null, reverse: null,
    drive_to: cs.drive_to, place_here: cs.place_here,
    autosteer: aw && typeof aw.autosteer === 'boolean' ? aw.autosteer : cs.autosteer,
    ab_line: ab ? [ab.a, ab.b] : null, ab_select: cs.ab_select, ab_swap: null,
    nudge_left: null, nudge_right: null, fine_nudge_left: null, fine_nudge_right: null, snap_left: null, snap_right: null,
    youturn: aw && typeof aw.youturn === 'boolean' ? aw.youturn : cs.youturn, youturn_dir: cs.youturn_dir, youturn_skip: cs.youturn_skip,
    headland: cs.headland, contour: cs.contour,
    implements: (tractor.implements || []).slice(),
    section_master: aw && typeof aw.section_master === 'boolean' ? (aw.section_master ? 'auto' : 'manual') : cs.section_master,
    num_sections: cs.num_sections, section_width: cs.section_width, overlap: cs.overlap, look_ahead: cs.look_ahead, tool_offset: cs.tool_offset,
    vehicle_type: cs.vehicle_type, wheelbase: cs.wheelbase, track_width: cs.track_width, antenna_height: cs.antenna_height, antenna_offset: cs.antenna_offset,
    max_steer_angle: cs.max_steer_angle, gain_p: cs.gain_p, steer_mode: cs.steer_mode, uturn_radius: cs.uturn_radius, uturn_style: cs.uturn_style, uturn_extension: cs.uturn_extension,
    profile_load: cs.profile_load, profile_save: null,
    name: tractor.name || tractor.id, color: tractor.color || null, refuel: null, max_speed: cs.max_speed, off_duty_t: cs.off_duty_t,
    pin_job: pinned ? pinned.id : null, ban_type: cs.ban_type,
  };
  cs.sections.forEach((on, i) => { v['section_' + (i + 1)] = on; });
  for (const a of ADVANCED) v['cfg.' + a.key] = cs.cfg[a.key];
  return v;
}

/** GET /tractors/{id}/controls body. */
export function getControlsBody(tractor, cs, jobs) {
  return { controls: controlSchema(tractor, cs, jobs), values: controlValues(tractor, cs, jobs) };
}

// ---------------------------------------------------------------- validation
/**
 * Normalise a map_pick value to grid+geo points. Accepts {x,y}, {lat,lon} or both; array for count > 1.
 * @returns array of {lat, lon, x, y}
 */
export function normalizePoints(value, count, scenario) {
  const pts = count > 1 ? value : Array.isArray(value) ? value : [value];
  if (!Array.isArray(pts) || pts.length !== count) throw err('INVALID_INPUT', count > 1 ? `Pick ${count} points on the map.` : 'Pick a spot on the map.', { field: 'value' });
  const g = scenario && scenario.geo, W = scenario?.grid?.width ?? 20, H = scenario?.grid?.height ?? 14;
  const mLon = g ? 111320 * Math.cos((g.origin_lat * Math.PI) / 180) : 0;
  return pts.map((p) => {
    if (!p || typeof p !== 'object') throw err('INVALID_INPUT', 'Pick a spot on the map.', { field: 'value' });
    let { x, y, lat, lon } = p;
    if (!(fin(x) && fin(y)) && fin(lat) && fin(lon) && g) { x = ((lon - g.origin_lon) * mLon) / g.cell_m; y = ((g.origin_lat - lat) * 111320) / g.cell_m; }
    if (!(fin(x) && fin(y))) throw err('INVALID_INPUT', 'That point has no position.', { field: 'value' });
    if (x < -0.5 || y < -0.5 || x > W - 0.5 || y > H - 0.5) throw err('INVALID_INPUT', 'That spot is outside the farm.', { field: 'value', x, y });
    if (!(fin(lat) && fin(lon)) && g) { lat = g.origin_lat - (y * g.cell_m) / 111320; lon = g.origin_lon + (x * g.cell_m) / mLon; }
    const q = (v, k) => (fin(v) ? Math.round(v * k) / k : null);
    return { lat: q(lat, 1e6), lon: q(lon, 1e6), x: q(x, 100), y: q(y, 100) };
  });
}

const optEq = (a, b) => a === b || (a == null && b == null);

/**
 * Validate one control change. Throws {code,message,details} in plain English:
 * NOT_FOUND, INVALID_INPUT, NEEDS_MANUAL, CONFLICT, SAFETY_REJECTED. Returns the normalised value.
 * @param ctx {tractor, cs, jobs, fleet, scenario, weather, busy, t}
 */
export function checkControl(ctx, controlId, value) {
  const { tractor, cs, jobs = [], scenario = null, weather = null, busy = false } = ctx;
  if (!tractor) throw err('NOT_FOUND', 'That tractor is not in the fleet.', {});
  const schema = controlSchema(tractor, cs, jobs);
  const c = schema.find((x) => x.id === controlId);
  if (!c) throw err('NOT_FOUND', `${tName(tractor)} has no control called "${controlId}".`, { control: controlId });
  const name = tName(tractor);
  // shape
  let v = value;
  switch (c.type) {
    case 'button': v = null; break;
    case 'toggle': if (typeof v !== 'boolean') throw err('INVALID_INPUT', `${c.label} must be on or off.`, { control: c.id }); break;
    case 'slider': case 'number':
      if (typeof v === 'string' && v.trim() !== '') v = Number(v);
      if (!fin(v)) throw err('INVALID_INPUT', `${c.label} needs a number.`, { control: c.id });
      if ((c.min != null && v < c.min) || (c.max != null && v > c.max)) throw err('INVALID_INPUT', `${c.label} must be between ${c.min} and ${c.max}${c.unit ? ' ' + c.unit : ''}.`, { control: c.id, min: c.min, max: c.max });
      break;
    case 'select': {
      const okv = (x) => c.options.some((o) => optEq(o.value, x));
      if (c.id === 'implements') {
        if (!Array.isArray(v) || !v.length || !v.every(okv)) throw err('INVALID_INPUT', 'Pick at least one implement.', { control: c.id });
        v = [...new Set(v)];
      } else if (!okv(v)) throw err('INVALID_INPUT', `"${v}" is not an option for ${c.label}.`, { control: c.id });
      break;
    }
    case 'map_pick': v = normalizePoints(v, c.min || 1, scenario); if ((c.min || 1) === 1) v = v[0]; break;
    case 'text':
      if (typeof v !== 'string' || !v.trim() || v.trim().length > 40) throw err('INVALID_INPUT', `${c.label} must be 1 to 40 characters.`, { control: c.id });
      v = v.trim(); break;
    default: throw err('INVALID_INPUT', 'Unknown control type.', { control: c.id });
  }
  // manual / availability rules
  if (c.needs_manual && DOWN.has(tractor.status)) throw err('SAFETY_REJECTED', `${name} is ${tractor.status.replace(/_/g, ' ')}; it can't be driven right now.`, { rule: 'tractor_down', status: tractor.status });
  if (c.needs_manual && !tractor.manual) throw err('NEEDS_MANUAL', `Take manual control of ${name} first. ${c.label} only works in manual mode.`, { control: c.id });
  if (c.replans && busy) throw err('CONFLICT', 'A re-plan is already running. Try again when it finishes.', { control: c.id });
  // Safety Agent (hard rules), plain words
  const wind = weather && weather.current && fin(weather.current.wind_mph) ? weather.current.wind_mph : null;
  const lim = WEATHER_RULES.spray.max_wind_mph;
  const spraying = (tractor.implements || []).includes('sprayer');
  const turningOn = (c.id === 'section_master' && v === 'auto') || (/^section_\d+$/.test(c.id) && v === true);
  if (turningOn && spraying && wind != null && wind > lim) throw err('SAFETY_REJECTED', `Can't spray now: wind ${Math.round(wind)} mph, limit ${lim} mph.`, { rule: 'spray_wind', wind_mph: wind, limit_mph: lim });
  if (c.id === 'pin_job' && v != null) {
    const j = jobs.find((x) => x.id === v);
    if (!j) throw err('NOT_FOUND', `Job ${v} does not exist.`, { job: v });
    if (!(tractor.implements || []).includes(j.implement)) throw err('SAFETY_REJECTED', `Can't pin ${j.label} to ${name}: it has no ${IMPL_NAME[j.implement]}.`, { rule: 'implement_match', job: j.id });
    if (cs.ban_type === j.type) throw err('SAFETY_REJECTED', `Can't pin ${j.label} to ${name}: ${TYPE_LABEL[j.type].toLowerCase()} is banned for it.`, { rule: 'job_type_ban', job: j.id });
  }
  if (c.id === 'implements') {
    const stuck = jobs.find((j) => j.pinned_to === tractor.id && unfinished(j) && !v.includes(j.implement));
    if (stuck) throw err('SAFETY_REJECTED', `Can't take the ${IMPL_NAME[stuck.implement]} off ${name}: ${stuck.label} is pinned to it. Unpin it first.`, { rule: 'implement_match', job: stuck.id });
  }
  if (c.id === 'ban_type' && v !== 'none') {
    const stuck = jobs.find((j) => j.pinned_to === tractor.id && unfinished(j) && j.type === v);
    if (stuck) throw err('SAFETY_REJECTED', `Can't ban ${TYPE_LABEL[v].toLowerCase()}: ${stuck.label} is pinned to ${name}.`, { rule: 'job_type_ban', job: stuck.id });
  }
  if (c.id === 'off_duty_t' && v != null && fin(ctx.t) && v <= ctx.t) throw err('INVALID_INPUT', `${clockOf(v)} has already passed.`, { control: c.id });
  if ((c.id === 'drive_to' || c.id === 'place_here') && scenario && Array.isArray(scenario.blocked_cells)) {
    const k = Math.round(v.x) + ',' + Math.round(v.y);
    if (scenario.blocked_cells.some((b) => b[0] + ',' + b[1] === k)) throw err('SAFETY_REJECTED', 'That road is blocked. Pick another spot.', { rule: 'blocked_road' });
  }
  if (c.id === 'ab_swap' && !cs.ab_select) throw err('INVALID_INPUT', 'There is no active AB line to swap.', { control: c.id });
  if (/nudge|snap/.test(c.id) && !cs.ab_select) throw err('INVALID_INPUT', 'Set an AB line first.', { control: c.id });
  return { control: c, value: v };
}

// ---------------------------------------------------------------- apply
/**
 * Apply a VALIDATED change to the control state. Never touches the world: returns the `effect` the owner carries
 * out, and {old, new, replans} for the `operator_action` log line.
 * effect kinds: none | tractor (patch: name/color/implements/speed) | pin (job, tractor) | refuel | drive_to (point)
 *               | teleport (point) | drive (speed/dir/steer changed) | ab (points or null) | off_duty | ban
 */
export function applyControl(cs, tractor, jobs, control, value) {
  const id = control.id;
  const before = controlValues(tractor, cs, jobs)[id];
  let effect = { kind: 'none' };
  const ab = () => cs.lines.find((l) => l.id === cs.ab_select);
  const abEffect = () => { const l = ab(); effect = { kind: 'ab', points: l ? [l.a, l.b] : null, line: l ? l.id : null }; };
  const nudge = (m) => {
    cs.nudge_m = Math.round((cs.nudge_m + m) * 100) / 100;
    const l = ab(); if (!l) return;
    // shift both points perpendicular to A->B, in grid cells (cell_m ~ 40 m in the mock, so this is tiny on screen)
    const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, L = Math.hypot(dx, dy) || 1, k = m / 40;
    const nx = -dy / L, ny = dx / L; // left of A->B in grid (y south)
    for (const p of [l.a, l.b]) { p.x = Math.round((p.x - nx * k) * 100) / 100; p.y = Math.round((p.y - ny * k) * 100) / 100; p.lat = null; p.lon = null; }
    abEffect();
  };
  switch (id) {
    case 'speed_up': cs.speed_mph = Math.min(MAX_SIM_MPH, fin(cs.max_speed) ? cs.max_speed : MAX_SIM_MPH, cs.speed_mph + SPEED_STEP); effect = { kind: 'drive' }; break;
    case 'speed_down': cs.speed_mph = Math.max(0, cs.speed_mph - SPEED_STEP); effect = { kind: 'drive' }; break;
    case 'stop': cs.speed_mph = 0; cs.drive_to = null; effect = { kind: 'drive', stop: true }; break;
    case 'sim_10x': cs.sim_10x = value; effect = { kind: 'drive' }; break;
    case 'steer': cs.steer = value; effect = { kind: 'drive' }; break;
    case 'steer_reset': cs.steer = 0; effect = { kind: 'drive' }; break;
    case 'reverse': cs.dir = -cs.dir; effect = { kind: 'drive' }; break;
    case 'drive_to': cs.drive_to = value; effect = { kind: 'drive_to', point: value }; break;
    case 'place_here': cs.place_here = value; cs.speed_mph = 0; effect = { kind: 'teleport', point: value }; break;
    case 'autosteer': cs.autosteer = value; if (value && cs.ab_select && !(cs.speed_mph > 0)) { cs.speed_mph = WORK_MPH; effect = { kind: 'drive' }; } break;
    case 'ab_line': {
      // a new line implies "follow it": autosteer on, and roll at work speed if stopped (mock sim)
      const n = cs.lines.length + 1, line = { id: 'AB' + n, name: 'AB ' + n, a: { ...value[0] }, b: { ...value[1] } };
      cs.lines.push(line); cs.ab_select = line.id; cs.nudge_m = 0; cs.guide = null; cs.autosteer = true;
      if (!(cs.speed_mph > 0)) cs.speed_mph = WORK_MPH;
      abEffect(); break;
    }
    case 'ab_select': cs.ab_select = value; cs.guide = null; abEffect(); break;
    case 'ab_swap': { const l = ab(); [l.a, l.b] = [l.b, l.a]; cs.guide = null; abEffect(); break; }
    case 'nudge_left': nudge(-0.1); break; case 'nudge_right': nudge(0.1); break;
    case 'fine_nudge_left': nudge(-0.01); break; case 'fine_nudge_right': nudge(0.01); break;
    case 'snap_left': case 'snap_right': { // jump one implement width
      const w = cs.num_sections * cs.section_width; nudge(id === 'snap_left' ? -w : w); break;
    }
    case 'youturn': case 'youturn_dir': case 'youturn_skip': case 'headland': case 'contour': cs[id] = value; break;
    case 'section_master': cs.section_master = value; if (value === 'auto') cs.sections = cs.sections.map(() => false); break;
    case 'num_sections': { const n = value; cs.sections = Array.from({ length: n }, (_, i) => cs.sections[i] ?? false); cs.num_sections = n; cs.width_set = true; break; }
    case 'section_width': cs.section_width = value; cs.width_set = true; break;
    case 'overlap': case 'look_ahead': case 'tool_offset':
    case 'vehicle_type': case 'wheelbase': case 'track_width': case 'antenna_height': case 'antenna_offset':
    case 'max_steer_angle': case 'gain_p': case 'steer_mode': case 'uturn_radius': case 'uturn_style': case 'uturn_extension':
      cs[id] = value; break;
    case 'profile_load': cs.profile_load = value; break;
    case 'profile_save': break;
    case 'implements': effect = { kind: 'tractor', patch: { implements: value.slice() }, depot_min: SWAP_MIN }; break;
    case 'name': effect = { kind: 'tractor', patch: { name: value } }; break;
    case 'color': effect = { kind: 'tractor', patch: { color: value } }; break;
    case 'refuel': effect = { kind: 'refuel', depot_min: REFUEL_MIN }; break;
    case 'max_speed': cs.max_speed = value; cs.speed_mph = Math.min(cs.speed_mph, value); effect = { kind: 'tractor', patch: { speed: value / NOMINAL_MPH } }; break;
    case 'off_duty_t': cs.off_duty_t = value; effect = { kind: 'off_duty', t: value }; break;
    case 'pin_job': effect = { kind: 'pin', job: value, tractor: tractor.id, unpin: jobs.filter((j) => j.pinned_to === tractor.id && unfinished(j)).map((j) => j.id) }; break;
    case 'ban_type': cs.ban_type = value; effect = { kind: 'ban', type: value === 'none' ? null : value }; break;
    default:
      if (/^section_\d+$/.test(id)) { const i = +id.slice(8) - 1; cs.sections[i] = value; if (value || cs.section_master === 'auto') cs.section_master = 'manual'; }
      else if (id.startsWith('cfg.')) cs.cfg[id.slice(4)] = value;
  }
  const after = id === 'implements' ? value.slice() : id === 'name' || id === 'color' ? value : id === 'pin_job' ? value : controlValues(tractor, cs, jobs)[id];
  return { old: before ?? null, new: after ?? null, replans: control.replans, effect };
}

// ---------------------------------------------------------------- manual kinematics
/** One step of the manual-drive bicycle model, in grid cells. Pure: returns the new {x, y, heading_deg, speed_mph}. */
export function stepManual(pose, cs, dtMin, grid = { width: 20, height: 14 }) {
  const mph = cs.speed_mph * (cs.sim_10x ? 10 : 1);
  const cellsPerMin = (mph / NOMINAL_MPH) * 0.5; // mock: 0.5 cells per farm minute at 8 mph
  const d = cellsPerMin * dtMin * cs.dir;
  const hd = ((pose.heading_deg || 0) * Math.PI) / 180;
  const wheelbaseCells = 0.6; // compressed grid: a visible, gentle arc
  const yaw = (d / wheelbaseCells) * Math.tan((cs.steer * Math.PI) / 180);
  const h2 = hd + yaw / 2;
  let x = pose.x + Math.sin(h2) * d, y = pose.y - Math.cos(h2) * d;
  x = Math.max(0, Math.min(grid.width - 1, x)); y = Math.max(0, Math.min(grid.height - 1, y));
  return { x, y, heading_deg: ((((hd + yaw) * 180) / Math.PI) % 360 + 360) % 360, speed_mph: mph };
}

/** Mock visual exaggeration for implement width on 40 m cells (pass spacing and painted stripe). */
export const MOCK_WIDTH_VIS = 2;
const CELL_M = 40;
/** Implement width in metres from the Implement tab (sections x section width). */
export const implWidthM = (cs) => Math.max(0.5, (cs.num_sections || 1) * (cs.section_width || 1));

/**
 * Autosteer for the mock sim: pure pursuit onto the active AB line (offset by the current pass), U-turn at the
 * line's ends onto the next pass (one implement width over, `youturn_dir` side, `youturn_skip` extra passes).
 * Returns the new pose like stepManual, or null when guidance does not apply (no line / autosteer off / stopped).
 * Mutates cs.guide = { off (cells, + = right of A->B), dir (+1 A->B, -1 B->A), side (pass step sign), turns }.
 */
export function stepGuided(pose, cs, dtMin, grid = { width: 20, height: 14 }) {
  const l = cs.autosteer && cs.ab_select ? cs.lines.find((x) => x.id === cs.ab_select) : null;
  if (!l || !(cs.speed_mph > 0)) return null;
  const g = cs.guide || (cs.guide = { off: 0, dir: 1, turns: 0 });
  const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  const nx = -uy, ny = ux; // right of A->B (grid y points south)
  let ox = l.a.x + nx * g.off, oy = l.a.y + ny * g.off;
  const s = (pose.x - ox) * ux + (pose.y - oy) * uy;
  // end of the pass: turn onto the next one
  if ((g.dir > 0 && s > L + 0.25) || (g.dir < 0 && s < -0.25)) {
    const spacing = (implWidthM(cs) * MOCK_WIDTH_VIS) / CELL_M * (1 + (cs.youturn_skip || 0));
    // first turn goes to the `youturn_dir` side of travel; later turns alternate so passes keep stepping that way
    if (!g.side) { const leftSign = -g.dir; g.side = cs.youturn_dir === 'right' ? -leftSign : leftSign; }
    const inside = (off) => { const mx = (l.a.x + l.b.x) / 2 + nx * off, my = (l.a.y + l.b.y) / 2 + ny * off; return mx >= 0 && mx <= grid.width - 1 && my >= 0 && my <= grid.height - 1; };
    if (!inside(g.off + g.side * spacing)) g.side = -g.side; // reached the farm edge: work back the other way
    const next = g.off + g.side * spacing;
    g.off = Math.round(next * 1000) / 1000; g.dir = -g.dir; g.turns++;
    ox = l.a.x + nx * g.off; oy = l.a.y + ny * g.off;
  }
  const Ld = 0.8, wb = 0.6;
  const s2 = (pose.x - ox) * ux + (pose.y - oy) * uy;
  const st = s2 + g.dir * Ld;
  const tx = ox + ux * st, ty = oy + uy * st;
  const h = ((pose.heading_deg || 0) * Math.PI) / 180, hx = Math.sin(h), hy = -Math.cos(h);
  const vx = tx - pose.x, vy = ty - pose.y;
  const alpha = Math.atan2(hx * vy - hy * vx, hx * vx + hy * vy);
  const maxS = fin(cs.max_steer_angle) ? cs.max_steer_angle : 35;
  let steer = (Math.atan((2 * wb * Math.sin(alpha)) / Ld) * 180) / Math.PI;
  if (Math.cos(alpha) < 0) steer = Math.sign(alpha || 1) * maxS; // target behind: full lock toward it
  steer = Math.max(-maxS, Math.min(maxS, steer));
  // on the pass (implement down, paints) vs turning / joining the line (implement up)
  const xt = Math.abs((pose.x - ox) * nx + (pose.y - oy) * ny);
  const onLine = xt < 0.12 && Math.cos(alpha) > 0.9 && s2 > -0.05 && s2 < L + 0.05;
  return { ...stepManual(pose, { ...cs, steer, dir: 1 }, dtMin, grid), on_line: onLine };
}

// ---------------------------------------------------------------- preview (re-plan impact, applies nothing)
/** Default travel estimate: road-ish Manhattan length in cells, 2 farm min per cell at speed 1 (mock model). */
export const manhattanTravel = (a, b, speed) => ((Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])) * 2) / (speed || 1);

function blockPts(scenario) {
  const by = Object.fromEntries(((scenario && scenario.blocks) || []).map((b) => [b.id, b]));
  return {
    entry: (j) => { const b = by[j.block]; return b ? [b.x, b.y - 0.5] : [0, 0]; },
    exit: (j) => { const b = by[j.block]; return b ? [b.x + 3, b.y - 0.5 + (2 * b.h) / 3] : [0, 0]; },
  };
}

/** Contract tractor -> the planner's tractor shape (with operator availability, bans and depot holds). */
function plannerTractor(world, tr, travel) {
  const depot = world.scenario && world.scenario.depot ? [world.scenario.depot.x, world.scenario.depot.y] : [1, 6];
  const x = tr.pose?.x ?? 0, y = tr.pose?.y ?? 0;
  const hold = tr._depot_min ? { kind: 'depot', until: world.t + travel([x, y], depot, tr.speed || 1) + tr._depot_min } : tr.hold || null;
  return {
    id: tr.id, name: tr.name, implements: tr.implements, status: tr.status, manual: !!tr.manual,
    current_job: tr.current_job, x, y, path: tr._depot_min || !tr.path ? [] : tr.path, pi: 0, speed: tr.speed || 1, queue: [],
    off_duty_t: tr.off_duty_t ?? null, banned_types: tr.banned_types || null, hold,
  };
}

/**
 * Per-tractor schedule for an assignment (Map tractorId -> queue after the current job).
 * env.schedule(plannerTractor, queue, jobs, t) -> {entries, end_t} is the owner's real scheduler (mockSource's
 * tractorSchedule with spray windows and road routes); without it a simple road-length estimate is used.
 */
function estimate(world, assign, travel, env = {}) {
  const { fleet, jobs, scenario, t } = world;
  const P = blockPts(scenario), byId = new Map(jobs.map((j) => [j.id, j]));
  const depot = scenario && scenario.depot ? [scenario.depot.x, scenario.depot.y] : [1, 6];
  const per = new Map();
  for (const tr of fleet) {
    if (!SCHEDULABLE.has(tr.status) || tr.manual) continue;
    if (env.schedule) {
      const sch = env.schedule(plannerTractor(world, tr, travel), assign.get(tr.id) || [], jobs, t);
      const entries = sch.entries.map((e) => ({ job: e.kind === 'work' || e.kind === 'travel' ? e.job : null, kind: e.kind, start_t: e.start_t, end_t: e.end_t, travel: e.kind === 'travel' ? e.end_t - e.start_t : 0 }));
      per.set(tr.id, { entries: entries.filter((e) => e.kind !== 'travel'), end_t: sch.end_t, travel: entries.reduce((a, e) => a + e.travel, 0) });
      continue;
    }
    let c = t, pos = [tr.pose?.x ?? 0, tr.pose?.y ?? 0], trav = 0;
    const entries = [];
    if (tr._depot_min) { const tt = travel(pos, depot, tr.speed); trav += tt; c += tt + tr._depot_min; pos = depot.slice(); entries.push({ job: null, kind: 'refuel', start_t: t, end_t: c, travel: tt }); }
    const cur = tr.current_job ? byId.get(tr.current_job) : null;
    const list = [...(cur && unfinished(cur) ? [cur.id] : []), ...(assign.get(tr.id) || [])];
    for (const id of list) {
      const j = byId.get(id); if (!j) continue;
      const atJob = cur && id === cur.id && tr.status === 'working';
      const tt = atJob ? 0 : travel(pos, P.entry(j), tr.speed);
      const s = c + tt, e = s + j.duration_min * (1 - (j.progress || 0));
      entries.push({ job: id, kind: 'work', start_t: s, end_t: e, travel: tt });
      trav += tt; c = e; pos = P.exit(j);
    }
    per.set(tr.id, { entries, end_t: c, travel: trav });
  }
  return per;
}

function stats(world, per) {
  const ends = [...per.values()].map((p) => p.end_t);
  const horizon = Math.max(world.t, ...ends);
  let travel = 0, idle = 0;
  for (const p of per.values()) { travel += p.travel; idle += horizon - p.end_t; }
  const late = [], finish = new Map();
  for (const [trId, p] of per) for (const e of p.entries) if (e.job) finish.set(e.job, { t: e.end_t, start: e.start_t, tractor: trId });
  for (const j of world.jobs) { const f = finish.get(j.id); if (f && unfinished(j) && f.t > j.deadline_t + 1e-9) late.push(j.id); }
  return { travel, idle, late, finish };
}

/** Planner over a contract-shaped world: mockSource's greedy planAssign (same weather windows when the owner
 *  passes env.wx), with availability, bans and depot holds passed through: preview and apply share one planner. */
function plan(world, travel, env = {}) {
  const tractors = world.fleet.map((tr) => plannerTractor(world, tr, travel));
  const jobs = world.jobs.map((j) => ({ ...j, progress: j.progress || 0 }));
  const disabled = new Map((world.scenario?.disabled_blocks || []).map((d) => [d.block, d]));
  const res = planAssign({ tractors, jobs, blocked: new Set((world.scenario?.blocked_cells || []).map((c) => c[0] + ',' + c[1])), t: world.t, wx: env.wx || null, disabled });
  return { assign: res.assign, unassigned: res.unassigned };
}

/** Apply a validated change to a CLONED contract world (preview only). */
function applyToClone(world, tractorId, controlId, value) {
  const tr = world.fleet.find((x) => x.id === tractorId);
  const depot = () => { tr._depot_min = (tr._depot_min || 0) + (controlId === 'refuel' ? REFUEL_MIN : SWAP_MIN); };
  const release = () => { // its held job goes back to the pool, progress kept
    const j = world.jobs.find((x) => x.id === tr.current_job);
    if (j) { j.tractor = null; j.status = j.progress > 0 ? 'paused' : 'pending'; }
    tr.current_job = null; tr.status = 'idle';
  };
  switch (controlId) {
    case 'implements': {
      tr.implements = value.slice();
      release(); depot(); // a swap means leaving the block for the depot now (progress kept)
      break;
    }
    case 'refuel': if (tr.current_job) release(); depot(); break;
    case 'max_speed': tr.speed = value / NOMINAL_MPH; break;
    case 'off_duty_t': tr.off_duty_t = value; break;
    case 'pin_job':
      for (const j of world.jobs) if (j.pinned_to === tr.id && unfinished(j)) j.pinned_to = null;
      if (value) { const j = world.jobs.find((x) => x.id === value); j.pinned_to = tr.id; const holder = world.fleet.find((o) => o.current_job === j.id && o.id !== tr.id); if (holder) { holder.current_job = null; holder.status = 'idle'; j.status = j.progress > 0 ? 'paused' : 'pending'; } }
      break;
    case 'ban_type': {
      tr.banned_types = value === 'none' ? null : [value];
      const cur = world.jobs.find((x) => x.id === tr.current_job);
      if (cur && value === cur.type) release();
      break;
    }
    default: break;
  }
  return tr;
}

/** First sentence of the operator-change explanation (preview and applied re-plan share it). */
export function leadText(tr, controlId, value, ctx) {
  const n = tName(tr);
  switch (controlId) {
    case 'implements': return `Switching ${n} to ${listText(value.map((i) => 'a ' + IMPL_NAME[i]))} means a depot visit (about ${SWAP_MIN} min plus travel).`;
    case 'refuel': return `Sending ${n} to refuel takes about ${REFUEL_MIN} min plus travel to the depot.`;
    case 'max_speed': return `Limiting ${n} to ${value} mph changes its travel times.`;
    case 'off_duty_t': return value == null ? `${n} stays available all day.` : `${n} goes off duty at ${clockOf(value)}.`;
    case 'pin_job': { const j = ctx.jobs.find((x) => x.id === value); return value ? `Pinning ${j ? j.label : value} to ${n}.` : `Unpinning ${n}'s job.`; }
    case 'ban_type': return value === 'none' ? `${n} can take any job type again.` : `${n} will never be given ${TYPE_LABEL[value].toLowerCase()} work.`;
    default: return `Changing ${n}.`;
  }
}

/**
 * POST /tractors/{id}/preview. Never mutates `world` (it is cloned). Safety refusals come back as
 * {allowed:false, refused_reason}; shape errors (NOT_FOUND / INVALID_INPUT) throw like the endpoint would.
 * @param world {fleet, jobs, scenario, weather, t, plan_version}  contract shapes (+ tractor `speed` if known)
 * @param opts  {cs, travel?, busy?}
 */
export function previewChange(world, tractorId, controlId, value, opts = {}) {
  const travel = opts.travel || manhattanTravel;
  const tr0 = world.fleet.find((x) => x.id === tractorId);
  if (!tr0) throw err('NOT_FOUND', `Tractor ${tractorId} is not in the fleet.`, { tractor: tractorId });
  let checked;
  try { checked = checkControl({ tractor: tr0, cs: opts.cs, jobs: world.jobs, scenario: world.scenario, weather: world.weather, busy: false, t: world.t }, controlId, value); }
  catch (e) {
    if (e.code === 'SAFETY_REJECTED' || e.code === 'NEEDS_MANUAL') return { allowed: false, refused_reason: e.message, plan: null, explanation: null, metrics_delta: {} };
    throw e;
  }
  const { control, value: v } = checked;
  if (!control.replans) return { allowed: true, refused_reason: null, plan: null, explanation: null, metrics_delta: { travel_min: 0, idle_min: 0, late_jobs: 0 } };
  const base = clone({ fleet: world.fleet, jobs: world.jobs, scenario: world.scenario, t: world.t });
  const curAssign = new Map(base.fleet.map((tr) => [tr.id, (tr.queue || []).slice()]));
  const env = { wx: opts.wx ? opts.wx() : null, schedule: opts.schedule || null };
  const before = stats(base, estimate(base, curAssign, travel, env));
  const next = clone(base);
  const tr = applyToClone(next, tractorId, controlId, v);
  const { assign, unassigned } = plan(next, travel, env);
  const perAfter = estimate(next, assign, travel, env);
  const after = stats(next, perAfter);
  // diff
  const moved = [], retimed = [];
  for (const j of next.jobs) {
    if (!unfinished(j)) continue;
    const b = before.finish.get(j.id), a = after.finish.get(j.id);
    const from = b ? b.tractor : null, to = a ? a.tractor : null;
    if (to && from !== to) moved.push({ job: j.id, from, to, progress_kept: Math.round((j.progress || 0) * 100) / 100 });
    else if (b && a && Math.abs(a.start - b.start) >= 5) retimed.push({ job: j.id, old_start_t: r1(b.start), new_start_t: r1(a.start) });
  }
  const dropped = [...unassigned.keys()].filter((id) => before.finish.has(id));
  const newlyLate = after.late.filter((id) => !before.late.includes(id));
  const entries = [];
  for (const [trId, p] of perAfter) for (const e of p.entries) entries.push({ tractor: trId, job: e.job, kind: e.kind, start_t: r1(e.start_t), end_t: r1(e.end_t), route: [] });
  const ver = (world.plan_version ?? 0) + 1;
  const planOut = { version: ver, entries, solver: 'greedy', solve_ms: 1, solver_status: 'feasible', diff: { moved, retimed, dropped: [], added: [] } };
  const label = (id) => (next.jobs.find((j) => j.id === id) || {}).label || id;
  const nm = (id) => tName(next.fleet.find((x) => x.id === id));
  let text = leadText(tr, controlId, v, next);
  if (moved.length) text += ' ' + moved.slice(0, 3).map((m) => `${label(m.job)} moves ${m.from ? 'from ' + nm(m.from) + ' ' : ''}to ${nm(m.to)}`).join('; ') + (moved.length > 3 ? `; ${moved.length - 3} more move` : '') + '.';
  for (const id of newlyLate.slice(0, 2)) {
    const j = next.jobs.find((x) => x.id === id), f = after.finish.get(id);
    text += ` ${j.label} now misses its ${clockOf(j.deadline_t)} deadline by ${durOf(f.t - j.deadline_t)}.`;
  }
  if (dropped.length) text += ` ${dropped.map(label).join(', ')} would have no tractor${unassigned.get(dropped[0]) ? ' (' + unassigned.get(dropped[0]).replace(/\.$/, '') + ')' : ''}.`;
  if (!moved.length && !newlyLate.length && !dropped.length) text += ' No other jobs change.';
  else if (!newlyLate.length && !after.late.length) text += ' All deadlines are still met.';
  const metrics_delta = {
    travel_min: Math.round(after.travel - before.travel),
    idle_min: Math.round(after.idle - before.idle),
    late_jobs: after.late.length - before.late.length,
  };
  const explanation = {
    id: 'PV' + tractorId + '-' + controlId, t: r1(world.t), trigger: 'operator_action', text,
    facts: {
      event: { type: 'operator_action', tractor: tractorId, control: controlId, value: v },
      moved, deadlines_missed: after.late, travel_delta_min: metrics_delta.travel_min, idle_delta_min: metrics_delta.idle_min,
      unassigned: [...unassigned].map(([job, reason]) => ({ job, reason })),
      context: { newly_late: newlyLate, retimed, lost_assignment: dropped },
    },
    plan_version: null,
  };
  return { allowed: true, refused_reason: null, plan: planOut, explanation, metrics_delta };
}

// ---------------------------------------------------------------- host (endpoint semantics over a world owner)
/**
 * The four endpoints over an injected world owner. Used by the Phase 1 harness and (Phase 2) by mockSource.
 * @param host {
 *   world(): {fleet, jobs, scenario, weather, t, plan_version}   current contract-shaped state (read-only)
 *   busy(): boolean                     a plan-producing Operation is queued/running
 *   carry(tractorId, change, control): void   carry out applyControl's effect on the real world (sync)
 *   startReplan(tractorId, change, control): Operation   enqueue the re-plan; return the queued Operation (202)
 *   setManual(tractorId, on, idempotencyKey?): Operation  enqueue manual on/off; return the queued Operation (202)
 *   travel?: travel estimate for preview
 * }
 */
export function createControlHost(host) {
  const states = new Map();
  const W = () => host.world();
  const trOf = (id) => { const tr = W().fleet.find((x) => x.id === id); if (!tr) throw err('NOT_FOUND', `Tractor ${id} is not in the fleet.`, { tractor: id }); return tr; };
  const csOf = (tr) => { let s = states.get(tr.id); if (!s) { s = newControlState(tr); states.set(tr.id, s); } return s; };
  const body = (b) => { if (!b || typeof b !== 'object' || typeof b.control !== 'string') throw err('INVALID_INPUT', 'Body must be {"control": id, "value": ...}.', {}); return b; };
  return {
    state: (id) => states.get(id) || null,
    forget: (id) => states.delete(id),
    reset: () => states.clear(),
    getControls(id) { const tr = trOf(id); const w = W(); return clone(getControlsBody(tr, csOf(tr), w.jobs)); },
    /** {status:200, body:{ok,value,explanation}} | {status:202, body: Operation} */
    control(id, b) {
      body(b); const tr = trOf(id), w = W(), cs = csOf(tr);
      const { control, value } = checkControl({ tractor: tr, cs, jobs: w.jobs, scenario: w.scenario, weather: w.weather, busy: host.busy(), t: w.t }, b.control, b.value);
      if (control.replans) {
        // apply atomically with the re-plan: the owner applies `change` inside the Operation
        const snap = clone(cs);
        const change = applyControl(cs, tr, w.jobs, control, value);
        const restore = () => { states.set(tr.id, snap); };
        return { status: 202, body: host.startReplan(id, change, control, restore) };
      }
      const change = applyControl(cs, tr, w.jobs, control, value);
      host.carry(id, change, control);
      return { status: 200, body: { ok: true, value: change.new, explanation: null }, change };
    },
    preview(id, b) { body(b); const tr = trOf(id); const w = W(); return previewChange(w, id, b.control, b.value, { cs: csOf(tr), travel: host.travel, wx: host.wx, schedule: host.schedule }); },
    manual(id, b, o = {}) {
      if (!b || typeof b.on !== 'boolean') throw err('INVALID_INPUT', 'Body must be {"on": true|false}.', {});
      const tr = trOf(id);
      if (b.on && DOWN.has(tr.status)) throw err('SAFETY_REJECTED', `${tName(tr)} is ${tr.status.replace(/_/g, ' ')}; it can't be driven right now.`, { rule: 'tractor_down' });
      const cs = csOf(tr);
      if (!b.on) { cs.speed_mph = 0; cs.steer = 0; cs.drive_to = null; cs.dir = 1; }
      return { status: 202, body: host.setManual(id, b.on, o.idempotencyKey) }; // §13.2: always 202, queued behind any running re-plan
    },
  };
}

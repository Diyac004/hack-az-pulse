// Placeholder used ONLY when src/data/index.js does not exist yet (see vite.config.js).
// Renders an empty farm so the visual layer can boot; every api call rejects politely.
const state = { source: 'mock', connected: true, seq: 0, scenario: null, clock: { t: 0, playing: false, speed: 1, day_minutes: 720, mode: 'ours', ended: false },
  fleet: [], jobs: [], plan: null, explanations: [], metrics: null, weather: null, pending: [], capacity: null, log: [], operations: [] };
const subs = new Set();
const no = () => Promise.reject({ code: 'INTERNAL', message: 'Data layer not installed yet (src/data/index.js missing).', details: {} });
export const sourceInfo = { kind: 'mock', api: null };
export const store = { get: () => state, subscribe(fn) { subs.add(fn); return () => subs.delete(fn); } };
export const api = new Proxy({}, { get: () => no });
export async function start() { subs.forEach((f) => f(state, { type: 'snapshot', t: 0, seq: 0, data: state })); return state; }

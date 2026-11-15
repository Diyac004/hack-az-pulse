// Pure formatting + palette helpers. No DOM, no three.js.

export const PALETTE = ['#0A84FF', '#BF5AF2', '#FF9F0A', '#30D158', '#FF375F', '#5E5CE6', '#64D2FF', '#FFD60A'];

export const PRIORITY_COLOR = { 3: '#FF453A', 2: '#FF9F0A', 1: '#6B7A90' };
export const PRIORITY_NAME = { 3: 'High', 2: 'Medium', 1: 'Low' };
export const priColor = (p) => PRIORITY_COLOR[p] || PRIORITY_COLOR[1];
export const priName = (p) => PRIORITY_NAME[p] || 'Low';

export const IMPLEMENTS = ['sprayer', 'mower', 'hedger', 'bin_trailer'];
export const implName = (i) => (i === 'bin_trailer' ? 'bin trailer' : String(i || '').replace(/_/g, ' '));

/** Farm time (minutes since 6:00 AM) -> "9:05 AM" */
export function clock(m) {
  if (m == null || !isFinite(m)) return '--:--';
  const h = 6 + Math.floor(m / 60), mm = Math.floor(((m % 60) + 60) % 60), hh = ((h + 11) % 12) + 1;
  return hh + ':' + String(mm).padStart(2, '0') + ((h % 24) >= 12 ? ' PM' : ' AM');
}

/** Short hour label for the timeline axis */
export function hourLabel(m, first, last) {
  const h = 6 + Math.round(m / 60), hh = ((h + 11) % 12) + 1, pm = (h % 24) >= 12;
  return (first || last || hh === 12) ? hh + (pm ? ' PM' : ' AM') : String(hh);
}

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const tractorColor = (tr, i = 0) => (tr && typeof tr.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(tr.color)) ? tr.color : PALETTE[i % PALETTE.length];

/** Status -> { label, color, ring } for chips and 3D rings. Unknown statuses fall back gracefully. */
const STATUS = {
  starting: { label: 'Starting…', color: '#0A84FF', ring: 'spin' },
  ready: { label: 'Ready', color: null, ring: 'solid' },
  idle: { label: 'Idle', color: null, ring: 'solid' },
  traveling: { label: 'Traveling', color: null, ring: 'solid' },
  working: { label: 'Working', color: null, ring: 'pulse' },
  refueling: { label: 'Refueling', color: '#C77C00', ring: 'solid' },
  waiting_weather: { label: 'Waiting on weather', color: '#C77C00', ring: 'solid' },
  broken: { label: 'Broken', color: '#FF453A', ring: 'broken' },
  awaiting_mechanic: { label: 'Awaiting mechanic', color: '#FF453A', ring: 'broken' },
  repair_scheduled: { label: 'Mechanic on the way', color: '#FF453A', ring: 'broken' },
  repairing: { label: 'Repairing', color: '#C77C00', ring: 'repair' },
  removing: { label: 'Removing…', color: '#8e8e93', ring: 'fade' },
  offline: { label: 'Offline', color: '#8e8e93', ring: 'fade' },
};
export const statusInfo = (s) => STATUS[s] || { label: s ? String(s).replace(/_/g, ' ') : 'Unknown', color: '#8e8e93', ring: 'solid' };
export const isDown = (s) => s === 'broken' || s === 'awaiting_mechanic' || s === 'repair_scheduled';
export const isBusy = (s) => s === 'traveling' || s === 'working';

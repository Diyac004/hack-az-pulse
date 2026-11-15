// Shared wording helpers for every user-facing string (mock explanations, activity feed, island, sheets).
// Pure, no DOM; imported by the in-browser mock, the Node mock-backend and the dashboard UI.

/**
 * Farm time t (minutes since 6:00 AM; may exceed the day) -> "9:05 AM". Times on a later calendar day say so:
 * t = 1134 -> "12:54 AM (+1 day)". Deltas between times must be computed on raw t, never on these strings.
 */
export function clockText(m) {
  if (m == null || !isFinite(m)) return '--:--';
  const tot = Math.floor(m) + 360; // minutes since midnight of the farm day
  const day = Math.floor(tot / 1440), mins = ((tot % 1440) + 1440) % 1440;
  const h = Math.floor(mins / 60), mm = mins % 60, hh = ((h + 11) % 12) + 1;
  return hh + ':' + String(mm).padStart(2, '0') + (h >= 12 ? ' PM' : ' AM') + (day > 0 ? ' (+' + day + ' day' + (day === 1 ? '' : 's') + ')' : day < 0 ? ' (previous day)' : '');
}

/** plural(1, 'job') -> "1 job"; plural(3, 'job') -> "3 jobs"; plural(2, 'person', 'people'). */
export const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
/** Verb agreeing with a count: verb(1, 'carries', 'carry') -> "carries". */
export const verb = (n, one, many) => (n === 1 ? one : many);
/** "A", "A and B", "A, B and C". */
export const listText = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
/** Minutes as "45 min" / "2 h 5 min" (rounded). */
export function durText(min) {
  const m = Math.round(Math.abs(+min || 0));
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
}
/** Priority number (3 high, 2 medium, 1 low) -> word. Never show "P1": operators read it as the highest. */
export const priorityWord = (p) => ({ 3: 'High', 2: 'Medium', 1: 'Low' }[p] || 'Low');

// Which view is showing ("sim" | "live"). Pure, Node-testable.
// - Only the user (the toggle) may change it; any other caller is refused and logged, so nothing in the app
//   (snapshots, focus/overview/home, sheets, timers) can flip the view behind the user's back.
// - The choice is persisted (sessionStorage by default) and restored after a page reload. During development
//   Vite does a full page reload whenever any imported module is saved, which used to drop the user back
//   into Simulated a moment after they picked Live feed.
export const VIEWS = ['sim', 'live'];
// User-facing names are "3D" and "Map"; ?view=3d|map are accepted as aliases of the internal ids.
const ALIAS = { '3d': 'sim', map: 'live' };
const KEY = 'hf.view';

function safeStorage(storage) {
  return {
    get() { try { return storage ? storage.getItem(KEY) : null; } catch (e) { return null; } },
    set(v) { try { if (storage) storage.setItem(KEY, v); } catch (e) { /* private mode etc. */ } },
  };
}

/** @param {{storage?: Storage|null, search?: string}} opts  `?view=live|sim` in search overrides storage. */
export function createViewState({ storage = null, search = '' } = {}) {
  const st = safeStorage(storage);
  const log = [];
  let view = 'sim';
  let q = null;
  try { q = new URLSearchParams(search || '').get('view'); } catch (e) { q = null; }
  q = ALIAS[q] || q;
  const wanted = VIEWS.includes(q) ? q : (VIEWS.includes(st.get()) ? st.get() : 'sim');
  const note = (entry) => { log.push(entry); if (log.length > 50) log.shift(); };
  return {
    get view() { return view; },
    /** The view to restore on boot ('live' only when the user last chose it or ?view=live). */
    get restore() { return wanted; },
    /**
     * Ask to change the view. source: 'user' (toggle) or 'restore' (boot). Anything else is refused.
     * @returns true when the view changed.
     */
    request(v, source) {
      const t = Date.now();
      if (!VIEWS.includes(v)) { note({ t, v, source, ok: false, why: 'unknown view' }); return false; }
      if (source !== 'user' && source !== 'restore') { note({ t, v, source, ok: false, why: 'not user' }); return false; }
      if (v === view) return false;
      view = v; note({ t, v, source, ok: true });
      if (source === 'user') st.set(v);
      return true;
    },
    log,
  };
}

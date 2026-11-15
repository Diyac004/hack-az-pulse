// Backend capability detection (integration feedback #3). The dashboard hides or disables features the connected
// backend does not support instead of letting the operator discover them through errors.
//
// How it decides, in order (no state-changing request is ever sent):
//   1. GET /api/capabilities, if the backend serves it: a partial Capabilities object, merged over the defaults.
//   2. Which backend this is: GET /openapi.json -> `paths` (FastAPI platform backend) or `routes` (our Node
//      mock-backend); else GET /api/bridge -> AgOpenWeb bridge; else unknown (everything on).
//   3. A small per-backend profile for features that can only be exercised with POST (weather events, approvals,
//      scale test): FastAPI documents them as not modeled / not implemented (backend/README.md).
//   4. Side-effect-free GET probes for why / tractor controls / mechanics: HTTP 501 or
//      error.details.not_implemented turns that feature family off.
// Pure ES module; `request` is liveSource.request (rejects {code,message,details,status}).

/** Every feature on: the in-browser mock, the Node mock-backend, or a backend we cannot identify. */
export const ALL_ON = Object.freeze({
  backend: 'mock', // mock | mock-backend | fastapi | bridge | unknown
  events: Object.freeze({ breakdown: true, block_route: true, unblock_route: true, tractor_repaired: true, priority_change: true, heat_alert: true, weather_change: true, block_disabled: true, block_enabled: true }), // block_*: ARCHITECTURE §14 proposal
  why: true, // GET /why/{job}
  controls: true, // cockpit: /tractors/{id}/controls, control, preview, manual
  mechanics: true, // GET /mechanics + POST /mechanics/book
  approve: true,
  scaleTest: true,
  submitJobs: true, // POST /jobs
  patchJob: true, // PATCH /jobs/{id} (priority from the Why sheet)
  weatherEnforced: true, // spraying decisions use the weather shown
  metricsMeasured: true, // travel/idle/violations are measured by a scheduler run
});

export const UNSUPPORTED = 'Not supported by this backend';

/** Backend-specific defaults for features that cannot be probed without side effects. */
const PROFILES = {
  'mock-backend': {},
  unknown: {},
  // Anay's FastAPI + MockGateway (backend/README.md "What's mocked or unfinished"): weather is a static
  // placeholder and heat_alert / weather_change return 400; approve and scale-test return 501.
  fastapi: { events: { heat_alert: false, weather_change: false, block_disabled: false, block_enabled: false }, approve: false, scaleTest: false, weatherEnforced: false },
  // AgOpenWeb bridge (agopenweb-bridge/server.mjs): drives real AgOpenWeb tractors and bypasses the Python
  // scheduler. Only breakdown / tractor_repaired events; no job edits, Why or approvals; metrics are placeholders.
  bridge: {
    events: { block_route: false, unblock_route: false, priority_change: false, heat_alert: false, weather_change: false, block_disabled: false, block_enabled: false },
    why: false, approve: false, scaleTest: false, submitJobs: false, patchJob: false, weatherEnforced: false, metricsMeasured: false,
  },
};

/** Deep-merge `over` (partial) onto a plain copy of `base`. Unknown keys are ignored. */
export function mergeCaps(base, over) {
  const out = { ...base, events: { ...base.events } };
  if (!over || typeof over !== 'object') return out;
  for (const [k, v] of Object.entries(over)) {
    if (k === 'events' && v && typeof v === 'object') { for (const [e, on] of Object.entries(v)) if (typeof on === 'boolean') out.events[e] = on; }
    else if (k === 'backend' && typeof v === 'string') out.backend = v;
    else if (k in base && typeof base[k] === 'boolean' && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

const notImplemented = (e) => !!e && (e.status === 501 || !!(e.details && e.details.not_implemented));

/**
 * @param {{root: string, request: Function, fetchJson?: (url: string) => Promise<any>, state?: object}} o
 *   root: backend origin (http://host:port); request: liveSource.request; state: the first snapshot (for probe ids).
 * @returns {Promise<typeof ALL_ON>} never rejects; on any doubt a feature stays on.
 */
export async function detectCapabilities({ root, request, fetchJson, state }) {
  const getJson = fetchJson || (async (url) => { const r = await fetch(url, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  let backend = 'unknown';
  try {
    const oa = await getJson(String(root).replace(/\/+$/, '') + '/openapi.json');
    if (oa && oa.paths && typeof oa.paths === 'object') backend = 'fastapi';
    else if (oa && Array.isArray(oa.routes)) backend = 'mock-backend';
  } catch { /* not served */ }
  if (backend === 'unknown') { try { const b = await request('GET', '/bridge'); if (b && typeof b === 'object' && 'mode' in b) backend = 'bridge'; } catch { /* not the bridge */ } }
  let caps = mergeCaps(ALL_ON, { ...PROFILES[backend], backend });

  if (backend === 'fastapi' || backend === 'unknown') {
    const job = state && (state.jobs || [])[0], tr = state && (state.fleet || [])[0];
    const probe = async (key, path) => {
      try { await request('GET', path); } catch (e) { if (notImplemented(e)) caps[key] = false; }
    };
    await Promise.all([
      job ? probe('why', '/why/' + encodeURIComponent(job.id)) : null,
      tr ? probe('controls', '/tractors/' + encodeURIComponent(tr.id) + '/controls') : null,
      tr ? probe('mechanics', '/mechanics?tractor=' + encodeURIComponent(tr.id)) : null,
    ]);
  }
  // An explicit capabilities document from the backend wins over everything we inferred.
  try { const doc = await request('GET', '/capabilities'); if (doc && typeof doc === 'object') caps = mergeCaps(caps, doc); } catch { /* optional */ }
  return caps;
}

// JobInput rules for POST /api/jobs (ARCHITECTURE.md §5 JobInput, matched to Anay's backend models.JobInput /
// World.add_jobs). Pure, no DOM; shared by the in-browser mock, the Node mock-backend and the dashboard UI
// (form pre-check, JSON "Validate", and mapping a server rejection back onto rows/fields).
//
// JobInput: { id?: string, type, implement, block, duration_min > 0, priority 1..3, deadline_t }
//   - implement must be the one the job type needs (spray->sprayer, mow->mower, hedge->hedger, haul_bins->bin_trailer)
//   - id optional (backend assigns the next free J<n>); duplicate ids in one request are rejected, existing ids 409
//   - deadline_t is farm minutes since 6:00 AM. We also reject negative deadlines (before 6:00 AM); Anay's backend
//     does not check this.

export const JOB_TYPES = ['spray', 'mow', 'hedge', 'haul_bins'];
export const IMPLEMENT_FOR = { spray: 'sprayer', mow: 'mower', hedge: 'hedger', haul_bins: 'bin_trailer' };
export const JOB_TYPE_NAME = { spray: 'Spray', mow: 'Mow', hedge: 'Hedge', haul_bins: 'Haul bins' };
export const JOB_FIELDS = ['id', 'type', 'implement', 'block', 'duration_min', 'priority', 'deadline_t'];
const FIELD_NAME = { id: 'ID', type: 'Job type', implement: 'Implement', block: 'Block', duration_min: 'Duration', priority: 'Priority', deadline_t: 'Deadline' };
const IMPL_NAME = { sprayer: 'sprayer', mower: 'mower', hedger: 'hedger', bin_trailer: 'bin trailer' };

/** "Spray E", "Haul bins C" */
export const jobLabel = (type, block) => (JOB_TYPE_NAME[type] || String(type || 'Job')) + ' ' + block;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate a job list. Returns a list of { index, field, msg } (index null = whole request; field null = whole row).
 * @param {unknown} jobs
 * @param {{blocks?: string[]|null, existingIds?: Iterable<string>}} ctx blocks: known block ids (skip the check if null)
 */
export function validateJobInputs(jobs, { blocks = null, existingIds = [] } = {}) {
  const errs = [];
  if (!Array.isArray(jobs)) return [{ index: null, field: null, msg: 'Send a list of jobs: {"jobs": [ ... ]}.' }];
  if (!jobs.length) return [{ index: null, field: null, msg: 'Add at least one job.' }];
  const known = new Set(existingIds);
  const blockSet = blocks ? new Set(blocks) : null;
  const seen = new Map();
  jobs.forEach((j, i) => {
    const e = (field, msg) => errs.push({ index: i, field, msg });
    if (!j || typeof j !== 'object' || Array.isArray(j)) { e(null, 'Each job must be an object like {"type": "mow", "block": "G", ...}.'); return; }
    if (j.id != null) {
      if (typeof j.id !== 'string' || !j.id.trim()) e('id', 'ID must be text such as "J20", or left out.');
      else if (seen.has(j.id)) e('id', `The same job ID (${j.id}) appears twice.`);
      else if (known.has(j.id)) e('id', `Job ${j.id} already exists.`);
      if (typeof j.id === 'string') seen.set(j.id, i);
    }
    const typeOk = JOB_TYPES.includes(j.type);
    if (!typeOk) e('type', 'Job type must be spray, mow, hedge or haul_bins.');
    if (!Object.values(IMPLEMENT_FOR).includes(j.implement)) e('implement', 'Implement must be sprayer, mower, hedger or bin_trailer.');
    else if (typeOk && IMPLEMENT_FOR[j.type] !== j.implement) e('implement', `A ${j.type} job needs a ${IMPL_NAME[IMPLEMENT_FOR[j.type]]}, not a ${IMPL_NAME[j.implement]}.`);
    if (typeof j.block !== 'string' || !j.block) e('block', 'Pick a block.');
    else if (blockSet && !blockSet.has(j.block)) e('block', `There is no block ${j.block} on this farm.`);
    if (!isNum(j.duration_min) || j.duration_min <= 0) e('duration_min', 'Duration must be a number of minutes above 0.');
    if (!Number.isInteger(j.priority) || j.priority < 1 || j.priority > 3) e('priority', 'Priority must be 1 (low), 2 (medium) or 3 (high).');
    if (!isNum(j.deadline_t)) e('deadline_t', 'Deadline must be a farm time in minutes after 6:00 AM.');
    else if (j.deadline_t < 0) e('deadline_t', 'Deadline must be after 6:00 AM.');
  });
  return errs;
}

/** Errors -> the contract error shape used by the mock (details.errors[].loc mirrors FastAPI/Pydantic). */
export function jobInputError(errs) {
  const first = errs[0];
  const where = first.index == null ? '' : `Job ${first.index + 1}${first.field ? ' ' + (FIELD_NAME[first.field] || first.field).toLowerCase() : ''}: `;
  return {
    code: errs.some((x) => /already exists/.test(x.msg)) && errs.every((x) => /already exists/.test(x.msg)) ? 'CONFLICT' : 'INVALID_INPUT',
    message: where + first.msg + (errs.length > 1 ? ` (${errs.length - 1} more problem${errs.length > 2 ? 's' : ''})` : ''),
    details: { errors: errs.map((x) => ({ loc: ['body', 'jobs', ...(x.index == null ? [] : [x.index]), ...(x.field ? [x.field] : [])], msg: x.msg })) },
  };
}

/**
 * Parse the JSON tab: accepts {"jobs": [...]} or a bare [...] list. Returns { jobs } or { error }.
 */
export function parseJobsJson(text) {
  let v;
  try { v = JSON.parse(text); } catch (e) {
    const m = /position (\d+)/.exec(String(e && e.message));
    let where = '';
    if (m) { const pos = +m[1], before = String(text).slice(0, pos); where = ` (line ${before.split('\n').length}, column ${pos - before.lastIndexOf('\n')})`; }
    return { error: 'That is not valid JSON' + where + '. ' + String((e && e.message) || '').replace(/^JSON\.parse: /, '') };
  }
  if (Array.isArray(v)) return { jobs: v };
  if (v && typeof v === 'object' && Array.isArray(v.jobs)) return { jobs: v.jobs };
  return { error: 'Expected {"jobs": [ ... ]} or a list of jobs.' };
}

/**
 * Map a rejected POST /api/jobs onto rows. Handles:
 *   - details.errors[].loc (FastAPI/Pydantic 400 and the mock): ["body","jobs",i,field]
 *   - Anay's World errors, which carry no row (details {}): matched by message against the submitted jobs
 * @returns {{rows: Map<number, Record<string,string>>, general: string[]}} rows: index -> {field|'_row': msg}
 */
export function mapJobErrors(err, jobs = []) {
  const rows = new Map(), general = [];
  const put = (i, field, msg) => { const r = rows.get(i) || {}; const k = field || '_row'; r[k] = r[k] ? r[k] + ' ' + msg : msg; rows.set(i, r); };
  const list = err && err.details && Array.isArray(err.details.errors) ? err.details.errors : null;
  if (list && list.length) {
    for (const x of list) {
      const loc = Array.isArray(x.loc) ? x.loc.filter((p) => p !== 'body') : [];
      const k = loc.indexOf('jobs');
      const i = k >= 0 && Number.isInteger(loc[k + 1]) ? loc[k + 1] : null;
      const field = i != null && typeof loc[k + 2] === 'string' ? loc[k + 2] : null;
      const msg = friendlyMsg(x.msg, field);
      if (i != null && i < jobs.length) put(i, JOB_FIELDS.includes(field) ? field : null, msg);
      else general.push(msg);
    }
    return { rows, general };
  }
  const msg = (err && err.message) || 'The backend rejected these jobs.';
  let m;
  if ((m = /There is no block (\S+) on this farm/.exec(msg))) {
    const hit = jobs.map((j, i) => [j, i]).filter(([j]) => j && j.block === m[1]);
    hit.forEach(([, i]) => put(i, 'block', msg));
    if (hit.length) return { rows, general };
  } else if ((m = /^A (\S+) job needs a/.exec(msg))) {
    const hit = jobs.map((j, i) => [j, i]).filter(([j]) => j && j.type === m[1] && IMPLEMENT_FOR[j.type] !== j.implement);
    hit.forEach(([, i]) => put(i, 'implement', msg));
    if (hit.length) return { rows, general };
  } else if ((m = /^Job (\S+) already exists/.exec(msg))) {
    const hit = jobs.map((j, i) => [j, i]).filter(([j]) => j && j.id === m[1]);
    hit.forEach(([, i]) => put(i, 'id', msg));
    if (hit.length) return { rows, general };
  }
  general.push(msg);
  return { rows, general };
}

// Pydantic messages are technical ("Input should be greater than 0"); prefix the field so they read on their own.
function friendlyMsg(msg, field) {
  const s = String(msg || 'Invalid value.');
  if (!field || !/^(Input|Field|Value)\b/.test(s)) return s;
  return (FIELD_NAME[field] || field) + ': ' + s.charAt(0).toLowerCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.');
}

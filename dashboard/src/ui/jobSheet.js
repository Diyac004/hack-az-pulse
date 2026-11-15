// "Add jobs" glass sheet: POST /api/jobs (ARCHITECTURE §5 JobInput, §13.2 202 Operation).
// Two tabs: Form (rows of type/block/priority/deadline/duration) and JSON (a job list). Both pre-check with the
// same rules as the backend (data/jobInput.js), submit through api.submitJobs, track the Operation with ops.track
// (spinner on Submit until it succeeds/fails), and map a 400/409 back onto the row and field that caused it.
import './jobSheet.css';
import { clock, esc, plural, durText, listText } from '../lib/format.js';
import { errText, errKind } from '../lib/derive.js';
import { JOB_TYPES, JOB_TYPE_NAME, IMPLEMENT_FOR, validateJobInputs, mapJobErrors, parseJobsJson, jobLabel } from '../data/jobInput.js';

const DEFAULT_MIN = { spray: 120, mow: 90, hedge: 100, haul_bins: 90 };
const PRI = [[1, 'Low'], [2, 'Medium'], [3, 'High']];
const FIELD_LABEL = { id: 'ID', type: 'type', implement: 'implement', block: 'block', duration_min: 'duration', priority: 'priority', deadline_t: 'deadline' };

/** "14:30" <-> farm t (minutes since 6:00 AM). */
const hhmmToT = (v) => { const m = /^(\d{1,2}):(\d{2})/.exec(v || ''); return m ? +m[1] * 60 + +m[2] - 360 : null; };
/** Muted line under the deadline: how far away it is, or that it is already past (allowed; the plan shows it late). */
const deadlineHint = (t, now) => (t == null || t < 0 ? '' : t < now ? 'already past: the plan will show it late' : 'in ' + durText(t - now));
const tToHhmm = (t) => { const tot = ((Math.round(t) + 360) % 1440 + 1440) % 1440; return String(Math.floor(tot / 60)).padStart(2, '0') + ':' + String(tot % 60).padStart(2, '0'); };

export function createJobSheet({ store, api, ops, toast, sheets }) {
  const el = document.getElementById('jobsheet');
  const btn = document.getElementById('bJobs');
  const st = () => store.get() || {};
  const blocks = () => ((st().scenario && st().scenario.blocks) || []).map((b) => b.id);
  const blockInfo = (id) => ((st().scenario && st().scenario.blocks) || []).find((b) => b.id === id);

  let tab = 'form';
  let rows = [];
  let json = '';
  let errs = { rows: new Map(), general: [] }; // rows: index -> {field|'_row': msg}
  let note = null;                             // { kind: 'ok'|'err', text } under the JSON box
  let opId = null;                             // the submit op we are tracking (status line)

  function defaultDeadline() {
    const t = (st().clock && st().clock.t) || 0;
    return Math.min(690, Math.ceil((t + 240) / 30) * 30); // ~4 h from now, on the half hour, by 5:30 PM
  }
  const newRow = (prev) => {
    const type = prev ? prev.type : 'mow';
    return { type, block: prev ? prev.block : (blocks()[0] || 'A'), priority: prev ? prev.priority : 2, deadline: tToHhmm(prev ? hhmmToT(prev.deadline) ?? defaultDeadline() : defaultDeadline()), duration: prev ? prev.duration : DEFAULT_MIN[type], durTouched: false };
  };
  function exampleJson() {
    const b = blocks(), pick = (i, d) => b[i % Math.max(1, b.length)] || d;
    const ex = [
      { type: 'mow', implement: 'mower', block: pick(6, 'G'), duration_min: 60, priority: 2, deadline_t: 480 },
      { type: 'spray', implement: 'sprayer', block: pick(0, 'A'), duration_min: 90, priority: 3, deadline_t: 360 },
    ];
    return '{\n  "jobs": [\n' + ex.map((j) => '    ' + JSON.stringify(j).replace(/,"/g, ', "').replace(/":/g, '": ')).join(',\n') + '\n  ]\n}';
  }
  const formJobs = () => rows.map((r) => ({ type: r.type, implement: IMPLEMENT_FOR[r.type], block: r.block, duration_min: r.duration === '' ? NaN : Number(r.duration), priority: r.priority, deadline_t: hhmmToT(r.deadline) ?? NaN }));
  const local = (jobs) => {
    const list = validateJobInputs(jobs, { blocks: blocks().length ? blocks() : null, existingIds: (st().jobs || []).map((j) => j.id) });
    const out = { rows: new Map(), general: [] };
    for (const x of list) {
      if (x.index == null) { out.general.push(x.msg); continue; }
      const r = out.rows.get(x.index) || {}; const k = x.field || '_row'; r[k] = r[k] ? r[k] + ' ' + x.msg : x.msg; out.rows.set(x.index, r);
    }
    return out;
  };
  const errCount = (e) => e.general.length + [...e.rows.values()].reduce((n, r) => n + Object.keys(r).length, 0);
  // Readable list for the JSON tab: "Job 2 block: There is no block Z on this farm."
  const errLines = (e) => [...[...e.rows.entries()].sort((a, b) => a[0] - b[0]).flatMap(([i, r]) => Object.entries(r).map(([f, m]) => 'Job ' + (i + 1) + (f === '_row' ? '' : ' ' + (FIELD_LABEL[f] || f)) + ': ' + m)), ...e.general];

  // ---------------- render (only on structural changes; typing never re-renders, so focus is kept)
  function fieldErr(i, f) { const r = errs.rows.get(i); return r && r[f] ? '<span class="jerr">' + esc(r[f]) + '</span>' : ''; }
  function rowHtml(r, i) {
    const bad = (f) => (errs.rows.get(i) || {})[f] ? ' bad' : '';
    const bl = blocks();
    const blockOpts = (bl.length ? bl : [r.block]).map((id) => { const b = blockInfo(id); return '<option value="' + esc(id) + '"' + (id === r.block ? ' selected' : '') + '>Block ' + esc(id) + (b && b.variety ? ' · ' + esc(b.variety) : '') + '</option>'; }).join('');
    const t = hhmmToT(r.deadline), now = (st().clock && st().clock.t) || 0;
    const hint = deadlineHint(t, now);
    return '<div class="jrow" data-row="' + i + '">' +
      '<div class="jrh"><b>Job ' + (i + 1) + '</b><span class="jlab">' + esc(jobLabel(r.type, r.block)) + '</span>' + (rows.length > 1 ? '<button class="jx" data-del="' + i + '" aria-label="Remove job ' + (i + 1) + '">Remove</button>' : '') + '</div>' +
      '<div class="jgrid">' +
        '<label class="jf' + bad('type') + bad('implement') + '"><span>Job type</span><select data-f="type">' + JOB_TYPES.map((ty) => '<option value="' + ty + '"' + (ty === r.type ? ' selected' : '') + '>' + JOB_TYPE_NAME[ty] + '</option>').join('') + '</select>' + fieldErr(i, 'type') + fieldErr(i, 'implement') + '</label>' +
        '<label class="jf' + bad('block') + '"><span>Block</span><select data-f="block">' + blockOpts + '</select>' + fieldErr(i, 'block') + '</label>' +
        '<div class="jf jpri' + bad('priority') + '"><span>Priority</span><div class="seg">' + PRI.map(([p, n]) => '<button type="button" data-pri="' + p + '" class="' + (r.priority === p ? 'on' : '') + '">' + n + '</button>').join('') + '</div>' + fieldErr(i, 'priority') + '</div>' +
        '<label class="jf' + bad('deadline_t') + '"><span>Deadline <i>farm time</i></span><input type="time" data-f="deadline" min="06:00" step="900" value="' + esc(r.deadline) + '"><em data-hint>' + esc(hint) + '</em>' + fieldErr(i, 'deadline_t') + '</label>' +
        '<label class="jf' + bad('duration_min') + '"><span>Work time <i>min</i></span><input type="number" data-f="duration" min="5" max="720" step="5" inputmode="numeric" value="' + esc(r.duration) + '">' + fieldErr(i, 'duration_min') + '</label>' +
      '</div>' + fieldErr(i, '_row') + fieldErr(i, 'id') + '</div>';
  }
  function render() {
    const busy = el.querySelector('[data-submit].busy');
    let html = '<div class="shead"><p>Add jobs</p><button class="gbtn sm" data-x>Close</button></div>' +
      '<div class="jtabs seg" role="tablist">' + [['form', 'Form'], ['json', 'JSON']].map(([k, n]) => '<button type="button" role="tab" aria-selected="' + (tab === k) + '" data-tab="' + k + '" class="' + (tab === k ? 'on' : '') + '">' + n + '</button>').join('') + '</div>';
    if (tab === 'form') {
      html += '<div class="jrows">' + rows.map(rowHtml).join('') + '</div><button type="button" class="jadd" data-more>+ Add another</button>';
    } else {
      html += '<p class="sub">A job list as JSON: <code>{"jobs": [JobInput]}</code>. <code>deadline_t</code> is minutes after 6:00 AM (480 = 2:00 PM); <code>implement</code> must match <code>type</code>; <code>id</code> is optional.</p>' +
        '<textarea class="jjson" data-json spellcheck="false" rows="8" aria-label="Job list JSON">' + esc(json) + '</textarea>';
      if (note) html += '<div class="jnote ' + note.kind + '">' + note.text + '</div>';
    }
    if (tab === 'form' && errs.general.length) html += '<div class="jnote err">' + errs.general.map(esc).join('<br>') + '</div>';
    const n = tab === 'form' ? rows.length : null;
    html += '<div class="jfoot"><span class="jst" data-opst></span>' +
      (tab === 'json' ? '<button class="gbtn" data-validate>Validate</button>' : '') +
      '<button class="abtn" data-submit>' + (n ? 'Submit ' + plural(n, 'job') : 'Submit') + '</button></div>';
    el.innerHTML = html;
    if (busy) { const b = el.querySelector('[data-submit]'); b.classList.add('busy'); b.dataset.busy = 1; }
    syncStatus();
  }
  function syncStatus() {
    const s = el.querySelector('[data-opst]'); if (!s) return;
    const op = opId && ((st().operations || []).find((o) => o && o.id === opId));
    s.textContent = op && (op.status === 'queued' || op.status === 'running') ? (op.status === 'queued' ? 'Queued' : 'Planning') + ' · ' + op.id : '';
  }

  // ---------------- submit
  function submit(jobs, src) {
    const b = el.querySelector('[data-submit]');
    if (!b || b.classList.contains('busy')) return;
    const before = new Set((st().jobs || []).map((j) => j.id));
    let rejected = null;
    const p = api.submitJobs(jobs).then((op) => { if (op && op.id) { opId = op.id; syncStatus(); } return op; }, (err) => { rejected = err; return null; });
    const okText = (op) => {
      const added = (st().jobs || []).filter((j) => !before.has(j.id));
      const v = op.result && op.result.applied_plan_version;
      if (!added.length) return op.message || 'Jobs added';
      const late = added.filter((j) => j.unassigned_reason && !j.tractor);
      return 'Added ' + listText(added.map((j) => j.id + ' ' + (j.label || ''))) + (v != null ? ' · plan v' + v : '') + (late.length ? ' · ' + plural(late.length, 'job') + ' waiting' : '');
    };
    ops.track(p, { els: b, okText }).then((res) => {
      opId = null; syncStatus();
      if (rejected) {
        if (rejected.code === 'INVALID_INPUT' || rejected.code === 'CONFLICT' || rejected.status === 400 || rejected.status === 409 || rejected.status === 422) {
          errs = mapJobErrors(rejected, jobs);
          if (src === 'json') note = { kind: 'err', text: '<b>The backend rejected these jobs.</b><ul>' + errLines(errs).map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>' };
          render(); revealError();
          toast('Jobs not added: ' + (rejected.message || 'check the highlighted fields'), 'err');
        } else toast(errText(rejected), errKind(rejected));
        return;
      }
      if (res && res.status === 'succeeded') { el.classList.remove('on'); reset(); }
    });
  }
  function revealError() { const e = el.querySelector('.bad, .jnote.err'); if (e) e.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  function reset() { rows = [newRow()]; errs = { rows: new Map(), general: [] }; note = null; }
  function checkJson() {
    const parsed = parseJobsJson(json);
    if (parsed.error) { note = { kind: 'err', text: esc(parsed.error) }; return null; }
    const e = local(parsed.jobs);
    if (errCount(e)) { note = { kind: 'err', text: '<b>' + plural(errCount(e), 'problem') + ' to fix:</b><ul>' + errLines(e).map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>' }; return null; }
    note = { kind: 'ok', text: 'Looks good: ' + esc(listText(parsed.jobs.map((j) => jobLabel(j.type, j.block) + ' by ' + clock(j.deadline_t)))) + '.' };
    return parsed.jobs;
  }

  // ---------------- events
  el.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-x]')) { el.classList.remove('on'); return; }
    const tb = t.closest('[data-tab]');
    if (tb && tb.dataset.tab !== tab) { tab = tb.dataset.tab; note = null; errs = { rows: new Map(), general: [] }; render(); return; }
    if (t.closest('[data-more]')) { rows.push(newRow(rows[rows.length - 1])); errs = { rows: new Map(), general: [] }; render(); const last = el.querySelector('.jrow:last-child'); if (last) last.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
    const del = t.closest('[data-del]');
    if (del) { rows.splice(+del.dataset.del, 1); errs = { rows: new Map(), general: [] }; render(); return; }
    const pr = t.closest('[data-pri]');
    if (pr) { const i = +pr.closest('[data-row]').dataset.row; rows[i].priority = +pr.dataset.pri; pr.parentNode.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === pr)); clearErr(i, 'priority'); return; }
    if (t.closest('[data-validate]')) { checkJson(); render(); return; }
    if (t.closest('[data-submit]')) {
      if (tab === 'form') {
        const jobs = formJobs(); errs = local(jobs);
        if (errCount(errs)) { render(); revealError(); return; }
        submit(jobs, 'form');
      } else {
        const jobs = checkJson(); render();
        if (jobs) { note = null; submit(jobs, 'json'); } else revealError();
      }
    }
  });
  function clearErr(i, f) {
    const r = errs.rows.get(i); if (!r || !r[f]) return;
    delete r[f]; const row = el.querySelector('[data-row="' + i + '"]');
    const ctl = row && row.querySelector(f === 'priority' ? '.jpri' : '[data-f="' + ({ deadline_t: 'deadline', duration_min: 'duration' }[f] || f) + '"]');
    const box = ctl && (ctl.classList.contains('jf') ? ctl : ctl.closest('.jf'));
    if (box) { box.classList.remove('bad'); box.querySelectorAll('.jerr').forEach((x) => x.remove()); }
  }
  el.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('[data-json]')) { json = t.value; return; }
    const row = t.closest('[data-row]'); if (!row || !t.dataset.f) return;
    const i = +row.dataset.row, r = rows[i], f = t.dataset.f;
    if (f === 'duration') { r.duration = t.value; r.durTouched = true; clearErr(i, 'duration_min'); }
    if (f === 'deadline') {
      r.deadline = t.value; clearErr(i, 'deadline_t');
      const h = row.querySelector('[data-hint]'), v = hhmmToT(t.value), now = (st().clock && st().clock.t) || 0;
      if (h) h.textContent = deadlineHint(v, now);
    }
  });
  el.addEventListener('change', (e) => {
    const t = e.target, row = t.closest('[data-row]'); if (!row || !t.dataset.f) return;
    const i = +row.dataset.row, r = rows[i];
    if (t.dataset.f === 'type') {
      r.type = t.value; clearErr(i, 'type'); clearErr(i, 'implement');
      if (!r.durTouched) { r.duration = DEFAULT_MIN[r.type]; const d = row.querySelector('[data-f="duration"]'); if (d) d.value = r.duration; }
    }
    if (t.dataset.f === 'block') { r.block = t.value; clearErr(i, 'block'); }
    const lab = row.querySelector('.jlab'); if (lab) lab.textContent = jobLabel(r.type, r.block);
  });
  // ⌘/Ctrl+Enter submits from anywhere in the sheet
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); const b = el.querySelector('[data-submit]'); if (b) b.click(); } });

  function open() {
    sheets.close();
    if (!rows.length) reset();
    if (!json) json = exampleJson();
    render();
    el.classList.add('on');
  }
  if (btn) btn.onclick = (e) => { e.stopPropagation(); if (el.classList.contains('on')) el.classList.remove('on'); else open(); };

  return {
    open,
    sync(state) {
      if (el.classList.contains('on')) syncStatus();
      if (btn) {
        const c = state.clock || {}, over = !!(c.ended || (c.t != null && c.day_minutes != null && c.t >= c.day_minutes));
        btn.disabled = over;
        btn.title = over ? 'The workday is over (6:00 PM). New jobs can be planned tomorrow.' : 'Add jobs with a form or a JSON job list (POST /api/jobs)';
      }
    },
  };
}

// AI Supervisor panel: side-column card + expandable glass sheet. Reads state.ai (data layer) and calls
// api.aiReview / aiApprove / aiDismiss. Approvals are tracked per Operation (ops.track), like every mutation.
// The AI only proposes; the copy always says who decided ("AI Supervisor proposed, operator approved, ...").
import './aiPanel.css';
import { esc } from '../lib/format.js';

const GROUPS = [['plan', 'Plan'], ['implements', 'Implements'], ['plots', 'Plots']];
const ago = (iso) => {
  if (!iso) return null;
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const secs = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const signed = (n, unit = 'min') => (n == null ? null : `${n > 0 ? '+' : ''}${Math.round(n)} ${unit}`);

function statusLine(ai) {
  if (!ai) return { dot: 'off', text: 'Starting…' };
  const who = ai.label === 'rules' ? 'rules' : `${ai.model} via ${ai.provider}`;
  if (ai.status === 'offline') return { dot: 'off', text: ai.error || 'AI Supervisor offline' };
  if (ai.status === 'reviewing') return { dot: 'run', text: `Reviewing with ${who}…` };
  if (ai.status === 'previewing') return { dot: 'run', text: 'Checking re-plans with the planner…' };
  const last = ai.last_run_at ? `Last review ${ago(ai.last_run_at)} · ${secs(ai.latency_ms)}` : 'No review yet';
  return { dot: ai.status === 'error' ? 'off' : 'ok', text: ai.status === 'error' ? `Review failed: ${ai.error}` : last };
}

export function createAiPanel({ stage, store, api, ops, toast, sheets = null, focusBlock = null }) {
  // ---- side card (after the "Latest explanation" card)
  const side = document.querySelector('.side');
  const card = document.createElement('div');
  card.className = 'card aicard';
  card.innerHTML = '<div class="aihead"><p class="lbl">AI Supervisor</p><span class="aimodel"></span></div><div class="aistat"></div><div class="aicounts"></div><ul class="aitop"></ul>' +
    '<div class="aibtns"><button class="gbtn sm" data-review>Review now</button><button class="gbtn sm" data-open>Open</button></div>';
  const anchor = side && side.querySelector('.card');
  if (anchor && anchor.nextSibling) side.insertBefore(card, anchor.nextSibling); else if (side) side.appendChild(card);
  // ---- sheet
  const sheet = document.createElement('div');
  sheet.className = 'sheet gl aisheet';
  sheet.id = 'aisheet';
  stage.appendChild(sheet);
  let open = false, lastKey = '';

  const ai = () => (store.get() || {}).ai || null;
  function review(btn) {
    ops.track(api.aiReview(), { els: [btn] }).then((r) => { if (r) toast('AI Supervisor review started'); });
  }
  card.querySelector('[data-review]').addEventListener('click', (e) => review(e.currentTarget));
  card.querySelector('[data-open]').addEventListener('click', () => setOpen(!open));
  card.querySelector('.aitop').addEventListener('click', () => setOpen(true));

  function setOpen(v) {
    open = v;
    if (v && sheets && sheets.close) sheets.close();
    sheet.classList.toggle('on', v);
    card.querySelector('[data-open]').textContent = v ? 'Close' : 'Open';
    lastKey = ''; render();
  }

  sheet.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.x !== undefined) return setOpen(false);
    if (b.dataset.review !== undefined) return review(b);
    const id = b.dataset.id;
    if (b.dataset.approve !== undefined) {
      const f = ((ai() || {}).findings || []).find((x) => x.id === id);
      ops.track(api.aiApprove(id), { els: [b], okText: () => `${f ? f.label : 'AI proposal'}: applied. AI Supervisor proposed, operator approved, Safety check passed.` });
    }
    if (b.dataset.dismiss !== undefined) ops.track(api.aiDismiss(id), { els: [b] });
    if (b.dataset.block && focusBlock) focusBlock(b.dataset.block);
  });

  function previewHtml(f) {
    if (f.advisory) return '';
    if (f.preview_status === 'loading') return '<div class="aipv">Asking the planner what this change would do…</div>';
    if (f.preview_status === 'ready' && f.preview) {
      const p = f.preview;
      if (!p.allowed) return `<div class="aipv bad">Safety check would refuse it: ${esc(p.refused_reason || 'not allowed')}</div>`;
      const bits = [];
      if (p.moved.length) bits.push(`<li>${p.moved.length} job${p.moved.length === 1 ? '' : 's'} move: ${p.moved.slice(0, 4).map((m) => `${esc(m.label)} ${m.from ? esc(m.from) + ' → ' : '→ '}${esc(m.to)}`).join(', ')}${p.moved.length > 4 ? '…' : ''}</li>`);
      if (p.retimed.length) bits.push(`<li>${p.retimed.length} job${p.retimed.length === 1 ? '' : 's'} re-timed</li>`);
      bits.push(`<li>${p.deadlines_missed.length ? `Deadlines missed in that plan: ${p.deadlines_missed.map((d) => esc(d.label)).join(', ')}` : 'No deadline missed in that plan'}</li>`);
      const d = [signed(p.travel_delta_min) && `travel ${signed(p.travel_delta_min)}`, signed(p.idle_delta_min) && `idle ${signed(p.idle_delta_min)}`, p.late_jobs_delta != null && `late jobs ${signed(p.late_jobs_delta, '')}`].filter(Boolean);
      if (d.length) bits.push(`<li>${d.join(' · ')}</li>`);
      return `<div class="aipv"><b>Preview (nothing applied yet)</b><ul>${bits.join('')}</ul></div>`;
    }
    if (f.preview_note) return `<div class="aipv">${esc(f.preview_note)}</div>`;
    return '';
  }

  function findingHtml(f) {
    const busy = f.status === 'applying';
    const canApprove = !f.advisory && ['open', 'failed', 'stale'].includes(f.status) && !(f.preview && f.preview.allowed === false);
    let h = `<div class="aif${busy ? ' applying' : ''}"><div class="aift"><span class="sev ${f.severity}">${f.severity}</span><span>${esc(f.title)}</span></div>`;
    h += `<p class="aiw">${esc(f.why)}</p>`;
    if (f.advisory) h += `<div class="aia adv">${esc(f.advisory_reason === 'Not supported by this backend' ? 'Not supported by this backend: shown as advice only.' : f.advisory_reason || 'Advice only.')}</div>`;
    else if (f.label) h += `<div class="aia">Proposed: <b>${esc(f.label)}</b>${f.request ? ` <span style="opacity:.7">(${esc(f.request.method)} /api${esc(f.request.path)})</span>` : ''}</div>`;
    h += previewHtml(f);
    if (busy) h += `<p class="aiok">Operator approved. The optimizer is re-planning; the Safety Agent checks the result…${f.operation ? ` (${esc(f.operation.id)} ${esc(f.operation.status)})` : ''}</p>`;
    if (f.error) h += `<p class="aierr">${esc(f.error)}</p>`;
    h += '<div class="aifb">';
    if (f.action && f.action.block && focusBlock) h += `<button class="gbtn sm" data-block="${esc(f.action.block)}">Show Block ${esc(f.action.block)}</button>`;
    if (!busy) h += `<button class="gbtn sm" data-dismiss data-id="${esc(f.id)}">Dismiss</button>`;
    if (!f.advisory) h += `<button class="abtn${busy ? ' busy' : ''}" data-approve data-id="${esc(f.id)}"${canApprove && !busy ? '' : ' disabled'}>Approve</button>`;
    return h + '</div></div>';
  }

  // "Latest explanation" card: say who decided when that plan came from an approved AI proposal
  const expEl = document.getElementById('exp');
  const attr = document.createElement('p'); attr.className = 'tiny aiattr'; attr.style.display = 'none';
  if (expEl && expEl.parentNode) expEl.parentNode.insertBefore(attr, expEl.nextSibling);
  function attribution(s) {
    const x = (s.explanations || [])[0];
    const h = x && x.plan_version != null && ((s.ai && s.ai.history) || []).find((e) => e.status === 'applied' && e.plan_version === x.plan_version);
    const txt = h && !/AI Supervisor proposed/.test(x.text || '') ? `${h.label || h.title}: AI Supervisor proposed, operator approved, Safety check passed.` : '';
    if (attr.textContent !== txt) attr.textContent = txt;
    attr.style.display = txt ? '' : 'none';
  }

  function render() {
    const s = store.get() || {};
    attribution(s);
    const a = s.ai;
    const st = statusLine(a);
    const findings = (a && a.findings) || [];
    const key = JSON.stringify([open, a && a.status, a && a.last_run_at, a && a.error, findings.map((f) => [f.id, f.status, f.preview_status, f.error, f.updated_at, f.advisory]), a && a.history && a.history.length, Math.floor(Date.now() / 15000)]);
    if (key === lastKey) return;
    lastKey = key;
    // card
    const model = card.querySelector('.aimodel');
    model.textContent = a ? (a.label === 'rules' ? 'rules' : a.model) : '—';
    model.className = 'aimodel' + (!a || a.label === 'rules' ? ' rules' : '');
    model.title = a ? (a.label === 'rules' ? 'Rule-based reviewer (no model). Start ai-supervisor and add ?ai= for the LLM.' : `${a.model} via ${a.provider} · backend ${a.backend}`) : '';
    card.querySelector('.aistat').innerHTML = `<span class="aidot ${st.dot}"></span><span>${esc(st.text)}</span>`;
    const openF = findings.filter((f) => f.status !== 'dismissed');
    card.querySelector('.aicounts').innerHTML = GROUPS.map(([k, n]) => { const c = openF.filter((f) => f.reviewer === k).length; return `<span>${n} <b>${c}</b></span>`; }).join('');
    const top = openF.slice().sort((x, y) => ['high', 'medium', 'low'].indexOf(x.severity) - ['high', 'medium', 'low'].indexOf(y.severity)).slice(0, 3);
    card.querySelector('.aitop').innerHTML = top.length ? top.map((f) => `<li><span class="sev ${f.severity}">${f.severity}</span><span>${esc(f.title)}</span></li>`).join('') : `<li style="cursor:default;color:var(--muted)">${a && a.last_run_at ? 'Nothing to fix right now.' : 'Waiting for the first review.'}</li>`;
    if (!open) return;
    // sheet
    const caps = (a && a.capabilities) || {};
    const capTxt = Object.entries({ 'job edits': caps.patch_job, controls: caps.controls, preview: caps.preview, 'block exclusion': caps.block_disabled }).filter(([, v]) => v === false).map(([k]) => k);
    let h = `<div class="shead"><p>AI Supervisor</p><span style="display:flex;gap:6px"><button class="gbtn sm" data-review>Review now</button><button class="gbtn sm" data-x>Close</button></span></div>`;
    h += `<div class="aisub"><span class="aimodel${!a || a.label === 'rules' ? ' rules' : ''}">${esc(a ? (a.label === 'rules' ? 'rules (no model)' : `${a.model} via ${a.provider}`) : '—')}</span><span class="aistat" style="display:inline-flex"><span class="aidot ${st.dot}"></span>${esc(st.text)}</span></div>`;
    h += `<p class="aiempty" style="margin-top:-4px">The AI only proposes. You approve; the optimizer re-plans and the Safety Agent validates every change.${capTxt.length ? ` This backend does not support ${esc(capTxt.join(', '))}: those findings are advice only.` : ''}</p>`;
    for (const [k, n] of GROUPS) {
      const list = findings.filter((f) => f.reviewer === k);
      const rv = a && a.reviews && a.reviews[k];
      const meta = rv ? (rv.error ? `failed: ${rv.error}` : rv.cached ? 'image check cached' : rv.latency_ms ? secs(rv.latency_ms) : '') : '';
      h += `<h4><span>${n}</span><i>${esc(meta)}</i></h4>`;
      if (!list.length) h += `<p class="aiempty">${esc((rv && rv.note) || (rv && rv.summary) || (rv ? 'No issues found.' : 'Not reviewed yet.'))}</p>`;
      else h += list.map(findingHtml).join('');
    }
    const hist = (a && a.history) || [];
    if (hist.length) {
      h += '<h4><span>History</span></h4>';
      h += hist.slice(0, 12).map((x) => `<div class="aihist"><span class="k ${x.status}">${x.status}</span><b>${esc(x.label || x.title)}</b>${x.at ? ` <span style="color:#8e8e93">· ${esc(ago(x.at))}</span>` : ''}<p>${esc(x.outcome || '')}</p></div>`).join('');
    }
    sheet.innerHTML = h;
  }

  return {
    sync() { render(); },
    get open() { return open; },
    close() { if (open) setOpen(false); },
  };
}

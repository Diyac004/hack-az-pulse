// One widget per ControlType (ARCHITECTURE.md §3/§5), rendered from the schema only: nothing here knows about
// steering or sections. Widgets never change their own value: they show the REPORTED value (update()) and ask
// the owner to change it (onChange). A native input that moves under the finger (slider, select, text) is held
// "pending" until the owner calls update() with the server's answer, and snaps back on error.
import { esc } from '../lib/format.js';

/** Short labels in a run of toggles -> a row of section chips. */
export const isChipToggle = (c) => c.type === 'toggle' && String(c.label).length <= 3;

const fmtNum = (v, c) => {
  if (v == null || v === '') return '—';
  const n = +v; if (!isFinite(n)) return String(v);
  const dec = c.step != null && c.step < 1 ? Math.min(3, String(c.step).split('.')[1]?.length || 1) : 0;
  return n.toFixed(dec);
};
const unitTxt = (c) => (c.unit ? (c.unit === 'deg' ? '°' : ' ' + c.unit) : '');
const optLabel = (c, v) => { const o = (c.options || []).find((x) => x.value === v || (x.value == null && v == null)); return o ? o.label : v == null ? '—' : String(v); };
/** Map pick value -> short text. Accepts {lat,lon,x,y} or an array of them. */
export function pointText(v) {
  if (!v) return 'Not set';
  const pts = Array.isArray(v) ? v : [v];
  const one = (p) => (p && p.lat != null && p.lon != null ? (+p.lat).toFixed(5) + ', ' + (+p.lon).toFixed(5) : p && p.x != null ? 'cell ' + (+p.x).toFixed(1) + ', ' + (+p.y).toFixed(1) : '?');
  return pts.length === 2 ? 'A ' + one(pts[0]) + '  ·  B ' + one(pts[1]) : one(pts[0]);
}
export const pickCount = (c) => Math.max(1, Math.round(+c.min || 1));

/**
 * @param c        Control (§5)
 * @param handlers { onChange(control, value), onPick(control) }
 * @returns { el, id, control, update(value, st), revert(), focused() }
 *   st = { disabled: bool, reason: string|null, busy: bool }
 */
export function createWidget(c, { onChange, onPick }) {
  const el = document.createElement('div');
  el.className = 'cw cw-' + c.type; el.dataset.id = c.id;
  let value, st = { disabled: false, reason: null, busy: false }, pending = false;
  const help = c.help ? '<p class="cw-help">' + esc(c.help) + '</p>' : '';
  const send = (v) => { if (!st.disabled && !st.busy) onChange(c, v); };
  let paint = () => {};

  switch (c.type) {
    case 'button': {
      el.innerHTML = '<button type="button" class="cw-b"></button>';
      const b = el.firstChild; b.textContent = c.label; if (c.help) b.title = c.help;
      b.addEventListener('click', () => send(null));
      paint = () => { b.disabled = st.disabled; b.classList.toggle('busy', st.busy); };
      break;
    }
    case 'toggle': {
      if (isChipToggle(c)) {
        el.className += ' cw-chipw';
        el.innerHTML = '<button type="button" class="cw-chip" role="switch"></button>';
        const b = el.firstChild; b.textContent = c.label; b.title = c.help || c.label;
        b.addEventListener('click', () => send(!value));
        paint = () => { b.setAttribute('aria-checked', String(!!value)); b.disabled = st.disabled; b.classList.toggle('busy', st.busy); };
        break;
      }
      el.innerHTML = '<div class="cw-row"><label class="cw-l"></label><button type="button" class="cw-sw" role="switch"><i></i></button></div>' + help;
      const l = el.querySelector('.cw-l'), b = el.querySelector('.cw-sw');
      l.textContent = c.label; b.setAttribute('aria-label', c.label);
      b.addEventListener('click', () => send(!value));
      paint = () => { b.setAttribute('aria-checked', String(!!value)); b.disabled = st.disabled; b.classList.toggle('busy', st.busy); };
      break;
    }
    case 'slider': {
      el.innerHTML = '<div class="cw-row"><label class="cw-l"></label><output class="cw-o"></output></div><input type="range" class="cw-r">' +
        '<div class="cw-ends"><span></span><span></span></div>' + help;
      const l = el.querySelector('.cw-l'), o = el.querySelector('.cw-o'), r = el.querySelector('input');
      l.textContent = c.label; r.setAttribute('aria-label', c.label);
      r.min = c.min ?? 0; r.max = c.max ?? 100; r.step = c.step ?? 1;
      const ends = el.querySelectorAll('.cw-ends span'); ends[0].textContent = fmtNum(c.min, c) + unitTxt(c); ends[1].textContent = fmtNum(c.max, c) + unitTxt(c);
      const fill = () => { const p = ((+r.value - +r.min) / ((+r.max - +r.min) || 1)) * 100; r.style.setProperty('--p', p + '%'); };
      r.addEventListener('input', () => { o.textContent = fmtNum(r.value, c) + unitTxt(c); o.classList.add('draft'); fill(); });
      r.addEventListener('change', () => { if (+r.value === +value) { o.classList.remove('draft'); return; } pending = true; send(+r.value); });
      paint = () => {
        r.disabled = st.disabled; el.classList.toggle('busy', st.busy);
        if (pending || document.activeElement === r && r.matches(':active')) return;
        if (value != null) r.value = value; o.textContent = fmtNum(value, c) + unitTxt(c); o.classList.remove('draft'); fill();
      };
      break;
    }
    case 'number': {
      el.innerHTML = '<div class="cw-row"><label class="cw-l"></label><div class="cw-step"><button type="button" data-d="-1" aria-label="Decrease">' +
        '<svg viewBox="0 0 12 12"><path d="M2.5 6h7"/></svg></button><input type="text" inputmode="decimal" class="cw-n"><span class="cw-u"></span>' +
        '<button type="button" data-d="1" aria-label="Increase"><svg viewBox="0 0 12 12"><path d="M2.5 6h7M6 2.5v7"/></svg></button></div></div>' + help;
      const l = el.querySelector('.cw-l'), n = el.querySelector('input'), u = el.querySelector('.cw-u');
      l.textContent = c.label; n.setAttribute('aria-label', c.label); u.textContent = c.unit && c.unit !== 'deg' ? c.unit : c.unit === 'deg' ? '°' : '';
      const clamp = (v) => Math.max(c.min ?? -Infinity, Math.min(c.max ?? Infinity, v));
      const round = (v) => { const s = c.step || 1; return Math.round(v / s) * s; };
      el.querySelectorAll('.cw-step button').forEach((b) => b.addEventListener('click', () => {
        const base = isFinite(+value) ? +value : 0;
        const v = +clamp(round(base + (+b.dataset.d) * (c.step || 1))).toFixed(6);
        if (v !== +value) { pending = true; n.value = fmtNum(v, c); send(v); }
      }));
      const commit = () => {
        const v = parseFloat(String(n.value).replace(',', '.'));
        if (!isFinite(v) || v === +value) { n.value = fmtNum(value, c); return; }
        pending = true; send(v); // out-of-range values go to the server, which answers INVALID_INPUT in words
      };
      n.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); n.blur(); } if (e.key === 'Escape') { n.value = fmtNum(value, c); n.blur(); } });
      n.addEventListener('blur', commit);
      paint = () => {
        n.disabled = st.disabled; el.querySelectorAll('.cw-step button').forEach((b) => { b.disabled = st.disabled || st.busy; });
        el.classList.toggle('busy', st.busy);
        if (pending || document.activeElement === n) return;
        n.value = fmtNum(value, c);
      };
      break;
    }
    case 'select': {
      el.innerHTML = '<div class="cw-row"><label class="cw-l"></label><div class="cw-sel"></div></div>' + help;
      el.querySelector('.cw-l').textContent = c.label;
      const box = el.querySelector('.cw-sel');
      const opts = c.options || [];
      let mode = null;
      const build = () => {
        const multi = Array.isArray(value);
        const seg = multi || (opts.length <= 4 && opts.every((o) => String(o.label).length <= 14));
        const m = multi ? 'multi' : seg ? 'seg' : 'native';
        if (m === mode) return; mode = m; box.innerHTML = '';
        el.classList.toggle('cw-wide', m !== 'native' && (opts.length > 2 || opts.some((o) => String(o.label).length > 8)));
        if (m === 'native') {
          const s = document.createElement('select'); s.setAttribute('aria-label', c.label);
          opts.forEach((o, i) => { const op = document.createElement('option'); op.value = String(i); op.textContent = o.label; s.appendChild(op); });
          s.addEventListener('change', () => { const o = opts[+s.value]; pending = true; send(o ? o.value : null); });
          box.appendChild(s);
        } else {
          const g = document.createElement('div'); g.className = 'cw-seg' + (m === 'multi' ? ' multi' : ''); g.setAttribute('role', m === 'multi' ? 'group' : 'radiogroup'); g.setAttribute('aria-label', c.label);
          opts.forEach((o, i) => {
            const b = document.createElement('button'); b.type = 'button'; b.dataset.i = i; b.textContent = o.label;
            b.setAttribute('role', m === 'multi' ? 'checkbox' : 'radio');
            b.addEventListener('click', () => {
              if (m === 'multi') { const cur = Array.isArray(value) ? value : []; const has = cur.includes(o.value); send(has ? cur.filter((x) => x !== o.value) : [...cur, o.value]); }
              else if (o.value !== value) send(o.value);
            });
            g.appendChild(b);
          });
          box.appendChild(g);
        }
      };
      paint = () => {
        build(); el.classList.toggle('busy', st.busy);
        if (mode === 'native') {
          const s = box.firstChild; s.disabled = st.disabled || st.busy;
          if (!pending) { const i = opts.findIndex((o) => o.value === value || (o.value == null && value == null)); s.value = String(Math.max(0, i)); }
        } else box.querySelectorAll('button').forEach((b) => {
          const o = opts[+b.dataset.i]; const on = Array.isArray(value) ? value.includes(o.value) : o.value === value || (o.value == null && value == null);
          b.setAttribute('aria-checked', String(on)); b.classList.toggle('on', on); b.disabled = st.disabled || st.busy;
        });
      };
      break;
    }
    case 'map_pick': {
      const n = pickCount(c);
      el.innerHTML = '<button type="button" class="cw-pick"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="' + (n === 2 ? 'M4 16 16 4' : 'M10 17s-5-5.2-5-9a5 5 0 0 1 10 0c0 3.8-5 9-5 9z') + '"/>' +
        (n === 2 ? '<circle cx="4" cy="16" r="2.2"/><circle cx="16" cy="4" r="2.2"/>' : '<circle cx="10" cy="8" r="1.8"/>') + '</svg><span><b></b><small></small></span></button>' + help;
      const b = el.firstChild; b.querySelector('b').textContent = c.label;
      const sm = b.querySelector('small');
      b.addEventListener('click', () => { if (!st.disabled && !st.busy) onPick(c); });
      paint = () => { b.disabled = st.disabled; b.classList.toggle('busy', st.busy); sm.textContent = value ? pointText(value) : n === 2 ? 'Tap two points on the map' : 'Tap a spot on the map'; };
      break;
    }
    case 'text': {
      el.innerHTML = '<div class="cw-row"><label class="cw-l"></label><input type="text" class="cw-t" maxlength="40"></div>' + help;
      const l = el.querySelector('.cw-l'), t = el.querySelector('input'); l.textContent = c.label; t.setAttribute('aria-label', c.label);
      const commit = () => { const v = t.value.trim(); if (v === (value ?? '')) { t.value = value ?? ''; return; } pending = true; send(v); };
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); t.blur(); } if (e.key === 'Escape') { t.value = value ?? ''; t.blur(); } });
      t.addEventListener('blur', commit);
      paint = () => { t.disabled = st.disabled; el.classList.toggle('busy', st.busy); if (!pending && document.activeElement !== t) t.value = value ?? ''; };
      break;
    }
    default:
      el.innerHTML = '<p class="cw-help">' + esc(c.label) + ': unsupported control type "' + esc(c.type) + '"</p>';
  }

  // the reason a control is unavailable, one line under it (chips and button rows show it on the group instead)
  const why = document.createElement('p'); why.className = 'cw-why'; el.appendChild(why);

  return {
    el, id: c.id, control: c,
    /** Show the reported value. Clears the pending draft. */
    update(v, s = {}) {
      // a draft the operator just sent stays on screen while the request is in flight (no snap-back under latency)
      value = v; if (!s.busy) pending = false;
      st = { disabled: !!s.disabled, reason: s.reason || null, busy: !!s.busy };
      el.classList.toggle('dis', st.disabled);
      why.textContent = st.disabled && st.reason && !s.groupReason ? st.reason : '';
      paint();
    },
    /** Server said no: drop the draft and show the reported value again. */
    revert() { pending = false; paint(); },
    /** True while the operator is typing/dragging in it (skip re-render). */
    focused() { const a = document.activeElement; return !!a && el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT'); },
  };
}

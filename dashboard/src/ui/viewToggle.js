// "3D | Map" segmented control (glass, top-left of the stage). Internal ids: 'sim' = 3D, 'live' = Map.
import './livefeed.css';

export function createViewToggle(stage, onChange) {
  const el = document.createElement('div');
  el.id = 'viewseg'; el.className = 'gl'; el.setAttribute('role', 'radiogroup'); el.setAttribute('aria-label', 'View: 3D or Map');
  el.innerHTML = '<span class="thumb" aria-hidden="true"></span>' +
    '<button type="button" role="radio" data-v="sim" title="3D view of the farm">3D</button>' +
    '<button type="button" role="radio" data-v="live" title="Top-down map: real positions, coverage, guidance lines"><i class="lf-dot" aria-hidden="true"></i>Map</button>';
  stage.appendChild(el);
  const btns = [...el.querySelectorAll('button')];
  const thumb = el.querySelector('.thumb');
  let view = 'sim';

  function place() {
    const b = btns.find((x) => x.dataset.v === view);
    thumb.style.width = b.offsetWidth + 'px';
    thumb.style.transform = 'translateX(' + (b.offsetLeft - 3) + 'px)';
  }
  function set(v, fire) {
    if (v !== 'sim' && v !== 'live') return;
    const changed = v !== view; view = v;
    btns.forEach((b) => { const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
    el.classList.toggle('live', v === 'live');
    place();
    if (changed && fire) onChange(v);
  }
  // respond on press, not release
  el.addEventListener('pointerdown', (e) => { const b = e.target.closest('button'); if (b) { e.preventDefault(); set(b.dataset.v, true); } });
  el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && e.detail === 0) set(b.dataset.v, true); }); // keyboard Enter/Space
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); set(view === 'sim' ? 'live' : 'sim', true); btns.find((b) => b.dataset.v === view).focus(); }
  });
  window.addEventListener('resize', place);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
  requestAnimationFrame(() => set(view, false));
  set(view, false);
  return { set: (v) => set(v, false), get view() { return view; }, el };
}

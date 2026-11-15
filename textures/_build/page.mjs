// Builds ../index.html (self-contained, file:// friendly; images are sibling SVGs).
export function page({ stats, isoFrame, pal, houseStats: hs, sceneVb }) {
  const k = 48 / stats.A.tractorH; // px per svg unit so a tractor is ~48 px tall
  const isoH = Math.round(isoFrame[3] * k);
  const cols = [
    { key: 'current', name: 'Current', files: ['tractor-current.svg', 'tractor-current-side.svg', 'tractor-current-top.svg'] },
    { key: 'A', name: 'A · Modern cab' },
    { key: 'B', name: 'B · Autonomous orchard' },
    { key: 'C', name: 'C · Compact utility' },
  ].map((c) => ({ ...c, files: c.files || ['iso', 'side', 'top'].map((v) => `tractor-${c.key}-${v}.svg`) }));
  const views = ['3/4 view', 'Side', 'Top · Live feed'];

  const dirs = [
    {
      key: 'A', name: 'A · Modern cab tractor',
      what: 'Tapered hood with grille, headlights and side vents. Raked glass cab with dark pillars and one highlight. Fleet-coloured roof, hood and fenders over 16-sided treaded rear tyres with grey rims. Exhaust stack, amber beacon, front ballast, three-point hitch.',
      why: 'Keeps today’s silhouette, with the cab at the back and the roof in fleet colour, so the scene reads the same and only gets more believable. The roof and hood stay the largest colour areas from the tilted camera, so all eight colours hold at 48 px.',
      parts: 'Chassis, axle, ballast: Box. Hood: Box with the four front vertices moved in and down (taper). Cab base, roof: Box. Cab: Box with the top-front edge pulled back (raked glass), dark Phong with low shininess. Fenders: 5 thin lofted boxes per side, or one ExtrudeGeometry arc. Wheels: Cylinder 16 / 14 with every other side face darker for tread, plus a 3-ring CircleGeometry rim. Exhaust, beacon: Cylinder 8. Mirrors, hitch links: thin Box.',
    },
    {
      key: 'B', name: 'B · Autonomous orchard tractor',
      what: 'Low, cab-less, electric. One long body that rises toward the back, with a chamfered nose and full-width LED bar, a glass sensor deck, and a mast carrying a camera bar and a LiDAR puck. Low fenders, red e-stop, tail lights, hitch.',
      why: 'Tells the autonomy story at a glance, and the mast gives a distinct silhouette even top-down. Trade-offs: there is no exhaust, so the breakdown smoke rises from the deck, “fuel %” would read better as “energy %”, and less fleet colour shows from above because of the glass deck.',
      parts: 'Body and nose: two lofted Boxes. Deck glass, LED bar, e-stop: vertex-coloured quads. Mast, camera bar, camera pods: Box. LiDAR: three stacked Cylinder 14 (base, lit window, cap). Fenders: 4 lofted boxes per side. Wheels as in A.',
    },
    {
      key: 'C', name: 'C · Compact utility',
      what: 'Short hood, open operator station with seat and steering wheel, a two-post roll frame under a fleet-coloured canopy, flat fenders.',
      why: 'Sits between A and B: lighter and more “farm utility”. The open frame looks busy below about 60 px, and the canopy floating on thin posts reads less solidly than A’s cab.',
      parts: 'All Box and Cylinder: hood (tapered Box), deck, seat, seat-back, column, roll-frame posts, canopy, flat fenders, beacon, exhaust, wheels 16 / 14.',
    },
  ];

  const row = (k2, label) => {
    const s = stats[k2];
    return `<tr><th scope="row">${label}</th><td>${s.meshes}</td><td>${s.tris}</td><td>+${s.decalTris}</td><td>+${s.rimTris}</td><td>${s.total}</td><td>${s.lod}</td><td>${s.total * 5}</td></tr>`;
  };

  const hCols = [['current', 'Current shed'], ['A', 'A · Machine shed'], ['B', 'B · Fleet hub'], ['C', 'C · Container yard']];
  const hDirs = [
    { key: 'A', name: 'A · Modern machine shed',
      what: 'Low gable shed with a standing-seam charcoal roof, a solar array on the south slope, a wide roll-up door and a man door, a clerestory strip on the side, and a small glass-fronted office with a flat roof. A thin fleet-blue fascia runs under the eave and around the office roof. Concrete apron in front.',
      why: 'Reads instantly as “where the tractors live”: the roll-up door is the depot. The dark roof is the biggest shape from the tilted camera, so it anchors the corner without fighting the orchard greens or the fleet colours; solar adds the modern note. Matches tractor A’s diesel and mechanic story.',
      parts: 'Walls, office, apron, fascia: Box. Gable ends: one Box with the top edge collapsed to the ridge. Roof: two thin sloped Boxes. Seams, solar, door slats, glass: vertex-coloured quads. Downpipe: Cylinder 6.' },
    { key: 'B', name: 'B · Autonomous fleet hub',
      what: 'A solar canopy on six posts over two marked bays with charging pedestals (screen and green status light) and cables, plus a small glass-banded control building with a comms mast and amber lamp. Fleet-blue fascia on the canopy and the building, blue bay markings on the apron.',
      why: 'Tells the autonomy story best and has the boldest top-down silhouette (one big solar rectangle). Trade-off: charging bays suggest electric tractors, which conflicts with tractor A’s exhaust, the fuel percentage and the breakdown smoke. The open canopy also hides the bays from the default camera.',
      parts: 'Pad, posts, canopy, chargers, building: Box. Cables: thin Box beams. Mast top: Cylinder 10, lamp: Cylinder 6. Solar grid, bay lines, screens: vertex-coloured quads.' },
    { key: 'C', name: 'C · Container yard',
      what: 'A fleet-colour shipping container as the workshop, an office container stacked on top with stairs and a landing, a lean-to shade roof on posts, and a fuel tank on saddles with a pump.',
      why: 'Utilitarian and characterful, and the one where the fleet colour is largest. It is the busiest at scene size: the lean-to hides the stairs and the tank reads as a white blob below about 60 px.',
      parts: 'Containers, posts, saddles, pump, landing: Box. Stairs, rail: Box beams. Lean-to: sloped Box. Tank: Cylinder 12 with one end disc. Corrugation, doors, glass: vertex-coloured quads.' },
  ];
  const sceneW = Math.round(sceneVb[2] * k);
  const hrow = (key, label) => { const s = hs[key]; return `<tr><th scope="row">${label}</th><td>${s.meshes}</td><td>${s.tris}</td><td>+${s.decalTris}</td><td>${s.total}</td><td>${s.w} × ${s.d} × ${s.h}</td></tr>`; };

  const img = (src, alt, h) => `<img src="${src}" alt="${alt}"${h ? ` style="height:${h}px"` : ''} loading="lazy">`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tractor Concepts</title>
<meta name="description" content="Harvest Fleet AI tractor redesign: current box tractor against three directions, in 3/4, side and top views, all eight fleet colours, at full and in-scene size.">
<style>
:root{
  --bg:#F5F5F7; --surface:#FFFFFF; --ink:#1D1D1F; --muted:#6E6E73; --line:rgba(0,0,0,.08);
  --diorama:linear-gradient(160deg,#EEF2E2 0%,#E6E9D2 45%,#EFE6D2 100%);
  --night:linear-gradient(160deg,#25262A 0%,#1C1C1E 100%);
  --accent:#0A84FF; --radius:18px;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#000; --surface:#1C1C1E; --ink:#F5F5F7; --muted:#98989D; --line:rgba(255,255,255,.1); color-scheme:dark;
}}
:root[data-theme="dark"]{--bg:#000; --surface:#1C1C1E; --ink:#F5F5F7; --muted:#98989D; --line:rgba(255,255,255,.1); color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
::selection{background:color-mix(in srgb,var(--accent) 28%,transparent)}
main{max-width:1240px;margin:0 auto;padding:56px 24px 96px}
h1{font-size:clamp(32px,5vw,48px);line-height:1.05;letter-spacing:-.025em;font-weight:700;margin:0 0 12px}
h2{font-size:24px;line-height:1.15;letter-spacing:-.015em;font-weight:650;margin:72px 0 6px}
h3{font-size:17px;letter-spacing:-.01em;font-weight:600;margin:0 0 6px}
p{margin:0 0 10px;max-width:72ch}
.lede{font-size:17px;color:var(--muted);max-width:68ch}
.sub{color:var(--muted);margin-bottom:20px}
.bar{display:flex;align-items:end;justify-content:space-between;gap:16px;flex-wrap:wrap}
.seg{display:inline-flex;padding:2px;border-radius:9px;background:var(--line);margin-bottom:20px}
.seg button{font:inherit;font-size:13px;font-weight:500;border:0;background:transparent;color:var(--ink);padding:5px 14px;border-radius:7px;cursor:pointer}
.seg button[aria-pressed="true"]{background:var(--surface);box-shadow:0 1px 3px rgba(0,0,0,.12),0 0 0 .5px rgba(0,0,0,.06)}
.seg button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.stage{border-radius:var(--radius);background:var(--diorama);color:#1D1D1F;transition:background .3s ease;overflow:hidden}
.stage[data-bg="dark"]{background:var(--night);color:#F5F5F7}
.stage[data-bg="dark"] .lbl{color:#C7C7CC}
.cmp{display:grid;grid-template-columns:110px repeat(4,minmax(0,1fr));gap:0}
.cmp .h{padding:18px 12px 4px;font-weight:600;font-size:14px;letter-spacing:-.01em}
.stage[data-bg="dark"] .h{color:#F5F5F7}
.cmp .v{padding:12px;display:flex;align-items:center;font-size:12px;color:#6E6E73}
.stage[data-bg="dark"] .v{color:#98989D}
.cmp .c{padding:10px;display:flex;align-items:center;justify-content:center;border-top:1px solid rgba(0,0,0,.05)}
.stage[data-bg="dark"] .c{border-color:rgba(255,255,255,.06)}
.cmp img{width:100%;height:auto;max-height:260px;object-fit:contain}
.cmp .c.cur img{opacity:.92}
.scene{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.scene .stage{padding:28px 24px}
.minis{display:flex;flex-wrap:wrap;gap:20px 28px;align-items:end}
.minis figure{margin:0;text-align:center}
.lbl{display:block;font-size:11px;color:#6E6E73;margin-top:4px;font-variant-numeric:tabular-nums}
.sheets{display:flex;flex-direction:column;gap:14px;margin-top:22px}
.sheets img{display:block;max-width:100%}
.pal .stage{padding:20px}
.pal img{width:100%;height:auto;display:block}
.pal figcaption{margin:10px 2px 28px;color:var(--muted);font-size:13px}
.dirs{display:grid;gap:0;border-top:1px solid var(--line)}
.dir{display:grid;grid-template-columns:220px 1fr;gap:28px;padding:28px 0;border-bottom:1px solid var(--line)}
.dir img{width:100%;height:auto}
.dir .k{font-size:12px;font-weight:600;color:var(--muted);margin:14px 0 2px}
.dir p{font-size:14px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:14px;margin-top:8px}
th,td{text-align:right;padding:9px 12px;border-bottom:1px solid var(--line)}
th:first-child,td:first-child{text-align:left}
thead th{font-size:12px;font-weight:600;color:var(--muted)}
tbody th{font-weight:600}
.note{font-size:13px;color:var(--muted);margin-top:12px;max-width:80ch}
.rec{margin-top:16px;padding:22px 24px;border-radius:var(--radius);background:var(--surface);box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 28px rgba(0,0,0,.06)}
.rec p{font-size:15px}
.wrap{overflow-x:auto}
@media (max-width:860px){
  main{padding:36px 16px 72px}
  .cmp{grid-template-columns:64px repeat(4,minmax(120px,1fr));min-width:600px}
  .scene{grid-template-columns:1fr}
  .dir{grid-template-columns:1fr;gap:12px}
  .dir figure{max-width:260px}
}
@media (prefers-reduced-motion:reduce){.stage{transition:none}}
</style>
</head>
<body>
<main>
<h1>Tractor concepts</h1>
<p class="lede">Today’s box tractor next to three directions with a hint of realism. Every drawing is an orthographic, flat-shaded projection of the same low-poly part list the three.js scene would build, so proportions, light from the top left and triangle counts carry straight over.</p>

<div class="bar"><h2 id="compare">Side by side</h2>
<div class="seg" role="group" aria-label="Background"><button type="button" data-bg="light" aria-pressed="true">Diorama</button><button type="button" data-bg="dark" aria-pressed="false">Dark</button></div></div>
<p class="sub">Same scale in every column. The top view points the nose up and marks the hitch point for the Live feed implement bar.</p>
<div class="wrap"><div class="stage" data-switch>
<div class="cmp">
<div></div>${cols.map((c) => `<div class="h">${c.name}</div>`).join('')}
${views.map((v, i) => `<div class="v">${v}</div>${cols.map((c) => `<div class="c${c.key === 'current' ? ' cur' : ''}">${img(c.files[i], `${c.name}, ${v}`)}</div>`).join('')}`).join('\n')}
</div></div></div>

<h2 id="scene">At scene size</h2>
<p class="sub">Tractor about 48 px tall, the size the orbit camera shows it. Current, A, B and C, then each direction’s fleet sheet at the same scale.</p>
<div class="scene">
${['light', 'dark'].map((bg) => `<div class="stage" data-bg="${bg}">
<div class="minis">${cols.map((c) => `<figure>${img(c.files[0], c.name, isoH)}<span class="lbl">${c.key === 'current' ? 'Current' : c.key}</span></figure>`).join('')}</div>
<div class="sheets">${['A', 'B', 'C'].map((key) => `<img src="tractor-palette-${key}.svg" alt="Direction ${key} in all fleet colours at scene size" style="width:${Math.round(pal[key].w * k)}px;height:auto" loading="lazy">`).join('')}</div>
</div>`).join('\n')}
</div>

<div class="bar"><h2 id="palettes">Fleet colours and states</h2>
<div class="seg" role="group" aria-label="Background"><button type="button" data-bg="light" aria-pressed="true">Diorama</button><button type="button" data-bg="dark" aria-pressed="false">Dark</button></div></div>
<p class="sub">T1 to T8, then T1 broken (pulsing red ring, smoke) and T3 working with a sprayer on the hitch. Colour sits only on body panels; tyres, glass and chassis stay neutral.</p>
<div class="pal">${['A', 'B', 'C'].map((key) => `<figure style="margin:0"><div class="stage" data-switch>${img(`tractor-palette-${key}.svg`, `Direction ${key} palette sheet`)}</div><figcaption>${dirs.find((d) => d.key === key).name}</figcaption></figure>`).join('')}</div>

<h2 id="directions">Directions</h2>
<p class="sub">What changes, why, and how each one maps to three.js r128 geometry.</p>
<div class="dirs">
${dirs.map((d) => `<article class="dir"><figure style="margin:0">${img(`tractor-${d.key}-iso.svg`, d.name)}</figure><div>
<h3>${d.name}</h3>
<p class="k">What changes</p><p>${d.what}</p>
<p class="k">Why</p><p>${d.why}</p>
<p class="k">Three.js parts</p><p>${d.parts}</p>
<p class="k">Budget</p><p>${stats[d.key].meshes} meshes and ${stats[d.key].tris} triangles of solid geometry. Add ${stats[d.key].decals} panel decals (grille, lights, vents, glass highlights; ${stats[d.key].decalTris} triangles as vertex-coloured quads) and the grey rim and hub discs (${stats[d.key].rimTris} triangles, three CircleGeometry rings per outer wheel face) for <b>${stats[d.key].total} triangles as drawn</b>. Estimated LOD for 50+: ${stats[d.key].lod} (not rendered here).</p>
</div></article>`).join('\n')}
</div>

<h2 id="budget">Triangle budget</h2>
<div class="wrap"><table>
<thead><tr><th>Tractor</th><th>Meshes</th><th>Solid</th><th>Panel decals</th><th>Rim discs</th><th>As drawn</th><th>LOD est.</th><th>Fleet of 5</th></tr></thead>
<tbody>${row('current', 'Current')}${row('A', 'A · Modern cab')}${row('B', 'B · Autonomous')}${row('C', 'C · Compact')}</tbody>
</table></div>
<p class="note">The status ring is not counted (RingGeometry, 80 triangles). As drawn, all three directions exceed 600 triangles per tractor; only C comes close. Read literally, “under 600 for five tractors” means about 120 per tractor, which even today’s ${stats.current.tris}-triangle tractor misses. The table therefore reports per-tractor counts, and the target needs a decision. The LOD estimate uses 10 / 8-sided wheels, one rim disc plus a hub disc, 3 fender segments and no panel decals; it lands near 500 to 600. A trims further with 12 / 10-sided wheels and an 8-sided beacon. For 50+ tractors, merge each design into two geometries: fleet-coloured panels (an InstancedMesh with <code>instanceColor</code>) and neutral parts with vertex colours (a second InstancedMesh). Add a third only if the wheels need to spin. That is two or three draw calls for the whole fleet. Footprint: A is about 1.1 long including the hitch (0.98 without), against today’s 0.8, so the ballast and hitch reach the ring’s inner edge; check lane spacing. New designs use a thinner ring (0.62 to 0.72) than today’s (0.62 to 0.76), which flatters them slightly at 48 px.</p>

<h2 id="recommendation">Recommendation</h2>
<div class="rec">
<p><b>Go with A, the modern cab tractor.</b> It keeps the silhouette people already know from the scene, puts the most fleet colour where the tilted camera looks (roof, hood, fenders), and stays readable in all eight colours at 48 px. Its exhaust stack gives the breakdown smoke a natural source, and it fits the fuel and mechanic story.</p>
<p style="margin:0;color:var(--muted)">If the pitch leans into autonomy, B’s mast and LiDAR puck can bolt onto A’s roof as an optional “autonomy kit” (about 200 extra triangles) without changing the base model.</p>
</div>

<h2 id="house">House: the depot</h2>
<p class="sub">Step 1, concepts only (not built in 3D yet). Same method as the tractors: each direction is a low-poly part list in scene units, projected with the same light and tones, so sizes and triangle counts carry straight over. The depot sits in the free strip between the depot road and block E (about 4.2 × 2.0 cells); every direction fits inside 3.4 × 1.6.</p>
<div class="bar"><h3 style="margin:24px 0 0">Side by side</h3>
<div class="seg" role="group" aria-label="Background"><button type="button" data-bg="light" aria-pressed="true">Diorama</button><button type="button" data-bg="dark" aria-pressed="false">Dark</button></div></div>
<p class="sub">Same scale in every column; the front (door side) faces the default camera.</p>
<div class="wrap"><div class="stage" data-switch>
<div class="cmp">
<div></div>${hCols.map(([, n]) => `<div class="h">${n}</div>`).join('')}
${['iso', 'side', 'top'].map((v, i) => `<div class="v">${["3/4 view", "Side", "Top"][i]}</div>${hCols.map(([key, n]) => `<div class="c${key === 'current' ? ' cur' : ''}">${img(`house-${key}-${v}.svg`, `${n}, ${["3/4 view", "Side", "Top"][i]}`)}</div>`).join('')}`).join('\n')}
</div></div></div>

<h3 style="margin:40px 0 6px">At scene size, next to tractor A</h3>
<p class="sub">Same pixels per unit as the tractor sheets above, tractor A at its scene scale (0.85) parked by the door.</p>
<div class="scene">
${['light', 'dark'].map((bg) => `<div class="stage" data-bg="${bg}"><div class="minis">${hCols.map(([key, n]) => `<figure>${img(`house-${key}-scene.svg`, `${n} with tractor A, scene size`)}<span class="lbl">${key === 'current' ? 'Current' : key} · ${hs[key].total} tris</span></figure>`).join('')}</div></div>`).join('\n')}
</div>
<style>.scene .minis img[src^="house-"]{width:${sceneW}px;height:auto}</style>

<h3 style="margin:40px 0 6px">Directions</h3>
<div class="dirs">
${hDirs.map((d) => `<article class="dir"><figure style="margin:0">${img(`house-${d.key}-iso.svg`, d.name)}</figure><div>
<h3>${d.name}</h3>
<p class="k">What changes</p><p>${d.what}</p>
<p class="k">Why</p><p>${d.why}</p>
<p class="k">Three.js parts</p><p>${d.parts}</p>
<p class="k">Budget</p><p>${hs[d.key].meshes} parts and ${hs[d.key].tris} triangles of solid geometry, plus ${hs[d.key].decals} panel decals (${hs[d.key].decalTris} triangles) for <b>${hs[d.key].total} triangles as drawn</b>. Footprint ${hs[d.key].w} × ${hs[d.key].d}, ${hs[d.key].h} tall.</p>
</div></article>`).join('\n')}
</div>
<div class="wrap"><table>
<thead><tr><th>House</th><th>Parts</th><th>Solid</th><th>Panel decals</th><th>As drawn</th><th>W × D × H</th></tr></thead>
<tbody>${hrow('current', 'Current shed')}${hrow('A', 'A · Machine shed')}${hrow('B', 'B · Fleet hub')}${hrow('C', 'C · Container yard')}</tbody>
</table></div>
<p class="note">The house is static, so in three.js it bakes into one vertex-coloured geometry (one draw call, one shadow caster), with the fleet-blue fascia as a fixed vertex colour. All three directions stay under 300 triangles, about a third of one tractor.</p>
<div class="rec">
<p><b>Go with A, the modern machine shed.</b> The roll-up door says “depot” at a glance, the dark solar roof anchors the corner from the tilted camera without competing with the fleet colours, and it fits tractor A’s diesel, fuel and mechanic story.</p>
<p style="margin:0;color:var(--muted)">If the pitch leans into autonomy, borrow two details from B for A’s apron: the comms mast with its amber lamp and the painted bay lines. Both are cheap (about 40 triangles) and keep A’s silhouette.</p>
</div>
</main>
<script>
document.querySelectorAll('.seg').forEach(function(seg){
  var stage=seg.closest('.bar').nextElementSibling.nextElementSibling;
  var targets=stage.matches('[data-switch]')?[stage]:Array.prototype.slice.call(stage.querySelectorAll('[data-switch]'));
  seg.addEventListener('click',function(e){
    var b=e.target.closest('button');if(!b)return;
    seg.querySelectorAll('button').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));});
    targets.forEach(function(t){t.setAttribute('data-bg',b.dataset.bg);});
  });
});
</script>
</body>
</html>
`;
}

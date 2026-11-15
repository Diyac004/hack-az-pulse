// Builds ../index.html (self-contained, file:// friendly; images are sibling SVGs).
export function page({ stats, isoFrame, pal, houseStats: hs, sceneVb, orchardStats: os, orchardFrames: of, hubInfo: hi, decideFrames: df, layoutInfo: li }) {
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

  const hCols = [['current', 'Current shed'], ['A', 'A · Machine shed'], ['B', 'B · Fleet hub (built)'], ['C', 'C · Container yard']];
  const hDirs = [
    { key: 'A', name: 'A · Modern machine shed',
      what: 'Low gable shed with a standing-seam charcoal roof, a solar array on the south slope, a wide roll-up door and a man door, a clerestory strip on the side, and a small glass-fronted office with a flat roof. A thin fleet-blue fascia runs under the eave and around the office roof. Concrete apron in front.',
      why: 'Reads instantly as “where the tractors live”: the roll-up door is the depot. The dark roof is the biggest shape from the tilted camera, so it anchors the corner without fighting the orchard greens or the fleet colours; solar adds the modern note. Matches tractor A’s diesel and mechanic story.',
      parts: 'Walls, office, apron, fascia: Box. Gable ends: one Box with the top edge collapsed to the ridge. Roof: two thin sloped Boxes. Seams, solar, door slats, glass: vertex-coloured quads. Downpipe: Cylinder 6.' },
    { key: 'B', name: 'B · Fleet hub (built)',
      what: 'A solar canopy on six posts over two marked bays: a REFUEL bay (fuel pump with price display, amber band and hose, amber bay stripes and fascia sign) and a SERVICE bay (red tool chest, air/oil hose reel, grey stripes and sign). A small glass-banded control building with a comms mast and amber lamp; fleet-blue fascia. Updated to match the 3D build in dashboard/src/scene/depotHub.js; the first concept had EV chargers.',
      why: 'The boldest top-down silhouette (one big solar rectangle) and, with refuel and service bays, it fits tractor A’s diesel, fuel percentage and mechanic story. The open canopy hides the bays from the default camera, so the bay-entry stripes on the front apron carry them.',
      parts: 'Pad, posts, canopy, pump, tool chest, building: Box. Hose: thin Box beam. Reel: Cylinder 8. Mast top: Cylinder 10, lamp: Cylinder 6. Solar grid, bay lines, signs, display: vertex-coloured quads. Built as one merged vertex-coloured geometry (1 draw).' },
    { key: 'C', name: 'C · Container yard',
      what: 'A fleet-colour shipping container as the workshop, an office container stacked on top with stairs and a landing, a lean-to shade roof on posts, and a fuel tank on saddles with a pump.',
      why: 'Utilitarian and characterful, and the one where the fleet colour is largest. It is the busiest at scene size: the lean-to hides the stairs and the tank reads as a white blob below about 60 px.',
      parts: 'Containers, posts, saddles, pump, landing: Box. Stairs, rail: Box beams. Lean-to: sloped Box. Tank: Cylinder 12 with one end disc. Corrugation, doors, glass: vertex-coloured quads.' },
  ];
  const sceneW = Math.round(sceneVb[2] * k);
  const hrow = (key, label) => { const s = hs[key]; return `<tr><th scope="row">${label}</th><td>${s.meshes}</td><td>${s.tris}</td><td>+${s.decalTris}</td><td>${s.total}</td><td>${s.w} × ${s.d} × ${s.h}</td></tr>`; };

  const tCols = [['current', 'Current'], ['A', 'A · Refined citrus'], ['B', 'B · Orchard rows'], ['C', 'C · Soft minimal']];
  const tViews = [['iso', '3/4 view'], ['side', 'Side'], ['top', 'Top']];
  const score = { current: [1, 3], A: [5, 3], A12: [4, 3], B: [4, 5], C: [2, 4] };
  const dots = (n) => `<span class="dots" aria-label="${n} of 5">${'●'.repeat(n)}<span>${'●'.repeat(5 - n)}</span></span>`;
  const fmt = (n) => n.toLocaleString('en-US');
  const blockW = Math.round(of.block[2] * k), mapW = Math.round(of.map[2] * k);
  const tDirs = [
    { key: 'A', name: 'A · Refined citrus',
      what: 'Real citrus proportions at one row pitch = 6.5 m: short bark-grey trunk, skirt pruned to 0.06 (about 40 cm), a dense dome 0.6 tall and 0.44 across the row with two offset shoulder lobes. Leaves are deep glossy green with lighter new-growth flush on the upward faces and a darker interior underneath. Fruit hangs in the outer, lower-middle band: none below ripeness 0.5, a few (3) at colour-break yellow-orange up to 0.7, heavy (9) full orange above (lemon blocks would use #EDD23A). Fruit is drawn at radius 0.03, about 5× real size, because real 8 cm fruit would be under a pixel at scene size. 6 trees per row at 4 m spacing (18 per block), with slight seeded scale, rotation and tint variation and one young replant. The ground is an Arizona grove: bare tilled berms under the rows, a darker wet strip and the drip line along each row, mowed grass middles striped along the work direction, tyre tracks in every lane, soft contact AO and edge tufts.',
      why: 'The most believable of the set and the closest match to tractor A’s level of detail. The canopy is kept narrow (0.44 across the row) because tractor A is oversized (0.6 wide; a real one would be 0.34): it still brushes the canopies on both sides of its 0.56 alley, which reads as real orchard work. Trade-off: the busiest silhouette. From the tilted camera the row in front hides part of the tractor and the coverage under it; the Map view and the alleys carry that.',
      parts: 'Canopy: IcosahedronGeometry(1, 0) non-indexed with per-face vertex colours (flush, mid, interior), drawn as ONE InstancedMesh with 3 instances per tree (dome and two shoulders) and instanceColor for the per-tree tint. Trunk: Cylinder 5 InstancedMesh. Fruit: OctahedronGeometry InstancedMesh. AO: Circle 10 with a radial alpha texture, InstancedMesh, or baked into the ground texture. Ground: one shared CanvasTexture on the existing grass planes (stripes, berms, wet strip, drip line, tracks). Tufts: one merged static mesh. Note: the SVGs mottle every lobe differently; one shared instanced geometry repeats the same face pattern, with only instanceColor and rotation varying. 18 trees per block also means farm.js stops placing one tree per cell; the layout loop has to use the row/in-row spacing instead.' },
    { key: 'B', name: 'B · Orchard rows',
      what: 'Modern high-density hedgerow: each row is one continuous machine-hedged canopy (an 8-sided prism per cell, with two low top humps), skirted, with trunks just peeking out underneath. Drive alleys sit exactly on the tractor’s E–W sweep lanes, with bare twin tram lines, tilled berms, a drip line just outside the skirt, and white-tagged row-end posts. Fruit sits on the hedge faces.',
      why: 'The most readable. The lanes are the plot, so coverage bands and AB lines line up with what you see, and the rows read even top-down. Mechanically hedged rows are common in commercial citrus, so it is real, but it is less iconic as “citrus tree”, and the long flat faces look more architectural than A’s domes.',
      parts: 'Hedge: one 8-sided prism (ExtrudeGeometry, or a 28-triangle BufferGeometry) per cell, InstancedMesh. Top humps: IcosahedronGeometry(1, 0), InstancedMesh with 2 per cell. Trunks: Cylinder 5, optional (mostly hidden; dropping them saves 3,840 triangles). Posts and tags: Box, one merged static mesh. AO: one Plane per cell. Ground: one shared CanvasTexture.' },
    { key: 'C', name: 'C · Soft minimal',
      what: 'One rounded blob per tree (IcosahedronGeometry detail 1) in a single calm sage tone with a light cap, a stub trunk, a soft contact disc, a pale grass with faint lane stripes and a muted soil frame. Fruit appears only on ripe blocks, as two soft dots per tree.',
      why: 'The calmest and most UI-like. Fleet colours, coverage and the AB line pop the most against the pale ground. It is the least realistic, and the uniform blobs read as “trees” rather than “citrus”, so it moves away from the realism direction set for tractor A.',
      parts: 'Canopy: IcosahedronGeometry(1, 1) InstancedMesh (or detail 0 with smooth normals for 20 triangles). Trunk stub: Cylinder 5. AO: Circle 16, alpha texture. Ground: the existing flat material plus a small stripe texture.' },
  ];
  const orow = (key) => { const o = os[key]; return `<tr><th scope="row">${o.label}</th><td>${o.n}</td><td>${o.perTree}</td><td>${fmt(o.trees)}</td><td>${fmt(o.fruitTris)} <span class="mut">(${o.fruitN})</span></td><td>${fmt(o.statics)}</td><td><b>${fmt(o.total)}</b></td><td>${fmt(o.worst)}</td><td>${o.draws} + 9</td><td>${o.shadowDraws}</td><td>${dots(score[key][0])}</td><td>${dots(score[key][1])}</td></tr>`; };

  const f2 = (n) => (Math.round(n * 100) / 100).toString();
  const hubRows = ['a', 'b', 'c'].map((o) => { const h = hi[o]; return `<tr><th scope="row">${o} · ${h.label}</th><td>${f2(h.sw)} × ${f2(h.sw)} × ${f2(h.sz)}</td><td>${f2(h.stripDepth)}</td><td>${f2(h.canopyH)}</td><td>${h.overhang > 0 ? f2(h.overhang) + ' into road 6' : 'none'}</td><td>${o === 'c' ? 'Block A moves one row north' : 'none'}</td></tr>`; }).join('');
  const layCap = {
    a: 'E–H sat one row lower than the middle: two empty rows above them and one below, so the bottom tier looks pushed down. Same 3-row size as A–D. The deeper strip south of road 6 (2.02) gives the Fleet hub full size, but on the south side it turns its back to the camera.',
    b: 'E–H start one row higher and grow to 4 rows, so there is exactly one empty row above and below, like A–D, and everything stays on whole cells. Cost: E–H are a third bigger than A–D (4 tree rows instead of 3), and the hub has to squeeze into the 1.02-deep strip north of road 6 (depth squashed to 0.6).',
    c: 'E–H stay 3 rows like A–D and move half a row up, so they are centred with 1.5 empty rows on each side. But their edges land in the middle of cells 8 and 11, and the tree rows land on cell lines, so anything that works in whole cells (blocked cells, block-by-cell lookups, labels, A* paths) no longer lines up with the trees. Hub: 1.52-deep strip south of road 6, scale 0.93, back to the camera.',
  };
  const decisions = () => `
<h2 id="decisions" style="margin-top:48px">Decisions</h2>
<p class="sub">Four side-by-side comparisons, each with a one-line recommendation. Same renderer, light and scale as everything below.</p>

<div class="bar"><h3 style="margin:24px 0 0">1 · Trees &amp; plots A + B’s touches</h3>
<div class="seg" role="group" aria-label="Background"><button type="button" data-bg="light" aria-pressed="true">Diorama</button><button type="button" data-bg="dark" aria-pressed="false">Dark</button></div></div>
<p class="sub">Left: plain A (refined citrus, realistic ground). Right: A with B’s bare twin tram lines in every drive lane (replacing A’s grass tyre tracks) and white-tagged row-end posts (row ends pulled in 0.05 so the posts stand clear).</p>
<div class="stage" data-switch>
<div class="grid2">${img('plots-A-block.svg', 'Plain A, block sample')}${img('plots-AB-block.svg', 'A + B touches, block sample')}</div>
<div class="grid2">${[['plots-A-map.svg', 'Plain A · Map view'], ['plots-AB-map.svg', 'A + B touches · Map view']].map(([f, n]) => `<figure>${img(f, n)}<figcaption>${n}</figcaption></figure>`).join('')}</div>
<div class="states">${[['plots-A-states.svg', 'Plain A · normal, ripe, heat'], ['plots-AB-states.svg', 'A + B touches · normal, ripe, heat']].map(([f, n]) => `<figure>${img(f, n)}<figcaption>${n}</figcaption></figure>`).join('')}</div>
</div>
<p class="note"><b>Readability:</b> the tram lines turn every sweep lane into two dark parallel stripes running the full block length, so the lanes, and therefore where coverage will paint next, read from both the tilted camera and the Map. Plain A’s tracks fade into the grass at scene size. The posts mark the row ends and help count rows, but they are dots on the Map. Coverage and AB stay on top and are unaffected. Cost: ${fmt(os.AB.total)} vs ${fmt(os.A.total)} triangles for 8 blocks; the posts merge into the same static mesh as the tufts, so no extra draw.</p>
<p class="rec"><b>Recommendation:</b> take A + B’s touches; the tram lines are the biggest readability gain for zero draws.</p>

<div class="bar"><h3 style="margin:40px 0 0">2 · AB line: today vs dark edge</h3>
<div class="seg" role="group" aria-label="Background"><button type="button" data-bg="light" aria-pressed="true">Diorama</button><button type="button" data-bg="dark" aria-pressed="false">Dark</button></div></div>
<p class="sub">The A + B block with tractor A on lane 2 and coverage painted behind it. Top row: the worst case (ripe grass, yellow coverage). Bottom row: a normal block with blue coverage. In each sheet, left is today’s line (0.05 wide, fleet colour mixed 45% with white) and right adds a 0.09-wide #1C1C1E underlay at 0.55.</p>
<div class="stage" data-switch><div class="grid2">${[['decide-abline-iso.svg', '3/4 view'], ['decide-abline-map.svg', 'Map view (top-down)']].map(([f, n]) => `<figure>${img(f, 'AB line comparison, ' + n)}<figcaption>${n}</figcaption></figure>`).join('')}</div></div>
<p class="note"><b>What changes:</b> on yellow over ripe grass, today’s line nearly disappears in both views (only the white end dots show). On blue it reads, but weakly over the painted band. With the edge it reads in all four cases, Map included. In 3D the front tree row hides most of the line either way, so the visible stretch and the end dots carry it.</p>
<p class="rec"><b>Recommendation:</b> add the dark edge. It is one extra quad per tractor (same as the Map’s implement-bar edge), drawn just under the line.</p>

<div class="bar"><h3 style="margin:40px 0 0">3 · Fleet hub depth</h3>
<div class="seg" role="group" aria-label="Background"><button type="button" data-bg="light" aria-pressed="true">Diorama</button><button type="button" data-bg="dark" aria-pressed="false">Dark</button></div></div>
<p class="sub">The real depot strip from the mock scenario, as built: hubPlacement() puts the hub north of road 6, above block A, in a strip only 1.02 deep for a 1.5-deep pad. The hub (refuel and service bays, as in depotHub.js) is shown with tractor A (0.85) nosed into the refuel bay, 0.05 short of the pump. Shown at about two-thirds of scene size; the top-down row is north up.</p>
<div class="stage" data-switch>
<div class="grid4" style="grid-template-columns:repeat(3,minmax(0,1fr))">${['a', 'b', 'c'].map((o) => `<figure>${img(`decide-hub-${o}.svg`, `Hub option ${o}`)}<figcaption>${o} · ${hi[o].label}</figcaption></figure>`).join('')}</div>
<figure style="margin:0;padding:8px 14px 16px">${img('decide-hub-top.svg', 'Hub options top-down')}</figure>
</div>
<div class="wrap"><table>
<thead><tr><th>Option</th><th>Scale w × h × d</th><th>Strip depth</th><th>Canopy height</th><th>Parked tractor overhang</th><th>Layout cost</th></tr></thead>
<tbody>${hubRows}</tbody>
</table></div>
<p class="note">Tractor A’s roof is at 0.72. <b>a</b> keeps the canopy (0.75) above it, but the squashed depth leaves the parked tractor’s hitch 0.16 over the road edge. <b>b</b> fits the pad more evenly but drops the canopy to 0.58, below the tractor roof, so the hub looks like a toy next to its own tractor, and the overhang barely changes (0.13): the tractor, not the pad, sets the overhang. <b>c</b> is the only one where the tractor fits under the canopy, but block A must move to rows 1–3. Its bed then sits 0.02 from road 0, its north headland lane runs 0.1 from the road edge, and A no longer lines up with B–D.</p>
<p class="rec"><b>Recommendation:</b> keep <b>a</b> (the current build). To lose the overhang, move the pump and tool chest about 0.16 further north inside the pad instead of changing the layout.</p>

<div class="bar"><h3 style="margin:40px 0 0">4 · Blocks E–H layout</h3>
<div class="seg" role="group" aria-label="Background"><button type="button" data-bg="light" aria-pressed="true">Diorama</button><button type="button" data-bg="dark" aria-pressed="false">Dark</button></div></div>
<p class="sub">The whole 20 × 14 farm grid, top-down, with row and column numbers. Roads are the pale bands (rows 0, 6, 13; columns 0, 5, 10, 15). Hatched bands are empty rows between a road and a block tier, the arrows on the right measure them, and orange marks the problem in each option. The blue band is the strip hubPlacement() fits the Fleet hub into. Next to each plan: the same farm from the default 3D camera.</p>
<div class="stage" data-switch><div class="layouts">${['a', 'b', 'c'].map((o) => `<figure><div class="lay2">${img(`decide-layout-${o}.svg`, `Layout ${o} plan`)}${img(`decide-layout-${o}-iso.svg`, `Layout ${o} in 3D`)}</div><figcaption><b>${o} · ${li[o].name}</b> (${li[o].sub}). ${layCap[o]}</figcaption></figure>`).join('')}</div></div>
<p class="rec"><b>Recommendation:</b> keep <b>b</b> (current). It is the only option with even gaps and whole cells; the 4-row E–H blocks read as “bigger blocks”, not as an error.</p>
`;
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
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0}
.grid2 figure,.grid4 figure{margin:0;padding:14px;display:flex;flex-direction:column;align-items:center}
.grid2 img,.grid4 img{width:100%;height:auto}
.grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0}
.grid2 figcaption,.grid4 figcaption,.states figcaption{font-size:12px;font-weight:600;margin-top:6px}
.states figure{margin:0;padding:16px 20px}
.states img{width:100%;height:auto;display:block}
.dots{letter-spacing:1px;color:var(--ink)}.dots span{opacity:.2}
.mut{color:var(--muted)}
.layouts figure{margin:0;padding:16px 18px;border-top:1px solid rgba(0,0,0,.05)}
.layouts figcaption{font-size:13px;line-height:1.45;margin-top:8px;max-width:110ch}
.lay2{display:grid;grid-template-columns:1.15fr 1fr;gap:12px;align-items:center}
.lay2 img{width:100%;height:auto;display:block}
.grid2>img{width:100%;height:auto;padding:12px}
.stage>figure img{width:100%;height:auto;display:block}
p.rec{margin-top:12px;font-size:15px;max-width:none}
@media (max-width:860px){
  main{padding:36px 16px 72px}
  .cmp{grid-template-columns:64px repeat(4,minmax(120px,1fr));min-width:600px}
  .scene{grid-template-columns:1fr}
  .dir{grid-template-columns:1fr;gap:12px}
  .dir figure{max-width:260px}
  .grid2{grid-template-columns:1fr}
  .lay2{grid-template-columns:1fr}
  .grid4{grid-template-columns:1fr 1fr}
}
@media (prefers-reduced-motion:reduce){.stage{transition:none}}
</style>
</head>
<body>
<main>
<h1>Tractor concepts</h1>
<p class="lede">Today’s box tractor next to three directions with a hint of realism. Every drawing is an orthographic, flat-shaded projection of the same low-poly part list the three.js scene would build, so proportions, light from the top left and triangle counts carry straight over.</p>
${decisions()}
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
<p class="note">The house is static, so in three.js it bakes into one vertex-coloured geometry (one draw call, one shadow caster), with the fleet-blue fascia as a fixed vertex colour. All three directions stay around 300 triangles or less (B, as built, is ${hs.B.total}), well under half a tractor.</p>
<div class="rec">
<p><b>Go with A, the modern machine shed.</b> The roll-up door says “depot” at a glance, the dark solar roof anchors the corner from the tilted camera without competing with the fleet colours, and it fits tractor A’s diesel, fuel and mechanic story.</p>
<p style="margin:0;color:var(--muted)">If the pitch leans into autonomy, borrow two details from B for A’s apron: the comms mast with its amber lamp and the painted bay lines. Both are cheap (about 40 triangles) and keep A’s silhouette.</p>
</div>

<h2 id="trees">Trees &amp; plots</h2>
<p class="sub">Concepts only, not built in 3D. Realism is the main axis, as with tractor A: stylised low-poly, but clearly a step toward a real Arizona citrus grove. Scale: one row pitch (1 cell) reads as a real 6.5 m row spacing, so 4 m in-row spacing is 0.62, a 4 m canopy is 0.6 tall and the 40 cm skirt is 0.06. Same renderer, light and tones as the tractors and houses; part lists map 1:1 to three.js r128 geometry.</p>
<div class="bar"><h3 style="margin:24px 0 0">Single tree</h3>
<div class="seg" role="group" aria-label="Background"><button type="button" data-bg="light" aria-pressed="true">Diorama</button><button type="button" data-bg="dark" aria-pressed="false">Dark</button></div></div>
<p class="sub">Same scale in every column. B shows one cell of hedgerow (its instancing unit) with a row-end post.</p>
<div class="wrap"><div class="stage" data-switch>
<div class="cmp">
<div></div>${tCols.map(([, n]) => `<div class="h">${n}</div>`).join('')}
${tViews.map(([v, vn]) => `<div class="v">${vn}</div>${tCols.map(([key, n]) => `<div class="c${key === 'current' ? ' cur' : ''}">${img(`trees-${key}-${v}.svg`, `${n} tree, ${vn}`)}</div>`).join('')}`).join('\n')}
</div></div></div>

<div class="bar"><h3 style="margin:40px 0 0">One block, tractor A at work</h3>
<div class="seg" role="group" aria-label="Background"><button type="button" data-bg="light" aria-pressed="true">Diorama</button><button type="button" data-bg="dark" aria-pressed="false">Dark</button></div></div>
<p class="sub">A ripe 4 × 3 block at scene scale: soil frame, grass treatment and trees. Tractor A (0.85) works lane 2 heading west, 45% of the way along, like mockSource’s serpentine sweep. Behind it is the coverage painted so far (row 1 done, row 2 behind the hitch, 0.6 opacity at y 0.032) and its AB line (0.05 wide, fleet colour mixed 45% with white, white end dots). The Fleet hub sits across the north road.</p>
<div class="stage" data-switch><div class="grid2">${tCols.map(([key, n]) => `<figure>${img(`plots-${key}-block.svg`, `${n}: block sample`)}<figcaption>${n}</figcaption></figure>`).join('')}</div></div>

<h3 style="margin:40px 0 6px">At scene size</h3>
<p class="sub">Same pixels per unit as the tractor sheets (tractor about 48 px tall), on both backgrounds.</p>
<div class="scene" style="grid-template-columns:1fr">
${['light', 'dark'].map((bg) => `<div class="stage" data-bg="${bg}"><div class="minis">${tCols.map(([key, n]) => `<figure>${img(`plots-${key}-block.svg`, `${n}, scene size`)}<span class="lbl">${key === 'current' ? 'Current' : key} · ${fmt(os[key].total)} tris</span></figure>`).join('')}</div></div>`).join('\n')}
</div>
<style>.scene .minis img[src^="plots-"]{width:${blockW}px;height:auto}</style>

<div class="bar"><h3 style="margin:40px 0 0">Map view (top-down)</h3>
<div class="seg" role="group" aria-label="Background"><button type="button" data-bg="light" aria-pressed="true">Diorama</button><button type="button" data-bg="dark" aria-pressed="false">Dark</button></div></div>
<p class="sub">North up. The same block in the Map’s vocabulary: coverage (0.62) and the AB line drawn above the canopy, a white block outline, and the tractor icon with its status ring on top. The Map’s procedural aerial (liveBasemap.js) paints about 5.5 canopy rows per cell (real density for 40 m cells), while the diorama has 3 rows per block. These samples use the diorama density; for the aerial, copy each direction’s colours and marks (flush highlight, NW-lit canopy with SE shadow, berm, wet strip, tram lines) at its own density.</p>
<div class="stage" data-switch><div class="grid4">${tCols.map(([key, n]) => `<figure>${img(`plots-${key}-map.svg`, `${n}: Map view`)}<figcaption>${n}</figcaption></figure>`).join('')}</div></div>

<div class="bar"><h3 style="margin:40px 0 0">Block states: normal, ripe, heat-stressed</h3>
<div class="seg" role="group" aria-label="Background"><button type="button" data-bg="light" aria-pressed="true">Diorama</button><button type="button" data-bg="dark" aria-pressed="false">Dark</button></div></div>
<p class="sub">The tints are what farm.js can actually produce: the Lambert grass colour plus the emissive set in <code>tick()</code>. The Current row shows exactly today’s values. For the directions, ripe uses emissive #FF7A1A at 0.15 (today’s formula gives 0.087 at ripeness 0.72, which barely shows), and fruit carries most of the signal. Heat uses #FF4A10 at 0.27 (the middle of today’s 0.18–0.36 pulse) plus drier grass and a yellowed canopy. Each tile uses the hardest fleet colour for its tint: green on normal, yellow on ripe, pink on heat.</p>
<div class="stage" data-switch><div class="states">${tCols.map(([key, n]) => `<figure>${img(`plots-${key}-states.svg`, `${n}: normal, ripe and heat-stressed block`)}<figcaption>${n}</figcaption></figure>`).join('')}</div></div>

<h3 style="margin:40px 0 6px">Directions</h3>
<div class="dirs">
${tDirs.map((d) => `<article class="dir"><figure style="margin:0">${img(`trees-${d.key}-iso.svg`, d.name)}</figure><div>
<h3>${d.name}</h3>
<p class="k">What changes</p><p>${d.what}</p>
<p class="k">Why</p><p>${d.why}</p>
<p class="k">Realism · readability · cost</p><p>Realism ${dots(score[d.key][0])} · Readability ${dots(score[d.key][1])} · ${fmt(os[d.key].total)} triangles for 8 blocks as mocked (${fmt(os[d.key].worst)} with every block heavy).</p>
<p class="k">Three.js parts</p><p>${d.parts}</p>
<p class="k">Budget</p><p>${os[d.key].perBlock} trees per block, ${os[d.key].perTree} triangles each (${os[d.key].parts.map((p) => `${p.part} ${p.tris}${p.per > 1 ? ' × ' + p.per : ''}`).join(', ')}). Fruit: ${os[d.key].fruit.geo}, ${os[d.key].fruit.tris} triangles each. Ground: ${os[d.key].ground}.</p>
</div></article>`).join('\n')}
</div>
<div class="wrap"><table>
<thead><tr><th>Direction</th><th>Trees / hedge cells</th><th>Tris / tree</th><th>Trees total</th><th>Fruit (count)</th><th>Static extras</th><th>As mocked</th><th>All heavy</th><th>Draws</th><th>Shadow draws</th><th>Realism</th><th>Readability</th></tr></thead>
<tbody>${['current', 'A', 'A12', 'B', 'C'].map(orow).join('')}</tbody>
</table></div>
<p class="note">8 blocks, one InstancedMesh per part type. “As mocked” uses mockSource’s block ripeness (A 0.4, B 0.5, C 0.72, D 0.3, E 0.55, F 0.6, G 0.45, H 0.35): today that puts 36 sphere fruit on C and F (2,880 triangles, as many as 65 trees), and a fully ripe farm would reach 384 spheres and ${fmt(os.current.fruitMaxTris)} triangles. Every direction switches fruit to an 8-triangle octahedron, so even “all heavy” stays bounded. “Draws” is the tree and fruit InstancedMeshes plus any merged static mesh (tufts, posts); “+ 9” is today’s 8 grass planes (one material each, for the per-block emissive) and the merged soil frame, which are unchanged. The stripes, berms, wet strips, tram lines and drip lines are one shared CanvasTexture on those planes, so they cost no draws or triangles. Shadow draws count the instanced casters (fruit, AO and ground do not cast). Cheaper A: bake the contact AO into the ground texture (−1 draw, −1,440 triangles) and drop to two lobes when zoomed out (−2,880). Coverage (y 0.032) and the AB line (y 0.07) stay above every ground layer, which all sit at y 0.02 in a single texture. “A at 12 per block” is the brief’s like-for-like count (one tree per cell, as farm.js lays them out today). B’s count is hedge cells, not trees.</p>
<p class="note"><b>AB line check.</b> Today’s line (fleet colour mixed 45% with white, 0.05 wide) fails on the pale tints: it almost disappears on yellow coverage over ripe grass, and on green coverage on C’s pale ground. In A and B the front tree row also hides most of it from the tilted camera. Every sample here therefore draws a proposed fix, the same idea as the Map’s <code>barEdge</code>: a 0.09-wide #1C1C1E underlay at 0.55 under the 0.05 line. It is one extra quad per tractor; the dashboard itself is unchanged.</p>
<div class="rec">
<p><b>Go with A, refined citrus.</b> It is the realism step Divi asked for, it matches tractor A, and it holds up at scene size: a dark, flush-tipped dome on a short trunk, believable spacing, and Arizona ground (tilled berms, wet strips, drip lines, tyre tracks). About 16.7k triangles and 5 instanced draws for the whole farm as mocked: roughly 2,100 per block, under three tractor A’s.</p>
<p style="margin:0;color:var(--muted)">Borrow two things from B: the twin tram lines in the alleys (they make the sweep lanes and coverage bands read from the tilted camera) and the white-tagged row-end posts. If the tilted view feels too busy in testing, B is the fallback: its hedgerows read best with coverage and AB lines.</p>
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

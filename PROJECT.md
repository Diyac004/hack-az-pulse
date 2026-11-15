# Harvest AI: Project Base Doc

> AgX Arizona Summit Hackathon (Hack Arizona x Arizona Hub for Agricultural Innovation)
> Team of 3. About 6 hours including submission.
> This doc is the source of truth for the project. If something here changes, update this file.

---

## 1. What we're building (short version)

An AI that runs the harvest for fruit farms.

It maps every tree from satellite imagery, reads ripeness from 3D phone scans, predicts when each block of the farm will be ready, and then staffs and coordinates the harvest by texting the farm's workers. The grower's only job is to tap **Approve**.

**One-line pitch:** The AI finds the ripe fruit, finds the workers, and runs the harvest. The grower taps Approve once.

**Problem we're solving:** Today a grower walks the rows, guesses when the fruit is ready, and spends days calling around for workers. Labor is often the biggest cost on a fruit farm, and bad harvest timing wastes it (idle crews, or fruit left to overripen or burn in the heat).

**Why we're different:** Companies like Orchard Robotics and Aerobotics already sell crop data (fruit counts, sizes, yield forecasts). Labor apps like PickTrace and Ganaz track or find workers. Nobody connects "the fruit is ripe Friday" to "this crew shows up Friday at these rows." We are that connection, and the AI executes it, not just reports it.

**Demo farm:** A real citrus farm in the Queen Creek / Mesa area (satellite data is real; scans are stand-in trees we can physically reach).

---

## 2. User walkthrough (hackathon version)

Our user is Maria, who manages a citrus farm.

**1. The farm map** *(preloaded)*
AI mapped every tree from satellite imagery and split the farm into blocks. Maria sees each tree as a dot colored by ripeness.

**2. Looking ahead** *(live)*
AI forecast each tree's ripeness for the next 14 days. Maria drags a slider and watches Block C turn orange by Friday.

**3. The 3D tree** *(live viewing, preloaded scan)*
AI turned a phone scan into a 3D tree, found every fruit, and graded each one as unripe, turning, ripe, or sunburned. Maria taps a scanned tree and spins it around, with each fruit glowing by ripeness.

**4. Approval** *(live)*
AI decided Block C needs 6 pickers on Friday. Maria's phone buzzes: "Block C is ready Friday. Book 6 pickers for about $2,900?" She taps Approve.

**5. Staffing** *(live)*
AI texts last season's workers with the job offer. Workers' phones buzz, they tap Yes, and the crew fills up on screen.

**6. Coordinating** *(live)*
AI picks a crew leader and sends them the rows, start time, and heat breaks. AI tells the packinghouse how much fruit is coming and when. Every step shows up in the AI activity feed.

**7. Tracking** *(live)*
The crew leader taps "Row done." AI updates the farm map instantly and picked rows turn gray.

---

## 3. The 90-second demo script

1. Farm map on the big screen. "This is a real citrus farm in Queen Creek. Every dot is a real tree our AI found from satellite imagery."
2. Drag the slider to Friday. Block C turns orange.
3. Tap a scanned tree. The 3D tree opens with glowing fruit. "We scanned this tree with a phone in about a minute."
4. Grower phone buzzes. Tap **Approve**.
5. Activity feed lights up: texting workers, replies coming in.
6. Two teammate phones buzz with the job offer. They tap **Yes**. Crew full.
7. Crew leader phone gets rows and heat breaks. Packinghouse notified.
8. Crew leader taps **Row done**. Rows turn gray on the big screen.
9. Close: "Today a grower walks the rows, guesses, and spends days calling for workers. Now they tap Approve once."

Three phones on stage, one per role: grower, worker, crew leader.

---

## 4. Preloaded vs live

**Preloaded (done before the demo starts, never processed on stage)**
- Satellite imagery and tree detection for the farm
- 3D tree scans and their fruit detection
- 14-day ripeness forecast for every tree
- Past workers list and the farm's blocks
- Backup demo video (recorded at the 4:30 freeze)

**Live (happens on stage)**
- Time slider and opening the 3D tree (instant, data already loaded)
- Approval notification and Approve tap
- AI texting workers, replies, crew filling up
- Crew leader assignment, "Row done" taps updating the map
- Packinghouse notification

**Optional live moment (only if rock solid in rehearsal)**
Scan a real tree on stage with Scaniverse and show it in the app. Keep the preloaded version of the same tree ready to swap in.

---

## 5. Tech stack

| Part | Tool |
|---|---|
| Web app | Next.js, installable as a PWA (Add to Home Screen) |
| Map | Map library of choice (Mapbox GL / MapLibre / deck.gl) with the NAIP image as an overlay |
| 3D tree | Gaussian splat viewer (Spark or GaussianSplats3D) on three.js |
| Backend, auth, realtime | Supabase |
| Push notifications | Web Push API (`web-push` npm + VAPID keys) |
| Tree scans | Scaniverse app (free, trains the splat on the phone in about a minute, exports PLY) |
| Satellite imagery | USDA NAIP via Microsoft Planetary Computer (free, 4-band incl. near-infrared) |
| Vision / data | Python: rioxarray, scikit-image, scipy, numpy |

**iPhone note:** web push only works after the app is added to the home screen (iOS 16.4+). Notification action buttons may not work on iOS, so tapping a notification should open a full-screen card with big buttons.

---

## 6. Who owns what

### You: Frontend and 3D (Divi)

Before the event
- [ ] Next.js app with PWA support
- [ ] Get one scan file loading in the splat viewer

During the event
- [ ] Farm map with the NAIP image overlay and tree dots from `trees.geojson`
- [ ] Tree dots colored by ripeness, block outlines and labels
- [ ] Time slider (today to +14 days) that recolors trees from `forecast.json`
- [ ] Summary bar: trees ready, estimated lbs, next harvest date
- [ ] Tap a scanned tree to open the 3D view with glowing fruit orbs and a count card
- [ ] AI activity feed sidebar, live from Supabase
- [ ] Picked rows turn gray live when the crew leader taps "Row done"
- [ ] Visual polish and transitions

### Person 2: Vision and data

Before the event
- [ ] Scan 2 or 3 trees with Scaniverse, export PLY
- [ ] Run the NAIP script (Appendix A) on the chosen farm and tune until `check_overlay.png` looks right

During the event
- [ ] Find fruit in each scan: color filter on splat colors, DBSCAN clustering, ripeness stage, sunburn flag
- [ ] Export `fruit_<scan_id>.json` for the 3D view
- [ ] Assign trees to blocks (`blocks.json`)
- [ ] Ripeness formula: canopy size + NDVI + scanned trees give ripeness per tree per day for 14 days
- [ ] Export `forecast.json`
- [ ] Estimate lbs per block per day (for crew size)
- [ ] Once data is done, help debug integration

### Person 3: Backend, phones, pitch

Before the event
- [ ] Test push notifications on all three teammates' phones, especially iPhones
- [ ] Draft the pitch outline

During the event
- [ ] Supabase tables (Section 7) and logins for grower, worker, crew leader
- [ ] Seed past workers (teammate accounts plus a few fake names)
- [ ] Planner: when a block is ready, create a job, compute crew size and cost, push approval to grower
- [ ] Approval card screen (Approve / Edit)
- [ ] Staffing: after approval, send job offers to past workers, fill seats on Yes, assign a crew leader
- [ ] Worker job offer screen (Yes / No)
- [ ] Crew leader screen: rows, start time, heat breaks, "Row done" buttons
- [ ] Write every AI action to `activity_log`
- [ ] Packinghouse notification (one message)
- [ ] Slides, backup demo video, submission write-up

---

## 7. Data contracts (everyone codes against these)

### Files (Person 2 produces, frontend loads)

`trees.geojson`
```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [-111.61, 33.205] },
      "properties": {
        "id": 1,
        "block": "C",
        "row": 3,
        "canopy_m2": 18.4,
        "ndvi": 0.52,
        "scan_id": null
      }
    }
  ]
}
```
`scan_id` is a string like `"tree_c_01"` for scanned trees, otherwise `null`.

`forecast.json`
```json
{
  "start_date": "2026-11-15",
  "days": 15,
  "ripeness": { "1": [0.41, 0.45, 0.49, "...15 values, 0 to 1"] },
  "block_lbs": { "C": [0, 0, 0, 0, 0, 14000, "...15 values"] }
}
```

`fruit_<scan_id>.json`
```json
{
  "tree_id": 42,
  "fruits": [
    { "x": 0.31, "y": 1.42, "z": -0.12, "ripeness": 0.78, "stage": "ripe", "sunburn": false }
  ]
}
```
`stage` is one of `unripe`, `turning`, `ripe`. Coordinates are in the splat's own space.

`blocks.json`
```json
[{ "id": "C", "name": "Block C", "variety": "Navel", "polygon": [[-111.61, 33.20], "..."] }]
```

Plus `naip.png` and `naip_bounds.json` (from the Appendix A script) for the map overlay.

### Supabase tables (Person 3)

| Table | Key columns |
|---|---|
| `workers` | id, name, phone, role (`grower` / `worker`), push_subscription |
| `jobs` | id, block_id, date, start_time, crew_size, est_cost, est_lbs, status (`proposed` / `approved` / `staffing` / `full` / `in_progress` / `done`) |
| `job_offers` | id, job_id, worker_id, status (`sent` / `yes` / `no`) |
| `assignments` | id, job_id, worker_id, is_leader, rows (int[]) |
| `row_progress` | id, job_id, row, done_at |
| `activity_log` | id, created_at, job_id, message |

Turn on Supabase Realtime for `activity_log`, `job_offers`, and `row_progress` so the map and feed update live.

### Business rules (keep these consistent everywhere)

- A tree is **ripe** when ripeness is 0.7 or higher.
- A block is **ready** when 60% or more of its trees are ripe.
- **Crew size** = ceil(block lbs for the day / 2,500 lbs per picker per day).
- **Cost** = crew size x about $480 per picker per day. (Illustrative numbers. Say so if asked.)
- Ripeness colors: green `#639922` (unripe), amber `#EF9F27` (turning), orange-red `#D85A30` (ripe), red ring (sunburn), gray `#B4B2A9` (picked).

---

## 8. Timeline and checkpoints

| Time | What happens |
|---|---|
| 0:00 to 0:20 | Hear the challenge. Confirm the idea fits or adjust the framing. Ask a mentor two questions about harvest labor. |
| 0:20 to 1:00 | Setup: repo, Supabase tables, app shell, 3D tree loading |
| **1:00 checkpoint** | Map shows real trees. Fruit JSON loads in 3D view. First push notification arrives on a phone. |
| 1:00 to 3:00 | Core build, everyone in their own lane |
| **3:00 checkpoint** | Full flow works end to end, even if ugly. Cut anything that doesn't. |
| 3:00 to 4:30 | Polish visuals, notifications on all 3 phones, activity feed animation |
| **4:30 feature freeze** | No new code after this |
| 4:30 to 5:15 | Record backup demo video. Rehearse the pitch 3 times. |
| 5:15 to 5:45 | Submit (write-up, video, repo link) |
| 5:45 to 6:00 | Buffer. Something will break. |

### What to cut first if we fall behind
1. Packinghouse notification (keep it as one line in the activity feed)
2. Time slider animation (show two fixed dates instead)
3. Block outlines and summary bar polish

**Never cut:** the 3D tree, the Approve tap, the worker and crew leader phones buzzing, rows turning gray.

---

## 9. If we finish early (stretch goals, in priority order)

These are in the pitch as "what's next." Only build them if the core flow is done and rehearsed.

1. **Job board posting and hiring.** If past workers don't fill the crew, AI writes a job posting, posts it, reviews applicants, and hires. For the demo, build a generic mock job board page (do not copy any real company's branding) and show the agent filling it out in a visible browser window. Never post demo jobs on real job boards, since real workers would see them.
   *Start this only if we're ahead at the 3:00 checkpoint.*
2. **Weekly paid scan tasks.** AI picks which trees need scanning and sends paid tasks ("Scan 3 trees in Block C, $9") to workers' phones. Worker accepts, scans, and the tree appears in the app.
3. **Learning from results.** After harvest, AI compares picked lbs to the forecast and adjusts the next forecast. Can be a simple "forecast accuracy" card showing predicted vs actual.
4. **Heat alerts.** 110°F+ forecast triggers a notification, shifts start times earlier, and highlights sun-exposed tree edges at risk of sunburn.

Until built, each of these is a slide or one line in the activity feed (for example, "Crew full, no job board posting needed").

---

## 10. Honest notes (so nobody gets surprised)

- **Satellite map will look messier than mockups.** NAIP at about 60 cm per pixel shows trees as fuzzy blobs. Expect some missed or doubled trees. Tune the script before the event.
- **3D scans** look photographic up close but have fuzzy floaters, blurry patches on sides we didn't walk past, and scanned ground around the tree. Crop to the tree.
- **Fruit detection** works by color, so it finds orange and yellow fruit well and misses most green fruit. Expect roughly 60 to 80% of visible fruit found. Pick a crop with visible color.
- **Forecast is directional, not precise.** Say that out loud if judges ask.
- **Push notifications** take 1 to 5 seconds and need home screen install on iPhone. Rehearse.
- **Competition exists** (Orchard Robotics, Aerobotics for crop data; PickTrace, Ganaz for labor). Our angle is connecting the forecast to staffing and having the AI execute it.

---

## 11. Before the event checklist

- [ ] Pick the demo farm and get its bounding box
- [ ] Run the NAIP script, tune it, save outputs
- [ ] Scan 2 or 3 trees with Scaniverse, export PLY
- [ ] Confirm a scan loads in the splat viewer in the browser
- [ ] Test web push on all three phones
- [ ] Check hackathon rules on pre-made assets and pre-written code
- [ ] Pitch outline drafted

---

## Appendix A: Satellite tree detection script (Person 2)

Pulls the latest NAIP imagery for the farm, finds each tree using vegetation index (NDVI) peaks, and exports tree points, the basemap image, and a verification overlay. Not yet tested on live data, expect to tune `TREE_SPACING_M` and `NDVI_THRESHOLD`.

```python
# pip install pystac-client planetary-computer rioxarray scikit-image scipy pyproj pillow matplotlib
import json
import numpy as np
import pystac_client
import planetary_computer
import rioxarray
import rasterio.transform
from scipy import ndimage
from skimage.feature import peak_local_max
from skimage.segmentation import watershed
from pyproj import Transformer
from PIL import Image
import matplotlib.pyplot as plt

# Replace with your farm's bounding box: [min_lon, min_lat, max_lon, max_lat]
BBOX = [-111.620, 33.200, -111.605, 33.212]
TREE_SPACING_M = 6.0   # typical citrus spacing, tune for your farm
NDVI_THRESHOLD = 0.30  # tune by checking the overlay image

catalog = pystac_client.Client.open(
    "https://planetarycomputer.microsoft.com/api/stac/v1",
    modifier=planetary_computer.sign_inplace,
)
items = sorted(catalog.search(collections=["naip"], bbox=BBOX).items(),
               key=lambda i: i.datetime, reverse=True)
if not items:
    raise SystemExit("No NAIP imagery found for this bbox")
item = items[0]
print("Using NAIP from", item.datetime.date())

da = rioxarray.open_rasterio(item.assets["image"].href)
da = da.rio.clip_box(*BBOX, crs="EPSG:4326")
raw = da.values  # bands: 1 red, 2 green, 3 blue, 4 NIR
img = raw.astype("float32")
red, nir = img[0], img[3]
ndvi = (nir - red) / (nir + red + 1e-6)

res = abs(da.rio.resolution()[0])  # meters per pixel
smooth = ndimage.gaussian_filter(ndvi, sigma=max(1.0, 1.0 / res))
mask = smooth > NDVI_THRESHOLD

min_dist = max(2, int(TREE_SPACING_M * 0.6 / res))
peaks = peak_local_max(np.where(mask, smooth, 0), min_distance=min_dist,
                       threshold_abs=NDVI_THRESHOLD)
markers = np.zeros(smooth.shape, dtype=int)
markers[peaks[:, 0], peaks[:, 1]] = np.arange(1, len(peaks) + 1)
crowns = watershed(-smooth, markers, mask=mask)

ids = np.arange(1, len(peaks) + 1)
areas = ndimage.sum(np.ones_like(smooth), crowns, index=ids) * res * res
health = ndimage.mean(ndvi, crowns, index=ids)

to_wgs = Transformer.from_crs(da.rio.crs, "EPSG:4326", always_xy=True)
xs, ys = rasterio.transform.xy(da.rio.transform(), peaks[:, 0], peaks[:, 1])
lons, lats = to_wgs.transform(xs, ys)

features = []
for i in range(len(peaks)):
    features.append({
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lons[i], lats[i]]},
        "properties": {"id": int(i + 1),
                       "canopy_m2": round(float(areas[i]), 1),
                       "ndvi": round(float(health[i]), 3)},
    })
with open("trees.geojson", "w") as f:
    json.dump({"type": "FeatureCollection", "features": features}, f)

# Basemap image plus its bounds for the frontend
rgb = np.transpose(raw[:3], (1, 2, 0)).astype("uint8")
Image.fromarray(rgb).save("naip.png")
h, w = rgb.shape[:2]
corners_x, corners_y = rasterio.transform.xy(da.rio.transform(), [0, h - 1], [0, w - 1])
(lon0, lon1), (lat0, lat1) = to_wgs.transform(corners_x, corners_y)
with open("naip_bounds.json", "w") as f:
    json.dump({"west": min(lon0, lon1), "east": max(lon0, lon1),
               "south": min(lat0, lat1), "north": max(lat0, lat1)}, f)

# Verification image: detected trees drawn on the imagery
plt.figure(figsize=(10, 10))
plt.imshow(rgb)
plt.scatter(peaks[:, 1], peaks[:, 0], s=4, c="red")
plt.axis("off")
plt.savefig("check_overlay.png", dpi=150, bbox_inches="tight")
print(f"Detected {len(peaks)} trees at {res:.2f} m/pixel")
```

**Verify before trusting it**
1. Open `check_overlay.png`. Each tree should have exactly one red dot.
2. Too many dots: raise `TREE_SPACING_M`. Missed trees: lower `NDVI_THRESHOLD`.
3. Count one row by eye and compare to the script's count.
4. Load `trees.geojson` on the map and confirm the dots line up with the imagery.
5. Add `block` and `row` to each tree's properties (Section 7) before handing off.

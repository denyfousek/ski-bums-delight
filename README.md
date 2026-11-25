# Ski Bum's Delight

Daily planning aid for ski touring and freeride in Switzerland: swisstopo 3D terrain with
today's SLF avalanche bulletin, critical-slope analysis, snow and wind stations, wind
forecast, recent Sentinel-2 imagery, GPX route checks and a snow view that makes the shape of
snow-covered terrain readable. Areas: a dozen presets, the current view, or your position.

Live version: <https://denyfousek.github.io/ski-bums-delight/> (installable on a phone as an app).

> **Planning aid only.** It does not replace your own avalanche assessment in the field,
> the full SLF bulletin, or training.

## Run

```
python serve.py
```

Then open <http://127.0.0.1:8765>. Python 3.9+ standard library only; the page loads
CesiumJS and geotiff.js from jsDelivr. The server binds to `127.0.0.1` only.

`serve.py` exists for two reasons: Cesium needs to be served over HTTP, and the SLF IMIS
station API sends no CORS header. The proxy forwards exactly two read-only paths
(`stations`, `station/<CODE>/measurements`) and caches answers for 10 minutes.

## Features

| Panel | What it does | Source |
|---|---|---|
| Snow view | GPU shader on the globe: snow above the snow line (lower on north faces, higher on south faces), steep faces stay rock with the aerial image showing through, warm sunlight, bluish shade, contour lines every 100 m (every 20 m close up). Drawn from terrain alone: it shows shape, not measured snow cover | swisstopo terrain |
| Snow line | estimated per area from snow depth against elevation: 25 model points (MeteoSwiss ICON) plus the stations, which count four times; shown with its date and method; slider to override. A loaded Sentinel-2 scene gives a second, observed value (share of snow per 100 m band from the scene classification) | Open-Meteo, SLF, MeteoSwiss, Copernicus |
| High quality | switch in the Day tab, on by default except on phones. Snow gets its own lighting: warm sun that turns golden when low, blue sky light in the shade, a soft roll-off to white, light bounced between slopes, hollows slightly darker than ridges, wind ripples and drift waves close up, a sheen towards the sun and single crystals that flash. Terrain shadows are cast at 4096 px and take away only the sunlight (Cesium's shadow pass is patched for that, see `quality.js`); rock above the snow line gets a cold grey veil and snow on its ledges. Measured on an RTX 3090 at 1800 × 1600: 4 to 13 ms per frame, standard 1.5 ms | — |
| Close-up terrain | the finest terrain tiles (level 18, a vertex every 0.4 to 0.9 m) carry height jitter that shows as terraces under low sun; at load a plane is fitted around every vertex (Gaussian weight, 1.6 m for the normals, 0.6 m for the heights), which removes the jitter and keeps slopes exact. `?terrain=raw` shows the tiles as delivered | swisstopo terrain |
| Areas | presets, "View" (19 × 14 km around the view centre) or your position; stations, satellite scenes and snow line reload; remembered in the browser | — |
| 3D view | swisstopo terrain, winter/summer national map or SWISSIMAGE | geo.admin.ch |
| Layers | slope ≥ 30°, ski and snowshoe routes, lifts, wildlife rest zones and protection areas | swisstopo, BAFU |
| Terrain shading | real sun for a date and time (or manual azimuth/elevation) | — |
| Closed forest | slope cells in swissTLM3D "forest" (vector tiles, z14) shown separately as protected; open forest and scrub do not count. Assumption, no source: dense forest rarely releases avalanches | swisstopo |
| Sun & shade map | exact terrain shadows on swissALTI3D (8 m), 8 × 8 km plus 4 km margin, follows the time slider | swisstopo |
| Avalanche bulletin | danger level, problems, aspects and elevations for the area or any clicked point; optional danger map; the last 7 days on request (the SLF API takes `?activeAt=`) | SLF (CC BY 4.0) |
| Critical slopes | slope + aspect from swissALTI3D (4 m) for an 8 × 8 km square; marks ≥ 30° slopes whose aspect and elevation the bulletin names | swisstopo, SLF |
| Stations | snow depth (and 24 h change), wind, gusts, temperature | SLF IMIS (CC BY 4.0), MeteoSwiss |
| Wind forecast | hourly wind, gusts, 0° line, snowfall for a clicked point, 2 days | Open-Meteo, model MeteoSwiss ICON (non-commercial use only) |
| Sentinel-2 | true colour 10 m, last 3 weeks, cloud cover per scene | Copernicus via Earth Search (keyless) |
| GPX | distance, ascent (changes under 5 m ignored, so GPS noise does not add up), profile, wildlife zones crossed; traffic light per section against today's bulletin: green below 30°, yellow from 30°, red from 30° in an aspect and elevation the bulletin names; line and profile are coloured | swisstopo terrain, SLF, BAFU |
| Click | ski route details with SAC link, wildlife zone rules, cableways | geo.admin.ch identify |
| Side panel | four tabs (Day: sun and shade; Avalanche: bulletin, critical slopes, wind forecast, stations; Map; Route), winter light (blue) or dark theme (Auto follows the system); tab and theme are remembered in the browser | — |

A sample route is in `web/samples/`.

## Known limits

- High quality patches the text of CesiumJS's shadow shader and reads private fields of its shadow map
  and terrain tiles. That is tied to version 1.121, which `index.html` pins. On another version the
  patch finds nothing to replace and the view falls back to grey shadows.
- Wind ripples, drift waves and sparkle are invented detail (a west wind is assumed), not data.

- The snow view is a drawing from terrain, snow line and sun. It does not know wind-blown ridges,
  avalanche debris or bare south faces above the line.
- The snow line estimate leans on the stations. The model's snow depth is smooth (about the same
  from valley to summit on a snowy day) and too deep in valleys; where no station is bare and none
  is low, the result is only "at or below the lowest point".
- Map layers (routes, lifts, wildlife zones, slope and shade maps) lie under the snow cover and
  show through only faintly. Lower the snow opacity or switch the snow view off to read them.
- The route check looks at the ground under the track only, not at slopes above or below it.
- Critical slopes use the bulletin region at the centre of the analysed square for the whole square.

- Bulletin elevations given as "treeline" are treated as 2000 m (assumption, `TREELINE_M` in `web/js/config.js`).
- Snow depth exists only at stations; there is no open gridded snow-depth map.
- Open-Meteo gives 10 m wind at model-grid elevation, not ridge wind. Its free tier forbids commercial use.
- Sentinel-2 cloud cover is per 100 km tile, not for the area; clouds and snow look alike in true colour.
- The SLF asks that its interfaces are used for data retrieval rather than serving information systems
  directly. Fine for private use; before sharing the tool more widely, cache through the server or ask
  data@slf.ch.

## Tests

```
python -m unittest discover -s tests
node --test tests/js/*.test.mjs
python scripts/check_sources.py
```

- Python: proxy whitelist, cache, malformed requests, a local smoke test.
- Node (22+, no packages): the modules that need no browser — projections, sun, shade sweep,
  slope and aspect, bulletin rules, GPX analysis and route check, snow line, areas, stations.
- `check_sources.py` asks every external data source once and checks the shape of the answer.

GitHub Actions run the first two on every push and pull request (`ci.yml`) and the third every
morning (`sources.yml`). The 3D view, the shader and the panel were checked by hand in the
browser, at desktop and phone width.

## Layout

```
serve.py            local server + IMIS proxy
web/index.html      page
web/css/app.css
web/js/main.js      viewer and panel wiring
web/js/config.js    endpoints, layer IDs
web/js/areas.js     area presets, boxes, storage
web/js/snowline.js  snow line estimate
web/js/snowlook.js  snow view shader (Cesium globe material)
web/js/terrainsmooth.js  smoothing of the finest terrain tiles
web/js/quality.js   rendering quality: shadows, haze, patch of Cesium's shadow pass
web/js/ui.js        tabs, theme, bottom sheet, service worker registration
web/sw.js           service worker (app shell only)
web/manifest.webmanifest, web/icons/   installable app
scripts/check_sources.py   data source check
tests/              Python and Node tests
web/js/bulletin.js  SLF bulletin
web/js/slope.js     swissALTI3D slope/aspect analysis
web/js/stations.js  IMIS + MeteoSwiss stations
web/js/weather.js   Open-Meteo wind forecast
web/js/sentinel.js  Sentinel-2 search and reprojection
web/js/gpx.js       GPX import and analysis
web/js/proj.js      LV95 / UTM / WGS84 helpers
```

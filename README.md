# Ski Bum's Delight

Daily planning aid for ski touring and freeride in Switzerland: swisstopo 3D terrain with
today's SLF avalanche bulletin, critical-slope analysis, snow and wind stations, wind
forecast, recent Sentinel-2 imagery and GPX route checks. Test area: Andermatt – Realp.

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
| 3D view | swisstopo terrain, winter/summer national map or SWISSIMAGE | geo.admin.ch |
| Layers | slope ≥ 30°, ski and snowshoe routes, lifts, wildlife rest zones and protection areas | swisstopo, BAFU |
| Terrain shading | sun azimuth and elevation sliders | — |
| Avalanche bulletin | danger level, problems, aspects and elevations for the area or any clicked point; optional danger map | SLF (CC BY 4.0) |
| Critical slopes | slope + aspect from swissALTI3D (4 m) for an 8 × 8 km square; marks ≥ 30° slopes whose aspect and elevation the bulletin names | swisstopo, SLF |
| Stations | snow depth (and 24 h change), wind, gusts, temperature | SLF IMIS (CC BY 4.0), MeteoSwiss |
| Wind forecast | hourly wind, gusts, 0° line, snowfall for a clicked point, 2 days | Open-Meteo, model MeteoSwiss ICON (non-commercial use only) |
| Sentinel-2 | true colour 10 m, last 3 weeks, cloud cover per scene | Copernicus via Earth Search (keyless) |
| GPX | distance, ascent, profile, share of terrain ≥ 30°, wildlife zones crossed | swisstopo terrain, BAFU |
| Click | ski route details with SAC link, wildlife zone rules, cableways | geo.admin.ch identify |

A sample route is in `web/samples/`.

## Known limits

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
```

Covers the proxy whitelist, the cache and a local smoke test. The browser parts were checked
by hand in the browser (see git log).

## Layout

```
serve.py            local server + IMIS proxy
web/index.html      page
web/css/app.css
web/js/main.js      viewer and panel wiring
web/js/config.js    area, endpoints, layer IDs
web/js/bulletin.js  SLF bulletin
web/js/slope.js     swissALTI3D slope/aspect analysis
web/js/stations.js  IMIS + MeteoSwiss stations
web/js/weather.js   Open-Meteo wind forecast
web/js/sentinel.js  Sentinel-2 search and reprojection
web/js/gpx.js       GPX import and analysis
web/js/proj.js      LV95 / UTM / WGS84 helpers
```

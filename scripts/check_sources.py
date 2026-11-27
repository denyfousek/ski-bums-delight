"""Checks that every external data source of Ski Bum's Delight still answers as expected.

Run:  python scripts/check_sources.py        (standard library only)
Exit code 0 if every required source passed, 1 otherwise. Used by the daily GitHub Action.

Each check makes one small request and looks at the shape of the answer, not at values:
a provider that renames a field or moves an endpoint should fail here before a user
notices an empty panel.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

USER_AGENT = "ski-bums-delight-source-check/1.0 (+https://github.com/denyfousek/ski-bums-delight)"
TIMEOUT = 40
# Test point and box: Andermatt – Realp.
LON, LAT = 8.575, 46.615
BOX = (8.45, 46.55, 8.70, 46.68)


def get(url, data=None, headers=None, limit=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.status, dict(resp.headers), resp.read(limit) if limit else resp.read()


def get_json(url, data=None, headers=None):
    _, hdrs, body = get(url, data, headers)
    return hdrs, json.loads(body)


def need(cond, message):
    if not cond:
        raise AssertionError(message)


def lon2tile(lon, z):
    return int((lon + 180) / 360 * 2 ** z)


def lat2tile(lat, z):
    import math
    r = math.radians(lat)
    return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)


def check_bulletin():
    hdrs, gj = get_json("https://aws.slf.ch/api/bulletin/caaml/en/geojson", headers={"Origin": "https://example.org"})
    need(hdrs.get("Access-Control-Allow-Origin") == "*", "no CORS header")
    feats = gj.get("features", [])
    # Outside the season SLF publishes no bulletin; an empty list is then correct.
    if not feats:
        return "no bulletin published (off-season)"
    p = feats[0]["properties"]
    for key in ("validTime", "dangerRatings", "regions"):
        need(key in p, "property %s missing" % key)
    need(feats[0]["geometry"]["type"] in ("Polygon", "MultiPolygon"), "unexpected geometry")
    return "%d regions" % len(feats)


def check_bulletin_history():
    at = (datetime.now(timezone.utc) - timedelta(days=2)).replace(hour=10, minute=0, second=0, microsecond=0)
    url = "https://aws.slf.ch/api/bulletin/caaml/en/geojson?activeAt=" + urllib.parse.quote(at.strftime("%Y-%m-%dT%H:%M:%SZ"))
    _, gj = get_json(url)
    feats = gj.get("features", [])
    if not feats:
        return "no bulletin two days ago (off-season)"
    end = feats[0]["properties"]["validTime"]["endTime"]
    need(end[:10] <= (at + timedelta(days=1)).strftime("%Y-%m-%d"), "activeAt ignored: got a bulletin valid until %s" % end)
    return "bulletin of %s" % at.strftime("%Y-%m-%d")


def check_imis():
    # The same three requests and the same condensing the hourly snapshot uses.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import fetch_imis
    raw = fetch_imis.fetch_raw(get=lambda url: get_json(url)[1])
    need(isinstance(raw["stations"], list) and len(raw["stations"]) > 50, "station list too short")
    for key in ("code", "label", "lon", "lat", "elevation", "type"):
        need(key in raw["stations"][0], "station field %s missing" % key)
    need(len(raw["measurements"]) > 1000, "bulk measurements too short")
    for key in ("station_code", "measure_date", "HS", "VW_30MIN_MEAN", "VW_30MIN_MAX", "DW_30MIN_MEAN", "TA_30MIN_MEAN"):
        need(any(key in m for m in raw["measurements"][:200]), "measurement field %s missing" % key)
    need(raw["daily"] and all(k in raw["daily"][0] for k in ("station_code", "measure_date", "HS", "HN_1D")), "daily-snow fields missing")
    snap = fetch_imis.build_snapshot(raw, datetime.now(timezone.utc))
    with_snow = sum(1 for st in snap["stations"] if st["snowCm"] is not None)
    need(with_snow > 50, "only %d stations with snow depth" % with_snow)
    return "%d stations, %d with snow depth, %d daily rows" % (len(snap["stations"]), with_snow, len(raw["daily"]))


def check_meteoswiss():
    _, gj = get_json("https://data.geo.admin.ch/ch.meteoschweiz.messwerte-schneehoehe-automatisch-10min/ch.meteoschweiz.messwerte-schneehoehe-automatisch-10min_en.json")
    f = gj["features"][0]
    for key in ("station_name", "altitude", "reference_ts"):
        need(key in f["properties"], "property %s missing" % key)
    need(len(f["geometry"]["coordinates"]) >= 2, "no coordinates")
    return "%d stations" % len(gj["features"])


def check_open_meteo_wind():
    q = urllib.parse.urlencode({
        "latitude": LAT, "longitude": LON, "forecast_days": 2, "timezone": "Europe/Zurich", "wind_speed_unit": "kmh",
        "hourly": "wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,freezing_level_height,snowfall",
        "models": "meteoswiss_icon_seamless",
    })
    _, d = get_json("https://api.open-meteo.com/v1/forecast?" + q)
    h = d["hourly"]
    for key in ("time", "wind_speed_10m", "wind_gusts_10m", "freezing_level_height", "snowfall"):
        need(key in h and len(h[key]) >= 24, "hourly %s missing or short" % key)
    return "%d hours" % len(h["time"])


def check_open_meteo_snow():
    q = urllib.parse.urlencode({
        "latitude": "46.60,46.65", "longitude": "8.50,8.60", "current": "snow_depth",
        "models": "meteoswiss_icon_seamless", "timezone": "UTC",
    })
    _, d = get_json("https://api.open-meteo.com/v1/forecast?" + q)
    need(isinstance(d, list) and len(d) == 2, "expected one answer per point")
    for item in d:
        need("elevation" in item, "elevation missing")
        need("snow_depth" in item.get("current", {}), "current.snow_depth missing")
        need(item["current_units"]["snow_depth"] == "m", "snow depth unit is no longer metres")
    return "snow depth %s m at %d m" % (d[0]["current"]["snow_depth"], d[0]["elevation"])


def check_open_meteo_newsnow():
    # The query of the new-snow table (web/js/newsnow.js).
    q = urllib.parse.urlencode({
        "latitude": "46.6300", "longitude": "8.5900",
        "daily": "precipitation_sum,wind_gusts_10m_max", "hourly": "freezing_level_height",
        "models": "meteoswiss_icon_seamless", "cell_selection": "nearest", "timezone": "Europe/Zurich",
        "past_days": "7", "forecast_days": "6", "wind_speed_unit": "kmh",
    })
    _, d = get_json("https://api.open-meteo.com/v1/forecast?" + q)
    days = d.get("daily", {})
    need(len(days.get("time", [])) == 13, "expected 13 days (7 back, today, 5 ahead)")
    need(d["daily_units"]["precipitation_sum"] == "mm", "precipitation is no longer in mm")
    need(d["daily_units"]["wind_gusts_10m_max"] == "km/h", "gusts are no longer in km/h")
    need("freezing_level_height" in d.get("hourly", {}), "hourly freezing level missing")
    complete = sum(1 for v in days["precipitation_sum"][7:] if v is not None)
    need(complete >= 4, "only %d days from today with a value" % complete)
    return "today plus %d days with values, cell %d m" % (complete - 1, d["elevation"])


def check_alti3d():
    q = urllib.parse.urlencode({"bbox": "8.57,46.61,8.58,46.62", "limit": 5})
    _, d = get_json("https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swissalti3d/items?" + q)
    feats = d.get("features", [])
    need(feats, "no elevation tiles found")
    hrefs = [a["href"] for f in feats for a in f["assets"].values()]
    tif = [h for h in hrefs if h.endswith(".tif") and "_2_2056_" in h]
    need(tif, "no 2 m GeoTIFF asset (naming changed?)")
    status, hdrs, _ = get(tif[0], headers={"Range": "bytes=0-1023", "Origin": "https://example.org"}, limit=1024)
    need(status in (200, 206), "tile not readable: HTTP %s" % status)
    need(hdrs.get("Access-Control-Allow-Origin") in ("*", "https://example.org"), "tile has no CORS header")
    return "%d items" % len(feats)


def check_terrain():
    _, d = get_json("https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/layer.json")
    need(d.get("format", "").startswith("quantized-mesh"), "terrain is not quantized-mesh")
    need("octvertexnormals" in d.get("extensions", []), "terrain has no vertex normals (snow view and shading need them)")
    return "format %s" % d["format"]


def check_wmts():
    z = 12
    x, y = lon2tile(LON, z), lat2tile(LAT, z)
    out = []
    for layer, ext in (("ch.swisstopo.swissimage", "jpeg"), ("ch.swisstopo.pixelkarte-farbe-winter", "jpeg"), ("ch.swisstopo-karto.skitouren", "png")):
        status, hdrs, body = get("https://wmts.geo.admin.ch/1.0.0/%s/default/current/3857/%d/%d/%d.%s" % (layer, z, x, y, ext))
        need(status == 200 and hdrs.get("Content-Type", "").startswith("image/"), "%s: no image" % layer)
        out.append(layer.split(".")[-1])
    return ", ".join(out)


def check_identify():
    d = 0.01
    box = "%f,%f,%f,%f" % (LON - d, LAT - d, LON + d, LAT + d)
    q = urllib.parse.urlencode({
        "geometryType": "esriGeometryEnvelope", "geometry": box, "sr": "4326", "imageDisplay": "1000,1000,96",
        "mapExtent": box, "tolerance": "0", "returnGeometry": "false", "geometryFormat": "geojson", "lang": "en",
        "layers": "all:ch.swisstopo-karto.skitouren,ch.bafu.wrz-wildruhezonen_portal",
    })
    _, d2 = get_json("https://api3.geo.admin.ch/rest/services/api/MapServer/identify?" + q)
    need("results" in d2, "no results list")
    return "%d features" % len(d2["results"])


def check_forest_tiles():
    z = 14
    status, _, body = get("https://vectortiles0.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/%d/%d/%d.pbf" % (z, lon2tile(LON, z), lat2tile(LAT, z)))
    need(status == 200 and len(body) > 200, "vector tile empty")
    need(b"landcover" in body or body[:2] == b"\x1f\x8b", "layer 'landcover' not found in the tile")
    return "%d bytes" % len(body)


def check_sentinel():
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=30)
    body = json.dumps({
        "collections": ["sentinel-2-l2a"], "bbox": list(BOX), "limit": 5,
        "datetime": "%s/%s" % (start.strftime("%Y-%m-%dT%H:%M:%SZ"), end.strftime("%Y-%m-%dT%H:%M:%SZ")),
    }).encode()
    _, d = get_json("https://earth-search.aws.element84.com/v1/search", data=body, headers={"Content-Type": "application/json"})
    feats = d.get("features", [])
    need(feats, "no Sentinel-2 scene in the last 30 days")
    f = feats[0]
    need("visual" in f["assets"], "asset 'visual' missing")
    need("scl" in f["assets"], "asset 'scl' missing (cloud mask and snow line need it)")
    need("eo:cloud_cover" in f["properties"], "cloud cover missing")
    need(f["properties"].get("proj:epsg") or f["properties"].get("proj:code"), "projection missing")
    return "%d scenes, newest %s" % (len(feats), f["properties"]["datetime"][:10])


def check_cdn():
    out = []
    for name, url in (
        ("cesium", "https://cdn.jsdelivr.net/npm/cesium@1.121.0/Build/Cesium/Cesium.js"),
        ("geotiff", "https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm"),
        ("vector-tile", "https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@2.0.3/+esm"),
        ("pbf", "https://cdn.jsdelivr.net/npm/pbf@4.0.1/+esm"),
    ):
        status, _, _ = get(url, limit=2048)
        need(status == 200, "%s not available" % name)
        out.append(name)
    return ", ".join(out)


CHECKS = [
    ("SLF bulletin", check_bulletin),
    ("SLF bulletin history (activeAt)", check_bulletin_history),
    ("SLF IMIS stations", check_imis),
    ("MeteoSwiss snow depth", check_meteoswiss),
    ("Open-Meteo wind forecast", check_open_meteo_wind),
    ("Open-Meteo snow depth", check_open_meteo_snow),
    ("Open-Meteo new snow", check_open_meteo_newsnow),
    ("swissALTI3D (STAC + GeoTIFF)", check_alti3d),
    ("swisstopo 3D terrain", check_terrain),
    ("swisstopo WMTS tiles", check_wmts),
    ("geo.admin identify", check_identify),
    ("swisstopo vector tiles (forest)", check_forest_tiles),
    ("Sentinel-2 via Earth Search", check_sentinel),
    ("jsDelivr libraries", check_cdn),
]


def main():
    failed = 0
    for name, fn in CHECKS:
        try:
            try:
                detail = fn()
            except Exception:  # one retry: a single network hiccup is not a changed provider
                time.sleep(20)
                detail = fn()
            print("ok    %-34s %s" % (name, detail))
        except Exception as exc:  # every failure is reported, none stops the run
            failed += 1
            print("FAIL  %-34s %s: %s" % (name, exc.__class__.__name__, exc))
    print("%d of %d sources ok" % (len(CHECKS) - failed, len(CHECKS)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

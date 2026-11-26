"""Snapshot of the SLF IMIS stations for Ski Bum's Delight.

The SLF measurement API sends no CORS header, so the browser cannot ask it directly. This
script makes three requests (station list, last 24 h of all stations, daily snow values of
the last 7 days) and condenses them into one small JSON file the app reads:

    python scripts/fetch_imis.py web/data/imis.json

The GitHub Pages workflow runs it every hour before publishing; serve.py uses the same
functions for the local version, so both deliver the same file for the same answers.
Standard library only.
"""
import gzip
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

IMIS_BASE = "https://measurement-api.slf.ch/public/api/imis/"
ENDPOINTS = {
    "stations": "stations",
    "measurements": "measurements",
    "daily": "daily-snow?period_in_days=7",
}
USER_AGENT = "ski-bums-delight-snapshot/1.0 (+https://github.com/denyfousek/ski-bums-delight)"
TIMEOUT = 60

SOURCE = "WSL Institute for Snow and Avalanche Research SLF"
SOURCE_URL = "https://www.slf.ch"
LICENSE = "CC BY 4.0"
NOTE = "raw station data, unchecked"


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        body = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
    return json.loads(body.decode("utf-8"))


def fetch_raw(get=get_json):
    """The three raw SLF answers as a dict with keys stations, measurements, daily."""
    return {key: get(IMIS_BASE + path) for key, path in ENDPOINTS.items()}


def fix_mojibake(s):
    """Some IMIS endpoints double-encode UTF-8 ("BÃ¤rentÃ¤lli"). Repair when possible."""
    if not s or ("Ã" not in s and "Â" not in s):
        return s
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def _round(v, digits=1):
    return None if v is None else round(float(v), digits)


def latest_values(series):
    """Newest values of one station's 30-min records (any order).

    Each variable comes from the newest record that has it: a record with wind but no snow
    depth must not hide the last measured depth. A missing key and null both mean no value.
    """
    rows = sorted(series, key=lambda m: str(m.get("measure_date")))

    def newest(key):
        for m in reversed(rows):
            if m.get(key) is not None:
                return m
        return None

    def oldest(key):
        for m in rows:
            if m.get(key) is not None:
                return m
        return None

    snow, snow_first = newest("HS"), oldest("HS")
    wind, air = newest("VW_30MIN_MEAN"), newest("TA_30MIN_MEAN")
    anyrow = rows[-1] if rows else None
    when = (snow or wind or anyrow or {}).get("measure_date")
    return {
        "time": when,
        "snowCm": _round(snow["HS"]) if snow else None,
        "snowChange24h": _round(snow["HS"] - snow_first["HS"]) if snow and snow_first and snow is not snow_first else None,
        "windKmh": _round(wind["VW_30MIN_MEAN"] * 3.6) if wind else None,
        "gustKmh": _round(wind["VW_30MIN_MAX"] * 3.6) if wind and wind.get("VW_30MIN_MAX") is not None else None,
        "windDir": _round(wind["DW_30MIN_MEAN"], 0) if wind and wind.get("DW_30MIN_MEAN") is not None else None,
        "airC": _round(air["TA_30MIN_MEAN"]) if air else None,
    }


def build_snapshot(raw, fetched):
    """Condense the raw answers. fetched is the UTC time of the request (datetime)."""
    by_station = {}
    for m in raw["measurements"]:
        by_station.setdefault(m.get("station_code"), []).append(m)
    daily = {}
    for d in raw["daily"]:
        day = str(d.get("measure_date", ""))[:10]
        if not day:
            continue
        daily.setdefault(d.get("station_code"), []).append(
            {"date": day, "hs": _round(d.get("HS")), "hn": _round(d.get("HN_1D"))})
    stations = []
    for s in raw["stations"]:
        code = s.get("code")
        if not code or s.get("lon") is None or s.get("lat") is None:
            continue
        entry = {
            "code": code,
            "name": fix_mojibake(s.get("label") or code),
            "lon": round(float(s["lon"]), 5),
            "lat": round(float(s["lat"]), 5),
            "elevation": _round(s.get("elevation"), 0),
            "type": s.get("type"),
            **latest_values(by_station.get(code, [])),
        }
        if code in daily:
            entry["daily"] = sorted(daily[code], key=lambda x: x["date"])
        stations.append(entry)
    stations.sort(key=lambda x: x["code"])
    return {
        "fetched": fetched.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": SOURCE,
        "sourceUrl": SOURCE_URL,
        "license": LICENSE,
        "note": NOTE,
        "stations": stations,
    }


def snapshot_bytes(raw, fetched):
    """The file content, compact UTF-8 JSON. Same input, same bytes."""
    return json.dumps(build_snapshot(raw, fetched), ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def main(argv):
    if len(argv) != 2:
        print("usage: python scripts/fetch_imis.py OUTPUT.json", file=sys.stderr)
        return 2
    out = Path(argv[1])
    body = snapshot_bytes(fetch_raw(), datetime.now(timezone.utc))
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_bytes(body)
    tmp.replace(out)
    print("wrote %s (%d bytes)" % (out, len(body)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

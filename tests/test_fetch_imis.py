"""Tests for scripts/fetch_imis.py: condensing the SLF answers into web/data/imis.json.

The fixture tests/fixtures/imis-raw.json is a real answer from 2026-11-26, cut down to three
stations: GOS3 (snow station with daily values), URS1 (wind station) and DAV2 (in the
station list, but without measurements; its label was double-encoded on purpose to test
the repair). No test touches the network.
"""
import json
import os
import sys
import unittest
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import fetch_imis  # noqa: E402

FETCHED = datetime(2026, 11, 26, 21, 27, tzinfo=timezone.utc)


def load_raw():
    with open(os.path.join(ROOT, "tests", "fixtures", "imis-raw.json"), encoding="utf-8") as fh:
        return json.load(fh)


class LatestValuesTest(unittest.TestCase):
    def test_each_value_comes_from_the_newest_record_that_has_it(self):
        v = fetch_imis.latest_values([
            {"measure_date": "2026-11-25T06:00:00Z", "HS": 40, "VW_30MIN_MEAN": 2, "VW_30MIN_MAX": 5, "DW_30MIN_MEAN": 180, "TA_30MIN_MEAN": -3},
            {"measure_date": "2026-11-24T06:00:00Z", "HS": 30, "VW_30MIN_MEAN": 1, "VW_30MIN_MAX": 2, "DW_30MIN_MEAN": 90, "TA_30MIN_MEAN": -1},
            {"measure_date": "2026-11-25T06:30:00Z", "HS": None, "VW_30MIN_MEAN": 5, "DW_30MIN_MEAN": 200},
        ])
        self.assertEqual(v["snowCm"], 40)
        self.assertEqual(v["snowChange24h"], 10)
        self.assertEqual(v["windKmh"], 18)
        self.assertIsNone(v["gustKmh"], "no gust in the newest wind record: no value, not 0")
        self.assertEqual(v["windDir"], 200)
        self.assertEqual(v["airC"], -3)
        self.assertEqual(v["time"], "2026-11-25T06:00:00Z")

    def test_no_records_give_no_values(self):
        v = fetch_imis.latest_values([])
        self.assertIsNone(v["snowCm"])
        self.assertIsNone(v["time"])
        self.assertIsNone(v["snowChange24h"])


class MojibakeTest(unittest.TestCase):
    def test_double_encoded_label_is_repaired(self):
        self.assertEqual(fetch_imis.fix_mojibake("BÃ¤rentÃ¤lli"), "Bärentälli")

    def test_correct_label_stays(self):
        self.assertEqual(fetch_imis.fix_mojibake("Gütsch"), "Gütsch")
        self.assertEqual(fetch_imis.fix_mojibake(""), "")


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.snap = fetch_imis.build_snapshot(load_raw(), FETCHED)
        self.by_code = {s["code"]: s for s in self.snap["stations"]}

    def test_header_carries_time_source_and_licence(self):
        self.assertEqual(self.snap["fetched"], "2026-11-26T21:27:00Z")
        self.assertIn("SLF", self.snap["source"])
        self.assertEqual(self.snap["license"], "CC BY 4.0")
        self.assertEqual(self.snap["note"], "raw station data, unchecked")

    def test_every_listed_station_is_kept(self):
        self.assertEqual(sorted(self.by_code), ["DAV2", "GOS3", "URS1"])

    def test_snow_station_has_current_and_daily_values(self):
        s = self.by_code["GOS3"]
        for key in ("code", "name", "lon", "lat", "elevation", "type", "time", "snowCm",
                    "snowChange24h", "windKmh", "gustKmh", "windDir", "airC"):
            self.assertIn(key, s)
        self.assertIsNotNone(s["snowCm"])
        days = [d["date"] for d in s["daily"]]
        self.assertEqual(len(days), 8)
        self.assertEqual(days, sorted(days), "daily values in date order")
        self.assertRegex(days[0], r"^\d{4}-\d{2}-\d{2}$", "date without time of day")

    def test_wind_station_has_wind_but_no_snow_or_daily_values(self):
        s = self.by_code["URS1"]
        self.assertIsNone(s["snowCm"])
        self.assertIsNotNone(s["windKmh"])
        self.assertNotIn("daily", s)

    def test_station_without_measurements_has_empty_values(self):
        s = self.by_code["DAV2"]
        self.assertIsNone(s["time"])
        self.assertIsNone(s["snowCm"])
        self.assertEqual(s["name"], "Bärentälli")

    def test_missing_daily_value_stays_null(self):
        raw = load_raw()
        raw["daily"][0]["HN_1D"] = None
        snap = fetch_imis.build_snapshot(raw, FETCHED)
        gos = next(s for s in snap["stations"] if s["code"] == "GOS3")
        self.assertIn(None, [d["hn"] for d in gos["daily"]], "a missing value is null, never 0")

    def test_same_answers_give_the_same_bytes(self):
        a = fetch_imis.snapshot_bytes(load_raw(), FETCHED)
        b = fetch_imis.snapshot_bytes(load_raw(), FETCHED)
        self.assertEqual(a, b)
        self.assertLess(len(a), 10000)


class FetchRawTest(unittest.TestCase):
    def test_asks_the_three_endpoints(self):
        asked = []
        raw = fetch_imis.fetch_raw(get=lambda url: asked.append(url) or [])
        self.assertEqual(sorted(raw), ["daily", "measurements", "stations"])
        self.assertEqual(asked, [
            "https://measurement-api.slf.ch/public/api/imis/stations",
            "https://measurement-api.slf.ch/public/api/imis/measurements",
            "https://measurement-api.slf.ch/public/api/imis/daily-snow?period_in_days=7",
        ])


if __name__ == "__main__":
    unittest.main()

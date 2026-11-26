"""Tests for serve.py: cache, the station snapshot route and a local smoke test (no network)."""
import http.client
import json
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import serve  # noqa: E402
import fetch_imis  # noqa: E402  (serve.py puts scripts/ on the path)

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "imis-raw.json")


def load_raw():
    with open(FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)


class CacheTest(unittest.TestCase):
    def test_entry_expires(self):
        now = [1000.0]
        cache = serve.TtlCache(ttl_seconds=60, clock=lambda: now[0])
        cache.put("k", b"v")
        self.assertEqual(cache.get("k"), b"v")
        now[0] += 61
        self.assertIsNone(cache.get("k"))


class SmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = serve.make_server(port=0)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", path)
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        return resp.status, body

    def test_index_is_served(self):
        status, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn(b"Ski Bum", body)

    def test_old_proxy_path_is_gone(self):
        status, _ = self.request("/proxy/imis/stations")
        self.assertEqual(status, 404)

    def test_snapshot_equals_the_script_output_for_the_same_answers(self):
        serve.CACHE.items.clear()
        old = serve.FETCH_RAW
        serve.FETCH_RAW = load_raw
        try:
            status, body = self.request("/data/imis.json")
        finally:
            serve.FETCH_RAW = old
        self.assertEqual(status, 200)
        served = json.loads(body.decode("utf-8"))
        from datetime import datetime, timezone
        fetched = datetime.strptime(served["fetched"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        self.assertEqual(body, fetch_imis.snapshot_bytes(load_raw(), fetched))

    def test_snapshot_is_cached(self):
        serve.CACHE.items.clear()
        calls = []
        old = serve.FETCH_RAW
        serve.FETCH_RAW = lambda: calls.append(1) or load_raw()
        try:
            self.request("/data/imis.json")
            self.request("/data/imis.json")
        finally:
            serve.FETCH_RAW = old
        self.assertEqual(len(calls), 1)

    def test_slf_failure_gives_502(self):
        serve.CACHE.items.clear()
        def broken():
            raise OSError("no network")
        old = serve.FETCH_RAW
        serve.FETCH_RAW = broken
        try:
            status, _ = self.request("/data/imis.json")
        finally:
            serve.FETCH_RAW = old
        self.assertEqual(status, 502)



class MalformedRequestTest(unittest.TestCase):
    def test_bad_request_line_gets_an_error_page_not_a_dropped_connection(self):
        import socket
        server = serve.make_server(0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=5) as sock:
                sock.sendall(b"GET / FOO/9.9\r\n\r\n")
                answer = b""
                while True:
                    chunk = sock.recv(4096)
                    if not chunk:
                        break
                    answer += chunk
            # http.server answers such a line in HTTP/0.9 style: an error page, no status line.
            self.assertIn(b"Error code: 400", answer)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()

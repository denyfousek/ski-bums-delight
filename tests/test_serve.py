"""Tests for serve.py: proxy whitelist, cache, and a local smoke test (no network)."""
import http.client
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import serve  # noqa: E402


class UpstreamUrlTest(unittest.TestCase):
    def test_station_list_is_allowed(self):
        self.assertEqual(
            serve.upstream_url("/proxy/imis/stations"),
            "https://measurement-api.slf.ch/public/api/imis/stations",
        )

    def test_station_measurements_are_allowed(self):
        self.assertEqual(
            serve.upstream_url("/proxy/imis/station/URS2/measurements"),
            "https://measurement-api.slf.ch/public/api/imis/station/URS2/measurements",
        )

    def test_unknown_paths_are_rejected(self):
        for path in [
            "/proxy/imis/",
            "/proxy/imis/../secret",
            "/proxy/imis/station/URS2/../../x",
            "/proxy/imis/station/urs2;rm/measurements",
            "/proxy/imis/stations?x=1",
            "/proxy/other/stations",
            "/proxy/imis/station/TOOLONGCODE/measurements",
        ]:
            with self.subTest(path=path):
                self.assertIsNone(serve.upstream_url(path))


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

    def test_rejected_proxy_path_returns_404(self):
        status, _ = self.request("/proxy/imis/../serve.py")
        self.assertEqual(status, 404)



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

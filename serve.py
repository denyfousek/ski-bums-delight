"""Local server for Ski Bum's Delight.

Serves the static web app from ./web. The SLF station snapshot /data/imis.json is built
here on request from the SLF IMIS API (which sends no CORS header), with the same code the
GitHub Pages workflow uses (scripts/fetch_imis.py), and kept for 10 minutes.

Usage:  python serve.py [port]      (default 8765, binds to 127.0.0.1 only)
"""
import http.server
import sys
import time
from datetime import datetime, timezone
from functools import partial
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "scripts"))
import fetch_imis  # noqa: E402

WEB_ROOT = HERE / "web"
SNAPSHOT_PATH = "/data/imis.json"
CACHE_SECONDS = 600
# Replaced in tests so that no test calls the SLF.
FETCH_RAW = fetch_imis.fetch_raw


class TtlCache:
    """Tiny in-memory cache so repeated page loads do not hammer the SLF API."""

    def __init__(self, ttl_seconds, clock=time.monotonic):
        self.ttl = ttl_seconds
        self.clock = clock
        self.items = {}

    def get(self, key):
        hit = self.items.get(key)
        if hit is None:
            return None
        stored_at, value = hit
        if self.clock() - stored_at > self.ttl:
            del self.items[key]
            return None
        return value

    def put(self, key, value):
        self.items[key] = (self.clock(), value)


CACHE = TtlCache(CACHE_SECONDS)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    }

    def end_headers(self):
        # Always revalidate: otherwise browsers mix cached and new ES modules after an update.
        # A malformed request line is rejected before self.path exists.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?", 1)[0] == SNAPSHOT_PATH:
            self.handle_snapshot()
        else:
            super().do_GET()

    def handle_snapshot(self):
        body = CACHE.get(SNAPSHOT_PATH)
        if body is None:
            try:
                body = fetch_imis.snapshot_bytes(FETCH_RAW(), datetime.now(timezone.utc))
            except Exception as exc:  # network errors surface as 502 to the page
                self.send_error(502, "SLF error: %s" % exc.__class__.__name__)
                return
            CACHE.put(SNAPSHOT_PATH, body)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if SNAPSHOT_PATH in (str(args[0]) if args else "") or "error" in fmt:
            super().log_message(fmt, *args)


def make_server(port=8765):
    handler = partial(Handler, directory=str(WEB_ROOT))
    return http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = make_server(port)
    print("Ski Bum's Delight on http://127.0.0.1:%d  (Ctrl+C to stop)" % server.server_address[1])
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

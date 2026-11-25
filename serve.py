"""Local server for Ski Bum's Delight.

Serves the static web app from ./web and forwards a small, fixed set of read-only
requests to the SLF IMIS measurement API, which sends no CORS header and therefore
cannot be called from the browser directly.

Usage:  python serve.py [port]      (default 8765, binds to 127.0.0.1 only)
"""
import http.server
import re
import sys
import time
import urllib.request
from functools import partial
from pathlib import Path

WEB_ROOT = Path(__file__).resolve().parent / "web"
IMIS_BASE = "https://measurement-api.slf.ch/public/api/imis/"
PROXY_PREFIX = "/proxy/imis/"
ALLOWED = [
    re.compile(r"^stations$"),
    re.compile(r"^station/[A-Z0-9]{2,6}/measurements$"),
]
CACHE_SECONDS = 600
USER_AGENT = "ski-bums-delight/0.1 (local planning tool)"


def upstream_url(path):
    """Return the IMIS URL for a proxy path, or None if the path is not whitelisted."""
    if not path.startswith(PROXY_PREFIX):
        return None
    rest = path[len(PROXY_PREFIX):]
    if any(rx.match(rest) for rx in ALLOWED):
        return IMIS_BASE + rest
    return None


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
        if not getattr(self, "path", "").startswith("/proxy/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/proxy/"):
            self.handle_proxy()
        else:
            super().do_GET()

    def handle_proxy(self):
        url = upstream_url(self.path)
        if url is None:
            self.send_error(404, "Unknown proxy path")
            return
        body = CACHE.get(url)
        if body is None:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=20) as resp:
                    body = resp.read()
            except Exception as exc:  # network errors surface as 502 to the page
                self.send_error(502, "Upstream error: %s" % exc.__class__.__name__)
                return
            CACHE.put(url, body)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if "/proxy/" in (str(args[0]) if args else "") or "error" in fmt:
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

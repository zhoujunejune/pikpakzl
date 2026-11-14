#!/usr/bin/env python3
"""Add a simple EVENT10 navigation link to the existing production prediction HTML.

Runs only on 127.0.0.1. All API/POST traffic remains on the original port 13001.
Caddy's existing Basic Auth is still the first gate.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.parse import urlsplit
import re

HOST = "127.0.0.1"
PORT = 13019
UPSTREAM = "http://127.0.0.1:13001/"
LIMIT = 1_500_000
LINK = ('<nav id="zl-event10-restored-nav" aria-label="十分钟事件合约入口" '
        'style="padding:10px 16px;background:#101d2f;'
        'border-bottom:1px solid #31445c;text-align:right;'
        'font:600 14px system-ui,-apple-system,sans-serif">'
        '<a href="/event10/" style="display:inline-block;color:#b8dbff;'
        'padding:8px 13px;border:1px solid #365b80;border-radius:8px;'
        'text-decoration:none">十分钟事件合约</a></nav>')

def decorate(raw):
    if not isinstance(raw, str) or not re.search(r"<html\b", raw, re.I):
        raise ValueError("upstream HTML missing")
    if 'id="zl-event10-restored-nav"' in raw:
        return raw
    out, n = re.subn(r"(<body\b[^>]*>)", lambda m: m.group(1) + LINK,
                     raw, count=1, flags=re.I)
    if n != 1:
        raise ValueError("upstream body missing")
    return out

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        route = urlsplit(self.path).path
        if route == "/healthz":
            return self.respond(200, b"ok", "text/plain; charset=utf-8")
        if route != "/":
            return self.send_error(404)
        try:
            req = Request(UPSTREAM, headers={"Accept": "text/html",
                                            "User-Agent": "EVENT10-Nav-ReadOnly/1"})
            with urlopen(req, timeout=5) as r:
                if r.status != 200 or "html" not in r.headers.get("Content-Type", ""):
                    raise ValueError("prediction HTML unavailable")
                body = r.read(LIMIT + 1)
            if len(body) > LIMIT:
                raise ValueError("prediction HTML too large")
            page = decorate(body.decode("utf-8")).encode("utf-8")
            return self.respond(200, page, "text/html; charset=utf-8")
        except (OSError, ValueError, UnicodeError):
            return self.send_error(502, "Existing prediction page unavailable")

    def respond(self, code, content, content_type):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        self.send_error(405)

    def log_message(self, *args):
        return

if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

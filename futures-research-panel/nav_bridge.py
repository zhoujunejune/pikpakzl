#!/usr/bin/env python3
"""Read-only HTML navigation bridge for deployed Alibaba futures/prediction UIs.

Avoids restarting either trading engine: on every GET, reads live UI HTML from
the existing local upstream, adds a third navigation link, returns HTML.
Other paths, including ALL trade APIs, go directly to their existing services.
Never reads keys, wallet, positions, state, secrets or sends POST requests.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
import re

HOST = "127.0.0.1"
PORT = 13019
MAIN = "https://47-237-188-69.sslip.io"
PRED = "https://prediction.47-237-188-69.sslip.io"
FUTURES_HTML = "http://127.0.0.1:10000/dashboard/"
PREDICTION_HTML = "http://127.0.0.1:13001/"
LIMIT = 2_000_000
LAB_LINK = '<a href="/futures-lab/" aria-label="影子模型自动训练">影子模型 · 自动训练</a>'
EVENT10_LINK = '<a href="/event10/" aria-label="DeepSeek 10分钟事件合约">事件合约 · EVENT10</a>'
PRED_NAV = (
    '<nav aria-label="切换机器人" style="display:flex;flex-wrap:wrap;gap:9px;'
    'padding:12px 14px;background:#132038;border-bottom:1px solid #30415e;'
    'font:600 14px system-ui,sans-serif">'
    '<a style="padding:8px;color:#9ed6ff" href="' + MAIN + '/dashboard/">合约机器人</a>'
    '<a style="padding:8px;color:#9ed6ff" href="' + PRED + '/">预测机器人</a>'
    '<a style="padding:8px;color:#9ed6ff" href="' + MAIN +
    '/futures-lab/" aria-label="影子模型自动训练">影子模型 · 自动训练</a>'
    '<a style="padding:8px;color:#9ed6ff" href="' + MAIN +
    '/event10/" aria-label="DeepSeek 10分钟事件合约">事件合约 · EVENT10</a>'
    '</nav>'
)

def decorate(raw, prediction=False):
    if not isinstance(raw,str) or "<html" not in raw.lower() or "<body" not in raw.lower():
        raise ValueError("upstream not recognized as HTML")
    if prediction:
        if MAIN + "/futures-lab/" in raw and MAIN + "/event10/" in raw:
            return raw
        # This production prediction page has no common <nav> at all.
        return re.sub(r"(<body(?:\s[^>]*)?>)",lambda match:match.group(1)+PRED_NAV,
                      raw,count=1,flags=re.IGNORECASE)
    if 'href="/futures-lab/"' in raw and 'href="/event10/"' in raw:
        return raw
    # Preserve every original live trading control, script and navigation item.
    if '<nav>' in raw and '</nav>' in raw:
        return raw.replace('</nav>',
                           ('' if 'href="/futures-lab/"' in raw else LAB_LINK)+
                           ('' if 'href="/event10/"' in raw else EVENT10_LINK)+'</nav>',1)
    return re.sub(r"(<body(?:\s[^>]*)?>)",lambda match:match.group(1)+PRED_NAV,
                  raw,count=1,flags=re.IGNORECASE)

def get_upstream(url):
    req=Request(url,headers={"Accept":"text/html","User-Agent":"ZL-Nav-Bridge-Internal/1.0"})
    with urlopen(req,timeout=6) as res:
        if res.status!=200:raise ValueError("original page unavailable")
        ct=res.headers.get("Content-Type","")
        if "html" not in ct:raise ValueError("original upstream did not return HTML")
        body=res.read(LIMIT+1)
        if len(body)>LIMIT:raise ValueError("oversized upstream page")
        return body.decode("utf-8")

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        route=urlsplit(self.path).path
        if route=="/healthz":
            self.respond(200,b"ok","text/plain; charset=utf-8")
            return
        if route not in ("/dashboard/","/"):
            self.send_error(404)
            return
        try:
            prediction=route=="/"
            source=PREDICTION_HTML if prediction else FUTURES_HTML
            payload=decorate(get_upstream(source),prediction).encode("utf-8")
            self.respond(200,payload,"text/html; charset=utf-8")
        except (OSError,ValueError,UnicodeError,HTTPError,URLError):
            # No sensitive local error information escapes to the browser.
            self.send_error(502,"Original dashboard temporarily unavailable")
    def respond(self,status,body,content_type):
        self.send_response(status)
        self.send_header("Content-Type",content_type)
        self.send_header("Content-Length",str(len(body)))
        self.send_header("Cache-Control","no-store")
        self.send_header("X-Content-Type-Options","nosniff")
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        self.send_error(405)
    def log_message(self,*args):
        return

if __name__=="__main__":
    ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()

#!/usr/bin/env python3
"""Read-only external HTTPS smoke test of Alibaba mobile paper dashboard.

Uses the password only in memory; prints no Authorization header or secret.
"""
import base64
import json
import os
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request

HOST="47-237-188-69.sslip.io"
URL="https://"+HOST

def query(path, authorized=False, origin=None):
    headers={"Accept":"application/json"}
    if authorized:
        pw=os.environ["ZL_PANEL_PASSWORD"]
        token=base64.b64encode(("zl:"+pw).encode()).decode()
        headers["Authorization"]="Basic "+token
    if origin:headers["Origin"]=origin
    req=urllib.request.Request(URL+path,headers=headers,method="GET")
    try:
        with urllib.request.urlopen(req, timeout=12,context=ssl.create_default_context()) as r:
            return (r.status,r.read(4096))
    except urllib.error.HTTPError as e:
        return (e.code,b"")

def main():
    if not os.getenv("ZL_PANEL_PASSWORD"):
        print("SMOKE_NOT_READY: password missing")
        return 2
    status=None
    for i in range(12):
        try:
            status,data=query("/healthz")
            if status==401:break
            print("SMOKE_WAIT: unexpected public status",status)
        except Exception as e:
            print("SMOKE_WAIT: HTTPS not reachable:",type(e).__name__)
        time.sleep(10)
    if status!=401:
        print("SMOKE_FAIL: unauthenticated requests must return HTTP 401 over valid HTTPS")
        return 3
    print("SMOKE_OK: HTTPS valid; no-password requests rejected with HTTP 401")
    try:
        code,raw=query("/healthz",authorized=True)
        if code!=200:
            print("SMOKE_FAIL: authenticated health status",code);return 4
        x=json.loads(raw)
        if x.get("mode")!="paper":
            print("SMOKE_FAIL: not paper mode");return 5
        code,raw=query("/status",authorized=True)
        if code!=200:
            print("SMOKE_FAIL: authenticated status code",code);return 6
        y=json.loads(raw)
        if y.get("liveTradingEnabled") is not False or "control" not in y:
            print("SMOKE_FAIL: missing control or live trading enabled");return 7
        print("SMOKE_OK: authenticated mobile dashboard status and controls present")
        print("SMOKE_WORKER_RUNNING:",y.get("workerRunning"))
        print("SMOKE_CONTROL_ENTRY_ENABLED:",y["control"].get("entry_enabled"))
        print("SMOKE_REAL_TRADING_ENABLED:",y["liveTradingEnabled"])
        print("SMOKE_URL:",URL)
        return 0
    except Exception as e:
        print("SMOKE_FAIL:",type(e).__name__);return 8

if __name__=="__main__":
    sys.exit(main())

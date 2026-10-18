#!/usr/bin/env python3
"""External zero-write HTTPS acceptance tests for Alibaba SWAS paper console."""
import json
import os
import ssl
import sys
import urllib.request
import urllib.error

URL="https://47-237-188-69.sslip.io"
USER="zl"

def probe(path, password=None, data=None,origin=None):
    # urllib defaults to SSL certificate verification and hostname validation.
    headers={"Accept":"application/json"}
    if password is not None:
        import base64
        token=base64.b64encode((USER+":"+password).encode("utf-8")).decode("ascii")
        headers["Authorization"]="Basic "+token
    if data is not None:
        headers["Content-Type"]="application/json"
        headers["X-ZL-Control"]="v1"
        if origin:headers["Origin"]=origin
        payload=json.dumps(data).encode("utf-8")
    else:
        payload=None
    req=urllib.request.Request(URL+path,data=payload,headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=14) as r:
            return r.status,r.read(25000)
    except urllib.error.HTTPError as e:
        return e.code,e.read(25000)

def main():
    pw=os.environ.get("ZL_PANEL_PASSWORD","")
    if not pw:
        print("PANEL_VERIFY: password GitHub secret missing");return 2
    try:
        unauth,_=probe("/healthz")
        print("HTTPS_NO_LOGIN_STATUS:",unauth)
        if unauth!=401:
            print("PANEL_VERIFY_FAILED: public endpoint not authenticated")
            return 3
        auth,raw=probe("/healthz",pw)
        print("HTTPS_LOGIN_STATUS:",auth)
        if auth!=200:return 4
        payload=json.loads(raw)
        print("HTTPS_AUTH_MODE:",payload.get("mode"))
        if payload.get("mode")!="paper":return 5
        # Verify the *actual phone landing page*, not just health endpoints.
        root_code,root_body=probe("/",pw)
        print("HTTPS_HOME_STATUS:",root_code)
        print("HTTPS_HOME_CONTENT:",root_body[:90].decode("utf-8","replace").replace("\\n"," "))
        if root_code!=200 or b"ZL" not in root_body:
            print("PANEL_VERIFY_FAILED: main page not actually served")
            return 12
        for p in ("/index.html", "/dashboard/", "/?v=1"):
            nav_status,nav_body=probe(p,pw)
            print("HTTPS_PAGE_VARIANT:",p,nav_status)
            if nav_status != 200 or b"ZL" not in nav_body:
                return 13
        status,raw=probe("/status",pw)
        print("HTTPS_STATUS_ENDPOINT:",status)
        if status!=200:return 6
        data=json.loads(raw)
        print("HTTPS_REAL_TRADING_ENABLED:",data.get("liveTradingEnabled"))
        print("HTTPS_HAS_CONTROL:",isinstance(data.get("control"),dict))
        health=data.get("marketHealth")
        print("MARKET_DIAG_SCHEMA_OK:",isinstance(health,dict))
        if isinstance(health,dict):
            print("MARKET_DIAG_STATUS:",health.get("status"))
            print("MARKET_DIAG_SYMBOL:",health.get("symbol"))
            print("MARKET_DIAG_SOURCE:",health.get("source"))
            print("MARKET_DIAG_LAST_AGE_SEC:",health.get("lastSuccessAgeSeconds"))
        if data.get("liveTradingEnabled") is not False or not isinstance(data.get("control"),dict):
            return 7
        if not isinstance(health,dict) or health.get("status") not in (
            "market_data_received","market_data_stale","waiting_first_market_data",
            "request_failed","engine_stopped","exchange_restricted"):
            print("PANEL_VERIFY_FAILED: unknown/missing market diagnostic")
            return 14
        if health.get("status")=="market_data_received" and (health.get("lastSuccessAt") is None or health.get("lastSuccessAgeSeconds") is None):
            print("PANEL_VERIFY_FAILED: claimed fresh market without observation")
            return 15
        status,raw=probe("/api/control",pw,data={"action":"invalid-non-mutating-test"},origin=URL)
        print("HTTPS_INVALID_COMMAND_REJECTED:",status)
        if status!=400:return 8
        status,raw=probe("/api/control",pw,data={"action":"pause"},origin="https://evil.invalid")
        print("HTTPS_BAD_ORIGIN_REJECTED:",status)
        if status!=403:return 9
        print("PANEL_EXTERNAL_HTTPS_VERIFY_OK")
        return 0
    except Exception as e:
        # Do not print exception text with URL containing credentials or any secrets.
        print("PANEL_VERIFY_ERROR_CLASS:",type(e).__name__)
        return 10

if __name__=="__main__":
    sys.exit(main())

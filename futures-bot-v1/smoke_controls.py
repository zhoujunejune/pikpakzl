#!/usr/bin/env python3
"""Authenticated HTTPS integration check of paper-only control mutations."""
import base64,json,os,ssl,sys,urllib.request,urllib.error
URL="https://47-237-188-69.sslip.io"

def call(action, origin=URL, authorized=True):
    pw=os.environ["ZL_PANEL_PASSWORD"]
    headers={"Content-Type":"application/json","X-ZL-Control":"v1","Origin":origin}
    if authorized:
        headers["Authorization"]="Basic "+base64.b64encode(("zl:"+pw).encode()).decode()
    req=urllib.request.Request(URL+"/api/control",data=json.dumps({"action":action}).encode(),headers=headers,method="POST")
    try:
        with urllib.request.urlopen(req,context=ssl.create_default_context(),timeout=12) as r:
            return r.status,json.loads(r.read(2048))
    except urllib.error.HTTPError as e:
        return e.code,{}
def status():
    pw=os.environ["ZL_PANEL_PASSWORD"]
    token=base64.b64encode(("zl:"+pw).encode()).decode()
    req=urllib.request.Request(URL+"/status",headers={"Authorization":"Basic "+token})
    with urllib.request.urlopen(req,context=ssl.create_default_context(),timeout=12) as r:
        return json.loads(r.read(6000))
def main():
    if not os.getenv("ZL_PANEL_PASSWORD"):return 2
    first=status()
    if first.get("liveTradingEnabled") is not False or first.get("mode")!="paper":
        print("CONTROL_FAIL: not simulation-only");return 3
    code,_=call("pause",authorized=False)
    if code!=401:
        print("CONTROL_FAIL: anonymous mutation not blocked",code);return 4
    code,_=call("pause",origin="https://example.com")
    if code!=403:
        print("CONTROL_FAIL: cross-origin mutation not blocked",code);return 5
    print("CONTROL_OK: anonymous mutations 401, forged Origin 403")
    initial=first.get("control") or {}
    if initial.get("emergency_stop"):
        print("CONTROL_SKIP: emergency latch active, preserving state");return 0
    if initial.get("entry_enabled") is not True:
        print("CONTROL_SKIP: strategy currently paused; preserving user setting");return 0
    try:
        code,_=call("pause")
        if code!=200 or status()["control"]["entry_enabled"] is not False:
            print("CONTROL_FAIL: pause failed",code);return 6
        print("CONTROL_OK: pause persisted")
    finally:
        code,_=call("resume")
        if code!=200:
            print("CONTROL_ERROR: could not restore original enabled state",code)
            return 7
    if status()["control"]["entry_enabled"] is not True:
        print("CONTROL_FAIL: original state not restored");return 8
    print("CONTROL_OK: resume restored original state; live trading still disabled")
    return 0

if __name__=="__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""External HTTPS smoke test; never print or send authentication secrets."""
import base64,json,os,socket,ssl,time,urllib.request,urllib.error,urllib.parse
DOMAIN="prediction.47-237-188-69.sslip.io"
BASE="https://"+DOMAIN
PW=os.getenv("ZL_PANEL_PASSWORD","")
if not PW:raise SystemExit("EXTERNAL_MISSING_LOGIN_TEST_SECRET")
AUTH="Basic "+base64.b64encode(("zl:"+PW).encode()).decode()
def request(path,authentication):
    headers={"Accept":"text/html,application/json;q=0.8","Cache-Control":"no-cache"}
    if authentication:headers["Authorization"]=AUTH
    req=urllib.request.Request(BASE+path,headers=headers)
    start=time.monotonic()
    try:
        with urllib.request.urlopen(req,timeout=18) as resp:
            body=resp.read(350_000)
            return {"status":resp.status,"bytes":len(body),"html":b"<html" in body.lower(),
                 "elapsedMs":round((time.monotonic()-start)*1000)}
    except urllib.error.HTTPError as e:
        return {"status":e.code,"bytes":0,"html":False,"elapsedMs":round((time.monotonic()-start)*1000)}
    except Exception as e:
        return {"status":0,"error":type(e).__name__,"elapsedMs":round((time.monotonic()-start)*1000)}
results={}
try:
    print("EXTERNAL_DNS",socket.gethostbyname_ex(DOMAIN)[2])
except Exception as e:print("EXTERNAL_DNS_ERROR",type(e).__name__)
try:
    ctx=ssl.create_default_context()
    with socket.create_connection((DOMAIN,443),timeout=12) as raw:
        with ctx.wrap_socket(raw,server_hostname=DOMAIN) as s:
            cert=s.getpeercert()
            print("EXTERNAL_TLS",{"protocol":s.version(),"issuer":str(cert.get("issuer",""))[:210],
             "notAfter":cert.get("notAfter")})
except Exception as e:print("EXTERNAL_TLS_ERROR",type(e).__name__)
for path in ("/","/api/shadow-breakout20/edge-5m","/api/shadow-breakout20/dynamic-entry",
             "/api/round-stats","/api-keys/"):
    public=request(path,False)
    authenticated=request(path,True)
    print("EXTERNAL_URL",path,"withoutLogin",json.dumps(public),
          "withLogin",json.dumps(authenticated))
    results[path]=(public,authenticated)
for index in range(4):
    one=request("/",True)
    print("EXTERNAL_REPEATED_HOME",index+1,json.dumps(one))
    if index<3:time.sleep(2)
status=results.get("/",({},{}))
if status[0].get("status")!=401 or status[1].get("status")!=200:
    raise SystemExit("EXTERNAL_PREDICTION_HOMEPAGE_NOT_REACHABLE")
print("EXTERNAL_ACCESS_OK")

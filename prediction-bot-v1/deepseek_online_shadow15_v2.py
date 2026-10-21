#!/usr/bin/env python3
"""Independent EARLY 8-15s causal BTC 5m shadow learner.

Learns logistic-regression weights ONLY after official Binance Prediction settlement.
Never creates orders, alters the production DeepSeek model, or calls paid LLM APIs.
"""
import json
import math
import os
import pathlib
import tempfile
import time
import hashlib
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

ROUND_MS=300000
FEATURES=("bias","from_open","rsi1","rsi5","ema1","ema5","macd1","macd5",
          "momentum1","momentum5","volume1","volume5","position1","position5")
OFFICIAL="BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY"
FEED="http://127.0.0.1:13003/api/shadow-market-data"
STATS="http://127.0.0.1:13002/api/round-stats"
STATE="/var/lib/zl-prediction/deepseek-shadow15-online/state.json"
PORT=13044
MODEL="ZL_ONLINE_LOGISTIC_SHADOW15_V2"
def clip(x,lo=-3.0,hi=3.0):
    return max(lo,min(hi,float(x))) if math.isfinite(float(x)) else 0.
def sigmoid(x):
    x=clip(x,-30,30)
    return 1/(1+math.exp(-x))
def ema(xs,n):
    if len(xs)<n:return None
    v=sum(xs[:n])/n
    for x in xs[n:]:v+=2/(n+1)*(x-v)
    return v
def rsi(xs,n=14):
    if len(xs)<=n:return None
    gains,losses=0.,0.
    for i in range(1,n+1):
        d=xs[i]-xs[i-1];gains+=max(0,d);losses+=max(0,-d)
    gains/=n;losses/=n
    for i in range(n+1,len(xs)):
        d=xs[i]-xs[i-1]
        gains=(gains*(n-1)+max(d,0))/n
        losses=(losses*(n-1)+max(-d,0))/n
    return 50. if gains==losses==0 else (100. if losses==0 else 100-100/(1+gains/losses))
def macd_hist(xs):
    if len(xs)<35:return None
    fast,slow=[],[]
    for i in range(26,len(xs)+1):
        a=ema(xs[:i],12);b=ema(xs[:i],26)
        fast.append(a-b)
    return fast[-1]-ema(fast,9) if len(fast)>=9 else None
def bars(m,k,now,expected_ms):
    section=(m.get("candles") or {}).get(k) or []
    if isinstance(section,dict):section=section.get("rows") or section.get("items") or section.get("candles") or []
    out=[]
    for x in section:
        if not isinstance(x,dict) or x.get("closed") is not True:continue
        t=x.get("startMs",x.get("openTime"))
        try:
            t=int(t)
            o,h,l,c,v=[float(x[z]) for z in ("open","high","low","close","volume")]
            if t<=0 or t>now or t+expected_ms>now or min(o,h,l,c)<=0 or v<0 or h<l:continue
            out.append((t,o,h,l,c,v))
        except (TypeError,ValueError,KeyError):continue
    out.sort(key=lambda x:x[0])
    unique={x[0]:x for x in out}
    return list(unique.values())[-150:]
def interval(xs,price):
    if len(xs)<35:raise ValueError("CLOSED_CANDLES_INSUFFICIENT")
    c=[r[4] for r in xs];v=[r[5] for r in xs]
    recent=xs[-20:];hi=max(x[2] for x in recent);lo=min(x[3] for x in recent)
    pos=(c[-1]-lo)/(hi-lo) if hi>lo else .5
    baseline=sum(v[-21:-1])/20 if len(v)>=21 else 0
    return (
      clip(((rsi(c)-50)/25) if rsi(c) is not None else 0),
      clip(((ema(c,9)-ema(c,21))/price)*1000),
      clip((macd_hist(c) or 0)/price*10000),
      clip((c[-1]/c[-2]-1)*1000),
      clip((v[-1]/baseline-1) if baseline>0 else 0),
      clip((pos-.5)*2)
    )
def feature_vector(m,now):
    if m.get("ok") is not True or m.get("readOnly") is not True or m.get("symbol")!="BTCUSDT":
        raise ValueError("UNTRUSTED_MARKET")
    latest=m.get("latest") or {}
    tick=int(latest["eventMs"])
    if now-tick>2500 or tick>now+800 or latest.get("marketFeedConnected") is False:
        raise ValueError("STALE_MARKET")
    r=(now//ROUND_MS)*ROUND_MS
    if int(latest["roundStartMs"])!=r:raise ValueError("WRONG_ROUND")
    price=float(latest["lastPrice"]);opening=float(latest["roundOpenPrice"])
    if price<=0 or opening<=0:raise ValueError("INVALID_PRICE")
    a=bars(m,"1m",now,60000);b=bars(m,"5m",now,300000)
    if not a or not b or now-(a[-1][0]+60000)>180000 or now-(b[-1][0]+300000)>900000:
        raise ValueError("STALE_CLOSED_CANDLES")
    i,j=interval(a,price),interval(b,price)
    return r,[1.,clip((price/opening-1)*1000),i[0],j[0],i[1],j[1],i[2],j[2],i[3],j[3],i[4],j[4],i[5],j[5]]
def http_json(url,timeout=6):
    with urllib.request.urlopen(urllib.request.Request(url,headers={"Accept":"application/json"}),timeout=timeout) as r:
        return json.load(r)
def fresh_state():
    return {"schema":2,"model":MODEL,"features":list(FEATURES),
            "weights":[0.]*len(FEATURES),"trained":0,
            "samples":[],"updatedAt":None,"trainedWeightVersions":[]}
class Shadow:
    def __init__(self,file=STATE,clock=lambda:int(time.time()*1000)):
        self.file=pathlib.Path(file);self.clock=clock;self.lock=threading.RLock()
        self.error=None;self.lastMarketAt=None;self.lastOfficialAt=None
        try:
            state=json.loads(self.file.read_text())
            if state.get("schema")!=2 or state.get("model")!=MODEL or state.get("features")!=list(FEATURES):raise ValueError()
            if len(state["weights"])!=len(FEATURES):raise ValueError()
            self.state=state
        except (OSError,ValueError,KeyError,TypeError):self.state=fresh_state()
    def save(self):
        self.state["updatedAt"]=self.clock()
        self.file.parent.mkdir(parents=True,exist_ok=True,mode=0o750)
        fd,tmp=tempfile.mkstemp(prefix=".shadow-",dir=str(self.file.parent))
        try:
            with os.fdopen(fd,"w") as f:json.dump(self.state,f,separators=(",",":"),allow_nan=False)
            os.chmod(tmp,0o640);os.replace(tmp,self.file)
        finally:
            if os.path.exists(tmp):os.unlink(tmp)
    def observe(self,market):
        now=self.clock()
        r=(now//ROUND_MS)*ROUND_MS
        if now-r<8000 or now-r>=15000:return False
        with self.lock:
            if any(x["round"]==r for x in self.state["samples"]):return False
            actual_round,x=feature_vector(market,now)
            if actual_round!=r:raise ValueError("ROUND_MISMATCH")
            w=self.state["weights"];p=sigmoid(sum(a*b for a,b in zip(w,x)))
            self.state["samples"].append({"round":r,"features":x,"probUp":p,
               "direction":"UP" if p>=.5 else "DOWN","capturedAt":now,
               "signalLatencyMs":now-r,"trainedBefore":self.state["trained"],
               "weightsBeforeHash":hashlib.sha256(json.dumps(w,separators=(",",":")).encode()).hexdigest()[:16],
               "actual":None})
            self.state["samples"]=self.state["samples"][-2000:]
            self.lastMarketAt=now;self.save()
            return True
    def settle(self,official):
        now=self.clock()
        if official.get("ok") is not True or official.get("settlementSource")!=OFFICIAL:
            raise ValueError("UNVERIFIED_OFFICIAL_SOURCE")
        available={}
        for row in official.get("records") or []:
            if not isinstance(row,dict):continue
            actual=row.get("productionActual")
            try:r=int(row["roundStartMs"])
            except (TypeError,ValueError,KeyError):continue
            if (actual in ("UP","DOWN") and
                (row.get("productionSettledAt") is not None or row.get("settledAt") is not None) and
                (row.get("officialSettlementAudit") is not None or row.get("resolutionEvidence") is not None) and
                now>=r+ROUND_MS):
                at=row.get("productionSettledAt",row.get("settledAt"))
                try:at=int(at)
                except (TypeError,ValueError):continue
                if r+ROUND_MS<=at<=now+1000:available[r]=actual
        changed=0
        with self.lock:
            for sample in self.state["samples"]:
                r=sample["round"]
                if sample["actual"] is not None or r not in available:continue
                y=1. if available[r]=="UP" else 0.
                x=sample["features"];p=sample["probUp"]
                sample["actual"]=available[r]
                sample["hit"]=sample["direction"]==sample["actual"]
                sample["logloss"]=-y*math.log(max(1e-7,min(1-1e-7,p)))-(1-y)*math.log(max(1e-7,min(1-1e-7,1-p)))
                sample["brier"]=(p-y)**2
                sample["settledAt"]=now
                # Prequential score is saved BEFORE any weight update.
                n=self.state["trained"]
                eta=.04/math.sqrt(1+n/30)
                w=self.state["weights"]
                self.state["weights"]=[
                    clip(v-eta*((p-y)*z + (.001*v if i else 0)),-10,10)
                    for i,(v,z) in enumerate(zip(w,x))
                ]
                self.state["trained"]+=1
                sample["trainedAfter"]=self.state["trained"]
                sample["weightsAfterHash"]=hashlib.sha256(json.dumps(self.state["weights"],separators=(",",":")).encode()).hexdigest()[:16]
                self.state["trainedWeightVersions"].append({
                    "sampleRound":r,"version":self.state["trained"],
                    "weightsHash":sample["weightsAfterHash"],"trainedAt":now})
                self.state["trainedWeightVersions"]=self.state["trainedWeightVersions"][-500:]
                changed+=1
            if changed:self.save()
            self.lastOfficialAt=now
        return changed
    def status(self):
        with self.lock:
            rows=self.state["samples"];settled=[x for x in rows if x["actual"] is not None]
            def metrics(items):
                n=len(items);hits=sum(x["hit"] for x in items)
                p=hits/n if n else None
                half=1.96
                if n:
                    den=1+half**2/n
                    mid=(p+half**2/(2*n))/den
                    delta=half*math.sqrt((p*(1-p)+half**2/(4*n))/n)/den
                    wilson=[round(max(0.,mid-delta),4),round(min(1.,mid+delta),4)]
                else:wilson=None
                return {"n":n,"hits":hits,"accuracy":round(p,4) if n else None,
                        "wilson95":wilson,
                        "meanLogLoss":round(sum(x["logloss"] for x in items)/n,4) if n else None,
                        "meanBrier":round(sum(x["brier"] for x in items)/n,4) if n else None}
            return {"ok":True,"model":MODEL,"mode":"SHADOW_TRAIN_ONLY",
                    "orders":False,"productionModelUnchanged":True,
                    "features":list(FEATURES),"trainableWeights":len(FEATURES),
                    "settledTrained":self.state["trained"],"observations":len(rows),
                    "unsettled":len(rows)-len(settled),
                    "captureWindowMs":[8000,15000],
                    "productionSignalDeadlineMs":15000,
                    "evaluation":"PREQUENTIAL_PREDICT_THEN_TRAIN_AFTER_OFFICIAL",
                    "actualModelWeightsUpdated":self.state["trained"]>0,
                    "currentWeightVersion":self.state["trained"],
                    "lastWeightVersion":self.state["trainedWeightVersions"][-1] if self.state["trainedWeightVersions"] else None,
                    "all":metrics(settled),"recent50":metrics(settled[-50:]),
                    "readyForEvaluation":len(settled)>=200,
                    "updatedAt":self.state["updatedAt"],"lastMarketAt":self.lastMarketAt,
                    "lastOfficialAt":self.lastOfficialAt,"lastError":self.error,
                    "note":"Different from old +30s shadow. Early <15s predictions logged BEFORE official outcome; training after resolution; no real orders or LLM weight fine-tune."}
def serve(shadow):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if urlsplit(self.path).path not in ("/healthz","/api/status"):
                self.send_error(404);return
            raw=json.dumps(shadow.status(),ensure_ascii=False).encode()
            self.send_response(200);self.send_header("Content-Type","application/json")
            self.send_header("Cache-Control","no-store")
            self.send_header("Content-Length",str(len(raw)));self.end_headers();self.wfile.write(raw)
        def log_message(self,*args):pass
    server=ThreadingHTTPServer(("127.0.0.1",PORT),Handler)
    t=threading.Thread(target=server.serve_forever,daemon=True);t.start()
    return server
def main():
    shadow=Shadow();server=serve(shadow);last_official=0
    print("ZL_SHADOW_TRAINING_STARTED no_orders=true",flush=True)
    try:
        while True:
            now=shadow.clock()
            try:
                if 8000<=now%ROUND_MS<15000:
                    shadow.observe(http_json(FEED))
                if now-last_official>=60000:
                    last_official=now
                    shadow.settle(http_json(STATS))
                shadow.error=None
            except Exception as ex:
                shadow.error=(type(ex).__name__+":"+str(ex))[:130]
            time.sleep(0.9 if 6000<=now%ROUND_MS<16000 else 5)
    finally:server.shutdown()
if __name__=="__main__":main()

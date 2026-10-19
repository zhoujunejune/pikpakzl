#!/usr/bin/env python3
"""Independent Binance USD-M forward-test daemon. GET public data only.

Pure standard-library indicators reproduce the entry/exit *conditions*
of 3 pinned Freqtrade community examples. This is not official Freqtrade
execution, auto ML training, or real exchange execution. Never import live bot.
"""
import datetime
import http.server
import json
import math
import os
import pathlib
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

SYMBOLS=("BTCUSDT","ETHUSDT","BTCUSDC")
MODELS=("TrendFollowingStrategy","FSampleStrategy","FAdxSmaStrategy")
STATE=pathlib.Path("/var/lib/zl-futures-shadow/state.json")
HTTP_HOST="127.0.0.1"
HTTP_PORT=13017
LOOP=30
FEE=0.0005
SLIP=0.0003
STOP=0.02
TAKE=0.03
LOCK=threading.RLock()
CACHE={"updatedAt":None,"market":{},"error":None,"streams":{}}
MEM={"streams":{},"events":[]}
MARKET_URL="https://fapi.binance.com"

def utc(t=None):
    return datetime.datetime.fromtimestamp(time.time() if t is None else t,
          datetime.timezone.utc).isoformat()

def persisted():
    if not STATE.exists():return {"streams":{},"events":[]}
    d=json.loads(STATE.read_text())
    if not isinstance(d,dict) or not isinstance(d.get("streams"),dict):raise ValueError("invalid ledger")
    return d

def save():
    STATE.parent.mkdir(parents=True,exist_ok=True)
    path=STATE.with_suffix(".tmp")
    path.write_text(json.dumps(MEM,ensure_ascii=False,separators=(",",":")))
    os.chmod(path,0o600)
    os.replace(path,STATE)

def api(path,params=None):
    assert path in ("/fapi/v1/premiumIndex","/fapi/v1/klines")
    query=urllib.parse.urlencode(params or {})
    url=MARKET_URL+path+("?"+query if query else "")
    req=urllib.request.Request(url,headers={"User-Agent":"ZLForwardResearch-ReadOnly/1.0"})
    with urllib.request.urlopen(req,timeout=9) as res:
        return json.load(res)

def ema(arr,n):
    value=float(arr[0])
    out=[value]
    k=2/(n+1)
    for v in arr[1:]:
        value=k*float(v)+(1-k)*value
        out.append(value)
    return out

def rsi(series,n=14):
    if len(series)<n+3:return [None]*len(series)
    up=[max(0,series[i]-series[i-1]) for i in range(1,len(series))]
    down=[max(0,series[i-1]-series[i]) for i in range(1,len(series))]
    u=sum(up[:n])/n
    d=sum(down[:n])/n
    out=[None]*(n)
    out.append(100 if d==0 else 100-100/(1+u/d))
    for i in range(n,len(up)):
        u=(u*(n-1)+up[i])/n
        d=(d*(n-1)+down[i])/n
        out.append(100 if d==0 else 100-100/(1+u/d))
    return out

def sma(arr,n):
    return [sum(arr[i-n+1:i+1])/n if i+1>=n else None for i in range(len(arr))]

def adx(rows,n=14):
    if len(rows)<3*n:return None
    tr=[];pdm=[];mdm=[]
    for i in range(1,len(rows)):
        p,c=rows[i-1],rows[i]
        up=c[2]-p[2]; down=p[3]-c[3]
        pdm.append(up if up>down and up>0 else 0)
        mdm.append(down if down>up and down>0 else 0)
        tr.append(max(c[2]-c[3],abs(c[2]-p[4]),abs(c[3]-p[4])))
    smtr=sum(tr[:n]); sp=sum(pdm[:n]); sm=sum(mdm[:n])
    dx=[]
    for i in range(n-1,len(tr)):
        if i>=n:
            smtr=smtr-smtr/n+tr[i];sp=sp-sp/n+pdm[i];sm=sm-sm/n+mdm[i]
        if smtr<=0:dx.append(0);continue
        plus=100*sp/smtr;minus=100*sm/smtr
        dx.append(100*abs(plus-minus)/(plus+minus) if plus+minus else 0)
    if len(dx)<n:return None
    result=sum(dx[:n])/n
    for d in dx[n:]:
        result=(result*(n-1)+d)/n
    return result

def signals(rows,model):
    if len(rows)<180:
        return (None,None)
    close=[r[4] for r in rows]
    volume=[r[5] for r in rows]
    if model=="TrendFollowingStrategy":
        ma=ema(close,20)
        obv_change=volume[-1] if close[-1]>close[-2] else (-volume[-1] if close[-1]<close[-2] else 0)
        enter="LONG" if close[-1]>ma[-1] and close[-2]<=ma[-2] and obv_change>0 else None
        # Original example has no can_short=True; preserve LONG-only behavior.
        exit_long=close[-1]<ma[-1] and close[-2]>=ma[-2] and obv_change>0
        return (enter,"LONG" if exit_long else None)
    if model=="FSampleStrategy":
        rr=rsi(close)
        if rr[-1] is None or rr[-2] is None:return (None,None)
        e1=ema(close,9);e2=ema(e1,9);e3=ema(e2,9)
        tema=[3*a-3*b+c for a,b,c in zip(e1,e2,e3)]
        tp=[(r[2]+r[3]+r[4])/3 for r in rows]
        mid=sma(tp,20)[-1]
        if mid is None:return (None,None)
        lo=(rr[-2]<=30<rr[-1] and tema[-1]<=mid and tema[-1]>tema[-2] and volume[-1]>0)
        hi=(rr[-2]<=70<rr[-1] and tema[-1]>mid and tema[-1]<tema[-2] and volume[-1]>0)
        return ("LONG" if lo else "SHORT" if hi else None,"SHORT" if lo else "LONG" if hi else None)
    if model=="FAdxSmaStrategy":
        strength=adx(rows)
        fast=sma(close,12);slow=sma(close,48)
        if strength is None or any(v is None for v in (fast[-1],slow[-1],fast[-2],slow[-2])):
            return (None,None)
        higher=fast[-2]<=slow[-2] and fast[-1]>slow[-1]
        lower=fast[-2]>=slow[-2] and fast[-1]<slow[-1]
        return ("LONG" if higher and strength>30 else "SHORT" if lower and strength>30 else None,
                "BOTH" if strength<30 else None)
    return (None,None)

def valid_candles(items,now):
    out=[]
    for x in items:
        if not isinstance(x,list) or len(x)<7:continue
        try:
            op=int(x[0]);cl=int(x[6])
            vals=[float(x[i]) for i in range(1,6)]
            if not all(math.isfinite(v) and v>=0 for v in vals) or vals[3]<=0:continue
            # Binance closeTime = last millisecond of candle. Never use open candle.
            if cl>=now*1000-1500:continue
            out.append([op,*vals])
        except (ValueError,TypeError,IndexError):continue
    return out

def pair_state(sym,model):
    key=sym+"_"+model
    if key not in MEM["streams"]:
        MEM["streams"][key]={"symbol":sym,"strategy":model,"asset":"USDC" if sym.endswith("USDC") else "USDT",
          "equity":1000.0,"position":None,"history":[],"lastCandle":None,"lastSignal":None,"barsSeen":0}
    return MEM["streams"][key]

def entry(p,side,mark,at):
    if p["position"] or p["equity"]<105:return
    price=mark*(1+SLIP if side=="LONG" else 1-SLIP)
    stake=min(100,p["equity"]*.1)
    qty=stake/price
    cost=stake*FEE
    p["equity"]-=cost
    p["position"]={"side":side,"qty":qty,"entry":price,"at":at,
          "stop":price*(1-STOP if side=="LONG" else 1+STOP),
          "take":price*(1+TAKE if side=="LONG" else 1-TAKE),"entryFee":cost}
    p["lastSignal"]={"side":side,"at":at,"price":round(mark,6)}
    MEM["events"].append({"type":"PAPER_ENTRY","symbol":p["symbol"],"model":p["strategy"],"at":at})

def close(p,mark,reason,at):
    pos=p["position"]
    if pos is None:return
    long=pos["side"]=="LONG"
    price=mark*(1-SLIP if long else 1+SLIP)
    pnl=(price-pos["entry"])*pos["qty"]*(1 if long else -1)-abs(price*pos["qty"])*FEE
    p["equity"]+=pnl
    item={"side":pos["side"],"openAt":pos["at"],"closedAt":at,"entry":round(pos["entry"],7),
          "exit":round(price,7),"net":round(pnl-pos["entryFee"],6),"reason":reason}
    p["history"].append(item)
    p["history"]=p["history"][-300:]
    p["position"]=None
    MEM["events"].append({"type":"PAPER_EXIT","symbol":p["symbol"],"model":p["strategy"],"at":at})
    MEM["events"]=MEM["events"][-200:]

def eval_one(p,rows,price,now):
    if len(rows)<180:return
    current=rows[-1][0]
    previous=p["lastCandle"]
    if previous is None:
        # Startup is only a warmup; do not invent fills from the past.
        p["lastCandle"]=current
        return
    pos=p["position"]
    if pos:
        if (pos["side"]=="LONG" and price<=pos["stop"]) or (pos["side"]=="SHORT" and price>=pos["stop"]):
            close(p,price,"STOP_OBSERVED_AT_POLL",utc(now))
        elif (pos["side"]=="LONG" and price>=pos["take"]) or (pos["side"]=="SHORT" and price<=pos["take"]):
            close(p,price,"TAKE_OBSERVED_AT_POLL",utc(now))
    if current<=previous:return
    # If missed multiple candles during outage, do not backfill fictitious orders.
    p["lastCandle"]=current
    p["barsSeen"]+=1
    period=300000 if p["strategy"]=="TrendFollowingStrategy" else 3600000
    if current-previous>period or now*1000-current>period*2:return
    entered,exit_for=signals(rows,p["strategy"])
    if p["position"] and exit_for in (p["position"]["side"],"BOTH"):
        close(p,price,"EXIT_SIGNAL",utc(now))
    if not p["position"] and entered:
        entry(p,entered,price,utc(now))

def run_cycle():
    now=time.time()
    raw=api("/fapi/v1/premiumIndex")
    if not isinstance(raw,list):raise ValueError("no aggregate mark prices")
    fresh={}
    for x in raw:
        if x.get("symbol") not in SYMBOLS:continue
        price=float(x["markPrice"])
        at=float(x["time"])/1000
        if math.isfinite(price) and price>0 and -10<now-at<45:
            fresh[x["symbol"]]={"markPrice":price,"exchangeTime":utc(at),"ageSeconds":round(now-at,2)}
    if len(fresh)<len(SYMBOLS):
        raise ValueError("missing_or_stale_real_mark_prices")
    bars={}
    for sym in SYMBOLS:
        for model in MODELS:
            pair_state(sym,model)
        for period in ("5m","1h"):
            data=api("/fapi/v1/klines",{"symbol":sym,"interval":period,"limit":240})
            bars[(sym,period)]=valid_candles(data,now)
            if len(bars[(sym,period)])<180:raise ValueError("insufficient_closed_candles_"+sym+period)
    for sym in SYMBOLS:
        for model in MODELS:
            period="5m" if model=="TrendFollowingStrategy" else "1h"
            eval_one(pair_state(sym,model),bars[(sym,period)],fresh[sym]["markPrice"],now)
    CACHE["market"]=fresh
    CACHE["updatedAt"]=utc(now)
    CACHE["error"]=None
    save()

def public_view():
    with LOCK:
        streams=[]
        for p in MEM["streams"].values():
            closed=list(p.get("history",[]))
            pos=p.get("position")
            mark=CACHE["market"].get(p["symbol"],{}).get("markPrice")
            unrealized=0.0
            if pos and mark:
                sign=1 if pos["side"]=="LONG" else -1
                unrealized=(mark-pos["entry"])*pos["qty"]*sign
            wins=sum(1 for x in closed if x["net"]>0)
            net=p["equity"]-1000+unrealized
            streams.append({"symbol":p["symbol"],"strategy":p["strategy"],"currency":p["asset"],
              "status":"SIMULATED_REAL_MARKET","ordersSubmitted":0,
              "equity":round(p["equity"]+unrealized,5),"realizedPnl":round(p["equity"]-1000,5),
              "totalPnlEstimate":round(net,5),"closedTrades":len(closed),"wins":wins,
              "winratePct":round(wins/len(closed)*100,2) if closed else None,
              "seenNewBars":p["barsSeen"],"lastSignal":p.get("lastSignal"),
              "position":pos,"history":closed[-12:]})
        ts=CACHE["updatedAt"]
        fresh=bool(ts and time.time()-datetime.datetime.fromisoformat(ts).timestamp()<100)
        return {"kind":"live_paper_forward_test","realOrders":False,"autoParameterTraining":False,
            "source":"Binance official public USD-M futures REST /fapi/v1/klines + /fapi/v1/premiumIndex",
            "updatedAt":ts,"fresh":fresh,"error":CACHE["error"],
            "market":CACHE["market"],"streams":streams,
            "modelNote":"Original community entry conditions reimplemented with built-in Python indicators, not the Freqtrade engine. Standardized paper stop 2%, take profit 3%.",
            "feePerSide":FEE,"slippageEstimatePerSide":SLIP,
            "caveat":"Virtual 1x forward testing, price sampled at 30s. Intrabar stop hits may be missed; funding/liquidation excluded. No ML auto-training."}

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # Browsers attach cache-busting query parameters. Route by parsed path
        # so ?t=<epoch> never turns a legitimate readonly feed into HTTP 404.
        route=urllib.parse.urlsplit(self.path).path
        if route not in ("/futures-lab/live.json","/healthz"):
            self.send_error(404);return
        data=public_view() if route=="/futures-lab/live.json" else {"ok":True}
        b=json.dumps(data,ensure_ascii=False,separators=(",",":")).encode()
        self.send_response(200)
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Cache-Control","no-store")
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("Content-Length",str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def do_POST(self):
        self.send_error(405)
    def log_message(self,*args):
        return

def loop():
    while True:
        with LOCK:
            try:run_cycle()
            except Exception as exc:
                CACHE["error"]=type(exc).__name__+":"+str(exc)[:120]
                # No bogus signals / closes on failed market data.
        time.sleep(LOOP)

def main():
    global MEM
    MEM=persisted()
    t=threading.Thread(target=loop,name="public-futures-shadow",daemon=True)
    t.start()
    http.server.ThreadingHTTPServer((HTTP_HOST,HTTP_PORT),Handler).serve_forever()

if __name__=="__main__":
    main()

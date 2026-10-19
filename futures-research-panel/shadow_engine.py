#!/usr/bin/env python3
"""Standalone LIVE-MARKET / FAKE-ORDER shadow engine.

Strict security: public Binance USD-M GET klines ONLY. Never imports production
bot, credentials or cloud SDK; never issues exchange orders.
This is rolling PAPER simulation, not Freqtrade's official engine or ML training.
"""
import datetime as dt
import json
import math
import os
from pathlib import Path
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SYMBOLS=("BTCUSDT","ETHUSDT","BTCUSDC")
STRATS=("TrendFollowingStrategy","FSampleStrategy","FAdxSmaStrategy")
SOURCE="https://fapi.binance.com/fapi/v1/klines"
STATE=Path(os.environ.get("SHADOW_STATE_FILE","/var/lib/zl-futures-lab/sim_state.json"))
FEE=0.0005
SLIPPAGE=0.0003
POLL_SECONDS=25
GUARD=threading.RLock()
STATUS={"running":False,"lastPoll":None,"lastSuccess":None,"error":None,
        "markets":{},"engine":"read-only public Binance futures OHLCV",
        "realOrdersAllowed":False,"trainingMethod":"fixed-parameter forward paper trading"}
STOP=threading.Event()

def utc(ts=None):
    return dt.datetime.fromtimestamp(time.time() if ts is None else ts,dt.timezone.utc).isoformat()

def empty():
    pairs={}
    for symbol in SYMBOLS:
        for strategy in STRATS:
            key=symbol+":"+strategy
            pairs[key]={"symbol":symbol,"strategy":strategy,"currency":"USDC" if symbol=="BTCUSDC" else "USDT",
                        "initialBalance":1000.0,"balance":1000.0,"open":None,
                        "trades":[],"signals":[],"lastProcessed":0,"lastSignal":None,
                        "startedAt":utc(),"sampledCandles":0}
    return {"schema":1,"createdAt":utc(),"pairs":pairs}

def load():
    if not STATE.exists():return empty()
    value=json.loads(STATE.read_text())
    if value.get("schema")!=1 or not isinstance(value.get("pairs"),dict):
        raise ValueError("shadow state schema mismatch")
    if set(value["pairs"])!={s+":"+m for s in SYMBOLS for m in STRATS}:
        raise ValueError("shadow state pairs mismatch")
    return value

def persist(state):
    STATE.parent.mkdir(parents=True,exist_ok=True)
    temp=STATE.with_suffix(".new")
    with temp.open("w") as out:
        json.dump(state,out,ensure_ascii=False,separators=(",",":"))
        out.flush();os.fsync(out.fileno())
    os.chmod(temp,0o600)
    os.replace(temp,STATE)

def get_klines(symbol,interval,now=None):
    now=time.time() if now is None else now
    if symbol not in SYMBOLS or interval not in ("5m","1h"):raise ValueError("invalid market request")
    query=urllib.parse.urlencode({"symbol":symbol,"interval":interval,"limit":160})
    req=urllib.request.Request(SOURCE+"?"+query,headers={"User-Agent":"ZLShadowPaperResearch/1.0"})
    with urllib.request.urlopen(req,timeout=9) as response:
        if response.status!=200:raise RuntimeError("public futures data unavailable")
        rows=json.load(response)
    if not isinstance(rows,list) or len(rows)<65:raise ValueError("insufficient Kline history")
    parsed=[]
    for row in rows:
        if not isinstance(row,list) or len(row)<7:continue
        open_ms,close_ms=int(row[0]),int(row[6])
        o,h,l,c,v=map(float,(row[1],row[2],row[3],row[4],row[5]))
        if not all(math.isfinite(x) and x>0 for x in (o,h,l,c)):continue
        if not math.isfinite(v) or v<0:continue
        parsed.append({"o":o,"h":h,"l":l,"c":c,"v":v,"open_ms":open_ms,"close_ms":close_ms})
    parsed.sort(key=lambda x:x["open_ms"])
    if len({v["open_ms"] for v in parsed})!=len(parsed):raise ValueError("duplicate kline open")
    ms=int(now*1000)
    current=[x for x in parsed if x["open_ms"]<=ms<=x["close_ms"]+30000]
    if not current:raise ValueError("no current exchange candle")
    completed=[x for x in parsed if x["close_ms"]+750<=ms]
    if len(completed)<60:raise ValueError("not enough completed candles")
    step=300_000 if interval=="5m" else 3_600_000
    if ms-completed[-1]["close_ms"]>step+45_000:
        raise ValueError("last closed candle stale")
    return completed,current[-1]

def ema(seq,n):
    if len(seq)<n:return None
    v=sum(seq[:n])/n;k=2/(n+1)
    for x in seq[n:]:v=k*x+(1-k)*v
    return v

def rsi(seq,period=14):
    if len(seq)<period+2:return None
    delta=[seq[i]-seq[i-1] for i in range(1,len(seq))]
    avg_gain=sum(max(x,0) for x in delta[:period])/period
    avg_loss=sum(max(-x,0) for x in delta[:period])/period
    for d in delta[period:]:
        avg_gain=(avg_gain*(period-1)+max(d,0))/period
        avg_loss=(avg_loss*(period-1)+max(-d,0))/period
    if avg_gain==avg_loss==0:return 50.0
    if avg_loss==0:return 100.0
    return 100-100/(1+avg_gain/avg_loss)

def adx(bars,n=14):
    if len(bars)<n*3+1:return None
    trs=[];plus=[];minus=[]
    for prev,now in zip(bars,bars[1:]):
        up=now["h"]-prev["h"];down=prev["l"]-now["l"]
        plus.append(up if up>down and up>0 else 0.)
        minus.append(down if down>up and down>0 else 0.)
        trs.append(max(now["h"]-now["l"],abs(now["h"]-prev["c"]),abs(now["l"]-prev["c"])))
    def smooth(series):
        v=sum(series[:n]);result=[None]*(n-1)+[v]
        for z in series[n:]:
            v=v-v/n+z
            result.append(v)
        return result
    a,b,c=map(smooth,(trs,plus,minus))
    dx=[]
    for av,bv,cv in zip(a,b,c):
        if av is None or av<=0:continue
        p=100*bv/av;m=100*cv/av
        dx.append(0 if p+m==0 else 100*abs(p-m)/(p+m))
    if len(dx)<n:return None
    value=sum(dx[:n])/n
    for x in dx[n:]:value=(value*(n-1)+x)/n
    return value

def signals(strategy,bars):
    if len(bars)<60:return None
    closes=[x["c"] for x in bars]
    if strategy=="TrendFollowingStrategy":
        def obv_change(seq):
            return seq[-1]["v"]*(1 if seq[-1]["c"]>seq[-2]["c"] else -1 if seq[-1]["c"]<seq[-2]["c"] else 0)
        prev_ema=ema(closes[:-1],20);now_ema=ema(closes,20)
        if prev_ema is None or now_ema is None:return None
        up=closes[-1]>now_ema and closes[-2]<=prev_ema and obv_change(bars)>0
        # Original community strategy does NOT set can_short = True, preserve.
        down=False
        exit_long=closes[-1]<now_ema and closes[-2]>=prev_ema and obv_change(bars)>0
        return {"entry":"LONG" if up else "SHORT" if down else None,"exitLong":exit_long,
                "exitShort":False,"why":"EMA20 + OBV, original community can_short=False"}
    if strategy=="FSampleStrategy":
        r0=rsi(closes[:-1]);r1=rsi(closes)
        if r0 is None or r1 is None:return None
        above30=r0<=30 and r1>30
        above70=r0<=70 and r1>70
        return {"entry":"LONG" if above30 else "SHORT" if above70 else None,
                "exitLong":above70,"exitShort":above30,
                "why":"RSI14 crossing upward 30 / 70 thresholds"}
    if strategy=="FAdxSmaStrategy":
        prev_s=ema(closes[:-1],12) # corrected to SMA below
        def sma(v,n):return sum(v[-n:])/n
        ad=adx(bars)
        if ad is None:return None
        p12,p48=sma(closes[:-1],12),sma(closes[:-1],48)
        n12,n48=sma(closes,12),sma(closes,48)
        return {"entry":"LONG" if ad>30 and p12<=p48 and n12>n48 else
                "SHORT" if ad>30 and p12>=p48 and n12<n48 else None,
                "exitLong":ad<30,"exitShort":ad<30,
                "why":"ADX14 >30, SMA12/SMA48 crossover"}
    return None

def target(strategy,minutes):
    if strategy=="FSampleStrategy":return None
    if strategy=="TrendFollowingStrategy":
        return 0.05 if minutes>=60 else 0.10 if minutes>=30 else 0.15
    return 0.075 if minutes>=60 else 0.10 if minutes>=30 else 0.05

def stop_distance(strategy):
    return .265 if strategy=="TrendFollowingStrategy" else .05

def balance_view(entry,last_price):
    if not entry or not last_price:return 0.
    side=1 if entry["side"]=="LONG" else -1
    x=last_price*(1-side*SLIPPAGE)
    return (x-entry["price"])*entry["qty"]*side-abs(x*entry["qty"])*FEE-entry["fee"]

def process(account,closed,price,interval,strategy):
    last=int(closed[-1]["close_ms"])
    prior=int(account.get("lastProcessed") or 0)
    if last<=prior:return False
    # On startup, begin forward tracking ONLY. Never 'backfill' retrospective
    # trades from unobserved history, and do not fabricate fills.
    if prior==0:
        account["lastProcessed"]=last
        return True
    if last-prior>(300_000 if interval=="5m" else 3_600_000)*2:
        account["lastProcessed"]=last
        account["lastSignal"]={"at":utc(last/1000),"direction":None,"reason":"GAP_SKIPPED"}
        return True
    sig=signals(strategy,closed)
    account["lastProcessed"]=last
    account["sampledCandles"]+=1
    if sig is None:return True
    side=sig["entry"]
    account["lastSignal"]={"at":utc(last/1000),"direction":side or "WAIT","reason":sig["why"]}
    position=account["open"]
    if position:
        direction=1 if position["side"]=="LONG" else -1
        age=(time.time()-position["time"])/60.
        sl=position["stop"]
        tp_rate=target(strategy,age)
        tp=position["price"]*(1+direction*tp_rate) if tp_rate is not None else None
        stop_hit=price<=sl if direction==1 else price>=sl
        tp_hit=tp is not None and (price>=tp if direction==1 else price<=tp)
        exit_signal=sig["exitLong"] if direction==1 else sig["exitShort"]
        if stop_hit or tp_hit or exit_signal:
            # Market-observed price, NOT guaranteed stop fill at stop trigger.
            exit_price=price*(1-direction*SLIPPAGE)
            pnl=balance_view(position,price)
            account["balance"]=round(account["balance"]+pnl,8)
            account["trades"].append({"entryTime":utc(position["time"]),"exitTime":utc(),
                "side":position["side"],"entry":position["price"],"exit":exit_price,
                "pnl":round(pnl,6),"reason":"STOP" if stop_hit else "ROI" if tp_hit else "EXIT_SIGNAL",
                "currency":account["currency"]})
            account["trades"]=account["trades"][-350:]
            account["open"]=None
            account["signals"].append({"at":utc(),"side":"EXIT","reason":"PAPER_CLOSE"})
    if account["open"] is None and side in ("LONG","SHORT") and len(account["trades"])==0 and not account.get("entryInThisCandle"):
        pass
    # Do not reopen in the same observation where a simulated close occurred.
    exited=bool(account["signals"] and account["signals"][-1].get("side")=="EXIT" and
                account["signals"][-1]["at"][:19]==utc()[:19])
    if account["open"] is None and side in ("LONG","SHORT") and not exited:
        if account["balance"]>100:
            direction=1 if side=="LONG" else -1
            px=price*(1+direction*SLIPPAGE)
            stake=min(100., account["balance"]*.1)
            account["open"]={"side":side,"price":px,"qty":stake/px,"time":time.time(),
                "fee":stake*FEE,"stop":px*(1-direction*stop_distance(strategy))}
            account["signals"].append({"at":utc(),"side":side,"price":px,"reason":sig["why"]})
    account["signals"]=account["signals"][-200:]
    return True

def snapshot(state):
    rows=[];markets=STATUS["markets"]
    for account in state["pairs"].values():
        hist=account["trades"]
        wins=[t for t in hist if t["pnl"]>0]
        gain=sum(t["pnl"] for t in hist if t["pnl"]>0)
        loss=-sum(t["pnl"] for t in hist if t["pnl"]<0)
        fresh=markets.get(account["symbol"],{})
        openp=account["open"]
        unreal=balance_view(openp,fresh.get("price")) if openp and fresh.get("fresh") else None
        rows.append({"symbol":account["symbol"],"strategy":account["strategy"],
          "currency":account["currency"],"initialBalance":1000.0,"balance":round(account["balance"],5),
          "realizedPnL":round(account["balance"]-1000,5),
          "netProfitPct":round((account["balance"]/1000-1)*100,4),
          "tradeCount":len(hist),"wins":len(wins),
          "winratePct":round(100*len(wins)/len(hist),2) if hist else None,
          "profitFactor":round(gain/loss,4) if loss else None,
          "open":openp,"unrealized":round(unreal,5) if unreal is not None else None,
          "sampledCandles":account.get("sampledCandles",0),
          "lastSignal":account.get("lastSignal"),"trades":hist[-30:],"signals":account["signals"][-30:]})
    return {"mode":"paper_forward","liveTradingEnabled":False,
            "realOrdersAllowed":False,"trainingMethod":"fixed-parameter ongoing shadow observation",
            "startedAt":state["createdAt"],"lastPoll":STATUS["lastPoll"],"lastSuccess":STATUS["lastSuccess"],
            "workerRunning":STATUS["running"],"error":STATUS["error"],"markets":markets,
            "rows":rows,"feePerSide":FEE,"slippagePerSide":SLIPPAGE,
            "sampleNote":"Only new signals observed since service start. No ML retraining; 0 trades is valid.",
            "warning":"模拟记账，不是 Freqtrade 官方回测或真实交易；资金费、强平、成交深度、跳空不保证模拟精度。"}

def poll_once(state):
    now=time.time()
    for symbol in SYMBOLS:
        try:
            b5,current5=get_klines(symbol,"5m",now)
            b1,_=get_klines(symbol,"1h",now)
            mark=current5["c"]
            # Current forming K-line is an approximate traded price, not Binance mark.
            if now*1000-current5["open_ms"]>345_000:raise ValueError("trade quote stale")
            STATUS["markets"][symbol]={"price":mark,"asOf":utc(now),"fresh":True,
              "priceType":"USD-M futures last traded price, current 5m candle",
              "closed5m":utc(b5[-1]["close_ms"]/1000),
              "closed1h":utc(b1[-1]["close_ms"]/1000)}
            for strategy in STRATS:
                interval="5m" if strategy=="TrendFollowingStrategy" else "1h"
                account=state["pairs"][symbol+":"+strategy]
                process(account,b5 if interval=="5m" else b1,mark,interval,strategy)
        except Exception as e:
            STATUS["markets"][symbol]={"price":None,"fresh":False,
              "error":type(e).__name__,"asOf":utc(now)}
    STATUS["lastPoll"]=utc()
    count=sum(1 for x in STATUS["markets"].values() if x.get("fresh"))
    if not count:
        STATUS["error"]="Public Binance futures feeds unavailable; no simulation orders generated"
    else:
        STATUS["error"]=None if count==3 else "Some pairs have stale market data"
        STATUS["lastSuccess"]=utc()
    return count

def loop():
    STATUS["running"]=True
    try:
        state=load()
    except Exception:
        STATUS["error"]="Persistent simulation state unreadable; refused to overwrite"
        STATUS["running"]=False
        return
    while not STOP.is_set():
        try:
            with GUARD:
                poll_once(state)
                persist(state)
        except Exception as e:
            STATUS["error"]="Unexpected shadow polling failure: "+type(e).__name__
        STOP.wait(POLL_SECONDS)
    STATUS["running"]=False

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path=urllib.parse.urlsplit(self.path).path
        if path=="/healthz":
            self.output({"ok":True,"workerRunning":STATUS["running"],
                         "realOrdersAllowed":False})
        elif path=="/status":
            with GUARD:
                try:
                    state=load();data=snapshot(state)
                except Exception:
                    data={"mode":"paper_forward","realOrdersAllowed":False,"error":"state unreadable"}
            self.output(data)
        else:self.send_error(404)
    def output(self,obj):
        body=json.dumps(obj,ensure_ascii=False,default=str).encode()
        self.send_response(200)
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Cache-Control","no-store")
        self.send_header("Content-Length",str(len(body)))
        self.end_headers();self.wfile.write(body)
    def log_message(self,*args):return

def main():
    p=int(os.environ.get("SHADOW_PORT","12081"))
    threading.Thread(target=loop,name="public-only-shadow-feed",daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1",p),Handler).serve_forever()

if __name__=="__main__":
    main()

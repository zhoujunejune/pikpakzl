#!/usr/bin/env python3
"""Isolated Binance USDT-M futures experiment. NOT a proven profitable strategy.
MODE=paper default. No external packages except requests.
Requires ONE-WAY mode, independent account/portfolio, durable storage for live mode.
"""
import datetime as dt
import hashlib
import hmac
import json
import math
import os
import pathlib
import tempfile
import time
import uuid
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP
from urllib.parse import urlencode

import requests

def env_float(k, d):
    return float(os.getenv(k, d))

MODE = os.getenv("MODE", "paper").lower()
BASE_URL = os.getenv("BINANCE_BASE_URL", "https://fapi.binance.com").rstrip("/")
SYMBOLS = [s.strip().upper() for s in os.getenv("SYMBOLS", "BTCUSDT,ETHUSDT").split(",") if s.strip()]
LEVERAGE = int(os.getenv("LEVERAGE", "10"))
RISK_FRACTION = env_float("RISK_FRACTION", ".015")
MARGIN_FRACTION = env_float("MAX_MARGIN_FRACTION", ".15")
DAILY_LOSS_FRACTION = env_float("MAX_DAILY_LOSS_FRACTION", ".08")
PAPER_BALANCE = env_float("PAPER_BALANCE", "200")
TAKER_FEE = env_float("PAPER_TAKER_FEE", ".0005")
LOOP_SECONDS = max(20, int(os.getenv("LOOP_SECONDS", "30")))
STATE_FILE = pathlib.Path(os.getenv("STATE_FILE", "./futures-state.json"))
KILL_FILE = pathlib.Path(os.getenv("KILL_FILE", "./KILL"))
TIMEOUT = 8
assert MODE in ("paper", "live"), "MODE must be paper or live"
assert 1 <= LEVERAGE <= 20, "This bot caps leverage at 20x"
assert 0 < RISK_FRACTION <= .03 and 0 < MARGIN_FRACTION <= .20
assert 0 < DAILY_LOSS_FRACTION <= .20
assert SYMBOLS and set(SYMBOLS).issubset({"BTCUSDT", "ETHUSDT"})
assert BASE_URL in ("https://fapi.binance.com", "https://testnet.binancefuture.com")
if MODE == "live":
    assert os.getenv("ALLOW_REAL_TRADING") == "I_ACCEPT_REAL_TRADING"
    assert os.getenv("BINANCE_API_KEY") and os.getenv("BINANCE_API_SECRET")
    assert os.getenv("DURABLE_STORAGE_CONFIRMED") == "YES", "Live mode needs a persistent Railway volume"
    assert STATE_FILE.is_absolute(), "Use STATE_FILE on a persistent volume in live mode"

def log(event, **kwargs):
    print(json.dumps({"at":dt.datetime.now(dt.timezone.utc).isoformat(),
                      "event":event, **kwargs}, ensure_ascii=False), flush=True)

def save(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    p = STATE_FILE.with_name(STATE_FILE.name + ".tmp")
    with p.open("w") as f:
        json.dump(state, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(p, STATE_FILE)

def load():
    if not STATE_FILE.exists():
        return {"balance":PAPER_BALANCE, "day":None, "day_start":PAPER_BALANCE,
                "trade":None, "pending":None, "halt":False,
                "last_signal":None, "last_exit":0, "history":[]}
    return json.loads(STATE_FILE.read_text())

class API:
    def __init__(self):
        self.session=requests.Session()
        self.session.headers.update({"User-Agent":"ZLFuturesExperiment/1.0"})
        self.key=os.getenv("BINANCE_API_KEY", "")
        self.secret=os.getenv("BINANCE_API_SECRET", "")
        self.offset=0
    def call(self, method, path, params=None, signed=False):
        params=dict(params or {})
        if signed:
            if not (self.key and self.secret):
                raise RuntimeError("Missing Binance API credentials")
            params["timestamp"]=int(time.time()*1000)+self.offset
            params["recvWindow"]=5000
            query=urlencode(params)
            params["signature"]=hmac.new(self.secret.encode(), query.encode(), hashlib.sha256).hexdigest()
        headers={"X-MBX-APIKEY":self.key} if signed else {}
        r=self.session.request(method,BASE_URL+path,params=params if method=="GET" else None,
                               data=params if method!="GET" else None,
                               headers=headers,timeout=TIMEOUT)
        if r.status_code in (418, 429, 451):
            # Fail closed: 418 may indicate an IP ban. NEVER poll repeatedly or rotate egress.
            retry_after=str(r.headers.get("Retry-After", "unknown"))[:40]
            raise RuntimeError(f"Exchange refused request HTTP {r.status_code}; Retry-After={retry_after}; no retry/no bypass")
        if not r.ok:
            raise RuntimeError(f"Exchange error HTTP {r.status_code}: {r.text[:250]}")
        return r.json()
    def server_time(self):
        self.offset=int(self.call("GET","/fapi/v1/time")["serverTime"])-int(time.time()*1000)
    def positions(self):
        return [p for p in self.call("GET","/fapi/v3/positionRisk",signed=True)
                if abs(float(p["positionAmt"]))>0.000000001]
    def balance(self):
        rows=self.call("GET","/fapi/v3/balance",signed=True)
        return float(next(x["balance"] for x in rows if x["asset"]=="USDT"))
    def mark(self,symbol):
        return float(self.call("GET","/fapi/v1/premiumIndex",{"symbol":symbol})["markPrice"])
    def candles(self,symbol,interval,limit=160):
        return self.call("GET","/fapi/v1/klines",{"symbol":symbol,"interval":interval,"limit":limit})
    def info(self):
        data=self.call("GET","/fapi/v1/exchangeInfo")
        return {x["symbol"]:x for x in data["symbols"] if x["symbol"] in SYMBOLS}
    def algo_open(self,symbol):
        return self.call("GET","/fapi/v1/openAlgoOrders",{"symbol":symbol},signed=True)

def ema(values, n):
    avg=sum(values[:n])/n
    alpha=2/(n+1)
    for v in values[n:]:
        avg=alpha*v+(1-alpha)*avg
    return avg

def atr(klines, n=14):
    closes=[float(x[4]) for x in klines]
    trs=[]
    for i in range(1,len(klines)):
        high=float(klines[i][2]); low=float(klines[i][3])
        trs.append(max(high-low,abs(high-closes[i-1]),abs(low-closes[i-1])))
    return sum(trs[-n:])/n

def signal(c5, c1):
    # Never use an unclosed candle. No look-ahead and no mandatory direction.
    if len(c5)<50 or len(c1)<70:
        return None
    closed5=c5[:-1]; closed1=c1[:-1]
    now=closed5[-1]
    price=float(now[4])
    look=closed5[-13:-1]
    avg_vol=sum(float(x[5]) for x in closed5[-21:-1])/20
    if avg_vol<=0 or float(now[5])<1.3*avg_vol:
        return None
    volatility=atr(closed5)
    if not .0008 < volatility/price < .025:
        return None
    closes1=[float(x[4]) for x in closed1]
    fast=ema(closes1,20); slow=ema(closes1,50)
    side=None
    if fast>slow*1.0005 and price>max(float(x[2]) for x in look):
        side="BUY"
    elif fast<slow*.9995 and price<min(float(x[3]) for x in look):
        side="SELL"
    if side is None:
        return None
    # ATR-based stops; no guarantee against gaps, slippage, or liquidation.
    distance=max(1.5*volatility, price*.004)
    strength=abs(fast/slow-1)
    return {"symbol":None,"side":side,"price":price,"distance":distance,
            "candle_close":int(now[6]),"strength":strength}

def quantity_for(balance, price, distance, sym_info):
    if balance<=0 or price<=0 or distance<=0:
        return 0.
    risk_notional=balance*RISK_FRACTION*price/distance
    max_margin_notional=balance*MARGIN_FRACTION*LEVERAGE
    desired=min(risk_notional,max_margin_notional)
    filters={x["filterType"]:x for x in sym_info["filters"]}
    lot=filters.get("MARKET_LOT_SIZE") or filters["LOT_SIZE"]
    step=Decimal(str(lot["stepSize"]))
    if step<=0:
        lot=filters["LOT_SIZE"]; step=Decimal(str(lot["stepSize"]))
    q=(Decimal(str(desired/price))/step).to_integral_value(rounding=ROUND_DOWN)*step
    quantity=float(q)
    min_qty=float(lot["minQty"])
    notional_filter=filters.get("MIN_NOTIONAL", {})
    minimum=float(notional_filter.get("notional",0))
    if quantity<min_qty or quantity*price<minimum:
        return 0.
    if quantity>float(lot["maxQty"]):
        return 0.
    return quantity

def price_tick(price, info):
    filters={x["filterType"]:x for x in info["filters"]}
    tick=Decimal(str(filters["PRICE_FILTER"]["tickSize"]))
    q=(Decimal(str(price))/tick).to_integral_value(rounding=ROUND_HALF_UP)*tick
    return format(q,"f")

def levels(side, price, distance):
    if side=="BUY":
        return price-distance,price+1.8*distance
    return price+distance,price-1.8*distance

def paper_price(api, symbol):
    return api.mark(symbol)

def pnl(trade, exit_price):
    direction=1 if trade["side"]=="BUY" else -1
    return ((exit_price-trade["entry"])*trade["qty"]*direction
            - (exit_price+trade["entry"])*trade["qty"]*TAKER_FEE)

def reconcile(api,state):
    trade=state.get("trade")
    if MODE=="paper":
        if trade is None:
            return
        mark=paper_price(api,trade["symbol"])
        hit_stop=mark<=trade["stop"] if trade["side"]=="BUY" else mark>=trade["stop"]
        hit_tp=mark>=trade["tp"] if trade["side"]=="BUY" else mark<=trade["tp"]
        if hit_stop or hit_tp:
            result=pnl(trade,mark)
            state["balance"]+=result
            state["history"].append({"trade":trade,"exit":mark,"net":result,
                "reason":"STOP" if hit_stop else "TAKE_PROFIT","at":int(time.time())})
            state["history"]=state["history"][-500:]
            state["trade"]=None
            state["last_exit"]=time.time()
            save(state)
            log("paper_closed",net=round(result,4),balance=round(state["balance"],4))
        return
    positions=api.positions()
    bot_positions=[p for p in positions if p["symbol"] in SYMBOLS]
    if trade:
        positions_for_trade=[p for p in bot_positions if p["symbol"]==trade["symbol"]]
        if not positions_for_trade:
            # Cleanup only the protective orders whose IDs this bot persisted.
            for algo_id in trade.get("algo_ids",[]):
                try: api.call("DELETE","/fapi/v1/algoOrder",{"symbol":trade["symbol"],"algoId":algo_id},signed=True)
                except Exception as e: 
                    state["halt"]=True
                    log("cancel_protection_failed",error=str(e))
                    save(state)
                    return
            log("position_flat_external_or_exit",symbol=trade["symbol"])
            state["trade"]=None
            state["last_exit"]=time.time()
            save(state)
            return
        open_ids={str(x["algoId"]) for x in api.algo_open(trade["symbol"])}
        if str(trade["algo_ids"][0]) not in open_ids:
            state["halt"]=True
            save(state)
            log("STOP_MISSING_EMERGENCY",symbol=trade["symbol"])
            flatten(api,positions_for_trade[0])
            return
    elif bot_positions:
        # Never take ownership of any manual or pre-existing positions.
        state["halt"]=True
        save(state)
        log("foreign_position_detected_halt",symbols=[x["symbol"] for x in bot_positions])

def flatten(api,p):
    amount=float(p["positionAmt"])
    if amount==0:
        return
    # Emergency close only; never retries automatically on timeout.
    api.call("POST","/fapi/v1/order",{
        "symbol":p["symbol"],"side":"SELL" if amount>0 else "BUY",
        "type":"MARKET","quantity":str(abs(amount)),"reduceOnly":"true",
        "newClientOrderId":"ZL_EM_"+uuid.uuid4().hex[:20]},signed=True)
    log("emergency_flatten_submitted",symbol=p["symbol"])

def paper_enter(api,state,s,quantity):
    sym=s["symbol"]; price=paper_price(api,sym); sl,tp=levels(s["side"],price,s["distance"])
    state["trade"]={"symbol":sym,"side":s["side"],"qty":quantity,"entry":price,
                    "stop":sl,"tp":tp,"at":int(time.time()),"paper":True}
    save(state)
    log("paper_open",symbol=sym,side=s["side"],qty=quantity,entry=price,stop=sl,tp=tp)

def live_enter(api,state,s,quantity,info):
    symbol=s["symbol"]
    # Reject hedge mode: reduceOnly and closePosition assumptions need one-way.
    dual=api.call("GET","/fapi/v1/positionSide/dual",signed=True)
    if dual["dualSidePosition"] is True or dual["dualSidePosition"]=="true":
        raise RuntimeError("Hedge Mode detected; refusing live entry")
    if api.positions():
        raise RuntimeError("Open account position detected; refusing live entry")
    api.call("POST","/fapi/v1/leverage",{"symbol":symbol,"leverage":LEVERAGE},signed=True)
    try:
        api.call("POST","/fapi/v1/marginType",{"symbol":symbol,"marginType":"ISOLATED"},signed=True)
    except RuntimeError as e:
        if '"code":-4046' not in str(e) and '"code": -4046' not in str(e):
            raise
    # Persist intent before sending irreversible order.
    client_id="ZL_"+uuid.uuid4().hex[:25]
    state["pending"]={"symbol":symbol,"client_id":client_id,"at":int(time.time())}
    save(state)
    try:
        api.call("POST","/fapi/v1/order",{
            "symbol":symbol,"side":s["side"],"type":"MARKET","quantity":str(quantity),
            "newClientOrderId":client_id,"newOrderRespType":"RESULT"},signed=True)
    except Exception:
        state["halt"]=True; save(state)
        raise RuntimeError("Entry uncertain, HALTED. Verify exchange orders manually; NEVER blind-retry")
    found=[p for p in api.positions() if p["symbol"]==symbol]
    if not found:
        state["halt"]=True;save(state)
        raise RuntimeError("No confirmed position after entry, HALTED")
    p=found[0]
    entry=float(p["entryPrice"]); qty=abs(float(p["positionAmt"]))
    sl,tp=levels(s["side"],entry,s["distance"])
    close_side="SELL" if s["side"]=="BUY" else "BUY"
    try:
        stop=api.call("POST","/fapi/v1/algoOrder",{
            "algoType":"CONDITIONAL","symbol":symbol,"side":close_side,
            "type":"STOP_MARKET","triggerPrice":price_tick(sl,info),
            "closePosition":"true","workingType":"MARK_PRICE",
            "clientAlgoId":"ZLS_"+uuid.uuid4().hex[:22]},signed=True)
    except Exception as e:
        state["halt"]=True;save(state)
        log("no_exchange_stop_emergency_flatten",error=str(e))
        flatten(api,p)
        raise RuntimeError("STOP failed; emergency close submitted, HALTED")
    state["trade"]={"symbol":symbol,"side":s["side"],"qty":qty,"entry":entry,
          "stop":sl,"tp":tp,"algo_ids":[stop["algoId"]],"at":int(time.time()),"paper":False}
    state["pending"]=None
    save(state)
    try:
        tp_order=api.call("POST","/fapi/v1/algoOrder",{
            "algoType":"CONDITIONAL","symbol":symbol,"side":close_side,
            "type":"TAKE_PROFIT_MARKET","triggerPrice":price_tick(tp,info),
            "closePosition":"true","workingType":"MARK_PRICE",
            "clientAlgoId":"ZLT_"+uuid.uuid4().hex[:22]},signed=True)
        state["trade"]["algo_ids"].append(tp_order["algoId"])
        save(state)
    except Exception as e:
        state["halt"]=True;save(state)
        log("take_profit_failed_halt_stop_remains",error=str(e))
    log("live_open_with_stop",symbol=symbol,side=s["side"],qty=qty,entry=entry,stop=sl,tp=tp)

def tick(api,state):
    if state.get("pending"):
        state["halt"]=True;save(state)
        log("pending_entry_manual_reconciliation_required",pending=state["pending"])
        return
    if KILL_FILE.exists():
        state["halt"]=True; save(state)
        log("kill_file_detected_halt")
    reconcile(api,state)
    if state["halt"] or KILL_FILE.exists():
        return
    if state.get("trade"):
        return
    if time.time()-state.get("last_exit",0)<1800:
        return
    today=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    balance=state["balance"] if MODE=="paper" else api.balance()
    if state.get("day")!=today:
        state["day"]=today; state["day_start"]=balance;save(state)
    if balance < state["day_start"]*(1-DAILY_LOSS_FRACTION):
        log("daily_loss_limit",current=balance,reference=state["day_start"])
        return
    if MODE=="live" and api.positions():
        log("foreign_position_prevents_entry")
        return
    markets=api.info()
    candidates=[]
    for sym in SYMBOLS:
        s=signal(api.candles(sym,"5m"),api.candles(sym,"1h",90))
        if s:
            s["symbol"]=sym
            candidates.append(s)
    candidates.sort(key=lambda x:x["strength"],reverse=True)
    for s in candidates:
        signal_key=f'{s["symbol"]}-{s["candle_close"]}'
        if state.get("last_signal")==signal_key:
            continue
        state["last_signal"]=signal_key;save(state)
        current=api.mark(s["symbol"])
        if abs(current-s["price"])/s["price"]>.002:
            log("stale_signal_price_drift",symbol=s["symbol"])
            continue
        q=quantity_for(balance,current,s["distance"],markets[s["symbol"]])
        if q<=0:
            log("skip_below_minimum_order",symbol=s["symbol"])
            continue
        if MODE=="live":
            live_enter(api,state,s,q,markets[s["symbol"]])
        else:
            paper_enter(api,state,s,q)
        break

def main():
    api=API()
    state=load()
    api.server_time()
    log("started",mode=MODE,symbols=SYMBOLS,leverage=LEVERAGE,real_trading=MODE=="live")
    if MODE=="live" and state.get("pending"):
        raise RuntimeError("Unresolved prior entry; investigate manually before starting")
    while True:
        try:
            tick(api,state)
        except Exception as e:
            msg=str(e)
            log("cycle_error",error=msg)
            if any(f"HTTP {code}" in msg for code in (418,429,451)):
                # Stop *all* further API calls on denied/banned egress, even in paper mode.
                state["halt"]=True
                save(state)
                log("exchange_access_blocked_engine_stopped",error=msg)
                raise RuntimeError(msg)
            if MODE=="live":
                # Never continue trading after an uncertain error.
                state["halt"]=True
                save(state)
                raise RuntimeError(f"Live engine halted: {msg}")
            time.sleep(LOOP_SECONDS)

if __name__=="__main__":
    main()

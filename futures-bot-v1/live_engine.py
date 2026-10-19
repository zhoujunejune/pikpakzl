"""Binance USD-M real-order engine. Zero real orders unless owner switch is ON.

Independent BTCUSDT / ETHUSDT / BTCUSDC symbols, one position per symbol.
Supports account Hedge Mode without changing exchange-wide position settings.
Never adopts foreign positions, retries an uncertain entry or fabricates fills.
"""
import datetime as dt
import json
import time
import uuid

import bot
import live_control
from controls import read_control
from position_view import view as position_view

SYMBOLS=tuple(bot.SYMBOLS)

def blank():
    return {"halt":False,"pending":None,"live_positions":{},"last_signals":{},
            "day":None,"day_start":None,"history":[]}

def load():
    if not bot.STATE_FILE.exists():
        return blank()
    s=bot.load()
    if not isinstance(s.get("live_positions"),dict) or not isinstance(s.get("last_signals"),dict):
        raise RuntimeError("Live ledger schema mismatch; orders disabled")
    return s

def persist(state):
    bot.save(state)

def position_side(side,hedge):
    return ("LONG" if side=="BUY" else "SHORT") if hedge else "BOTH"

def matching_position(exchange_positions,trade):
    return next((p for p in exchange_positions
        if p.get("symbol")==trade["symbol"] and
           p.get("positionSide","BOTH")==trade.get("positionSide","BOTH")
        and abs(float(p.get("positionAmt",0)))>0),None)

def halt(state,reason):
    state["halt"]=True
    persist(state)
    live_control.save_enabled(False)
    bot.log("futures_live_halted",reason=str(reason)[:180])

def flatten(api,exchange_position,hedge):
    sym=exchange_position["symbol"]
    amt=abs(float(exchange_position["positionAmt"]))
    if not amt:return
    side="SELL" if (float(exchange_position["positionAmt"])>0 or exchange_position.get("positionSide")=="LONG") else "BUY"
    params={"symbol":sym,"side":side,"type":"MARKET","quantity":str(amt),
            "newClientOrderId":"ZLE_"+uuid.uuid4().hex[:22]}
    if hedge:params["positionSide"]=exchange_position["positionSide"]
    else:params["reduceOnly"]="true"
    api.call("POST","/fapi/v1/order",params,signed=True)
    bot.log("futures_emergency_close_sent",symbol=sym)

def reconcile(api,state,hedge):
    actual=api.positions()
    owned=state["live_positions"]
    for sym,trade in list(owned.items()):
        p=matching_position(actual,trade)
        open_algos=api.algo_open(sym)
        current_ids={str(x.get("algoId")) for x in open_algos}
        if not p:
            # Cancel only THIS bot's surviving stop/TP orders, not others.
            for aid in trade.get("algo_ids",[]):
                if str(aid) in current_ids:
                    api.call("DELETE","/fapi/v1/algoOrder",
                             {"symbol":sym,"algoId":aid},signed=True)
            state["history"].append({"symbol":sym,"side":trade["side"],
                     "entry":trade["entry"],"exit":None,"net":None,
                     "reason":"EXCHANGE_POSITION_CLOSED","at":int(time.time())})
            state["history"]=state["history"][-300:]
            del owned[sym]
            persist(state)
            bot.log("futures_exchange_position_closed",symbol=sym)
            continue
        if not trade.get("algo_ids") or str(trade["algo_ids"][0]) not in current_ids:
            halt(state,"Owned position exchange STOP absent: "+sym)
            try:flatten(api,p,hedge)
            except Exception as exc:bot.log("futures_emergency_close_failed",symbol=sym,errorClass=type(exc).__name__)
            raise RuntimeError("Stop lost; emergency close attempted; manual review required")
        if len(trade["algo_ids"])<2 or str(trade["algo_ids"][1]) not in current_ids:
            halt(state,"Owned position exchange take-profit absent: "+sym)
            raise RuntimeError("Take-profit missing; stop remains, review required")
    unknown=[p for p in actual if not any(matching_position([p],t) for t in owned.values())]
    return unknown

def wallet_assets(api):
    # Available balance is used for NEW position sizing, not total wallet equity.
    rows=api.call("GET","/fapi/v3/balance",signed=True)
    d={row["asset"]:row for row in rows if row.get("asset") in ("USDT","USDC")}
    available={name:float(d.get(name,{}).get("availableBalance",0)) for name in ("USDT","USDC")}
    equity={name:float(d.get(name,{}).get("balance",0)) for name in ("USDT","USDC")}
    return available,equity

def enter(api,state,s,qty,info,hedge,leverage):
    sym=s["symbol"]
    pos_side=position_side(s["side"],hedge)
    if sym in state["live_positions"]:return
    if api.positions():
        # Since account is currently flat before first order, only allow previously
        # tracked positions. Manual or foreign positions never become bot-owned.
        positions=api.positions()
        if any(not any(matching_position([p],t) for t in state["live_positions"].values())
               for p in positions):
            raise RuntimeError("Untracked exchange position found; refusing entry")
    api.call("POST","/fapi/v1/leverage",{"symbol":sym,"leverage":leverage},signed=True)
    try:
        api.call("POST","/fapi/v1/marginType",{"symbol":sym,"marginType":"ISOLATED"},signed=True)
    except Exception as exc:
        if "-4046" not in str(exc):raise
    cid="ZLF_"+uuid.uuid4().hex[:22]
    state["pending"]={"symbol":sym,"positionSide":pos_side,"clientId":cid,"at":int(time.time())}
    persist(state)
    params={"symbol":sym,"side":s["side"],"type":"MARKET","quantity":str(qty),
            "newClientOrderId":cid,"newOrderRespType":"RESULT"}
    if hedge:params["positionSide"]=pos_side
    try:
        api.call("POST","/fapi/v1/order",params,signed=True)
    except Exception:
        halt(state,"Uncertain market entry; query order by client ID before any retry")
        raise
    p=next((p for p in api.positions() if p.get("symbol")==sym and
            p.get("positionSide","BOTH")==pos_side),None)
    if not p or abs(float(p.get("positionAmt",0)))<=0:
        halt(state,"Exchange did not confirm filled position")
        raise RuntimeError("Entry status uncertain; manual reconciliation required")
    entry=float(p["entryPrice"])
    stop,tp=bot.levels(s["side"],entry,s["distance"])
    close_side="SELL" if s["side"]=="BUY" else "BUY"
    base={"algoType":"CONDITIONAL","symbol":sym,"side":close_side,
          "closePosition":"true","workingType":"MARK_PRICE"}
    if hedge:base["positionSide"]=pos_side
    try:
        protective=api.call("POST","/fapi/v1/algoOrder",{
            **base,"type":"STOP_MARKET","triggerPrice":bot.price_tick(stop,info),
            "clientAlgoId":"ZLS_"+uuid.uuid4().hex[:22]},signed=True)
        if not protective.get("algoId"):raise RuntimeError("STOP response has no algo ID")
    except Exception:
        halt(state,"Exchange STOP placement failed")
        try:flatten(api,p,hedge)
        except Exception as exc:bot.log("futures_emergency_close_failed",symbol=sym,errorClass=type(exc).__name__)
        raise
    state["live_positions"][sym]={"symbol":sym,"side":s["side"],"positionSide":pos_side,
       "qty":abs(float(p["positionAmt"])),"entry":entry,"stop":stop,"tp":tp,
       "at":int(time.time()),"paper":False,"algo_ids":[protective["algoId"]]}
    state["pending"]=None
    persist(state)
    try:
        target=api.call("POST","/fapi/v1/algoOrder",{
            **base,"type":"TAKE_PROFIT_MARKET","triggerPrice":bot.price_tick(tp,info),
            "clientAlgoId":"ZLT_"+uuid.uuid4().hex[:22]},signed=True)
        if not target.get("algoId"):raise RuntimeError("TP response has no algo ID")
        state["live_positions"][sym]["algo_ids"].append(target["algoId"])
        persist(state)
    except Exception:
        halt(state,"Take profit missing; exchange stop is present")
        raise
    bot.log("futures_live_entry_protected",symbol=sym,side=s["side"],qty=qty,stop=stop,tp=tp)

def tick(api,state,hedge):
    controls=read_control()
    active=live_control.read()["enabled"]
    if bot.KILL_FILE.exists():
        halt(state,"Kill file present")
        return
    # Exchange-owned positions are reconciled even after the owner turns OFF new entries.
    unknown=reconcile(api,state,hedge) if state["live_positions"] or active else []
    if state["halt"] or not active or not controls["entry_enabled"] or controls["emergency_stop"]:
        return
    if unknown:
        halt(state,"Manual or foreign exchange position found")
        return
    if state.get("pending"):
        halt(state,"Unresolved prior order intent")
        return
    available,equity=wallet_assets(api)
    today=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    total=sum(equity.values())
    if state["day"]!=today:
        state["day"]=today
        state["day_start"]=total
        persist(state)
    if total < state["day_start"]*(1-bot.DAILY_LOSS_FRACTION):
        halt(state,"Daily loss threshold breached")
        return
    markets=api.info()
    candidates=[]
    for sym in SYMBOLS:
        if sym in state["live_positions"]:continue
        market=markets.get(sym)
        if not market or market.get("status")!="TRADING" or market.get("contractType")!="PERPETUAL" or market.get("marginAsset")!=bot.margin_asset(sym):
            continue
        s=bot.signal(api.candles(sym,"5m"),api.candles(sym,"1h",90))
        if not s:continue
        s["symbol"]=sym
        key=str(sym)+"-"+str(s["candle_close"])
        if state["last_signals"].get(sym)!=key:candidates.append((s,key,market))
    for s,key,market in sorted(candidates,key=lambda x:x[0]["strength"],reverse=True):
        # Switch can be turned off while scanning; never submit after OFF.
        if not live_control.read()["enabled"]:break
        sym=s["symbol"]
        state["last_signals"][sym]=key
        persist(state)
        price=api.mark(sym)
        if abs(price-s["price"])/s["price"]>.002:continue
        asset=bot.margin_asset(sym)
        wallet=available[asset]
        q=bot.quantity_for(wallet,price,s["distance"],market,
               risk_fraction=controls["risk_fraction"],margin_fraction=controls["max_margin_fraction"],
               leverage=controls["leverage"])
        if q<=0:continue
        enter(api,state,s,q,market,hedge,controls["leverage"])
        available,_=wallet_assets(api)
        # Intentionally no global one-position limit or post-close cooldown.

def main():
    api=bot.API()
    api.server_time()
    state=load()
    if state["pending"]:
        halt(state,"Crash recovery: unresolved exchange order intent")
    hedge=str(api.call("GET","/fapi/v1/positionSide/dual",signed=True).get("dualSidePosition")).lower()=="true"
    bot.log("futures_live_monitor_started",symbols=SYMBOLS,hedgeMode=hedge,armed=False)
    while True:
        try:tick(api,state,hedge)
        except Exception as exc:
            halt(state,"Live cycle failure: "+type(exc).__name__)
            bot.log("futures_live_cycle_error",errorClass=type(exc).__name__)
        time.sleep(bot.LOOP_SECONDS)

def snapshot(worker,quotes):
    state=load()
    control=live_control.read()
    held=list(state["live_positions"].values())
    positions=[position_view(t,quotes,bot.TAKER_FEE) for t in held]
    from wallet_view import public_wallet
    return {"app":"zl-futures-bot-v1","mode":"live","liveTradingEnabled":control["enabled"],
      "liveControl":control,"control":read_control(),"workerRunning":worker["running"],"workerError":worker["error"],
      "configuredSymbols":list(SYMBOLS),"positions":held,
      "positionDetails":[x for x in positions if x is not None],
      "latestPrices":quotes,"futuresWallet":public_wallet(worker.get("wallet")),
      "preflight":worker.get("preflight"),"halted":state["halt"],
      "pendingOrderUncertain":bool(state["pending"]),
      "history":[{"symbol":r["symbol"],"at":r["at"],"reason":r["reason"]} for r in state["history"][-15:]],
      "strategy":"5m closed breakout + 1h EMA trend; volume >1.3x",
      "perSymbolPositionLimit":1,"postCloseCooldownSeconds":0,
      "note":"Real trading: exchange fills and protection are authoritative; displayed PnL is estimated."}

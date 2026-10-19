#!/usr/bin/env python3
"""Faithful GitHub Freqtrade community SIGNALS, independent conservative fill replay.

WARNING: This is NOT the official Freqtrade backtesting engine, and cannot
validate slippage, funding, orderbook fills or the exchange's mark-price
triggering. No API keys, no network, no real orders.
"""
import importlib.util
import json
import math
import pathlib
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

ROOT=pathlib.Path(__file__).resolve().parent
STRATEGY_FILES=ROOT/"user_data"/"strategies"
RESULTS=ROOT/"results"
ARCHIVE=ROOT/"user_data"/"archive"
SYMBOLS={"BTCUSDT":"BTC/USDT:USDT","ETHUSDT":"ETH/USDT:USDT","BTCUSDC":"BTC/USDC:USDC"}
CANDIDATES=["TrendFollowingStrategy","FSampleStrategy","FAdxSmaStrategy"]
STAGES=[("train","2026-08-15","2026-09-15"),
        ("holdout","2026-09-15","2026-10-16")]
FEE=.0005
SLIPPAGE=.0003

def strategies():
 out={}
 for name in CANDIDATES:
  loc=STRATEGY_FILES/(name+".py")
  spec=importlib.util.spec_from_file_location("research_"+name,str(loc))
  mod=importlib.util.module_from_spec(spec)
  spec.loader.exec_module(mod)
  cls=getattr(mod,name)
  inst=cls.__new__(cls)
  out[name]=inst
 return out

def load_candles(symbol):
 rows=json.loads((ARCHIVE/(symbol+"_5m.json")).read_text())
 if not rows:raise ValueError("Missing public archive OHLCV")
 data=pd.DataFrame(rows,columns=["t","open","high","low","close","volume"])
 data["date"]=pd.to_datetime(data["t"],unit="ms",utc=True)
 data=data.drop_duplicates("date").sort_values("date")
 data=data[["date","open","high","low","close","volume"]].reset_index(drop=True)
 if data.empty:raise ValueError("Empty archive")
 return data

def aggregate_hourly(bars):
 # One hour consists of twelve fully observed 5m candles.
 indexed=bars.set_index("date")
 b=indexed.resample("1h").agg({"open":"first","high":"max","low":"min",
    "close":"last","volume":"sum"})
 counts=indexed["close"].resample("1h").count()
 b=b[counts==12].dropna().reset_index()
 return b

def signed_fill(price,side,is_entry):
 # Adverse 3 basis points applied on both entry and exit.
 if is_entry: return price*(1+side*SLIPPAGE)
 return price*(1-side*SLIPPAGE)

def simulate(df,strat,stage,start,stop):
 start=pd.Timestamp(start,tz="UTC")
 stop=pd.Timestamp(stop,tz="UTC")
 balance=1000.0
 curve=[{"t":str(start),"equity":balance}]
 trades=[]
 active=None
 start_count=0
 max_balance=balance
 worst_dd=0.0
 for i in range(1,len(df)):
  bar=df.iloc[i]
  moment=bar["date"]
  if moment<start or moment>=stop:continue
  start_count+=1
  previous=df.iloc[i-1]
  o,h,l,c=[float(bar[k]) for k in ("open","high","low","close")]
  if not all(math.isfinite(z) and z>0 for z in (o,h,l,c)):continue
  if active:
   direction=active["direction"]
   age=(moment-active["entry_time"]).total_seconds()/60
   schedule={int(k):float(v) for k,v in getattr(strat,"minimal_roi",{}).items()}
   target_rate=max([v for k,v in schedule.items() if age>=k],default=1.0)
   entry=active["entry_price"]
   stop_price=active["stop"]
   target=entry*(1+direction*target_rate)
   exit_signal=(previous.get("exit_long",0)==1) if direction==1 else (previous.get("exit_short",0)==1)
   # If entry candle is in-progress, gap-through stop fills at worse open.
   stop_hit=l<=stop_price if direction==1 else h>=stop_price
   tp_hit=h>=target if direction==1 else l<=target
   if exit_signal:
    raw,reason=o,"EXIT_SIGNAL"
   elif stop_hit:
    raw,reason=(min(stop_price,o) if direction==1 else max(stop_price,o)),"STOP"
   elif tp_hit:
    raw,reason=target,"ROI_TAKE"
   else:raw=None
   if raw is not None:
    exit_price=signed_fill(raw,direction,False)
    pnl=(exit_price-entry)*active["qty"]*direction-\
          active["entry_fee"]-abs(exit_price*active["qty"])*FEE
    balance+=pnl
    trades.append({"symbol":stage["symbol"],"strategy":stage["strategy"],
       "entry_time":str(active["entry_time"]),"exit_time":str(moment),
       "side":"LONG" if direction==1 else "SHORT",
       "entry":round(entry,8),"exit":round(exit_price,8),
       "pnl":round(pnl,6),"reason":reason})
    active=None
   else:
    # Update trailing STOP only at completed-bar boundary, never on this
    # bar's same-bar high before the low; avoids hidden lookahead.
    if getattr(strat,"trailing_stop",False):
     peak_gain=(h-entry)/entry if direction==1 else (entry-l)/entry
     threshold=float(getattr(strat,"trailing_stop_positive_offset",0))
     if peak_gain>=threshold:
      trail=float(getattr(strat,"trailing_stop_positive",0.05))
      candidate=c*(1-direction*trail)
      active["stop"]=max(active["stop"],candidate) if direction==1 else min(active["stop"],candidate)
  # Prevent simultaneous close + new open on the same bar.
  if active is None and not (locals().get("raw") is not None and locals().get("reason")):
   is_long=previous.get("enter_long",0)==1
   is_short=previous.get("enter_short",0)==1 and bool(getattr(strat,"can_short",False))
   if is_long!=is_short and balance>105:
    direction=1 if is_long else -1
    price=signed_fill(o,direction,True)
    stake=min(100.0,balance*0.1)
    qty=stake/price
    loss_pct=abs(float(getattr(strat,"stoploss",-.05)))
    active={"direction":direction,"entry_price":price,"qty":qty,
       "entry_fee":stake*FEE,"stop":price*(1-direction*loss_pct),"entry_time":moment}
  # Explicitly reset previous bar close indicator before the next iteration.
  raw=None
  max_balance=max(max_balance,balance)
  worst_dd=max(worst_dd,(max_balance-balance)/max_balance)
  curve.append({"t":str(moment),"equity":round(balance,5)})
 # Close existing trade only at end-of-window close, using actual final candle close.
 if active and start_count:
  last=df[(df.date>=start)&(df.date<stop)].iloc[-1]
  px=signed_fill(float(last["close"]),active["direction"],False)
  pnl=(px-active["entry_price"])*active["qty"]*active["direction"]-\
       active["entry_fee"]-abs(px*active["qty"])*FEE
  balance+=pnl
  trades.append({"symbol":stage["symbol"],"strategy":stage["strategy"],
       "entry_time":str(active["entry_time"]),"exit_time":str(last["date"]),
       "side":"LONG" if active["direction"]==1 else "SHORT",
       "entry":round(active["entry_price"],8),"exit":round(px,8),
       "pnl":round(pnl,6),"reason":"WINDOW_END"})
  max_balance=max(max_balance,balance)
  worst_dd=max(worst_dd,(max_balance-balance)/max_balance)
  curve.append({"t":str(last["date"]),"equity":round(balance,5)})
 wins=[x for x in trades if x["pnl"]>0]
 positives=sum(x["pnl"] for x in trades if x["pnl"]>0)
 negatives=-sum(x["pnl"] for x in trades if x["pnl"]<0)
 result={"status":"SIMULATED","trades":len(trades),"wins":len(wins),
  "winrate_pct":round(len(wins)/len(trades)*100,2) if trades else None,
  "net_profit_abs":round(balance-1000,5),
  "net_profit_pct":round((balance/1000-1)*100,4),
  "max_drawdown_pct":round(worst_dd*100,3),
  "profit_factor":round(positives/negatives,3) if negatives else None,
  "currency":"USDC" if stage["symbol"]=="BTCUSDC" else "USDT",
  "fee_bps_per_side":FEE*10000,"adverse_slippage_bps_per_side":SLIPPAGE*10000,
  "funding_included":False,"backtesting_engine":"custom_offline_replay_not_freqtrade_engine",
  "notes":"Community Freqtrade original entry/exit signals; offline OHLC fills; 1x; funding/liquidation excluded"}
 return result,trades,curve

def main():
 coverage=json.loads((RESULTS/"archive_coverage.json").read_text())
 models=strategies()
 rows=[]
 details={}
 for symbol,pair in SYMBOLS.items():
  data=coverage.get(symbol,{})
  if data.get("coverage",0)<.99 or data.get("missing_files"):
   print("REPLAY_NO_DATA",symbol,"coverage",data.get("coverage"),"missing",len(data.get("missing_files",[])))
   for name in CANDIDATES:
    for label,_,_ in STAGES:
     rows.append({"symbol":symbol,"strategy":name,"stage":label,
           "status":"NO_DATA","currency":"USDC" if symbol=="BTCUSDC" else "USDT"})
   continue
  bars5=load_candles(symbol)
  bars1=aggregate_hourly(bars5)
  for name,model in models.items():
   source=bars5 if getattr(model,"timeframe","1h")=="5m" else bars1
   frame=model.populate_indicators(source.copy(),{"pair":pair})
   frame=model.populate_entry_trend(frame,{"pair":pair})
   frame=model.populate_exit_trend(frame,{"pair":pair})
   for label,start,end in STAGES:
    tag={"symbol":symbol,"strategy":name,"stage":label}
    try:
     metrics,trades,curve=simulate(frame,model,tag,start,end)
     row={**tag,**metrics}
     rows.append(row)
     details[symbol+"_"+name+"_"+label]={"trades":trades,"curve":curve[-2000:]}
     print("REPLAY_RESULT",symbol,name,label,"trades",row["trades"],
           "pct",row["net_profit_pct"],"wins",row["wins"],flush=True)
    except Exception as e:
     rows.append({**tag,"status":"BACKTEST_ERROR","error_class":type(e).__name__})
     print("REPLAY_ERROR",symbol,name,label,type(e).__name__,str(e)[:110],flush=True)
 output={
   "kind":"historical_simulation",
   "official_freqtrade_engine":False,
   "public_data_source":"data.binance.vision Binance USD-M 5m archives",
   "strategy_code_source":"freqtrade/freqtrade-strategies commit f3340ce11f5bdf62f598522e64d1f5638eaa13f5",
   "never_live_orders":True,
   "data_coverage":coverage,"rows":rows,"details":details,
   "disclaimer":"Historical replay only; NOT training or real profit. Excludes funding, liquidation, real orderbook and mark-price stop execution."
 }
 (RESULTS/"historical_simulation.json").write_text(json.dumps(output,separators=(",",":"),ensure_ascii=False))
 print("REPLAY_SUMMARY_ROWS",len(rows),"VALID",sum(x["status"]=="SIMULATED" for x in rows))

if __name__=="__main__":
 main()

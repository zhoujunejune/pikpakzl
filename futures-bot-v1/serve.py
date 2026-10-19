"""Local-only Binance futures paper dashboard behind an authenticated HTTPS proxy."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import datetime as dt
import html
import json
import os
import threading
import time
import traceback

import bot
from controls import read_control, change
from dashboard import PAGE
from live_dashboard import PAGE as LIVE_PAGE
import live_control
import live_engine
from market_health import snapshot as market_snapshot
from position_view import view as paper_position_view
from paper_portfolio import positions_for_display, reserved_margin
import quotes
from preflight import assess
from wallet_view import parse_futures_wallet, public_wallet

BOOT_AT=dt.datetime.now(dt.timezone.utc).isoformat()
WORKER={"running":False,"error":None,"finished_at":None,"preflight":None,"wallet":None}
QUOTE_STOP=threading.Event()

def refresh_wallet():
    """Read-only Binance account wallet refresh (120s), independent of paper PnL.

    Never places orders. Stops further polling on Binance 418/429/451.
    """
    while not QUOTE_STOP.wait(120):
        try:
            api=bot.API()
            api.server_time()
            fresh=parse_futures_wallet(api.call("GET","/fapi/v3/balance",signed=True))
            WORKER["wallet"]=fresh
        except Exception as e:
            msg=str(e)
            status="exchange_restricted" if any("HTTP "+str(code) in msg for code in (418,429,451)) else "refresh_failed"
            prev=WORKER.get("wallet") or {"assets":{},"asOf":None}
            WORKER["wallet"]={**prev,"status":status}
            if status=="exchange_restricted":
                return


def worker():
    WORKER["running"]=True
    try:
        if bot.MODE=="live":
            live_control.disarm_at_startup()  # A restart must never auto-enable real money orders.
        # No outbound requests during Binance 418 cooldown. After expiry, allow a
        # one-off test order permission check (does not enter matching engine).
        check=assess(allow_trade_test=bot.MODE=="paper")
        WORKER["wallet"]=check.get("wallet")
        WORKER["preflight"]={
            "outboundAllowed":check.get("outboundAllowed",False),
            "credentialNamesPresent":check.get("keyPresent",False) and check.get("secretPresent",False),
            "authenticated":check.get("authenticated",False),
            "testOrderPermission":check.get("tradePermissionTested",False),
            "blocker":("双向持仓模式已兼容，开启时验证交易权限" if bot.MODE=="live" and check.get("authenticated") and check.get("blocker")=="existing_positions_or_hedge_mode" else check.get("blocker")),
        }
        if not check.get("outboundAllowed"):
            raise RuntimeError("Exchange ban/cooldown until "+str(check.get("retryNotBefore")))
        # One aggregated public mark-price request every 15s; no trade keys used.
        # Failure with 418/429/451 stops this collector, not an IP bypass/retry.
        threading.Thread(target=quotes.run_quotes,args=(lambda:WORKER["running"],QUOTE_STOP),
                         name="paper-market-prices",daemon=True).start()
        if check.get("authenticated") and check.get("wallet"):
            threading.Thread(target=refresh_wallet,
                             name="readonly-futures-wallet",daemon=True).start()
        if bot.MODE=="live":
            live_engine.main()
        else:
            bot.main()
    except Exception as e:
        WORKER["error"]=str(e)[:200]
        WORKER["finished_at"]=dt.datetime.now(dt.timezone.utc).isoformat()
        bot.log("worker_failed", error=str(e)[:200])
    finally:
        WORKER["running"]=False
        QUOTE_STOP.set()

def public_snapshot():
    if bot.MODE=="live":
        try:
            return live_engine.snapshot(WORKER,quotes.current())
        except Exception as e:
            return {"mode":"live","liveTradingEnabled":False,"workerRunning":WORKER["running"],
                    "error":"live_state_unavailable","halted":True}
    try:
        current=bot.load()
        trades=current.get("history") or []
        balance=float(current.get("balance",bot.PAPER_BALANCE))
        days=[round(float(t.get("net",0)),6) for t in trades]
        stats={symbol:{"closed":0,"wins":0,"net":0.0,"open":False}
               for symbol in bot.SYMBOLS}
        for t in trades:
            symbol=(t.get("trade") or {}).get("symbol")
            if symbol in stats:
                st=stats[symbol]
                net=float(t.get("net",0))
                st["closed"]+=1
                st["wins"]+=int(net>0)
                st["net"]+=net
        paper_positions=positions_for_display(current)
        for symbol in paper_positions:
            if symbol in stats:
                stats[symbol]["open"]=True
        for st in stats.values():
            st["net"]=round(st["net"],4)
        market=market_snapshot(WORKER["running"])
        latest_prices=quotes.current()
        positions=list(paper_positions.values())
        position_details=[paper_position_view(trade,latest_prices,bot.TAKER_FEE) for trade in positions]
        position_details=[p for p in position_details if p is not None]
        simulation_reserved_by_asset={"USDT":0.0,"USDC":0.0}
        for trade in positions:
            asset="USDC" if trade["symbol"]=="BTCUSDC" else "USDT"
            simulation_reserved_by_asset[asset]+=reserved_margin({trade["symbol"]:trade},read_control()["leverage"])
        for asset in simulation_reserved_by_asset:
            simulation_reserved_by_asset[asset]=round(simulation_reserved_by_asset[asset],4)
        total_reserved=sum(simulation_reserved_by_asset.values())
        usdc_realized=round(sum(float(t.get("net",0)) for t in trades
                               if (t.get("trade") or {}).get("symbol")=="BTCUSDC"),4)
        # A worker thread is not by itself evidence of fresh Binance prices.
        if WORKER["error"] and any(x in WORKER["error"] for x in ("418","429","451")):
            market["status"]="exchange_restricted"
        return {
            "app":"zl-futures-bot-v1",
            "mode":"paper",
            "liveTradingEnabled":False,
            "storageNote":("Local state file: "+str(bot.STATE_FILE)+". On a persistent server disk, it survives service restarts; disk replacement or deletion loses data; no backup configured." if bot.STATE_FILE.is_absolute() else "Relative local state on ephemeral hosting may disappear after redeploy or restart; not a durable performance record."),
            "strategy":"5m breakout + 1h EMA trend",
            "configuredSymbols":bot.SYMBOLS,
            "supportedSymbols":list(quotes.SYMBOLS),
            "paperCurrencyNote":"Single synthetic U wallet; USDT and USDC accounted 1:1 (not actual exchange balances).",
            "startingBalance":bot.PAPER_BALANCE,
            "simulatedBalance":round(balance,4),
            "simulatedPnL":round(balance-bot.PAPER_BALANCE,4),
            "closedTrades":len(trades),
            "wins":sum(1 for x in days if x>0),
            "losses":sum(1 for x in days if x<=0),
            "symbolStats":stats,
            "onePositionAcrossAllSymbols":False,
            "onePositionPerSymbol":True,
            "cooldownRemainingSeconds":0,
            "maxConcurrentPaperPositions":len(bot.SYMBOLS),
            "paperReservedMargin":round(total_reserved,4),
            "paperMarginByAsset":simulation_reserved_by_asset,
            "paperFreeMargin":round(max(0.,balance-total_reserved),4),
            "paperUSDCRealizedPnL":usdc_realized,
            "futuresWallet":public_wallet(WORKER.get("wallet")),
            "lastTrades":[{"symbol":str((t.get("trade") or {}).get("symbol","UNKNOWN")),
                           "side":str((t.get("trade") or {}).get("side","")),
                           "net":round(float(t.get("net",0)),4),
                           "reason":str(t.get("reason",""))[:30],
                           "at":t.get("at"),
                           "marginAsset":"USDC" if (t.get("trade") or {}).get("symbol")=="BTCUSDC" else "USDT"} for t in trades[-12:]],
            "position":positions[0] if positions else None,  # old API consumer compatibility
            "positionDetail":position_details[0] if position_details else None,
            "positions":positions,
            "positionDetails":position_details,
            "latestPrices":latest_prices,
            "halted":bool(current.get("halt",False)),
            "workerRunning":WORKER["running"],
            "workerError":WORKER["error"],
            "preflight":WORKER["preflight"],
            "control":read_control(),
            "marketHealth":market,
            "exchangeAccess":market["status"],
            "leverageConfigured":bot.LEVERAGE,
            "leverageMaximum":20,
            "riskPerTradePercent":round(bot.RISK_FRACTION*100,2),
            "instanceBootAt":BOOT_AT,
            "serverNow":dt.datetime.now(dt.timezone.utc).isoformat(),
            "note":"Paper trades use reference mark prices, estimated fees, no order-book fill/slippage. Not proof of profit.",
        }
    except Exception as e:
        return {"app":"zl-futures-bot-v1","mode":"paper","liveTradingEnabled":False,"error":"state_unavailable", "workerRunning":WORKER["running"]}

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        # This endpoint must NEVER be accessible without the HTTPS reverse-proxy login.
        # Without a configured origin all writes are disabled, including localhost calls.
        import urllib.parse
        origin=os.environ.get("PUBLIC_ORIGIN","")
        if bot.MODE not in ("paper","live") or not origin or not origin.startswith("https://"):
            self.send_json({"error":"remote controls are not configured"},503);return
        expected_host=urllib.parse.urlsplit(origin).netloc
        if (self.path!="/api/control" or self.headers.get("Origin","")!=origin
            or self.headers.get("Host","")!=expected_host
            or self.headers.get("X-ZL-Control","")!="v1"
            or self.headers.get("Content-Type","").split(";")[0]!="application/json"
            or self.headers.get("Sec-Fetch-Site","same-origin") not in ("same-origin","none")):
            self.send_json({"error":"unauthorized action or origin"},403);return
        try:
            size=int(self.headers.get("Content-Length","0"))
            if size<=0 or size>512:
                self.send_json({"error":"invalid request size"},413);return
            obj=json.loads(self.rfile.read(size).decode("utf-8"))
            if not isinstance(obj,dict) or set(obj)-{"action","payload"}:
                raise ValueError("invalid command")
            action=obj.get("action")
            if not isinstance(action,str):raise ValueError("action must be a string")
            if bot.MODE=="live":
                if action=="live_off":
                    result=live_control.save_enabled(False)
                elif action=="live_on":
                    if not WORKER["running"] or WORKER["error"]:
                        raise ValueError("实盘引擎尚未正常运行")
                    if bot.KILL_FILE.exists():
                        raise ValueError("存在紧急锁定文件，禁止实盘开启")
                    state=live_engine.load()
                    if state.get("halt") or state.get("pending"):
                        raise ValueError("实盘流水存在未确认或锁定状态，禁止开启")
                    params=read_control()
                    if params["emergency_stop"] or not params["entry_enabled"]:
                        raise ValueError("交易控制仍是暂停或紧急锁定状态")
                    api=bot.API()
                    api.server_time()
                    hedge=str(api.call("GET","/fapi/v1/positionSide/dual",signed=True).get("dualSidePosition")).lower()=="true"
                    if api.positions():
                        raise ValueError("交易所已有持仓，先核对仓位，禁止机器人接管")
                    if any(api.algo_open(sym) for sym in bot.SYMBOLS):
                        raise ValueError("交易所存在原有止盈止损单，禁止自动接管")
                    test={"symbol":"BTCUSDT","side":"BUY","type":"MARKET","quantity":"0.002"}
                    if hedge:test["positionSide"]="LONG"
                    # Binance documented test-order endpoint never enters matching engine.
                    api.call("POST","/fapi/v1/order/test",test,signed=True)
                    if not bot.STATE_FILE.exists():
                        live_engine.persist(live_engine.blank())
                    result=live_control.save_enabled(True)
                elif action=="set_params":
                    # Adjust sizing of FUTURE positions only; do not change
                    # existing exchange orders or enable the live switch.
                    result=change("set_params",obj.get("payload"))
                else:
                    raise ValueError("实盘页面只支持开关和调整未来新仓参数")
            else:
                result=change(action,obj.get("payload"))
            self.send_json({"ok":True,"control":result})
        except (ValueError,TypeError,json.JSONDecodeError) as e:
            self.send_json({"error":str(e)[:160]},400)
        except Exception:
            self.send_json({"error":"control update failed"},500)
    def do_GET(self):
        # Mobile browsers and password managers may append query strings or use
        # /index.html after completing their HTTP Basic-Auth prompt.
        # Parse only the path; never log query strings or credentials.
        from urllib.parse import urlsplit
        path=urlsplit(self.path).path
        if path in ("/healthz","/health"):
            payload={"ok":True,"mode":bot.MODE,"workerRunning":WORKER["running"],"bootAt":BOOT_AT}
            self.send_json(payload)
        elif path=="/status":
            self.send_json(public_snapshot())
        elif path in ("/","/index.html","/dashboard","/dashboard/"):
            payload=(LIVE_PAGE if bot.MODE=="live" else PAGE).encode()
            self.send_response(200)
            self.send_header("Content-Type","text/html; charset=utf-8")
            self.send_header("Cache-Control","no-store")
            self.send_header("Content-Length",str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            self.send_error(404)
    def send_json(self,value,status=200):
        payload=json.dumps(value,ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Cache-Control","no-store")
        self.send_header("Content-Length",str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self,format,*args):
        pass

def main():
    if bot.MODE not in ("paper","live"):
        raise RuntimeError("Invalid futures engine mode")
    t=threading.Thread(target=worker,name="futures-engine",daemon=True)
    t.start()
    port=int(os.environ.get("PORT","10000"))
    bot.log("paper_control_http_ready",port=port,boundHost=os.environ.get("BIND_HOST", "127.0.0.1"))
    ThreadingHTTPServer((os.environ.get("BIND_HOST", "127.0.0.1"),port),Handler).serve_forever()

if __name__=="__main__":
    main()

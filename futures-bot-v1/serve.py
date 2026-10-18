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
from preflight import assess

BOOT_AT=dt.datetime.now(dt.timezone.utc).isoformat()
WORKER={"running":False,"error":None,"finished_at":None,"preflight":None}

def worker():
    WORKER["running"]=True
    try:
        # No outbound requests during Binance 418 cooldown. After expiry, allow a
        # one-off test order permission check (does not enter matching engine).
        check=assess(allow_trade_test=True)
        WORKER["preflight"]={
            "outboundAllowed":check.get("outboundAllowed",False),
            "credentialNamesPresent":check.get("keyPresent",False) and check.get("secretPresent",False),
            "authenticated":check.get("authenticated",False),
            "testOrderPermission":check.get("tradePermissionTested",False),
            "blocker":check.get("blocker"),
        }
        if not check.get("outboundAllowed"):
            raise RuntimeError("Exchange ban/cooldown until "+str(check.get("retryNotBefore")))
        bot.main()
    except Exception as e:
        WORKER["error"]=str(e)[:200]
        WORKER["finished_at"]=dt.datetime.now(dt.timezone.utc).isoformat()
        bot.log("worker_failed", error=str(e)[:200])
    finally:
        WORKER["running"]=False

def public_snapshot():
    try:
        current=bot.load()
        trades=current.get("history") or []
        balance=float(current.get("balance",bot.PAPER_BALANCE))
        days=[round(float(t.get("net",0)),6) for t in trades]
        return {
            "app":"zl-futures-bot-v1",
            "mode":"paper",
            "liveTradingEnabled":False,
            "storageNote":("Local state file: "+str(bot.STATE_FILE)+". On a persistent server disk, it survives service restarts; disk replacement or deletion loses data; no backup configured." if bot.STATE_FILE.is_absolute() else "Relative local state on ephemeral hosting may disappear after redeploy or restart; not a durable performance record."),
            "strategy":"5m breakout + 1h EMA trend",
            "startingBalance":bot.PAPER_BALANCE,
            "simulatedBalance":round(balance,4),
            "simulatedPnL":round(balance-bot.PAPER_BALANCE,4),
            "closedTrades":len(trades),
            "wins":sum(1 for x in days if x>0),
            "losses":sum(1 for x in days if x<=0),
            "lastTrades":[{"net":round(float(t.get("net",0)),4),"reason":str(t.get("reason",""))[:30],
                           "at":t.get("at")} for t in trades[-12:]],
            "position":current.get("trade"),
            "halted":bool(current.get("halt",False)),
            "workerRunning":WORKER["running"],
            "workerError":WORKER["error"],
            "preflight":WORKER["preflight"],
            "control":read_control(),
            "exchangeAccess": "blocked" if WORKER["error"] and any(x in WORKER["error"] for x in ("418", "451", "429")) else ("engine_running_no_recent_error" if WORKER["running"] else "unverified"),
            "leverageConfigured":bot.LEVERAGE,
            "leverageMaximum":20,
            "riskPerTradePercent":round(bot.RISK_FRACTION*100,2),
            "instanceBootAt":BOOT_AT,
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
        if bot.MODE!="paper" or not origin or not origin.startswith("https://"):
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
            result=change(action,obj.get("payload"))
            self.send_json({"ok":True,"control":result})
        except (ValueError,TypeError,json.JSONDecodeError) as e:
            self.send_json({"error":str(e)[:160]},400)
        except Exception:
            self.send_json({"error":"control update failed"},500)
    def do_GET(self):
        if self.path in ("/healthz","/health"):
            payload={"ok":True,"mode":"paper","workerRunning":WORKER["running"],"bootAt":BOOT_AT}
            self.send_json(payload)
        elif self.path=="/status":
            self.send_json(public_snapshot())
        elif self.path=="/":
            payload=PAGE.encode()
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
    if bot.MODE!="paper":
        raise RuntimeError("Render preview is paper-only: refuse live mode in web service")
    t=threading.Thread(target=worker,name="paper-engine",daemon=True)
    t.start()
    port=int(os.environ.get("PORT","10000"))
    bot.log("paper_control_http_ready",port=port,boundHost=os.environ.get("BIND_HOST", "127.0.0.1"))
    ThreadingHTTPServer((os.environ.get("BIND_HOST", "127.0.0.1"),port),Handler).serve_forever()

if __name__=="__main__":
    main()

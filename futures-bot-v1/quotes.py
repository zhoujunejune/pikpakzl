"""Bounded, independent read-only price snapshots for paper dashboard.

Fetch ONE public aggregated Binance USDT-M mark-price endpoint every 15 seconds.
Never use Binance trade credentials and never send orders. Stop rather than
retry after exchange 418/429/451 restrictions. The widget shows stale quotes
as stale, not as live market data.
"""
import datetime as dt
import math
import threading
import time

SYMBOLS=("BTCUSDT","ETHUSDT")
LOCK=threading.Lock()
VALUES={}
ERROR=None
POLL_SECONDS=15
FRESH_SECONDS=45

def iso(ts):
    return dt.datetime.fromtimestamp(ts,dt.timezone.utc).isoformat()

def ingest(payload,now=None):
    """Validate exchange timestamps and mark prices; ignore non-target tokens."""
    global ERROR
    now=time.time() if now is None else float(now)
    if not isinstance(payload,list):
        return 0
    valid={}
    for item in payload:
        if not isinstance(item,dict) or item.get("symbol") not in SYMBOLS:
            continue
        try:
            price=float(item["markPrice"])
            source_at=float(item["time"])/1000.0
        except (TypeError,ValueError,KeyError,OverflowError):
            continue
        if not (math.isfinite(price) and price>0 and math.isfinite(source_at)
                and -10<=now-source_at<=120):
            continue
        valid[item["symbol"]]={"price":price,"sourceAt":source_at,"receivedAt":now}
    with LOCK:
        VALUES.update(valid)
        if valid:
            ERROR=None
    return len(valid)

def failure(reason):
    global ERROR
    with LOCK:
        ERROR=str(reason)[:80]

def current(now=None):
    now=time.time() if now is None else float(now)
    with LOCK:
        data={symbol:dict(value) for symbol,value in VALUES.items()}
        error=ERROR
    quotes={}
    for symbol in SYMBOLS:
        value=data.get(symbol)
        if not value:
            quotes[symbol]={"price":None,"updatedAt":None,"ageSeconds":None,"stale":True}
            continue
        age=max(0,int(now-value["receivedAt"]))
        source_age=max(0,int(now-value["sourceAt"]))
        quotes[symbol]={
            "price":value["price"],
            "updatedAt":iso(value["receivedAt"]),
            "exchangeTime":iso(value["sourceAt"]),
            "ageSeconds":age,
            "exchangeAgeSeconds":source_age,
            "stale":age>FRESH_SECONDS or source_age>FRESH_SECONDS,
        }
    return {"symbols":quotes,"pollIntervalSeconds":POLL_SECONDS,
            "priceType":"Binance USD-M mark price / 公共标记价格",
            "error":error}

def run_quotes(is_engine_running,stop_event):
    # No root privileges or trading API credentials required.
    import bot
    client=bot.API()
    while is_engine_running() and not stop_event.is_set():
        try:
            data=client.call("GET","/fapi/v1/premiumIndex")
            if not ingest(data):
                failure("no_fresh_quotes")
        except Exception as exc:
            message=str(exc)
            if any("HTTP "+str(s) in message for s in (418,429,451)):
                failure("exchange_access_restricted")
                return
            failure("quote_request_failed")
        stop_event.wait(POLL_SECONDS)

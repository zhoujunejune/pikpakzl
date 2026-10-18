"""In-process observations of successful public Binance futures market responses.

Observes EXISTING trading-engine HTTP responses; never creates extra exchange
requests. A healthy worker thread alone is not proof of live market data.
"""
import datetime as dt
import threading
import time

_LOCK=threading.Lock()
_LAST=None
_LAST_ERROR=None

def record(path,params,payload,now=None):
    """Record one plausible, current mark-price or kline response."""
    global _LAST,_LAST_ERROR
    now=time.time() if now is None else float(now)
    params=params or {}
    symbol=str(params.get("symbol","")).upper()
    valid=False
    source=""
    source_timestamp=None
    if path=="/fapi/v1/premiumIndex" and isinstance(payload,dict):
        try:
            price=float(payload["markPrice"])
            source_timestamp=float(payload["time"])/1000
            valid=price>0 and 0<=now-source_timestamp<=120
            source="标记价格"
        except (ValueError,TypeError,KeyError,OverflowError):
            return False
    elif path=="/fapi/v1/klines" and isinstance(payload,list) and len(payload)>0:
        interval=str(params.get("interval",""))
        if interval not in ("5m","1h"):
            return False
        try:
            row=payload[-1]
            source_timestamp=float(row[0])/1000
            close=float(row[4])
            max_age=420 if interval=="5m" else 3900
            valid=(close>0 and 0<=now-source_timestamp<=max_age)
            source=interval+" K线"
        except (ValueError,TypeError,IndexError,OverflowError):
            return False
    if not valid or symbol not in ("BTCUSDT","ETHUSDT"):
        return False
    with _LOCK:
        _LAST={"receivedAt":now,"sourceAt":source_timestamp,"symbol":symbol,"source":source}
        _LAST_ERROR=None
    return True

def record_error(code,now=None):
    """A failed market request must not be mistaken for a successful response."""
    global _LAST_ERROR
    with _LOCK:
        _LAST_ERROR={"code":str(code)[:16],"at":time.time() if now is None else float(now)}

def snapshot(worker_running,now=None):
    now=time.time() if now is None else float(now)
    with _LOCK:
        item=dict(_LAST) if _LAST else None
        err=dict(_LAST_ERROR) if _LAST_ERROR else None
    observed_at=item["receivedAt"] if item else None
    age=max(0,int(now-observed_at)) if observed_at is not None else None
    source_age=max(0,int(now-item["sourceAt"])) if item else None
    error_recent=bool(err and now-err["at"] < 150 and (not item or err["at"]>=item["receivedAt"]))
    if not worker_running:
        status="engine_stopped"
    elif error_recent:
        status="request_failed"
    elif age is None:
        status="waiting_first_market_data"
    elif age>max(120,3*30):
        status="market_data_stale"
    else:
        status="market_data_received"
    return {
        "status":status,
        "lastSuccessAt":dt.datetime.fromtimestamp(observed_at,dt.timezone.utc).isoformat() if observed_at else None,
        "lastSuccessAgeSeconds":age,
        "sourceAgeSeconds":source_age,
        "source":str(item["source"]) if item else None,
        "symbol":str(item["symbol"]) if item else None,
        "lastRequestError":str(err["code"]) if error_recent else None,
        "meaning":"observed one recent valid REST market response; this does not verify all symbols or trade execution",
    }

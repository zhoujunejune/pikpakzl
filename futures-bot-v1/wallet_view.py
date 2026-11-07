"""Read-only display adapter for authenticated Binance USD-M USDT/USDC wallets.

Only data from /fapi/v3/balance is labeled real; missing assets stay unknown.
A paper synthetic U pool must never be represented as real USDC.
"""
import datetime as dt
import math

ASSETS=("USDT","USDC")

def parse_futures_wallet(rows,now=None):
    if not isinstance(rows,list):
        raise ValueError("Expected futures balance rows")
    values={}
    for row in rows:
        if not isinstance(row,dict) or row.get("asset") not in ASSETS:
            continue
        asset=row["asset"]
        # Missing numeric amounts are unknown, not zero.
        wallet=row.get("balance")
        available=row.get("availableBalance")
        def safe_float(n):
            if n is None or isinstance(n,bool):
                return None
            try:
                value=float(n)
            except (TypeError,ValueError,OverflowError):
                return None
            return round(value,8) if math.isfinite(value) else None
        values[asset]={"walletBalance":safe_float(wallet),"availableBalance":safe_float(available)}
    return {"status":"ok","assets":values,
            "asOf":now or dt.datetime.now(dt.timezone.utc).isoformat()}

def public_wallet(snapshot,max_age_seconds=300,now=None):
    if not isinstance(snapshot,dict):
        return {"status":"unavailable","assets":{},"asOf":None}
    data={"status":snapshot.get("status","unavailable"),
          "assets":snapshot.get("assets",{}),"asOf":snapshot.get("asOf")}
    if data["status"]=="ok" and data["asOf"]:
        try:
            stamp=dt.datetime.fromisoformat(data["asOf"].replace("Z","+00:00"))
            clock=now or dt.datetime.now(dt.timezone.utc)
            if (clock-stamp).total_seconds()>max_age_seconds:
                data["status"]="stale"
        except (ValueError,TypeError):
            data["status"]="stale"
    return data

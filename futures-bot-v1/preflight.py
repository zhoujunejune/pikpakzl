"""Read-only Binance USD-M permission and position preflight.

NO real orders are submitted. Optional /order/test is a documented *test* endpoint
that does not reach the matching engine. Run only after any Retry-After expires.
No key values, balances or detailed positions are logged.
"""
import json
import os
import sys
from bot import API, seconds_until_binance_retry, BINANCE_RETRY_NOT_BEFORE_UTC

def assess(api=None, allow_trade_test=False):
    remaining=seconds_until_binance_retry()
    result={
        "kind":"binance_usdm_preflight_v1",
        "outboundAllowed":remaining==0,
        "retryNotBefore":BINANCE_RETRY_NOT_BEFORE_UTC or None,
        "retryRemainingSeconds":remaining,
        "keyPresent":bool(os.getenv("BINANCE_API_KEY")),
        "secretPresent":bool(os.getenv("BINANCE_API_SECRET")),
        "authenticated":False,
        "tradePermissionTested":False,
        "accountPositionCount":None,
        "protectiveOrderCount":None,
        "canEnableRealTrading":False,
    }
    if remaining>0:
        result["blocker"]="exchange_cooldown"
        return result
    if not (result["keyPresent"] and result["secretPresent"]):
        result["blocker"]="futures_credentials_not_present_on_this_service"
        return result
    client=api or API()
    try:
        client.server_time()
        balances=client.call("GET","/fapi/v3/balance",signed=True)
        positions=client.positions()
        hedge=client.call("GET","/fapi/v1/positionSide/dual",signed=True)
        result["authenticated"]=True
        result["accountPositionCount"]=len(positions)
        result["hedgeMode"]=str(hedge.get("dualSidePosition","")).lower()=="true"
        # Existing manual positions or Hedge mode always block a new unattended bot.
        if positions or result["hedgeMode"]:
            result["blocker"]="existing_positions_or_hedge_mode"
            return result
        orders=[]
        for symbol in ("BTCUSDT","ETHUSDT"):
            orders.extend(client.algo_open(symbol))
        result["protectiveOrderCount"]=len(orders)
        if orders:
            result["blocker"]="existing_algo_orders_manual_review"
            return result
        if allow_trade_test:
            # Test order requires TRADE permission but never enters the matching engine.
            client.call("POST","/fapi/v1/order/test",{
                "symbol":"BTCUSDT","side":"BUY","type":"MARKET","quantity":"0.002"
            },signed=True)
            result["tradePermissionTested"]=True
        result["blocker"]="durable_storage_and_live_recovery_not_certified"
    except Exception as e:
        # Do not print raw HTTP response bodies or private account details.
        msg=str(e)
        if "HTTP 418" in msg or "HTTP 429" in msg or "HTTP 451" in msg:
            result["blocker"]="exchange_access_denied"
            result["httpError"]=next((x for x in (418,429,451) if f"HTTP {x}" in msg),None)
        else:
            result["blocker"]="authenticated_preflight_failed"
            result["errorClass"]=type(e).__name__
    return result

if __name__=="__main__":
    print(json.dumps(assess(allow_trade_test="--test-order" in sys.argv)))

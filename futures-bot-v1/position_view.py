"""Paper position view, exactly matching the persisted simulated trade journal.

No fabricated prices or PnL without a fresh quote. Uses marked price and the
same estimated 0.05% per-side taker fee as the existing paper settlement.
"""
import math

def view(trade,quotes,fee_rate=0.0005):
    if not trade:
        return None
    try:
        symbol=str(trade["symbol"])
        side=str(trade["side"])
        if side not in ("BUY","SELL") or symbol not in ("BTCUSDT","ETHUSDT"):
            return None
        entry=float(trade["entry"])
        qty=float(trade["qty"])
        stop=float(trade["stop"])
        take_profit=float(trade["tp"])
        if not all(math.isfinite(x) and x>0 for x in (entry,qty,stop,take_profit)):
            return None
        if side=="BUY" and not(stop<entry<take_profit):
            return None
        if side=="SELL" and not(take_profit<entry<stop):
            return None
    except (TypeError,ValueError,KeyError,OverflowError):
        return None
    quote=(quotes.get("symbols") or {}).get(symbol) or {}
    live=not quote.get("stale",True) and quote.get("price") is not None
    price=quote.get("price") if live else None
    gross=net=None
    if price is not None:
        price=float(price)
        sign=1 if side=="BUY" else -1
        gross=(price-entry)*qty*sign
        net=gross-(entry+price)*qty*fee_rate
    return {
        "symbol":symbol,"side":side,"quantity":qty,
        "entryPrice":entry,"stopPrice":stop,"takeProfitPrice":take_profit,
        "openAt":trade.get("at"),"isPaper":trade.get("paper",False),
        "markPrice":price,"markPriceStale":not live,
        "markAgeSeconds":quote.get("ageSeconds"),
        "estimatedGrossPnl":round(gross,4) if gross is not None else None,
        "estimatedNetPnl":round(net,4) if net is not None else None,
        "estimatedNetPnlPctNotional":round(net/(entry*qty)*100,3) if net is not None else None,
        "distanceToStopPct":round(abs(price-stop)/price*100,3) if price else None,
        "distanceToTakeProfitPct":round(abs(price-take_profit)/price*100,3) if price else None,
        "estimatedEntryNotional":round(entry*qty,4),
        "feeAssumption":"entry+exit 0.05% each, excludes funding, slippage, liquidation and price gaps",
    }

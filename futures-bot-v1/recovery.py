"""Fail-closed exchange snapshot validation for isolated one-way USD-M positions.

Only exchange-owned positions accompanied by BOTH of this program's own
identifiable exchange-hosted STOP and TAKE_PROFIT algo orders qualify.
No orders are submitted or cancelled by this module.
"""
import time

class ManualReviewRequired(RuntimeError):
    pass

def reconstruct_owned_position(positions, algos, allowed_symbols=("BTCUSDT","ETHUSDT","BTCUSDC")):
    """Return None if flat with no owned algos, or an owned position snapshot.

    Raise ManualReviewRequired if unknown/ambiguous. Never infer ownership from
    symbol alone. Do not auto resume trading after restoration.
    """
    active=[x for x in positions if abs(float(x.get("positionAmt",0)))>1e-10]
    owned=[x for x in algos if str(x.get("clientAlgoId","")).startswith(("ZLS_","ZLT_"))]
    if not active:
        if owned:
            raise ManualReviewRequired("Orphan bot algo orders on flat account")
        return None
    if len(active)!=1:
        raise ManualReviewRequired("Multiple open positions")
    p=active[0]
    symbol=str(p.get("symbol",""))
    if symbol not in allowed_symbols:
        raise ManualReviewRequired("Position symbol not permitted")
    if str(p.get("positionSide","BOTH"))!="BOTH":
        raise ManualReviewRequired("Hedge-mode position")
    qty=abs(float(p["positionAmt"]))
    if qty<=0:
        raise ManualReviewRequired("Position quantity missing")
    entry=float(p["entryPrice"])
    if entry<=0:
        raise ManualReviewRequired("Entry price missing")
    side="BUY" if float(p["positionAmt"])>0 else "SELL"
    close_side="SELL" if side=="BUY" else "BUY"
    def selection(prefix,kind):
        result=[]
        for a in algos:
            if not str(a.get("clientAlgoId","")).startswith(prefix):
                continue
            if a.get("symbol")!=symbol or a.get("side")!=close_side:
                raise ManualReviewRequired("Unexpected protective order symbol/side")
            if a.get("positionSide","BOTH")!="BOTH":
                raise ManualReviewRequired("Unexpected protective order mode")
            if str(a.get("closePosition","")).lower()!="true":
                raise ManualReviewRequired("Protective order not close-all")
            if a.get("orderType",a.get("type"))!=kind:
                raise ManualReviewRequired("Protective order type mismatch")
            if str(a.get("algoStatus","NEW")) not in ("NEW","WORKING"):
                raise ManualReviewRequired("Protective order not live")
            result.append(a)
        if len(result)!=1:
            raise ManualReviewRequired("Missing or duplicate "+kind)
        return result[0]
    stop=selection("ZLS_","STOP_MARKET")
    target=selection("ZLT_","TAKE_PROFIT_MARKET")
    if len(owned)!=2:
        raise ManualReviewRequired("Unexpected additional bot protective orders")
    sl=float(stop["triggerPrice"])
    tp=float(target["triggerPrice"])
    if side=="BUY" and not (sl<entry<tp):
        raise ManualReviewRequired("Invalid long protective triggers")
    if side=="SELL" and not (tp<entry<sl):
        raise ManualReviewRequired("Invalid short protective triggers")
    if not stop.get("algoId") or not target.get("algoId"):
        raise ManualReviewRequired("Missing algo IDs")
    return {"symbol":symbol,"side":side,"qty":qty,"entry":entry,
            "stop":sl,"tp":tp,
            "algo_ids":[stop["algoId"],target["algoId"]],
            "at":int(time.time()),"paper":False,"recovered":True}

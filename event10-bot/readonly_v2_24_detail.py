#!/usr/bin/env python3
"""EVENT10 V2 historical signal audit: read-only; never rewrite session or ledger."""
import json
import datetime
import time
from readonly_old_10min_recalc import read_sessions,read_ledger,historical_minutes,OLD_INDEX,MINUTE,HORIZON,positive,millis

def local(ms):
    return datetime.datetime.fromtimestamp(ms/1000,
       datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")

sessions=read_sessions()
ledger=read_ledger()
combined={}
for id,r in ledger.items():combined[id]=dict(r)
for id,r in sessions.items():combined[id]={**combined.get(id,{}),**r}
records=[]
for x in combined.values():
    version=x.get("decisionReviewVersion") or x.get("strategyVersion")
    if version==OLD_INDEX and x.get("direction") in ("UP","DOWN") and millis(x.get("openedAt")):
        records.append(x)
records.sort(key=lambda x:x["openedAt"])
if len(records)!=24:
    # Do not silently fabricate or trim records if the server has progressed.
    print("V2_DETAIL_SOURCE_COUNT="+str(len(records)))
if not records:
    print("V2_DETAIL_JSON="+json.dumps({"n":0,"rows":[]}))
    raise SystemExit(0)
start=min(r["openedAt"] for r in records)
finish=max(r["openedAt"] for r in records)+HORIZON
bars,calls=historical_minutes(start-MINUTE,finish+MINUTE)
rows=[]
for x in records:
    t=x["openedAt"]; exp=t+HORIZON
    c=bars.get((exp//MINUTE)*MINUTE)
    reference=x.get("liveIndexPrice")
    quoteAt=x.get("referencePriceObservedAt")
    valid=positive(reference) and millis(quoteAt) and 0<=t-quoteAt<=5000
    if not c or not valid:outcome="无法核实"
    elif c[2]>reference:outcome="确定命中" if x["direction"]=="UP" else "确定未命中"
    elif c[1]<reference:outcome="确定命中" if x["direction"]=="DOWN" else "确定未命中"
    else:outcome="分钟内跨价，无法确定"
    if c and valid:
        estimate=c[0] if exp%MINUTE<30000 else c[3]
        guess="估算命中" if ((estimate>reference and x["direction"]=="UP") or
            (estimate<reference and x["direction"]=="DOWN")) else "估算未命中"
        if estimate==reference:guess="持平"
    else:estimate=None;guess="无法估算"
    rows.append({
        "id":x["id"],
        "signalTime":local(t),
        "expiryTime":local(exp),
        "utcTime":t,
        "signal":x["direction"],
        "reference":round(reference,5) if valid else None,
        "originalCycleOpen":round(x["openPrice"],5) if positive(x.get("openPrice")) else None,
        "expiryMinuteOpen":round(c[0],5) if c else None,
        "expiryMinuteHigh":round(c[1],5) if c else None,
        "expiryMinuteLow":round(c[2],5) if c else None,
        "expiryMinuteClose":round(c[3],5) if c else None,
        "approxPrice":round(estimate,5) if estimate is not None else None,
        "classification":outcome,
        "estimate":guess,
        "legacyHit":x.get("proxyHit") if isinstance(x.get("proxyHit"),bool) else None,
        "referenceLagMs":t-quoteAt if valid else None
    })
summary={k:sum(r["classification"]==k for r in rows) for k in ["确定命中","确定未命中","分钟内跨价，无法确定","无法核实"]}
result={"method":"V2 ORIGINAL LOCKED liveIndexPrice vs FUTURE +600s USD-M 1m index OHLC",
    "sourceCount":len(sessions),"ledgerCount":len(ledger),
    "apiCalls":calls,"indexMinuteBars":len(bars),
    "total":len(rows),"summary":summary,"rows":rows,
    "disclaimer":"1m OHLC bounds certify direction if fully above/below reference; ambiguous rows lack exact tick."}
print("V2_DETAIL_JSON="+json.dumps(result,ensure_ascii=False,separators=(",",":")))

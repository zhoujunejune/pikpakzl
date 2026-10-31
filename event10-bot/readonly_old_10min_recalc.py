#!/usr/bin/env python3
"""Read-only forensic check of historical EVENT10 signals at signal timestamp + 600s.
Does not alter trade data, service state, signals or stored settlements.
Only emits aggregate counts; no identifiers, prices, secrets or trades in public CI logs.
Uses public Binance BTCUSDT USD-M index 1m OHLC, NOT exact 1s index or official event settlement.
"""
import collections
import datetime
import json
import math
import pathlib
import statistics
import time
import urllib.parse
import urllib.request

SAVED=pathlib.Path("/var/lib/zl-event10/manual-sessions-v2.json")
LEDGER=pathlib.Path("/var/lib/zl-event10/rule-signals-v1.ndjson")
CURRENT="EVENT10_SIGNAL_TPLUS10_INDEX_V3_20261031"
OLD_INDEX="EVENT10_LATE_INDEX_LEAD_RETRACE_V2_20261030"
HORIZON=600000
MINUTE=60000
BINANCE="https://fapi.binance.com/fapi/v1/indexPriceKlines"

def millis(x):
    return isinstance(x,(int,float)) and math.isfinite(x) and 1700000000000 < x < 1900000000000

def positive(x):
    return isinstance(x,(int,float)) and math.isfinite(x) and x>0

def read_sessions():
    result={}
    if SAVED.is_file():
        data=json.loads(SAVED.read_text())
        if not isinstance(data,list): raise ValueError("SESSION_HISTORY_NOT_ARRAY")
        for r in data:
            if not isinstance(r,dict) or not isinstance(r.get("id"),str):continue
            result[r["id"]]=dict(r)
    return result

def read_ledger():
    result={}
    if not LEDGER.is_file():return result
    for i,line in enumerate(LEDGER.read_text().splitlines(),1):
        if not line.strip():continue
        x=json.loads(line)
        if x.get("kind")=="SIGNAL":
            r=x.get("signal")
            if isinstance(r,dict) and isinstance(r.get("id"),str):
                result[r["id"]]=dict(r)
        elif x.get("kind")=="SETTLEMENT":
            prior=result.get(x.get("id"))
            if prior is not None and isinstance(x.get("result"),dict):
                prior.update(x["result"])
    return result

def utc(ms):
    return datetime.datetime.fromtimestamp(ms/1000,datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")

def historical_minutes(from_ms,to_ms):
    current=(from_ms//MINUTE)*MINUTE
    stop=((to_ms//MINUTE)+1)*MINUTE
    data={}
    calls=0
    while current < stop:
        query=urllib.parse.urlencode({"pair":"BTCUSDT","interval":"1m","startTime":current,"limit":1500})
        request=urllib.request.Request(BINANCE+"?"+query,headers={
            "Accept":"application/json","User-Agent":"ZL-event10-readonly-audit/1.0"})
        try:
            with urllib.request.urlopen(request,timeout=18) as response:
                rows=json.load(response)
        except Exception as exc:
            print("INDEX_HISTORY_FETCH_ERROR="+type(exc).__name__)
            break
        calls+=1
        if not isinstance(rows,list) or not rows:
            break
        latest=current
        for r in rows:
            try:
                ms=int(r[0]); op=float(r[1]); hi=float(r[2]); lo=float(r[3]); cl=float(r[4])
                if ms>=current and min(op,hi,lo,cl)>0 and lo<=min(op,cl)<=hi and lo<=max(op,cl)<=hi:
                    data[ms]=(op,hi,lo,cl)
                    latest=max(latest,ms)
            except (ValueError,TypeError,IndexError):continue
        if latest<current:break
        current=latest+MINUTE
        if calls>=40:break
        time.sleep(0.1)
    return data,calls

def classify(r,bars):
    start=r["openedAt"]; expiry=start+HORIZON
    finish=bars.get((expiry//MINUTE)*MINUTE)
    if not finish:return "missing_end",None
    if r["strategy"]==OLD_INDEX and positive(r.get("liveIndexPrice")):
        lo=hi=float(r["liveIndexPrice"])
        anchor="stored_quote"
        # Previous real-time index quotes were accepted only if <= 5sec old.
        observed=r.get("referencePriceObservedAt")
        if not millis(observed) or not (0<=start-observed<=5000):
            return "uncertain_entry",None
    else:
        first=bars.get((start//MINUTE)*MINUTE)
        if not first:return "missing_start",None
        lo,hi=first[2],first[1]
        anchor="index_minute_range"
    if finish[2]>hi:
        direction="UP"
    elif finish[1]<lo:
        direction="DOWN"
    else:
        direction=None
    definite=None if direction is None else (direction==r["direction"])
    # For context only: minute open or close nearest to required expiration second.
    nearest=finish[0] if expiry%MINUTE < 30000 else finish[3]
    estimate="UP" if nearest>(hi+lo)/2 else "DOWN" if nearest<(hi+lo)/2 else None
    return ("definite_win" if definite else "definite_loss") if definite is not None else "minute_ambiguous", {
        "anchor":anchor,"minute_estimate": None if estimate is None else (estimate==r["direction"]),
        "minute_up_span":finish[1]-finish[2]
    }

def main():
    sessions=read_sessions()
    ledger=read_ledger()
    merged={}
    for id,r in ledger.items():
        merged[id]=r
    for id,r in sessions.items():
        merged[id]={**merged.get(id,{}),**r}
    counted=[]
    excluded=collections.Counter()
    for r in merged.values():
        direction=r.get("direction")
        if direction not in ("UP","DOWN"):continue
        version=r.get("decisionReviewVersion") or r.get("strategyVersion") or "UNVERSIONED"
        if version==CURRENT:continue
        start=r.get("openedAt")
        if not millis(start):
            excluded["bad_time"]+=1
            continue
        if start+HORIZON>time.time()*1000:
            excluded["not_yet_matured"]+=1
            continue
        counted.append({**r,"strategy":version})
    result={
        "auditMode":"READ_ONLY_MINUTE_BOUNDARY_INDEX_PROXY",
        "reference":"signal-openedAt +600000ms; both index bars are 1m OHLC",
        "conservativeCriterion":"exit minute LOW > entry HIGH proves UP; exit HIGH < entry LOW proves DOWN",
        "stateSessionCount":len(sessions),
        "ledgerSignalCount":len(ledger),
        "legacyEligibleCount":len(counted),
        "legacyVersions":dict(collections.Counter(r["strategy"] for r in counted)),
        "earliestUtc":utc(min(r["openedAt"] for r in counted)) if counted else None,
        "latestUtc":utc(max(r["openedAt"] for r in counted)) if counted else None,
        "excluded":dict(excluded)
    }
    if not counted:
        print("EVENT10_RECALC_AGGREGATE="+json.dumps(result,ensure_ascii=False,separators=(",",":")))
        return
    start=min(r["openedAt"] for r in counted)-MINUTE
    end=max(r["openedAt"] for r in counted)+HORIZON+MINUTE
    bars,calls=historical_minutes(start,end)
    result["indexMinuteBarsRead"]=len(bars)
    result["indexApiCalls"]=calls
    groups=collections.defaultdict(list)
    for r in counted:groups[r["strategy"]].append(r)
    stats={}
    for version,records in sorted(groups.items()):
        c=collections.Counter()
        original=collections.Counter()
        quote_anchors=0
        estimate_win=estimate_loss=0
        for r in records:
            status,info=classify(r,bars)
            c[status]+=1
            if info and info["anchor"]=="stored_quote":quote_anchors+=1
            if info and info["minute_estimate"] is True:estimate_win+=1
            if info and info["minute_estimate"] is False:estimate_loss+=1
            if isinstance(r.get("proxyHit"),bool):original["win" if r["proxyHit"] else "loss"]+=1
        definite=c["definite_win"]+c["definite_loss"]
        possible=definite+c["minute_ambiguous"]
        stats[version]={
            "signals":len(records),"storedIndexAtSignal":quote_anchors,
            "certainWins":c["definite_win"],"certainLosses":c["definite_loss"],
            "ambiguousMinute":c["minute_ambiguous"],
            "missingEntryMinute":c["missing_start"],
            "missingExitMinute":c["missing_end"],
            "uncertainStoredEntry":c["uncertain_entry"],
            "certainSubsetWinRatePct":round(100*c["definite_win"]/definite,2) if definite else None,
            "oldOriginalProxyWins":original["win"],"oldOriginalProxyLosses":original["loss"],
            "minuteApproxWins":estimate_win,"minuteApproxLosses":estimate_loss,
            "minuteApproxWinPct":round(100*estimate_win/(estimate_win+estimate_loss),2)
                if estimate_win+estimate_loss else None,
            "allUsableOutcomeLowerPct":round(100*c["definite_win"]/possible,2) if possible else None,
            "allUsableOutcomeUpperPct":round(100*(c["definite_win"]+c["minute_ambiguous"])/possible,2) if possible else None
        }
    result["breakdown"]=stats
    print("EVENT10_RECALC_AGGREGATE="+json.dumps(result,ensure_ascii=False,separators=(",",":")))

if __name__=="__main__":
    main()

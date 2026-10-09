#!/usr/bin/env python3
"""Independent, read-only Binance prediction settlement audit. Fail closed."""
import datetime as dt
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error

BASE = os.environ.get("BINANCE_PREDICTION_API_BASE", "https://api.binance.com").rstrip("/")
DETAIL = "/sapi/v1/w3w/wallet/prediction/market/detail"
STATS = "https://trade-control-panel-production.up.railway.app/api/round-stats"

def get_json(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "independent-settlement-audit/1"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.load(resp)

def official_detail(topic_id, key, secret):
    query = urllib.parse.urlencode({"marketTopicId": topic_id, "timestamp": int(time.time()*1000), "recvWindow": 5000})
    signature = hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()
    url = BASE + DETAIL + "?" + query + "&signature=" + signature
    return get_json(url, {"X-MBX-APIKEY": key, "User-Agent": "independent-settlement-audit/1"})

def ms(value):
    if value is None: return None
    if isinstance(value, (int, float)): return int(value)
    try: return int(dt.datetime.fromisoformat(str(value).replace("Z","+00:00")).timestamp()*1000)
    except (ValueError, TypeError): return None

def direction_from_detail(topic):
    variant = topic.get("variantData") or topic.get("variant_data") or {}
    start = variant.get("startPrice", variant.get("start_price"))
    end = variant.get("endPrice", variant.get("end_price"))
    try:
        a,b = float(start),float(end)
        if not all(map(lambda x: x == x and abs(x) != float("inf"), (a,b))): return None
        return "UP" if b>a else ("DOWN" if b<a else None)
    except (ValueError,TypeError): return None

def main():
    key,secret = os.environ.get("BINANCE_PREDICTION_API_KEY"),os.environ.get("BINANCE_PREDICTION_API_SECRET")
    if not key or not secret:
        print("ERROR: GitHub Actions read-only audit secrets missing",file=sys.stderr);return 2
    snapshot=get_json(STATS)
    if snapshot.get("ok") is not True: raise ValueError("round-stats snapshot not OK")
    records=snapshot.get("records") or []
    if not isinstance(records,list): raise ValueError("round-stats records not an array")
    out=[]; seen=set(); skipped_wait=0
    for row in records[:40]:
        round_id=ms(row.get("roundStartMs"))
        prediction=row.get("productionPrediction")
        # WAIT is an abstention, not a failed or unverifiable prediction.
        # Retain its count for coverage without attempting signed API requests.
        if prediction not in ("UP", "DOWN"):
            skipped_wait+=1
            continue
        evidence=row.get("officialSettlementAudit") or {}
        # Topic identity is recorded independently of settlement evidence.
        # Missing auditEvidence must not hide a persisted predictionMarketTopicId.
        topic_id=evidence.get("marketTopicId") or row.get("predictionMarketTopicId")
        if topic_id is not None: topic_id=str(topic_id)
        # Require the persisted production lock; generatedAt is not proof of lock.
        locked_at=ms(row.get("productionLockedAt"))
        item={"round_id":round_id,"marketTopicId":topic_id,"prediction":prediction,"result":"UNVERIFIED","issues":[]}
        if round_id is None or round_id in seen: item["issues"].append("INVALID_OR_DUPLICATE_ROUND")
        seen.add(round_id)
        if not topic_id: item["issues"].append("NO_AUDIT_TOPIC_ID")
        if locked_at is None: item["issues"].append("NO_PROVEN_FROZEN_LOCK_TIMESTAMP")
        if topic_id:
            try:
                response=official_detail(topic_id,key,secret)
                # Never accept a cached production outcome as independent evidence.
                topic=response.get("data",response) if isinstance(response,dict) else {}
                if not isinstance(topic,dict): topic={}
                # Never inject the requested topic ID into a response as if Binance returned it.
                returned_id=topic.get("marketTopicId") or topic.get("topicId")
                if returned_id is None:
                    item["issues"].append("OFFICIAL_TOPIC_ID_NOT_RETURNED")
                elif str(returned_id)!=str(topic_id):
                    item["issues"].append("OFFICIAL_TOPIC_ID_MISMATCH")
                start,end=ms(topic.get("startDate")),ms(topic.get("endDate"))
                direction=direction_from_detail(topic)
                item.update(official_direction=direction,official_observed_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                            independent_detail_sha256=hashlib.sha256(json.dumps(topic,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest())
                if start != round_id or end != round_id+300000: item["issues"].append("OFFICIAL_ROUND_TIME_MISMATCH")
                if direction is None: item["issues"].append("OFFICIAL_NOT_RESOLVED")
                if locked_at is not None and round_id is not None and not (round_id <= locked_at < round_id+300000): item["issues"].append("LOCK_OUTSIDE_PREDICTION_ROUND")
            except urllib.error.HTTPError as exc:
                # Report HTTP status only; never log credentials, signatures, or signed URLs.
                item["issues"].append("INDEPENDENT_API_HTTP_"+str(exc.code))
                if exc.code == 451:
                    item["issues"].append("BINANCE_REGION_OR_LEGAL_RESTRICTION")
            except Exception as exc:
                item["issues"].append("INDEPENDENT_API_ERROR:"+type(exc).__name__)
        if not item["issues"]: item["result"]="HIT" if prediction==item["official_direction"] else "MISS"
        out.append(item)
        time.sleep(.15)
    counts={k:sum(x["result"]==k for x in out) for k in ("HIT","MISS","UNVERIFIED")}
    report={"source":"INDEPENDENT_SIGNED_BINANCE_API","generatedAt":dt.datetime.now(dt.timezone.utc).isoformat(),
            "windowRounds":min(len(records),40),"productionFinalWait":skipped_wait,"productionDecided":len(out),
            "productionCoveragePct":round(100*len(out)/min(len(records),40),2) if records else None,
            "counts":counts,"records":out,"note":"No independent result is inferred from production HIT/MISS. No trading permissions used."}
    os.makedirs("audit-output",exist_ok=True)
    with open("audit-output/independent-settlement.json","w") as f: json.dump(report,f,indent=2,ensure_ascii=False)
    print(json.dumps({"windowRounds":min(len(records),40),"productionFinalWait":skipped_wait,"productionDecided":len(out),"counts":counts,"issues":{i:sum(i in x["issues"] for x in out) for x in out for i in x["issues"]}},ensure_ascii=False))
    # An access restriction is an infrastructure blocker, never a model MISS.
    # Preserve a nonzero status and all original audit evidence for manual review.
    return 0 if counts["HIT"]+counts["MISS"]>0 and counts["UNVERIFIED"]==0 else 3

if __name__=="__main__":
    try: sys.exit(main())
    except Exception as exc:
        print("Independent audit failed closed: "+type(exc).__name__+": "+str(exc),file=sys.stderr)
        sys.exit(4)

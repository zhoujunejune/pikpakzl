#!/usr/bin/env python3
"""Install *only* read-only dynamically generated HTML nav on existing Alibaba SWAS.

Uses the existing GitHub encrypted Alibaba deployment secrets. Never imports,
edits, restarts or controls any trading logic or model settings.
"""
import base64,json,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as m
from alibabacloud_tea_openapi import models as a

REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
BRANCH="feature/zl-futures-bot-v1"

def main():
    sha=os.getenv("GITHUB_SHA","")
    if os.getenv("GITHUB_REF_NAME")!=BRANCH or not re.fullmatch("[0-9a-f]{40}",sha):
        print("NAV_INVALID_GITHUB_REF")
        return 2
    key=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
    secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
    if not key or not secret:
        print("NAV_CLOUD_CREDENTIALS_NOT_CONFIGURED")
        return 3
    client=Client(a.Config(access_key_id=key,access_key_secret=secret,
        region_id=REGION,endpoint="swas.ap-southeast-1.aliyuncs.com"))
    cmd=f"""#!/bin/bash
set -Eeuo pipefail
s=$(mktemp)
trap 'rm -f "$s"' EXIT
curl -fsSL --retry 3 --max-time 25 \
https://raw.githubusercontent.com/zhoujunejune/pikpakzl/{sha}/futures-research-panel/install_nav_bridge.sh -o "$s"
export APP_SHA={sha}
bash "$s"
"""
    # A tightly-scoped, read-only inspection of EVENT10 when a tagged push
    # explicitly requests it. No production install, restart, or trade operation.
    try:
        event=json.load(open(os.environ.get("GITHUB_EVENT_PATH",""),encoding="utf8"))
        audit_only=(os.environ.get("GITHUB_EVENT_NAME")=="push" and
                    "[EVENT10-READ-ONLY-AUDIT]" in str((event.get("head_commit") or {}).get("message","")))
    except (OSError,ValueError,TypeError):
        audit_only=False
    if audit_only:
        cmd="""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PYAUDIT'
import json,urllib.request,datetime,collections,time
def get(path):
    with urllib.request.urlopen('http://127.0.0.1:13020'+path,timeout=6) as r:
        return json.load(r)
def tm(ms):
    if not isinstance(ms,(int,float)):return None
    return datetime.datetime.fromtimestamp(ms/1000,datetime.timezone.utc).isoformat(timespec='seconds')
stat=get('/api/status')
hist=get('/api/history').get('records',[])
try:
    stream=get('/api/stream-health')
except Exception as exc:stream={'connected':False,'error':type(exc).__name__}
print('EVENT10_READ_ONLY_AUDIT=true')
print('EVENT10_PROD_MODEL='+str(stat.get('providerModel')))
print('EVENT10_PROD_STATS='+json.dumps(stat.get('stats'),ensure_ascii=False,separators=(',',':')))
print('EVENT10_LIVE_STREAM='+json.dumps({k:stream.get(k) for k in ['connected','gapCount','missingAggregateIds','underlyingTradeIdSkips','reconnectCount','lastEventLatencyMs']},ensure_ascii=False,separators=(',',':')))
for key in ('60s','300s','600s'):
    w=(stream.get('windows') or {}).get(key) or {}
    print('EVENT10_LIVE_WINDOW_'+key+'='+json.dumps({k:w.get(k) for k in ['complete','issues','observedGroups','eventLatencyP95Ms']},separators=(',',':')))
print('EVENT10_AUDIT_RECORDS_FOUND='+str(len(hist)))
recent=hist[:30]
settled=[h for h in recent if isinstance(h.get('proxyHit'),bool)]
total=len(settled); wins=sum(h.get('proxyHit') for h in settled)
print('EVENT10_AUDIT_LAST30='+json.dumps({'count':len(recent),'settled':total,'hits':wins,'misses':total-wins,'hitPct':round(100*wins/total,2) if total else None},separators=(',',':')))
versions={}
for h in settled:
 v=h.get('decisionReviewVersion') or 'UNVERSIONED'
 d=versions.setdefault(v,{'count':0,'hits':0,'UP':0,'DOWN':0})
 d['count']+=1;d['hits']+=int(h['proxyHit']);d[h.get('direction','UP') if h.get('direction') in ('UP','DOWN') else 'UP']+=1
print('EVENT10_AUDIT_BY_VERSION='+json.dumps(versions,ensure_ascii=False,separators=(',',':')))
streak=0
for h in hist:
 if h.get('proxyHit') is False:streak+=1
 elif h.get('proxyHit') is True:break
print('EVENT10_AUDIT_LATEST_LOSS_STREAK='+str(streak))

for n,h in enumerate(hist[:15]):
    features=h.get('features') or {}
    enr=(h.get('enrichment') or {}).get('features') or {}
    cflow=h.get('continuousTradeFlow') or {}
    cond={k:features.get(k) for k in ['rsi1m14','rsi5m14','ema1m9','ema1m21','ema5m9','ema5m21','momentum1m5Pct','momentum5m15Pct','volumeRatio1m','location1m20']}
    market={}
    for k in ['fifteenMinute','orderBook','aggressiveFlow','futuresIndex','openInterestChange']:
        x=enr.get(k)
        if x:
            filt=['rsi14','ema9','ema21','moveLast45mPct','imbalanceTop20','deltaNotionalUsd','takerBuyFraction','indexPrice','change5mPct','observedAt']
            market[k]={q:x.get(q) for q in filt if q in x}
    cov={k:('OK' if v.get('available') else v.get('error')) for k,v in (h.get('featureAvailability') or {}).items()}
    record={'seq':n+1,'startedUtc':tm(h.get('openedAt')),'endedUtc':tm(h.get('expiresAt')),
     'model':h.get('model'),'status':h.get('status'),'direction':h.get('direction'),
     'confidence':h.get('confidence'),'reason':(h.get('reason') or '')[:240],
     'openPrice':h.get('openPrice'),'closePrice':h.get('closePrice'),
     'closeObservedAtUtc':tm(h.get('closeObservedAt')),
     'deltaPct':h.get('returnPct'),'proxyOutcome':h.get('proxyOutcome'),
     'proxyHit':h.get('proxyHit'),'settlementStatus':h.get('settlementStatus'),
     'expirySampleLagMs':h.get('expirySampleLagMs'),
     'modelLatencyMs':h.get('modelLatencyMs'),
     'clickToCaptureMs':h.get('clickToCaptureMs'),
     'indicators':cond,'extra':market,'availability':cov,
     'continuousWindows':list((cflow.get('windows') or {}).keys())}
    record['explanationLanguage']=h.get('explanationLanguage')
    record['decisionReviewVersion']=h.get('decisionReviewVersion')
    record['reviewWarnings']=(h.get('decisionReview') or {}).get('warnings',[])[:5]
    record['arguments']={k:(v or '')[:150] for k,v in (h.get('analysisArguments') or {}).items()}
    record['openAgeMs']=h.get('openAgeMs')
    record['startToModelFinishMs']=(h['modelFinishedAt']-h['openedAt']) if isinstance(h.get('modelFinishedAt'),int) and isinstance(h.get('openedAt'),int) else None
    if n>=6:
        record={k:record.get(k) for k in ('seq','startedUtc','endedUtc','status','direction','confidence','openPrice','closePrice','proxyOutcome','proxyHit','deltaPct','settlementStatus','expirySampleLagMs','modelLatencyMs','decisionReviewVersion','availability')}
    print('EVENT10_ROUND_'+str(n+1)+'='+json.dumps(record,ensure_ascii=False,separators=(',',':')))
# Latest post-V5/post-high reports are printed last so they survive
# cloud command's log tail truncation. Read-only; original records unchanged.
def summarise(items):
 settled=[x for x in items if isinstance(x.get('proxyHit'),bool)]
 hit=sum(1 for x in settled if x['proxyHit'] is True)
 return {'records':len(items),'settled':len(settled),'hits':hit,
         'misses':len(settled)-hit,
         'accuracyPct':round(100*hit/len(settled),2) if settled else None,
         'pending':sum(1 for x in items if x.get('status')=='PREDICTED' and x.get('proxyHit') is None),
         'up':sum(1 for x in settled if x.get('direction')=='UP'),
         'down':sum(1 for x in settled if x.get('direction')=='DOWN'),
         'reasoningConfirmed':sum(1 for x in items if x.get('reasoningObserved') is True),
         'reasoningUnconfirmed':sum(1 for x in items if x.get('reasoningObserved') is False)}
v5=[h for h in hist if h.get('decisionReviewVersion')=='EVENT10_COMPACT_EVIDENCE_V5_20261024']
afterhigh=[h for h in v5 if h.get('thinkingRequested') is True]
beforehigh=[h for h in v5 if h.get('thinkingRequested') is not True]
print('EVENT10_AUDIT_V5_ALL='+json.dumps(summarise(v5),ensure_ascii=False,separators=(',',':')))
print('EVENT10_AUDIT_V5_PRE_HIGH='+json.dumps(summarise(beforehigh),ensure_ascii=False,separators=(',',':')))
print('EVENT10_AUDIT_V5_AFTER_HIGH='+json.dumps(summarise(afterhigh),ensure_ascii=False,separators=(',',':')))
print('EVENT10_AUDIT_LATEST_10='+json.dumps(summarise(hist[:10]),ensure_ascii=False,separators=(',',':')))
print('EVENT10_AUDIT_CURRENT_THINKING='+json.dumps({
    'thinkingMode':stat.get('thinkingMode'),
    'reasoningEffort':stat.get('reasoningEffort'),
    'lastReasoningObserved':stat.get('lastReasoningObserved'),
    'lastReasoningTokenCount':stat.get('lastReasoningTokenCount'),
    'model':stat.get('providerModel'),
    'reviewVersion':stat.get('decisionReviewVersion')},ensure_ascii=False,separators=(',',':')))
for i,h in enumerate(hist[:12]):
 row={
    'n':i+1,'atUTC':tm(h.get('openedAt')),'direction':h.get('direction'),
    'status':h.get('status'),'ref':h.get('openPrice'),'end':h.get('closePrice'),
    'proxyHit':h.get('proxyHit'),'outcome':h.get('proxyOutcome'),
    'deltaPct':h.get('returnPct'),
    'version':h.get('decisionReviewVersion'),
    'thinkingRequested':h.get('thinkingRequested'),
    'reasoningObserved':h.get('reasoningObserved'),
    'reasoningTokenCount':h.get('reasoningTokenCount'),
    'modelLatencyMs':h.get('modelLatencyMs'),
    'settlementStatus':h.get('settlementStatus'),
    'reason':str(h.get('reason') or '')[:100]
 }
 print('EVENT10_LATEST_'+str(i+1)+'='+json.dumps(row,ensure_ascii=False,separators=(',',':')))
print('EVENT10_AUDIT_NO_PRODUCTION_WRITES=true')
PYAUDIT
"""
    try:
        r=client.run_command(m.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
            name="zl-three-menu-read-only-ui-only",type="RunShellScript",
            command_content=cmd,working_user="root",timeout=170))
        inv=r.body.invoke_id
        if not inv:
            print("NAV_NO_INVOCATION_ID")
            return 4
        for _ in range(50):
            time.sleep(3)
            result=client.describe_invocation_result(m.DescribeInvocationResultRequest(
                region_id=REGION,instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
            if not result:continue
            st=str(result.invocation_status)
            if st in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero",
                      "ClientNotRunning","InstanceNotRunning"):
                raw=result.output or ""
                try:raw=base64.b64decode(raw,validate=True).decode("utf8","replace")
                except Exception:pass
                print("NAV_DEPLOY_STATUS",st,"EXIT",result.exit_code)
                print("NAV_DEPLOY_TAIL",raw[-25000:] if audit_only else raw[-4000:])
                return 0 if st=="Success" and int(result.exit_code)==0 else 5
        print("NAV_DEPLOY_TIMEOUT_UNCONFIRMED")
        return 6
    except Exception as exc:
        print("NAV_DEPLOY_ERROR_CLASS",type(exc).__name__)
        print("NAV_DEPLOY_CLOUD_CODE",str(getattr(exc,"code","unknown"))[:80])
        return 7
if __name__=="__main__":
    sys.exit(main())

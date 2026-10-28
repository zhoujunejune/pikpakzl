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
    # UI-only release: V6-exclusive counts, history rows and safe page label; no AI model changes.
    ui_only=(os.environ.get("GITHUB_EVENT_NAME")=="push" and
             "[EVENT10-CONFIDENCE-UI-ONLY]" in
             str((event.get("head_commit") or {}).get("message",""))) if 'event' in locals() else False
    restore_event10=(os.environ.get("GITHUB_EVENT_NAME")=="push" and
                     "[EVENT10-FRONTEND-RESTORE]" in
                     str((event.get("head_commit") or {}).get("message",""))) if 'event' in locals() else False
    diagnose_event10=(os.environ.get("GITHUB_EVENT_NAME")=="push" and
                      "[EVENT10-RESTORE-DIAG]" in
                      str((event.get("head_commit") or {}).get("message",""))) if 'event' in locals() else False
    if diagnose_event10:
        # Explicitly read only service states, anonymized routes, and EVENT10 readiness.
        cmd="""#!/bin/bash
set -eu
echo EVENT10_RESTORE_READONLY_DIAG_BEGIN=true
for unit in caddy zl-event10-deepseek zl-event10-trade-stream zl-frontend-nav-bridge zl-futures-bot-paper zl-prediction-trade zl-guardian5; do
  echo "UNIT=$unit state=$(systemctl is-active "$unit" 2>/dev/null || true)"
done
for port in 10000 13001 13019 13020 13021; do
  for path in / /healthz /api/status; do
    code=$(curl -s -o /dev/null --max-time 2 -w '%{http_code}' "http://127.0.0.1:$port$path" || true)
    echo "LOCAL_PORT=$port PATH=$path CODE=$code"
  done
done
python3 - <<'PYREAD'
from pathlib import Path
import json,urllib.request
p=Path('/etc/caddy/Caddyfile')
print('CADDY_EXISTS='+str(p.exists()))
if p.exists():
 for i,line in enumerate(p.read_text().splitlines(),1):
  s=line.strip()
  if (s.endswith('sslip.io {') or s.startswith('handle ') or s.startswith('handle_path ') or
      s.startswith('reverse_proxy ') or s.startswith('redir ') or s.startswith('basic_auth')):
   print('CADDY_ROUTE',i,s[:150])
d=Path('/opt/zl-event10')
print('EVENT10_DIR_EXISTS='+str(d.exists()))
if d.exists():
 for q in ('panel.html','manual-engine.mjs','server.mjs','trade-stream-collector.mjs'):
  print('EVENT10_FILE_'+q+'='+str((d/q).exists()))
try:
 with urllib.request.urlopen('http://127.0.0.1:13020/api/status',timeout=3) as r: x=json.load(r)
 print('EVENT10_STATUS='+json.dumps({k:x.get(k) for k in ('ok','configured','providerModel','decisionReviewVersion','autoTradingEnabled','executionAvailable')},ensure_ascii=False))
except Exception as exc:print('EVENT10_STATUS_ERROR='+type(exc).__name__)
PYREAD
python3 - <<'PYREAD2'
from pathlib import Path
import urllib.request,re,os
p=Path('/etc/caddy/Caddyfile')
if p.exists():
 lines=p.read_text().splitlines()
 for a,b in ((26,41),(50,65)):
  for i in range(a-1,min(len(lines),b)):
   line=lines[i].strip()
   if 'password' in line.lower() or line.startswith('zl ') or line.startswith('admin '):
    line='[REDACTED]'
   print('CADDY_DETAIL',i+1,line[:130])
for q in ('/etc/zl-prediction/deepseek5.env','/opt/zl-prediction-node/bin/node',
          '/var/lib/zl-event10/manual-sessions-v2.json','/opt/zl-event10',
          '/opt/zl-prediction/serve.py','/opt/zl-prediction-trade/serve.py'):
 print('PROD_FILE',q,Path(q).exists())
try:
 with urllib.request.urlopen('http://127.0.0.1:13001/',timeout=4) as r:page=r.read(2000000).decode('utf8','replace')
 print('PRED_HTML_TITLE='+str(re.findall(r'<title[^>]*>([^<]+)',page,re.I)[:2]))
 print('PRED_HTML_LEN='+str(len(page)))
 for term in ['event10','十分钟','EVENT10','dual5','预测机器人','合约机器人','<nav']:
  print('PRED_HTML_MARKER_'+term+'='+str(term.lower() in page.lower()))
 print('PRED_HTML_LINKS='+str(re.findall(r'<a[^>]+href=["\\x27]([^"\\x27]+)',page,re.I)[:15]))
except Exception as exc:print('PRED_HTML_ERROR='+type(exc).__name__)
PYREAD2
for port in 13003 13049 13018; do
  for path in /healthz /api/shadow-market-data /api/market /api/status; do
    code=$(curl -s -o /dev/null --max-time 2 -w '%{http_code}' "http://127.0.0.1:$port$path" || true)
    echo "FEED_PORT=$port PATH=$path CODE=$code"
  done
done
echo "UNIT=zl-prediction-deepseek5 state=$(systemctl is-active zl-prediction-deepseek5 2>/dev/null || true)"
python3 - <<'PYDATA'
import urllib.request,json
try:
 with urllib.request.urlopen('http://127.0.0.1:13003/api/shadow-market-data',timeout=4) as r:x=json.load(r)
 print('FEED_TOP_KEYS='+','.join(sorted(x.keys())[:25]))
 for k in ('source','updatedAt','timestamp','symbol','ok','valid','price'):
  print('FEED_FIELD_'+k+'='+str(x.get(k))[:90])
except Exception as e:print('FEED_ERROR='+type(e).__name__)
PYDATA
echo EVENT10_RESTORE_READONLY_DIAG_DONE=true
"""
    elif restore_event10:
        # Restore only EVENT10's existing frontend/navigation, not any other trading worker.
        # Install independent EVENT10 files only when the old service is genuinely absent.
        cmd=f"""#!/bin/bash
set -Eeuo pipefail
script=$(mktemp /tmp/zl-event10-restore.XXXXXXXX)
trap 'rm -f "$script"' EXIT
curl -fsSL --retry 3 --max-time 25 \
  https://raw.githubusercontent.com/zhoujunejune/pikpakzl/{sha}/event10-bot/restore_frontend.sh -o "$script"
bash -n "$script"
export APP_SHA={sha}
bash "$script"
"""
    elif ui_only:
        # Only replace the cached EVENT10 HTML view, never deploy model files.
        # The web server reads panel.html at startup, so ONLY this service is restarted.
        cmd="""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
test "$(systemctl is-active zl-event10-deepseek)" = active
test -f /opt/zl-event10/panel.html
test -f /opt/zl-event10/manual-engine.mjs
base=http://127.0.0.1:13020
pre=$(mktemp)
post=$(mktemp)
staged=$(mktemp /opt/zl-event10/.panel-confidence.XXXXXX)
backup=$(mktemp /tmp/event10-panel-prev.XXXXXX)
trap 'rm -f "$pre" "$post" "$staged" "$backup"' EXIT
curl -fsS --max-time 8 "$base/api/status" >"$pre"
python3 - "$pre" <<'PYCONF'
import json,sys
x=json.load(open(sys.argv[1]))
assert x.get('decisionReviewVersion')=='EVENT10_AI_PRICE_STRUCTURE_V6_20261024','ACTIVE_MODEL_NOT_ORIGINAL_V6'
assert x.get('thinkingMode')=='enabled' and x.get('reasoningEffort')=='high'
assert x.get('autoTradingEnabled') is False and x.get('executionAvailable') is False
assert not x.get('busyStart') and not x.get('busySettle')
assert (x.get('active') or {}).get('status')!='ANALYZING','AI_ANALYSIS_IN_PROGRESS'
print('EVENT10_UI_ONLY_V6_MODEL_PRECHECK=true')
PYCONF
fpid=$(systemctl show -p MainPID --value zl-futures-bot-paper)
ppid=$(systemctl show -p MainPID --value zl-prediction-trade)
before=$(sha256sum /opt/zl-event10/manual-engine.mjs /opt/zl-event10/compact-evidence.mjs /opt/zl-event10/decision-review.mjs /opt/zl-event10/price-structure.mjs)
curl -fsSL --retry 3 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/@@SHA@@/event10-bot/panel.html" -o "$staged"
python3 - "$staged" <<'PYCONF'
from pathlib import Path
import sys
p=Path(sys.argv[1]).read_text()
assert all(x in p for x in ('id="quickConfidence"','id="confidence"',
    '<th>AI主观置信度</th>','const displayConfidence=s=>',
    '主观置信度来自 DeepSeek' if '主观置信度来自 DeepSeek' in p else
    '置信度来自 DeepSeek'))
assert '分析逻辑：V6 AI价格结构版' in p,'ROLLBACK_V6_PANEL_COPY_EXPECTED'
assert 'V6.1' not in p,'WRONG_V61_PANEL'
print('EVENT10_UI_ONLY_STATIC_CONFIDENCE=true')
PYCONF
cp -p /opt/zl-event10/panel.html "$backup"
restore(){
 code=$?
 trap - EXIT
 if test "$code" -ne 0;then
   cp -p "$backup" /opt/zl-event10/panel.html
   systemctl restart zl-event10-deepseek || true
   echo EVENT10_UI_ONLY_RESTORED_OLD_PANEL=true
 fi
 rm -f "$pre" "$post" "$staged" "$backup"
 exit "$code"
}
trap restore EXIT
install -o root -g root -m 0644 "$staged" /opt/zl-event10/panel.html
systemctl restart zl-event10-deepseek
ready=0
for n in $(seq 1 20);do
 if curl -fsS --max-time 4 "$base/api/status" >"$post" 2>/dev/null;then ready=1;break;fi
 sleep 1
done
test "$ready" = 1
curl -fsS --max-time 5 "$base/" | python3 -c 'import sys; t=sys.stdin.read(); assert "quickConfidence" in t and "AI主观置信度" in t; print("EVENT10_UI_ONLY_LIVE_CONFIDENCE=true")'
python3 - "$pre" "$post" <<'PYCONF'
import json,sys
a,b=[json.load(open(f)) for f in sys.argv[1:]]
assert b.get('decisionReviewVersion')==a.get('decisionReviewVersion'),'MODEL_CHANGED'
assert b.get('providerModel')==a.get('providerModel'),'MODEL_PROVIDER_CHANGED'
assert b.get('reasoningEffort')==a.get('reasoningEffort')
assert b.get('autoTradingEnabled') is False and b.get('executionAvailable') is False
assert (b.get('stats') or {}).get('total',0)>=(a.get('stats') or {}).get('total',0),'HISTORY_MISSING'
assert (b.get('stats') or {}).get('proxySettled',0)>=(a.get('stats') or {}).get('proxySettled',0),'SETTLED_HISTORY_MISSING'
assert (b.get('lastSession') or {}).get('id')==(a.get('lastSession') or {}).get('id'),'LAST_SESSION_CHANGED'
print('EVENT10_UI_ONLY_V6_LOGIC_UNCHANGED=true')
print('EVENT10_UI_ONLY_HISTORY_PRESERVED=true')
PYCONF
test "$before" = "$(sha256sum /opt/zl-event10/manual-engine.mjs /opt/zl-event10/compact-evidence.mjs /opt/zl-event10/decision-review.mjs /opt/zl-event10/price-structure.mjs)"
test "$fpid" = "$(systemctl show -p MainPID --value zl-futures-bot-paper)"
test "$ppid" = "$(systemctl show -p MainPID --value zl-prediction-trade)"
echo EVENT10_UI_ONLY_MODEL_FILES_UNCHANGED=true
echo EVENT10_UI_ONLY_OTHER_PRODUCTION_PIDS_UNCHANGED=true
echo EVENT10_UI_ONLY_DEPLOY_COMPLETE=true
""".replace("@@SHA@@",sha)
    elif audit_only:
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
v6=[h for h in hist if h.get('decisionReviewVersion')=='EVENT10_AI_PRICE_STRUCTURE_V6_20261024']
v6settled=[h for h in v6 if isinstance(h.get('proxyHit'),bool)]
print('EVENT10_AUDIT_V6_ONLY='+json.dumps(summarise(v6),ensure_ascii=False,separators=(',',':')))
print('EVENT10_AUDIT_V6_LAST5='+json.dumps(summarise(v6[:5]),ensure_ascii=False,separators=(',',':')))
print('EVENT10_AUDIT_V6_LAST10='+json.dumps(summarise(v6[:10]),ensure_ascii=False,separators=(',',':')))
for direction in ('UP','DOWN'):
 group=[h for h in v6settled if h.get('direction')==direction]
 print('EVENT10_AUDIT_V6_'+direction+'='+json.dumps(summarise(group),ensure_ascii=False,separators=(',',':')))
pending=[{'startUTC':tm(h.get('openedAt')),'status':h.get('status'),'direction':h.get('direction')} for h in v6 if not isinstance(h.get('proxyHit'),bool)]
print('EVENT10_AUDIT_V6_PENDING='+json.dumps(pending[:5],ensure_ascii=False,separators=(',',':')))
for i,h in enumerate(v6[:12]):
 row={'seq':i+1,'startUTC':tm(h.get('openedAt')),'expiresUTC':tm(h.get('expiresAt')),
      'status':h.get('status'),'direction':h.get('direction'),'confidence':h.get('confidence'),
      'proxyOutcome':h.get('proxyOutcome'),'proxyHit':h.get('proxyHit'),
      'openPrice':h.get('openPrice'),'closePrice':h.get('closePrice'),
      'returnPct':h.get('returnPct'),'settlementStatus':h.get('settlementStatus'),
      'reasoningObserved':h.get('reasoningObserved'),'modelLatencyMs':h.get('modelLatencyMs'),
      'reviewWarnings':(h.get('decisionReview') or {}).get('warnings',[])[:4],
      'priceStructure':{k:(h.get('priceStructure') or {}).get(k) for k in ('nearestSupport','nearestResistance','lastThreeClosedBarsTrend','confirmedThreeBarBreakout')},
      'reason':str(h.get('reason') or '')[:190]}
 print('EVENT10_V6_ROUND_'+str(i+1)+'='+json.dumps(row,ensure_ascii=False,separators=(',',':')))
v6_latest_settled=[h for h in v6 if isinstance(h.get('proxyHit'),bool)]
print('EVENT10_V6_LATEST5_SETTLED='+json.dumps(summarise(v6_latest_settled[:5]),ensure_ascii=False,separators=(',',':')))
print('EVENT10_V6_LATEST10_SETTLED='+json.dumps(summarise(v6_latest_settled[:10]),ensure_ascii=False,separators=(',',':')))
streak=0
for item in v6_latest_settled:
 if item.get('proxyHit') is False:streak+=1
 else:break
print('EVENT10_V6_CURRENT_LOSS_STREAK='+str(streak))
print('EVENT10_V6_DIAGNOSTIC='+json.dumps({
 'structureCaptured':sum(1 for h in v6 if (h.get('priceStructure') or {}).get('source')=='SAME_PUBLIC_REFERENCE_CLOSED_1M_CANDLES'),
 'reasoningConfirmed':sum(1 for h in v6 if h.get('reasoningObserved') is True),
 'completeFlow600':sum(1 for h in v6 if (h.get('continuousTradeFlow') or {}).get('windows',{}).get('600s',{}).get('complete') is True),
 'smallOutcomeChangeUnder001Pct':sum(1 for h in v6_latest_settled if isinstance(h.get('returnPct'),(int,float)) and abs(h['returnPct'])<0.01),
 'finishedFailures':sum(1 for h in v6 if h.get('status')=='FAILED')
},ensure_ascii=False,separators=(',',':')))
v61=[h for h in hist if h.get('decisionReviewVersion')=='EVENT10_AI_PRICE_STRUCTURE_V6R1_20261025']
done61=[h for h in v61 if isinstance(h.get('proxyHit'),bool)]
def fmt_group(group):
 d=summarise(group)
 return dict((k,d[k]) for k in ('records','settled','hits','misses','accuracyPct','pending','up','down','reasoningConfirmed'))
print('EVENT10_V61_AUDIT='+json.dumps(fmt_group(v61),ensure_ascii=False,separators=(',',':')))
print('EVENT10_V61_LAST5_SETTLED='+json.dumps(fmt_group(done61[:5]),ensure_ascii=False,separators=(',',':')))
print('EVENT10_V61_LAST10_SETTLED='+json.dumps(fmt_group(done61[:10]),ensure_ascii=False,separators=(',',':')))
for direction in ('UP','DOWN'):
 subset=[h for h in done61 if h.get('direction')==direction]
 print('EVENT10_V61_'+direction+'='+json.dumps(fmt_group(subset),separators=(',',':')))
streak61=0
for h in done61:
 if h['proxyHit'] is False:streak61+=1
 else:break
print('EVENT10_V61_LOSS_STREAK='+str(streak61))
print('EVENT10_V61_DATA_QUALITY='+json.dumps({
 'model':stat.get('providerModel'),'activePrompt':stat.get('decisionReviewVersion'),
 'thinking':stat.get('thinkingMode'),'effort':stat.get('reasoningEffort'),
 'structureCaptured':sum(1 for h in v61 if (h.get('priceStructure') or {}).get('source')=='SAME_PUBLIC_REFERENCE_CLOSED_1M_CANDLES'),
 'flow600Complete':sum(1 for h in v61 if (h.get('continuousTradeFlow') or {}).get('windows',{}).get('600s',{}).get('complete') is True),
 'reasoningObserved':sum(1 for h in v61 if h.get('reasoningObserved') is True),
 'failed':sum(1 for h in v61 if h.get('status')=='FAILED'),
 'tinyCloseLess001Pct':sum(1 for h in done61 if isinstance(h.get('returnPct'),(int,float)) and abs(h['returnPct'])<0.01),
 'latencyMs':[h.get('modelLatencyMs') for h in v61 if isinstance(h.get('modelLatencyMs'),(int,float))][-10:],
 'lastError':stat.get('lastError')
 },ensure_ascii=False,separators=(',',':')))
for i,h in enumerate(v61[:16]):
 row={'n':i+1,'atUTC':tm(h.get('openedAt')),'direction':h.get('direction'),
 'status':h.get('status'),'hit':h.get('proxyHit'),'actual':h.get('proxyOutcome'),
 'returnPct':h.get('returnPct'),'open':h.get('openPrice'),'close':h.get('closePrice'),
 'reasoning':h.get('reasoningObserved'),'latencyMs':h.get('modelLatencyMs'),
 'priceStructure':{k:(h.get('priceStructure') or {}).get(k) for k in
  ('nearestSupport','nearestResistance','confirmedThreeBarBreakout','lastThreeClosedBarsTrend')},
 'warn':(h.get('decisionReview') or {}).get('warnings',[])[:3],
 'reason':str(h.get('reason') or '')[:130]}
 print('EVENT10_V61_ROUND_'+str(i+1)+'='+json.dumps(row,ensure_ascii=False,separators=(',',':')))
for idx,h in enumerate(hist[:6],1):
 ev=h.get('compactEvidence') or {}
 availability=h.get('featureAvailability') or {}
 def section(name):
  x=ev.get(name)
  return 'PRESENT' if isinstance(x,dict) and len(x)>0 else 'MISSING'
 flow=h.get('continuousTradeFlow') or {}
 ws=(flow.get('windows') or {}).get('600s') or {}
 ps=h.get('priceStructure') or {}
 row={'n':idx,'openedUTC':tm(h.get('openedAt')),'version':h.get('decisionReviewVersion'),
      'state':h.get('status'),'direction':h.get('direction'),
      'clickToCaptureMs':h.get('clickToCaptureMs'),
      'modelLatencyMs':h.get('modelLatencyMs'),
      'captureToModelFinishMs':(h['modelFinishedAt']-h['openedAt']) if isinstance(h.get('modelFinishedAt'),int) and isinstance(h.get('openedAt'),int) else None,
      'attempts':h.get('attempts'),'thinkingRequested':h.get('thinkingRequested'),
      'reasoningObserved':h.get('reasoningObserved'),
      'reasoningTokenCount':h.get('reasoningTokenCount'),
      'evidence':{k:section(k) for k in ('shortPriceTrend','priceStructure','fifteenMinuteContext','continuousFlow10m','shortFuturesPriceResponse')},
      'actualEvidenceVersion':ev.get('version'),
      'validSnapshotAtReference':isinstance(ps.get('lastClosedCandleAt'),int) and isinstance(h.get('openedAt'),int) and ps.get('lastClosedCandleAt')<=h.get('openedAt'),
      'stream600Complete':ws.get('complete'),'stream600Groups':ws.get('observedGroups'),
      'availability':{k:('YES' if v.get('available') else v.get('error')) for k,v in availability.items() if isinstance(v,dict)},
      'outcome':h.get('proxyOutcome'),'hit':h.get('proxyHit')}
 print('EVENT10_EVIDENCE_PROOF_'+str(idx)+'='+json.dumps(row,ensure_ascii=False,separators=(',',':')))
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

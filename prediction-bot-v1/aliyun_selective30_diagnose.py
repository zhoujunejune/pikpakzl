#!/usr/bin/env python3
"""Read-only current SWAS prediction signal diagnosis via Cloud Assistant.

No mutation, no user credentials printed, no order endpoints invoked.
"""
import base64, os, re, sys, time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as om

REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,urllib.request,time,subprocess,collections,datetime,pathlib,re
def read(port,route):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,route),timeout=10) as r:return json.load(r)
 except Exception as e:return {'ok':False,'error':type(e).__name__}
def show(label,obj):print(label,json.dumps(obj,ensure_ascii=False,default=str)[:2700])
now=int(time.time()*1000);rnd=now//300000*300000
print('READONLY_INSPECTION_TIME_UTC',datetime.datetime.now(datetime.timezone.utc).isoformat())
print('ROUND_ELAPSED_S',int((now-rnd)/1000))
for service in ('zl-prediction-v2','zl-prediction-v3','zl-prediction-trade','zl-prediction-redis','zl-futures-bot-paper'):
 try:val=subprocess.check_output(['systemctl','is-active',service],timeout=5,text=True).strip()
 except Exception as e:val=type(e).__name__
 print('SERVICE',service,val)
v2=read(13002,'/api/round-stats')
show('V2_HEALTH',read(13002,'/healthz'))
show('V3_HEALTH',read(13003,'/healthz'))
show('TRADE_HEALTH',read(13001,'/healthz'))
show('TRADE_MODEL_CHOICE',{k:read(13001,'/api/order-signal-model').get(k) for k in ('ok','ready','model','effectiveAfterRound','storageError')})
show('ACTIVE_MODELS',v2.get('activeSignalModels'))
show('V2_HEALTH_FROM_STATS',{k:v for k,v in (v2.get('health') or {}).items() if not re.search('key|secret|token|url|credential',str(k),re.I)})
records=v2.get('records') or []
selected=records[-30:]
if selected and selected[0].get('roundStartMs',0)>selected[-1].get('roundStartMs',0):selected=list(reversed(selected))
for r in selected[-18:]:
 print('LAST_ROUND',json.dumps({k:r.get(k) for k in ('roundStartMs','productionModel','productionModelVersion','productionSource','productionPrediction','productionActual','productionDelayMs','productionFallbackReason','productionInputVersion','result','productionResult')},ensure_ascii=False))
stats=collections.Counter((x.get('productionModel') or 'NONE',x.get('productionSource') or 'NONE',x.get('productionPrediction') or 'NONE') for x in records)
for k,v in stats.most_common(15):print('SIGNAL_COUNT',str(k),v)
sig=read(13002,'/api/production-signal')
live=sig.get('live') or {}
show('V2_LIVE',{k:live.get(k) for k in ('round','status','source','model','modelVersion','generatedAt','productionLockedAt','executionEligible','waitReason','fallbackReason','fast8Quality')})
v3=read(13003,'/api/local-predictions')
up=(v3.get('live') or {})
f=up.get('facts') or {}
keys=('currentScore','normalizedMomentum15s','currentTrendScore','normalizedMomentum30s','normalizedMomentum60s','regimeScore','liveScore','predictionMarketUpMid','predictionMarketTopicId','absorptionRisk','depthAgeMs','predBookAgeMs','roundOpenAligned','lastAggTradeAgeMs','predictionMarketUpdateTimestampMs')
show('V3_LIVE',{k:up.get(k) for k in ('round','factsCalculatedAt','status','source','generatedAt','model')})
show('V3_CAUSAL_INPUTS',{k:f.get(k,'NOT_PRESENT') for k in keys})
path=pathlib.Path('/opt/zl-prediction-live/src/round-tracker/selective-v2-fast8-router.mjs')
if path.exists():
 txt=path.read_text()
 show('V2_DEPLOYED_ROUTER_CONFIG',{'version':re.findall(r"export const POLICY_VERSION='([^']+)'",txt),'window_ms':re.findall(r'LOCK_DEADLINE_MS=(\d+)',txt),'decision_start_ms':re.findall(r'DECISION_START_MS=(\d+)',txt),'min_observations':re.findall(r'MIN_OBSERVATIONS=(\d+)',txt),'min_span_ms':re.findall(r'MIN_OBSERVATION_SPAN_MS=(\d+)',txt)})
try:
 proc=subprocess.run(['journalctl','-u','zl-prediction-v2','--since','-65 minutes','--no-pager','--output=cat'],capture_output=True,text=True,timeout=20)
 lines=[]
 for line in proc.stdout.splitlines():
  if not any(w in line.lower() for w in ('selective','signal_poll','production_signal','locked','fresh','no_signal','error','stale','prediction')):continue
  try:
   j=json.loads(line)
   if isinstance(j,dict):
    safe={k:j.get(k) for k in ('event','round','status','source','delayMs','elapsedMs','reason','error','code','policyVersion','inputVersion','missingFeatures','previousRoundFeatureCount','currentRoundFeatureCount','factsCalculatedAt','lastSignalError','waitReason') if k in j}
    lines.append(safe)
  except:continue
 print('RECENT_V2_LOG_COUNT',len(lines))
 for j in lines[-45:]:show('V2_LOG',j)
except Exception as e:print('LOG_READ_ERROR',type(e).__name__)
PY
"""
def main():
    k=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID")
    v=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
    if not k or not v:print("ALIYUN_AUTH_MISSING");return 2
    c=Client(om.Config(access_key_id=k,access_key_secret=v,region_id=REGION,endpoint='swas.ap-southeast-1.aliyuncs.com'))
    task=c.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name="zl-prediction-selective30-readonly-diagnosis",type="RunShellScript",command_content=SCRIPT,working_user="root",timeout=130))
    for _ in range(55):
        time.sleep(3)
        r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=task.body.invoke_id)).body.invocation_result
        if not r:continue
        s=str(r.invocation_status)
        if s in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
            raw=r.output or ''
            try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
            except Exception:pass
            print("DIAG_STATUS",s,"EXIT",r.exit_code)
            print(raw[-18500:])
            return 0 if s=="Success" and int(r.exit_code)==0 else 5
    print("DIAG_TIMEOUT");return 6
if __name__=="__main__":sys.exit(main())

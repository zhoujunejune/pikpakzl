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
t=read(13001,'/api/status')
sig=t.get('signal') or {}
p=t.get('pendingAction') or {}
o=t.get('lastOrder') or {}
show('TRADE_STATUS_SUMMARY',{'enabled':t.get('enabled'),'amountConfigured':bool(t.get('amount')),
 'signal':{k:sig.get(k) for k in ('round','status','direction','upstreamModel','source','generatedAt','lockedAt','executionEligible','qualityGate')},
 'directionModeReady':t.get('directionModeReady'),
 'directionModes':t.get('directionModes'),
 'orderSignal':t.get('orderSignal'),
 'startAfterRound':t.get('startAfterRound'),
 'pending':{k:p.get(k) for k in ('state','round','error','code','productionSource','signal','orderSignal','mappingMode')},
 'lastOrder':{k:o.get(k) for k in ('status','state','error','code','round','signal','submittedAt')}})
show('V2_LOCK_TRANSPORT_STATUS',read(13002,'/api/signals/latest').get('transport'))

show('ACTIVE_MODELS',v2.get('activeSignalModels'))
show('V2_HEALTH_FROM_STATS',{k:v for k,v in (v2.get('health') or {}).items() if not re.search('key|secret|token|url|credential',str(k),re.I)})
records=v2.get('records') or []
selected=records[-30:]
if selected and selected[0].get('roundStartMs',0)>selected[-1].get('roundStartMs',0):selected=list(reversed(selected))
for r in selected[-2:]:
 print('LAST_ROUND',json.dumps({k:r.get(k) for k in ('roundStartMs','productionModel','productionModelVersion','productionSource','productionPrediction','productionActual','productionDelayMs','productionFallbackReason','productionInputVersion','result','productionResult')},ensure_ascii=False))
# Investigate user-reported 10:55 Beijing (=02:55 UTC) round.
target=int(datetime.datetime(2026,10,20,2,55,tzinfo=datetime.timezone.utc).timestamp()*1000)
print('TARGET_ROUND_START_MS',target)
match=[x for x in records if int(x.get('roundStartMs') or 0)==target]
if match:
 v=match[0]
 show('TARGET_1055_V2_SIGNAL',{k:v.get(k) for k in (
  'roundStartMs','productionModel','productionModelVersion','productionPrediction',
  'productionSource','productionGeneratedAt','productionLockedAt','productionDelayMs',
  'productionInputVersion','productionExecutionEligible','productionActual','productionResult',
  'predictionMarketTopicId','productionFallbackReason')})
else:
 print('TARGET_1055_V2_SIGNAL','NOT_IN_LATEST_100_RECORDS')
controller=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic/wrapper.mjs')
if controller.exists():
 t=controller.read_text()
 show('TARGET_1055_DEPLOYED_DEADLINE_CODE',{'has_15s_deadline':'ORDER_SUBMIT_DEADLINE_MS = 15000' in t,
    'has_selective_30s_special_case':bool(re.search(r'SELECTIVE8_MODEL\s*\?\s*(?:\d+|[A-Z_]+)',t)),
    'has_order_window_early_guard':'if (!orderSubmitWindowOpen(signal.round,Date.now(),choice.model)) return;' in t,
    'has_auto_confirm_submit':'await submitPendingOrder(pendingAction' in t,
    'controller_module':'wrapper.mjs'})
for service in ('zl-prediction-v2','zl-prediction-trade'):
 try:
  ps=subprocess.run(['journalctl','-u',service,'--since','2026-10-20 02:50:00 UTC',
    '--until','2026-10-20 03:02:00 UTC','--utc','--no-pager','-o','json'],
    capture_output=True,text=True,timeout=30)
  matched=[]
  by_event=collections.Counter()
  all_lines=ps.stdout.splitlines()
  for line in all_lines:
   try:
    sysj=json.loads(line)
    msg=str(sysj.get('MESSAGE') or '')
    payload=json.loads(msg) if msg.startswith('{') else None
    if not isinstance(payload,dict):continue
    event=str(payload.get('event') or '')
    at_us=int(sysj.get('__REALTIME_TIMESTAMP') or 0)
    at=datetime.datetime.fromtimestamp(at_us/1000000,datetime.timezone.utc).isoformat() if at_us else None
    rr=payload.get('round') or payload.get('roundStartMs') or payload.get('roundId')
    by_event[event or 'NO_EVENT_NAME']+=1
    if service=='zl-prediction-trade':
     keep = any(z in event for z in ('order','submit','intent','control','follow','confirm','quote','direction','wallet','payment','ready','lock','model','error','enable','start','stop'))
    else:
     keep = any(z in event for z in ('selective','production_signal','locked_signal','poll','order','round_settle'))
    if not keep:continue
    if rr is not None and str(rr).isdigit() and abs(int(rr)-target)>600000:continue
    allowed=('event','round','roundStartMs','status','state','source','stage','trigger',
      'direction','productionSignal','orderSignal','mappingMode','productionSource','signalModelChoice',
      'deadlineMs','elapsedMs','signalGeneratedAt','error','code','httpStatus','reason',
      'enabled','amount','at','orderSubmitWindowOpen','amountConfigured','quoteRemainingAtSubmitMs')
    safe={k:payload[k] for k in allowed if k in payload}
    matched.append({'atUTC':at,**safe})
   except Exception:pass
  print('TARGET_1055_JOURNAL_META',json.dumps({'service':service,'json_messages':len(all_lines),
     'parsed_events':sum(by_event.values()),'top_events':by_event.most_common(18),'output_err_type':ps.returncode},ensure_ascii=False))
  for x in matched[-75:]:
   print('TARGET_1055_JOURNAL_EVENT',json.dumps({'service':service,**x},ensure_ascii=False)[:750])
 except Exception as exc:
  print('TARGET_1055_JOURNAL_READ_ERROR',service,type(exc).__name__)

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
# Only actual rows under the live 30s model; older 8s history is not comparable.
model='SELECTIVE_V2_30S_CURRENT_ROUND_V2'
cohort=sorted((x for x in records if x.get('productionModel')==model),key=lambda x:int(x.get('roundStartMs') or 0))
start_at=int(datetime.datetime(2026,10,20,1,51,tzinfo=datetime.timezone.utc).timestamp()*1000)
cohort_all=sorted((x for x in records if int(x.get('roundStartMs') or 0)>=start_at),key=lambda x:int(x.get('roundStartMs') or 0))
locked=[x for x in cohort if x.get('productionPrediction') in ('UP','DOWN')]
timings=sorted([float(x.get('productionDelayMs')) for x in locked if isinstance(x.get('productionDelayMs'),(int,float))])
settled=[x for x in locked if x.get('productionActual') in ('UP','DOWN')]
hit=sum(1 for x in settled if x.get('productionActual')==x.get('productionPrediction'))
print('CURRENT_30S_MODEL_COARSE_AUDIT',json.dumps({
 'audit_now_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'all_rounds_since_deploy_in_last_100':len(cohort_all),
 'new_model_locked_in_last_100':len(locked),
 'no_lock_in_last_100_since_deploy':sum(1 for x in cohort_all if x.get('productionPrediction') not in ('UP','DOWN')),
 'source_counts':dict(collections.Counter(x.get('productionSource') for x in locked)),
 'lock_delay_ms_min':min(timings) if timings else None,
 'lock_delay_ms_median':timings[len(timings)//2] if timings else None,
 'lock_delay_ms_max':max(timings) if timings else None,
 'on_time_locks':sum(1 for t in timings if 23000<=t<30000),
 'settled_locks':len(settled),
 'settled_correct':hit,
 'official_pending_locks':len(locked)-len(settled),
 'newest_record_round':max((x.get('roundStartMs') or 0 for x in records),default=0),
 'newest_new_model_round':max((x.get('roundStartMs') or 0 for x in locked),default=0),
},ensure_ascii=False))
# The 8s prewarm unit is still in the codebase but should not be an input to
# the 30-second model. Verify the deployed JS names, not just the repo version.
srcpath=pathlib.Path('/opt/zl-prediction-live/src/round-tracker/index-rest.mjs')
src=srcpath.read_text()
print('CURRENT_INPUT_CODE_MARKERS',json.dumps({
 'has_current_round_feature_array':'selective30FeatureSamples' in src,
 'current_facts_from_v3':'const currentFacts=causal&&live.facts' in src,
 'no_previous_trend_features':'fromPrevious:[],fromEarlierPrevious:[]' in src,
 'current_feature_weight_70pct':'latest*0.7+mean*0.3' in src,
 'saw_legacy_latency_filter_removed':"filter(x=>x!=='LOCK_DELAY_ABOVE_ADAPTIVE_MAX')" in src,
},ensure_ascii=False))
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
 for j in lines[-3:]:show('V2_LOG',j)
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

# Post-repair read-only follow-up: signal transport and panel state.

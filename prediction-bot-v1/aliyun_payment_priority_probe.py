#!/usr/bin/env python3
"""Read-only SWAS prediction wallet-route deployment preflight."""
import os,base64,sys,time,json
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as o
REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
SH=r'''#!/bin/bash
set -u
echo PROBE_START
for svc in zl-prediction-trade zl-prediction-v2 zl-prediction-v3;do
 echo "SERVICE:$svc:$(systemctl is-active "$svc" 2>/dev/null || true)"
done
ROOT=/opt/zl-prediction-live/src
if [ -d "$ROOT/.git" ];then
 echo "REPO_PRESENT:yes"
 git -C "$ROOT" rev-parse --short HEAD 2>/dev/null | sed 's/^/SERVER_SHA:/'
else echo "REPO_PRESENT:no";fi
for file in railway-diagnostic/index.mjs railway-diagnostic/wrapper.mjs railway-diagnostic/payment-source-priority.mjs;do
 if [ -f "$ROOT/$file" ];then
   echo "FILE:$file:present"
   sha256sum "$ROOT/$file" | cut -d' ' -f1 | sed 's/^/CONTENT_SHA256:/'
   git hash-object "$ROOT/$file" | sed 's/^/GIT_BLOB_SHA:/'
 else echo "FILE:$file:missing";fi
done
python3 - <<'PY'
import json,urllib.request
for p in (13005,13004,13001):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d/api/status'%p,timeout=2) as response:
   d=json.load(response)
  print('PREDICTION_CONTROL_STATUS',json.dumps({'port':p,'ok':d.get('ok'),'enabled':d.get('enabled'),'pendingState':(d.get('pendingAction') or {}).get('state'),'lastOrderState':(d.get('lastOrder') or {}).get('state'),'autoConfirmEnabled':d.get('autoConfirmEnabled')},separators=(',',':')))
  break
 except Exception as e:print('PREDICTION_PORT_UNAVAILABLE',p,type(e).__name__)
PY
for p in 13005 13004 13001;do
 echo "HEALTHZ_PORT:$p:$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:$p/healthz || true)"
done
echo "TRADE_SERVICE_RECENT_FAILURES_BEGIN"
journalctl -u zl-prediction-trade --since '18 minutes ago' --no-pager -o cat 2>/dev/null | python3 -c 'import re,sys
rows=[]
for line in sys.stdin:
 if re.search(r"Error|ERR_|Cannot find|failed|exit|missing|SyntaxError|MODULE_NOT_FOUND|EACCES|address already|ECONNREFUSED",line,re.I):
  line=re.sub(r"(?i)(key|token|password|secret)[=:]\\s*\\S+",r"\\1=[REDACTED]",line.strip()[:210])
  rows.append(line)
print("\\n".join(rows[-17:]))' || true
echo "TRADE_SERVICE_RECENT_FAILURES_END"
python3 - <<'PY'
import subprocess
r=subprocess.run(['runuser','-u','zl-pred','--','journalctl','-u','zl-prediction-trade','--since','2 minutes ago','-n','1','-o','json','--no-pager'],capture_output=True,text=True,timeout=10)
print('ZL_PRED_JOURNAL_ACCESS',r.returncode==0 and bool(r.stdout.strip()),'rc',r.returncode,'rows',len(r.stdout.splitlines()))
PY
echo GUARDIAN_FULL_ORDER_READONLY_AUDIT_BEGIN
python3 - <<'PY'
import json,subprocess,datetime,urllib.request,pathlib,collections,re,time
tz=datetime.timezone(datetime.timedelta(hours=8))
def safe_read(port,ep):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%s%s'%(port,ep),timeout=4) as r:return json.load(r)
 except Exception as e:return {'readError':type(e).__name__}
def filt(row,names):return {k:row.get(k) for k in names}
for port in (13001,13005):
 s=safe_read(port,'/api/status')
 keys=['ok','enabled','mode','orderSignalModel','orderSignalModelReady','guardianRiskReady','guardianExecutionReady','directionModeReady','autoConfirmEnabled','autoConfirmHalted','tradeAmount','amount','lastAutoSubmitAt','pendingAction','lastOrder']
 vals=filt(s,keys)
 for k in ('pendingAction','lastOrder'):
  ob=vals.get(k) or {}; vals[k]=filt(ob,['state','round','code','httpStatus','error','blockReason','paymentAccount','orderAttempts','maxOrderAttempts','amount','submittedAt','startedAt'])
 print('FULL_AUDIT_TRADE_STATUS',port,json.dumps(vals,ensure_ascii=False,default=str)[:2000])
s=safe_read(13049,'/api/status')
rec=s.get('records') or []
print('FULL_AUDIT_GUARDIAN',json.dumps({'ok':s.get('ok'),'configured':s.get('configured'),'model':s.get('model'),'error':str(s.get('error',''))[:120],
'latest':filt(s.get('latest') or {},['round','direction','reason','status']),
'round':s.get('round'),'observedAgeSec':round((time.time()*1000-int(s.get('observedAt') or 0))/1000,1) if s.get('observedAt') else None,
'recordsLast5':[filt(x,['round','at','status','predictedDirection']) for x in rec[-5:]]},ensure_ascii=False,default=str)[:1800])
riskroot=pathlib.Path('/var/lib/zl-prediction/rounds')
def age(x):
 if not x:return None
 try:return round(time.time()-datetime.datetime.fromisoformat(str(x).replace('Z','+00:00')).timestamp(),1)
 except:return None
for name,keys in [
 ('risk-control.json',['takeProfitEnabled','stopLossEnabled','takeProfitPercent','stopLossPercent','enabled']),
 ('risk-runtime-status.json',['enabled','workerRunning','configApplied','transitioning','guardianDynamicExitEnabled','at','error']),
 ('risk-worker-health.json',['positionsSeen','lastSuccessfulPositionsAt','lastErrorAt','lastError','lastTickFinishedAt','quoteErrors'])]:
 try:
  p=riskroot/name
  d=json.loads(p.read_text())
  out=filt(d,keys)
  for k in ['at','lastSuccessfulPositionsAt','lastTickFinishedAt']:
   if k in out:out[k+'AgeSec']=age(out.pop(k))
  print('FULL_AUDIT_RISK',name,json.dumps(out,ensure_ascii=False,default=str)[:900])
 except Exception as e:print('FULL_AUDIT_RISK_MISSING',name,type(e).__name__)
for service in ('zl-prediction-trade','zl-prediction-guardian-analysis','zl-prediction-risk-exits','redis-server'):
 p=subprocess.run(['systemctl','is-active',service],capture_output=True,text=True,timeout=3)
 print('FULL_AUDIT_SERVICE',service,p.stdout.strip() or 'unknown')
for file in ('index.mjs','wrapper.mjs','guardian-live-bridge.mjs'):
 p=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')/file
 if not p.exists(): print('FULL_AUDIT_FILE_MISSING',file);continue
 t=p.read_text()
 print('FULL_AUDIT_LIVE_CODE',file,{'guardedSignalRetries':'GUARDIAN_RECHECK_V2' in t,'observedRetention':'retainedObservation' in t,'takeProfitRequired':"config.takeProfitEnabled===true&&config.stopLossEnabled===true" in t,'guardianSourcePresent':'GUARDIAN_ID' in t})
# Production journald: only event type & safe scalar attributes; never print credentials or raw order objects.
proc=subprocess.run(['journalctl','-u','zl-prediction-trade','--since','12 hours ago','-o','json','--no-pager'],capture_output=True,text=True,timeout=25)
wanted={'api_confirm_control','api_intent_ready','intent_prepare_failed','auto_submit_triggered','auto_confirm_halted','guardian_signal_recheck_completed','submit_blocked_signal_changed','fresh_quote_failed','fresh_quote_ready','prediction_wallet_quote_insufficient_spot_fallback','prediction_wallet_insufficient_spot_unavailable','api_order_submit_attempt','api_order_failed','api_order_submitted','order_submit_attempt_denied','order_submit_deadline_expired','order_retry_requote_failed','order_unknown_fence_failed','submission_unknown','risk_worker_unready','guard_order_blocked','guardian_feed_unavailable','production_signal_choice_hydrate_failed','direction_mode_hydrate_failed','order_status_conflict_auto_halted'}
freq=collections.Counter();last=[]
for line in proc.stdout.splitlines():
 try:
  row=json.loads(line); m=json.loads(row.get('MESSAGE',''))
  if not isinstance(m,dict):continue
  e=m.get('event')
  if e not in wanted:continue
  freq[e]+=1
  ts=datetime.datetime.fromtimestamp(int(row['__REALTIME_TIMESTAMP'])/1e6,tz).strftime('%m-%d %H:%M:%S')
  item={k:m.get(k) for k in ('round','state','code','httpStatus','source','spotQuoteOk','retries','signalRecovered','signalIdMatches','attempt','maxAttempts','status','currentStatus','currentDirection','currentSignalIdMatches','recheckRetries','paymentAccount','productionSignal','orderSignal','amount') if m.get(k) is not None and isinstance(m.get(k),(str,int,float,bool))}
  if 'error' in m and isinstance(m['error'],str):item['error']=m['error'][:120]
  last.append([ts,e,item])
 except Exception:continue
print('FULL_AUDIT_LOG_READ',proc.returncode,len(proc.stdout.splitlines()))
print('FULL_AUDIT_EVENTS_COUNTS',json.dumps(freq,ensure_ascii=False))
for i in last[-25:]:print('FULL_AUDIT_EVENT',json.dumps(i,ensure_ascii=False))
print('GUARDIAN_FULL_ORDER_READONLY_AUDIT_END')
PY
echo PROBE_END
'''
def main():
 if not os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID") or not os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET"):
  print("ALICLOUD_CREDENTIALS_UNAVAILABLE");return 2
 c=Client(o.Config(access_key_id=os.environ["ALIBABA_CLOUD_ACCESS_KEY_ID"],access_key_secret=os.environ["ALIBABA_CLOUD_ACCESS_KEY_SECRET"],endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
 try:
  r=c.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name="zl-payment-priority-readonly-probe",type="RunShellScript",command_content=SH,working_user="root",timeout=70))
  if not r.body.invoke_id:print("NO_INVOKE_ID");return 3
  for _ in range(35):
   time.sleep(2)
   x=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=r.body.invoke_id)).body.invocation_result
   if x and str(x.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout","ClientNotRunning"):
    output=x.output or ""
    try:output=base64.b64decode(output,validate=True).decode("utf8","replace")
    except Exception:pass
    print("PROBE_STATUS",x.invocation_status,"EXIT",x.exit_code)
    print(output[-16000:])
    return 0 if str(x.invocation_status)=="Success" and int(x.exit_code)==0 else 4
  print("PROBE_PENDING");return 5
 except Exception as e:print("PROBE_ERROR",type(e).__name__,str(getattr(e,'code','unknown'))[:80]);return 6
if __name__=="__main__":sys.exit(main())

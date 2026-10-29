#!/usr/bin/env python3
"""Read-only Alibaba runtime and risk-worker checks; no secrets or order calls."""
import base64,os,time,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -eu
BASE=/opt/zl-prediction-live/src/railway-diagnostic
echo GUARDIAN_RUNTIME_DIAG_START=true
for name in wrapper.mjs guardian-live-bridge.mjs risk-worker.mjs risk-runner.mjs risk-config-storage.mjs control-shell.mjs guardian-main-dashboard.mjs; do
  file="$BASE/$name"
  if test -r "$file"; then sha256sum "$file" | cut -c1-88
  else echo "GUARDIAN_RUNTIME_FILE_MISSING $name"; fi
done
for name in risk-runtime-status.json risk-worker-health.json risk-control.json guardian-risk-ready.json;do
  if test -f "/tmp/$name";then ls -l "/tmp/$name";else echo "GUARDIAN_RUNTIME_MISSING $name";fi
done
for name in wrapper.mjs risk-worker.mjs risk-runner.mjs control-shell.mjs;do
  file="$BASE/$name"
  test -f "$file" || continue
  for mark in guardianExitMonitorReady GUARDIAN_DYNAMIC_EXIT_ENABLED guardianRiskQuote lastSuccessfulPositionsAt dynamicExitEnabled guardianRiskReady writeStatus;do
    if grep -Fq "$mark" "$file";then echo "GUARDIAN_RUNTIME_MARKER $name $mark yes";fi
  done
done
for name in risk-runner.mjs risk-worker.mjs guardian-risk-integration.mjs; do
  file="$BASE/$name"
  if test -r "$file";then
    grep -nE '^(const (STATUS_FILE|WORKER_HEALTH_FILE|CONTROL_FILE|READY|REGISTRY)|let storageReady)|risk_runtime_status_write_failed|risk_health_write_failed' "$file" | cut -c1-210 || true
  fi
done
find /var/lib/zl-prediction -maxdepth 4 -type f \( -name '*risk*json' -o -name '*guardian*ready*' \) 2>/dev/null | head -25 || true
python3 - <<'PY'
import json,os
root='/var/lib/zl-prediction/rounds'
fields=('at','enabled','workerRunning','guardianDynamicExitEnabled','configApplied',
 'dynamicExitEnabled','takeProfitEnabled','stopLossEnabled','persistenceHealthy',
 'lastSuccessfulPositionsAt','lastTickFinishedAt','lastWorkerStartedAt','configUpdatedAt')
for name in ['risk-runtime-status.json','risk-worker-health.json','risk-control.json',
             'guardian5/guardian-risk-ready.json']:
 try:
  obj=json.load(open(os.path.join(root,name)))
  print('GUARDIAN_SAFE_RISK_STATE',name,{k:obj.get(k) for k in fields if k in obj})
 except Exception as e:print('GUARDIAN_SAFE_RISK_STATE_ERROR',name,type(e).__name__)
PY
systemctl show zl-prediction-risk-exits -p MainPID -p ActiveState -p PrivateTmp
systemctl show zl-prediction-trade -p MainPID -p ActiveState -p PrivateTmp
echo GUARDIAN_DIAG_SKIP_BASELINE_DOWNLOADS=true
python3 - <<'PY'
from pathlib import Path
b=Path('/opt/zl-prediction-live/src/railway-diagnostic')
patterns={
 'guardian-live-bridge.mjs':['stats.validated===true','settled>=300','round+FIVE_MIN-now<25000','modelProbability<0.70','edge>=0.05','guardianRegisterIntent'],
 'wrapper.mjs':['GUARDIAN_ORDER_DEADLINE_MS = 275000','GUARDIAN_ORDER_DEADLINE_MS = 300000','guardianExitMonitorReady','lastSuccessfulPositionsAt','currentRetry.direction!==p.signal','currentRetry.direction!==p.productionSignal'],
 'control-shell.mjs':['dynamicExitEnabled','outerAuthOnly','process.env.RISK_CONTROL_FILE','pinOK(body.pin'],
 'risk-runner.mjs':['dynamicExitEnabled','GUARDIAN_DYNAMIC_EXIT_ENABLED','process.env.RISK_STATUS_FILE'],
 'risk-config-storage.mjs':['dynamicExitEnabled','process.env.RISK_CONTROL_FILE'],
 'guardian-risk-integration.mjs':['GUARDIAN_RISK_READY_FILE','process.env.GUARDIAN_REGISTRY_FILE']
}
for name,needles in patterns.items():
 try:s=(b/name).read_text()
 except Exception:continue
 print('GUARDIAN_RUNTIME_PATCH_ANCHORS',name,{n:s.count(n) for n in needles})
PY
python3 - <<'PY'
from pathlib import Path
p=Path('/opt/zl-prediction-live/src/railway-diagnostic')
for name in ['guardian-live-bridge.mjs','order-direction-policy.mjs','index.mjs']:
 try:s=(p/name).read_text()
 except Exception as e:print('SOURCE_READ_FAILURE',name,type(e).__name__);continue
 for i,line in enumerate(s.splitlines(),1):
  if ('GUARDIAN_SOURCE=' in line or 'ORDER_SOURCES=' in line or
      'function mappedOrderSignal(' in line or 'function orderDirectionForProduction(' in line or
      "choice.model===GUARDIAN_ID" in line):
   print('GUARDIAN_2125_SOURCE_ANCHOR',name,i,line.strip()[:210])
PY
echo GUARDIAN_2210_2215_INCIDENT_START=true
python3 - <<'PY'
import json,datetime,subprocess,urllib.request,collections,pathlib
def get(port,path):
 try:
  with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=5) as r:return json.load(r)
 except Exception as e:return {'readError':type(e).__name__}
def pick(o,ks):return {k:o.get(k) for k in ks if k in o} if isinstance(o,dict) else {}
def ms(utc):return int(datetime.datetime.fromisoformat(utc.replace('Z','+00:00')).timestamp()*1000)
target=[ms('2026-10-29T14:10:00Z'),ms('2026-10-29T14:15:00Z')]
g=get(13049,'/api/status');s=get(13001,'/api/status')
mode=get(13001,'/api/direction-mode');choice=get(13001,'/api/order-signal-model')
print('G2210_GUARDIAN_CURRENT',json.dumps(pick(g,['ok','configured','model','observedAt','lastTickAt','lastAIAt','error']),ensure_ascii=False))
print('G2210_GUARDIAN_LATEST',json.dumps(pick(g.get('latest'),['round','direction','status','reason']),ensure_ascii=False))
recs=g.get('records') or []
print('G2210_TOTAL_RECORDS',len(recs))
for t in target:
 a=[x for x in recs if isinstance(x,dict) and x.get('round')==t]
 print('G2210_TARGET',t,'ROWS',len(a))
 for x in a[-2:]:
  print('G2210_SIGNAL',json.dumps(pick(x,['round','at','marketAt','status','predictedDirection','reason','subjectiveConfidence','tradeEligible','tradeGate']),ensure_ascii=False)[:950])
print('G2210_TRADE_STATUS',json.dumps(pick(s,['ok','enabled','mode','amount','orderSignalModel','orderSignalModelReady','directionModeReady','guardianRiskReady','guardianExecutionReady','guardianRiskBlockReason','guardianExecutionBlockReason','orderMappingMode','orderSignal','productionSignal','orderProductionSource','startAfterRound']),ensure_ascii=False)[:1100])
print('G2210_TRADE_PENDING',json.dumps(pick(s.get('pendingAction'),['round','state','status','error','code','blockReason','productionSignal','orderSignal','mappingMode']),ensure_ascii=False))
print('G2210_LAST_ORDER',json.dumps(pick(s.get('lastOrder'),['round','state','status','error','code','submittedAt']),ensure_ascii=False))
print('G2210_DIRECTION',json.dumps(pick(mode,['ok','ready','revision','modes','effectiveAfterRound']),ensure_ascii=False)[:1100])
print('G2210_SOURCE_POLICY',json.dumps(pick(s,['directionModes','orderMappingMode','orderDirectionPolicy','signalTransport']),ensure_ascii=False)[:1200])
print('G2210_CHOICE',json.dumps(pick(choice,['ok','ready','model','effectiveAfterRound']),ensure_ascii=False))
for fn in ('guardian-live-bridge.mjs','order-direction-policy.mjs','index.mjs','wrapper.mjs'):
 p=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')/fn
 try:content=p.read_text().splitlines()
 except Exception as e:print('G2210_SOURCE_ERR',fn,type(e).__name__);continue
 for i,line in enumerate(content,1):
  if any(z in line for z in ("GUARDIAN_SOURCE=","ORDER_SOURCES=","function guardianOrderSignal(","function mappedOrderSignal(","function guardianExitMonitorReady(","if(choice.model===GUARDIAN_ID)")):
   print('G2210_SOURCE_ANCHOR',fn,i,line.strip()[:200])
try:
 pid=subprocess.check_output(['systemctl','show','--property=MainPID','--value','zl-prediction-trade'],text=True,timeout=5).strip()
 raw=open('/proc/'+pid+'/environ','rb').read().split(bytes([0]))
 for k in (b'AUTO_CONFIRM_ENABLED',b'AUTO_CONFIRM_STOP_ON_ERROR'):
  v=next((x.split(b'=',1)[1].decode('utf8','replace') for x in raw if x.startswith(k+b'=')),'UNSET')
  print('G2210_ENV',k.decode(),v)
except Exception as e:print('G2210_ENV_ERROR',type(e).__name__)
for unit in ('zl-prediction-trade','zl-prediction-guardian-analysis'):
 try:
  out=subprocess.run(['journalctl','--no-pager','-o','cat','-u',unit,
   '--since','2026-10-29 14:09:30 UTC','--until','2026-10-29 14:21:00 UTC'],
   capture_output=True,text=True,timeout=10).stdout
 except Exception as e:print('G2210_JOURNAL_ERROR',unit,type(e).__name__);continue
 cnt=collections.Counter();events=[]
 for line in out.splitlines():
  try:v=json.loads(line[line.index('{'):])
  except Exception:continue
  if not isinstance(v,dict):continue
  event=str(v.get('event') or '')
  cnt[event]+=1
  if event and any(k in event.lower() for k in ('guardian','signal','intent','order','quote','submit','block','control','follow','confirm','ready','risk','fail')):
   events.append(pick(v,['event','round','at','status','state','code','reason','blockReason','direction','productionSignal','orderSignal','source','error','enabled']))
 print('G2210_JOURNAL_SUMMARY',unit,'lines',len(out.splitlines()),'events',json.dumps(cnt.most_common(18),ensure_ascii=False))
 for row in events[-45:]:print('G2210_JOURNAL_EVENT',unit,json.dumps(row,ensure_ascii=False)[:450])
print('GUARDIAN_2210_2215_INCIDENT_DONE=true')
PY
echo GUARDIAN_RUNTIME_DIAG_COMPLETE=true
"""
c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
req=sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
 type='RunShellScript',name='guardian-runtime-readonly-diff',command_content=SCRIPT,working_user='root',timeout=75)
invoke=c.run_command(req).body.invoke_id
for _ in range(46):
 time.sleep(2)
 d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=invoke)).body.invocation_result
 if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
  try:out=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
  except Exception:out='OUTPUT_UNAVAILABLE'
  print('GUARDIAN_RUNTIME_AUDIT',d.invocation_status,d.exit_code)
  print(out[-11000:])
  sys.exit(0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 else 4)
sys.exit(5)

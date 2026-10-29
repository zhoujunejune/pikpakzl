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
echo GUARDIAN_2125_INCIDENT_START=true
python3 - <<'PY'
import json,datetime,subprocess,urllib.request,collections
from datetime import timezone
def read(port,path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=6) as r:return json.load(r)
 except Exception as e:return {'readError':type(e).__name__}
def pick(d,keys):
 return {k:d.get(k) for k in keys if k in d} if isinstance(d,dict) else {}
def ms(iso):
 return int(datetime.datetime.fromisoformat(iso.replace('Z','+00:00')).timestamp()*1000)
round_ms=ms('2026-10-29T13:25:00Z')
g=read(13049,'/api/status')
s=read(13001,'/api/status')
choice=read(13001,'/api/order-signal-model')
mode=read(13001,'/api/direction-mode')
print('INCIDENT_TARGET_ROUND',round_ms,'2026-10-29 21:25 Asia/Shanghai')
print('INCIDENT_GUARDIAN_CURRENT',pick(g,['ok','model','configured','lastTickAt','observedAt','error','lastAIAt','modelLatencyMs']))
print('INCIDENT_GUARDIAN_LATEST',pick(g.get('latest'),['round','direction','status','reason']))
records=g.get('records') or []
matched=[x for x in records if isinstance(x,dict) and x.get('round')==round_ms]
print('INCIDENT_GUARDIAN_RECORD_COUNT',len(records),'MATCHED',len(matched))
for x in matched[-4:]:
 print('INCIDENT_GUARDIAN_RECORD',json.dumps(pick(x,['round','at','marketAt','status','predictedDirection','reason','subjectiveConfidence','tradeEligible','tradeGate']),ensure_ascii=False)[:750])
print('INCIDENT_TRADE_STATUS',json.dumps(pick(s,['ok','enabled','amount','mode','orderSignalModel','orderSignalModelReady','orderSignalModelEffectiveAfterRound','directionModeReady','guardianRiskReady','guardianExecutionReady','guardianRiskBlockReason','guardianExecutionBlockReason','orderSignal','productionSignal','orderProductionSource']),ensure_ascii=False))
print('INCIDENT_TRADE_SIGNAL',json.dumps(pick(s.get('signal'),['round','direction','status','source','upstreamModel','signalId','executionEligible','qualityGate']),ensure_ascii=False))
print('INCIDENT_TRADE_PENDING',json.dumps(pick(s.get('pendingAction'),['round','state','status','productionSignal','orderSignal','mappingMode','error','blockReason','code','at']),ensure_ascii=False))
print('INCIDENT_TRADE_LAST_ORDER',json.dumps(pick(s.get('lastOrder'),['round','state','status','productionSignal','action','submittedAt','error','code']),ensure_ascii=False))
print('INCIDENT_DIRECTION',json.dumps(pick(mode,['ok','ready','revision','effectiveAfterRound','modes']),ensure_ascii=False)[:950])
print('INCIDENT_DIRECTION_FROM_STATUS',json.dumps(pick(s,['directionModes','orderMappingMode','orderDirectionPolicy']),ensure_ascii=False)[:950])
print('INCIDENT_CHOICE',json.dumps(pick(choice,['ok','ready','model','effectiveAfterRound']),ensure_ascii=False))
try:
 p=subprocess.check_output(['systemctl','show','-p','MainPID','--value','zl-prediction-trade'],text=True,timeout=5).strip()
 raw=open('/proc/'+p+'/environ','rb').read().split(bytes([0]))
 for key in (b'AUTO_CONFIRM_ENABLED',b'AUTO_CONFIRM_STOP_ON_ERROR'):
  val=next((z.split(b'=',1)[1].decode('utf8','replace') for z in raw if z.startswith(key+b'=')),'NOT_SET')
  print('INCIDENT_ENV',key.decode(),val)
except Exception as e:print('INCIDENT_ENV_ERR',type(e).__name__)
for unit in ['zl-prediction-trade','zl-prediction-guardian-analysis']:
 for bounds in [('2026-10-29 13:24:30 UTC','2026-10-29 13:31:00 UTC')]:
  try:
   out=subprocess.run(['journalctl','--no-pager','-o','cat','-u',unit,'--since',bounds[0],'--until',bounds[1]],
     capture_output=True,text=True,timeout=12).stdout
  except Exception as e:print('INCIDENT_LOG_ERR',unit,type(e).__name__);continue
  lines=out.splitlines()
  print('INCIDENT_LOG_LINES',unit,len(lines))
  events=collections.Counter()
  safe=[]
  for line in lines:
   try:
    j=json.loads(line[line.index('{'):]) if '{' in line else {}
   except Exception:continue
   if not isinstance(j,dict):continue
   typ=str(j.get('event') or '')
   if typ:events[typ]+=1
   if typ and any(q in typ.lower() for q in ('order','signal','intent','quote','submit','confirm','fail','block','follow','control','mode','risk','guardian')):
    safe.append(pick(j,['event','at','round','state','status','direction','productionSignal','source','code','reason','blockReason','error','enabled','upstreamModel','currentDirection','currentRound']))
  print('INCIDENT_EVENT_COUNTS',unit,json.dumps(events.most_common(25),ensure_ascii=False))
  for row in safe[-45:]:print('INCIDENT_EVENT',unit,json.dumps(row,ensure_ascii=False)[:550])
print('GUARDIAN_2125_INCIDENT_DONE=true')
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

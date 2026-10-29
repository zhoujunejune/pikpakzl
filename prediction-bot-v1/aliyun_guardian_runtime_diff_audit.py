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
BASE_SHA=16350d9faa9046224702f82a5c8f34f6cc1d9f68
STAGE=$(mktemp -d /tmp/guardian-compare-XXXXXX)
for name in wrapper.mjs guardian-live-bridge.mjs risk-runner.mjs risk-config-storage.mjs control-shell.mjs guardian-risk-integration.mjs guardian-main-dashboard.mjs;do
  file="$BASE/$name"
  if curl -fsSL --max-time 15 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$BASE_SHA/railway-diagnostic/$name" -o "$STAGE/$name";then
    if test -f "$file" && cmp -s "$STAGE/$name" "$file";then echo "GUARDIAN_DEPLOY_BASELINE $name MATCH"
    else echo "GUARDIAN_DEPLOY_BASELINE $name LIVE_DRIFT";fi
  else echo "GUARDIAN_DEPLOY_BASELINE $name REFERENCE_UNAVAILABLE";fi
done
rm -rf "$STAGE"
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
echo GUARDIAN_INCIDENT_2000_READONLY_START=true
python3 - <<'PY'
import json, subprocess, urllib.request
from datetime import datetime
def cmd(argv):
 try:return subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=12).stdout
 except Exception as exc:return ''
def get_status(port=13001):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%s/api/status'%port,timeout=3) as resp:
   return json.load(resp)
 except Exception as exc:return {'error':type(exc).__name__}
s=get_status()
print('GUARDIAN_INCIDENT_LIVE_STATUS',json.dumps({
 k:s.get(k) for k in ['ok','enabled','autoConfirmEnabled','autoConfirmHalted','orderSignalModel','guardianRiskReady','guardianExecutionReady','guardianExecutionBlockReason','guardianRiskBlockReason','orderSignalModelReady','orderSignal','mode','amount','startAfterRound']},ensure_ascii=False))
for k in ['signal','pendingAction','lastOrder']:
 x=s.get(k)
 if isinstance(x,dict):
  print('GUARDIAN_INCIDENT_LIVE_'+k.upper(),json.dumps({
   a:x.get(a) for a in ['round','status','state','direction','productionSignal','upstreamModel','error','blockReason','code','at'] if a in x},ensure_ascii=False))
pid=cmd(['systemctl','show','-p','MainPID','--value','zl-prediction-trade']).strip()
try:
 env=open('/proc/'+str(int(pid))+'/environ','rb').read().split(bytes([0]))
 for key in [b'AUTO_CONFIRM_ENABLED',b'AUTO_CONFIRM_STOP_ON_ERROR']:
  name=key.decode();v=next((a.split(b'=',1)[1].decode('ascii','replace') for a in env if a.startswith(key+b'=')),'NOT_SET')
  print('GUARDIAN_INCIDENT_ENV',name,v)
except Exception as ex:print('GUARDIAN_INCIDENT_ENV_ERROR',type(ex).__name__)
print('GUARDIAN_INCIDENT_MACHINE_TZ',cmd(['date','+%Y-%m-%dT%H:%M:%S%z']).strip())
print('GUARDIAN_INCIDENT_STATUS_KEYS',sorted(s.keys()))
for unit in ['zl-prediction-trade','zl-prediction-guardian-analysis']:
 raw=cmd(['journalctl','-u',unit,'--since','2026-10-29 11:59:30 UTC',
          '--until','2026-10-29 12:05:30 UTC','-o','cat','--no-pager'])
 print('GUARDIAN_INCIDENT_JOURNAL_TOTAL',unit,len(raw.splitlines()))
 parsed=0;found=[]
 for line in raw.splitlines():
  try: v=json.loads(line[line.index('{'):])
  except (ValueError,TypeError):continue
  if not isinstance(v,dict):continue
  parsed+=1
  event=v.get('event')
  if isinstance(event,str) and event not in found:found.append(event)
 print('GUARDIAN_INCIDENT_JOURNAL_STRUCTURED',unit,parsed,'EVENT_NAMES',found[:35])
 rows=[]
 for line in raw.splitlines():
  pos=line.find('{')
  if pos<0:continue
  try: o=json.loads(line[pos:])
  except Exception:continue
  if not isinstance(o,dict):continue
  event=o.get('event')
  if not isinstance(event,str):continue
  if not any(t in event.lower() for t in ['guardian','signal','submit','order','quote','intent','prepare','risk','auto','market']):continue
  keys=['event','round','at','status','state','direction','productionSignal','currentDirection',
        'currentRound','upstreamModel','blockReason','reason','code','httpStatus','source']
  safe={k:o.get(k) for k in keys if k in o and isinstance(o[k],(str,int,float,bool,type(None)))}
  rows.append(safe)
 print('GUARDIAN_INCIDENT_EVENTS',unit,'count',len(rows))
 for row in rows[-35:]:print('GUARDIAN_INCIDENT_EVENT',unit,json.dumps(row,ensure_ascii=False)[:260])
PY
echo GUARDIAN_INCIDENT_2000_READONLY_DONE=true
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

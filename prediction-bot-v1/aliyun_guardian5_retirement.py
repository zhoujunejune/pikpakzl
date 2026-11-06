#!/usr/bin/env python3
"""Safely inspect or retire only five-minute Guardian units on Alibaba SWAS; preserve all source and state."""
import base64
import os
import sys
import time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
SERVICES=("zl-prediction-trade","zl-prediction-risk-exits","zl-prediction-guardian-analysis")
SCRIPT=r'''#!/usr/bin/env bash
set -Eeuo pipefail
MODE="__MODE__"
units=(zl-prediction-trade zl-prediction-risk-exits zl-prediction-guardian-analysis)
safe=(zl-event10-deepseek caddy)
echo "GUARDIAN_RETIRE_MODE=$MODE"
echo "GUARDIAN_RETIRE_TIME_UTC=$(date -u +%FT%TZ)"
echo "GUARDIAN_RELEVANT_SERVICES:"
systemctl list-units --all --type=service --plain --no-pager | grep -E 'zl-(prediction|guardian|event10)|caddy|redis' | cut -c1-155 || true
echo "GUARDIAN_RELEVANT_TIMERS:"
systemctl list-timers --all --no-pager | grep -E 'zl-(prediction|guardian|event10)' | cut -c1-155 || true
for svc in "${units[@]}" "${safe[@]}"; do
 echo "SERVICE_STATE_BEGIN=$svc"
 for prop in LoadState ActiveState SubState UnitFileState MainPID Restart FragmentPath PartOf Requires; do
  val=$(systemctl show "$svc" -p "$prop" --value 2>/dev/null | head -c 230)
  echo "SERVICE_STATE_$prop=$val"
 done
 echo "SERVICE_STATE_END=$svc"
done
python3 - <<'PY'
import json,urllib.request
for port,path,name in [(13001,'/api/status','trade'),(13049,'/api/status','guardian'),(13020,'/api/status','event10'),(13020,'/api/signals?limit=1','event10_signals')]:
 try:
  with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=5) as r:
   val=json.load(r)
  safe={key:val.get(key) for key in ('ok','model','configured','decisionReviewVersion','enabled','active') if key in val}
  if isinstance(safe.get('active'),dict):safe['active']=bool(safe['active'])
  print('LOCAL_ENDPOINT',name,r.status,json.dumps(safe,ensure_ascii=False))
 except Exception as e:print('LOCAL_ENDPOINT',name,type(e).__name__)
PY
if [[ "$MODE" == audit ]];then
 echo "GUARDIAN_RETIRE_AUDIT_COMPLETE=true"
 exit 0
fi
if [[ "$MODE" != stop ]];then echo "GUARDIAN_RETIRE_INVALID_MODE=true";exit 2;fi
# Fail-closed: unrelated event signal service and authenticated reverse proxy must be operational.
for svc in "${safe[@]}";do systemctl is-active --quiet "$svc" || { echo "GUARDIAN_RETIRE_SHARED_SERVICE_NOT_ACTIVE=$svc";exit 12;};done
# Refuse changes if the trading engine reports an unresolved in-flight order/position.
python3 - <<'PY'
import json,urllib.request
try:
 with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=5) as r:x=json.load(r)
except Exception as e:
 print('GUARDIAN_RETIRE_TRADE_STATUS_UNREADABLE',type(e).__name__)
 raise SystemExit(14)
if x.get('ok') is not True:
 print('GUARDIAN_RETIRE_TRADE_STATUS_NOT_OK');raise SystemExit(15)
p=x.get('pendingAction')
state=str(p.get('state') or '').upper() if isinstance(p,dict) else ''
# "pendingAction" may persist past completed rounds. Distinguish unsettled in-flight states.
unsafe=('SUBMITTING','PENDING','PROCESSING','UNCERTAIN','SENT','WAITING','IN_FLIGHT','IN_PROGRESS','CREATED')
if state in unsafe or x.get('pendingOrderUncertain') is True:
 print('GUARDIAN_RETIRE_UNCERTAIN_ORDER_STATE',state);raise SystemExit(16)
print('GUARDIAN_RETIRE_ORDER_PREFLIGHT_OK=true',state or 'NONE')
PY
for svc in "${units[@]}";do
 state=$(systemctl show "$svc" -p LoadState --value 2>/dev/null || true)
 if [[ "$state" != loaded ]];then
  echo "GUARDIAN_RETIRE_SKIPPED_NOT_LOADED=$svc";continue
 fi
 systemctl disable --now "$svc" >/dev/null
 systemctl stop "$svc"
 echo "GUARDIAN_RETIRE_STOPPED=$svc"
done
for svc in "${units[@]}";do
 if systemctl is-active --quiet "$svc";then echo "GUARDIAN_RETIRE_STILL_RUNNING=$svc";exit 20;fi
 echo "GUARDIAN_RETIRE_INACTIVE=$svc"
 done
for svc in "${safe[@]}";do systemctl is-active --quiet "$svc" || { echo "GUARDIAN_RETIRE_SHARED_SERVICE_DAMAGED=$svc";exit 22;};done
python3 - <<'PY'
import json,urllib.request
for name,path in [('status','/api/status'),('signals','/api/signals?limit=1')]:
 try:
  with urllib.request.urlopen('http://127.0.0.1:13020'+path,timeout=8) as r:x=json.load(r)
  if x.get('ok') is not True:raise RuntimeError('not_ok')
  print('EVENT10_POST_RETIRE_OK',name,True)
 except Exception as e:
  print('EVENT10_POST_RETIRE_CHECK_FAILED',name,type(e).__name__)
  raise
PY
echo "GUARDIAN_RETIRE_COMPLETE=true"
'''
def main():
 mode=os.environ.get("GUARDIAN_RETIRE_MODE","audit")
 if mode not in ("audit","stop"):
  print("GUARDIAN_RETIRE_INVALID_MODE");return 2
 ak=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID")
 sk=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
 if not ak or not sk:print("GUARDIAN_RETIRE_CLOUD_AUTH_MISSING");return 3
 client=Client(api.Config(access_key_id=ak,access_key_secret=sk,region_id=REGION,endpoint="swas.ap-southeast-1.aliyuncs.com"))
 run=client.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name="guardian5-"+mode+"-preserve-code",type="RunShellScript",working_user="root",command_content=SCRIPT.replace("__MODE__",mode),timeout=145))
 invoke=run.body.invoke_id
 if not invoke:print("GUARDIAN_RETIRE_NO_INVOCATION_ID");return 4
 for i in range(75):
  time.sleep(2)
  x=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=invoke)).body.invocation_result
  if not x or str(x.invocation_status) not in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero","ClientNotRunning","InstanceNotRunning"):continue
  output=base64.b64decode(x.output or "").decode("utf8","replace")
  print("GUARDIAN_RETIRE_REMOTE_STATUS",x.invocation_status,"EXIT",x.exit_code,flush=True)
  print(output[-13500:],flush=True)
  wanted="GUARDIAN_RETIRE_AUDIT_COMPLETE=true" if mode=="audit" else "GUARDIAN_RETIRE_COMPLETE=true"
  return 0 if str(x.invocation_status)=="Success" and int(x.exit_code)==0 and wanted in output else 5
 print("GUARDIAN_RETIRE_REMOTE_TIMEOUT");return 6
if __name__=="__main__":
 try:sys.exit(main())
 except Exception as e:
  print("GUARDIAN_RETIRE_REMOTE_API_EXCEPTION",type(e).__name__,str(getattr(e,"code",""))[:80])
  sys.exit(7)

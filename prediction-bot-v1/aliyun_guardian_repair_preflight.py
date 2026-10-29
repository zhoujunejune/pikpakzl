#!/usr/bin/env python3
"""Read-only remote preflight for GUARDIAN5 production repair. No service mutations."""
import base64,os,time,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -euo pipefail
ROOT=/opt/zl-prediction-live/src/railway-diagnostic
echo GUARDIAN_REPAIR_PREFLIGHT_BEGIN
for s in zl-prediction-trade zl-prediction-risk-exits zl-prediction-guardian-analysis;do
 echo UNIT=$s
 systemctl is-active "$s" || true
 systemctl show "$s" -p FragmentPath -p WorkingDirectory -p MainPID -p ExecStart --value | sed -E 's/(ACCESS_KEY|SECRET|TOKEN|PASSWORD)[^ ]*/[REDACTED]/Ig'
done
echo GENERATED_TRADE_FILE
if test -f "$ROOT/trade-control-fixed.mjs";then
 sha256sum "$ROOT/trade-control-fixed.mjs" | cut -d' ' -f1
 grep -Fc 'guardianRiskReady' "$ROOT/trade-control-fixed.mjs" || true
else echo MISSING;fi
python3 - <<'PY'
import json,urllib.request,os,datetime
root='/var/lib/zl-prediction/rounds'
for x in ('risk-control.json','risk-runtime-status.json','risk-worker-health.json'):
 p=os.path.join(root,x)
 try:
  j=json.load(open(p))
  allowed=('at','enabled','workerRunning','workerPid','pid','configApplied','transitioning','guardianDynamicExitEnabled','takeProfitEnabled','takeProfitPercent','stopLossEnabled','stopLossPercent','lastSuccessfulPositionsAt','positionsSeen')
  print('RISK_FILE',x,{k:j.get(k) for k in allowed if k in j})
 except Exception as e:print('RISK_FILE_ERROR',x,type(e).__name__)
try:
 with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as resp:s=json.load(resp)
 print('TRADE_STATUS',{k:s.get(k) for k in ['ok','enabled','orderSignalModel','orderSignalModelReady','guardianRiskReady','guardianExecutionReady','pendingAction']})
 print('LAST_ORDER_STATE',s.get('lastOrder',{}).get('state') if isinstance(s.get('lastOrder'),dict) else None)
except Exception as e:print('TRADE_STATUS_ERROR',type(e).__name__)
PY
echo GUARDIAN_REPAIR_PREFLIGHT_END
"""
c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
req=sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
 type='RunShellScript',name='guardian-repair-readonly-preflight',
 command_content=SCRIPT,working_user='root',timeout=80)
call=c.run_command(req).body.invoke_id
for _ in range(40):
 time.sleep(2)
 d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=call)).body.invocation_result
 if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
  try:out=base64.b64decode(d.output or '',validate=True).decode('utf-8','replace')
  except Exception:out='OUTPUT_UNAVAILABLE'
  print('GUARDIAN_REPAIR_PREFLIGHT',d.invocation_status,d.exit_code)
  print(out[-13000:])
  sys.exit(0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'GUARDIAN_REPAIR_PREFLIGHT_END' in out else 5)
print('GUARDIAN_REPAIR_PREFLIGHT_TIMEOUT');sys.exit(6)

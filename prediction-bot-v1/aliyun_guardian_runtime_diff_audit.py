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

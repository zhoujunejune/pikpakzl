#!/usr/bin/env python3
"""Guarded GUARDIAN5 fixed-only production repair: follow OFF, zero live orders, rollback."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
umask 077
REV=__REV__
ROOT=/opt/zl-prediction-live/src/railway-diagnostic
NODE=/opt/zl-prediction-node/bin/node
BACK=/var/backups/guardian-fixed-repair-$(date -u +%Y%m%dT%H%M%SZ)-$$
WORK=$(mktemp -d /tmp/guardian-repair-XXXXXXXX)
FILES="index.mjs wrapper.mjs guardian-fixed-readiness.mjs guardian-live-bridge.mjs risk-runner.mjs risk-worker.mjs risk-config-storage.mjs control-shell.mjs guardian-main-dashboard.mjs"
changed=0
committed=0
mkdir -p -m 0700 "$BACK"
rollback(){
 code=$?
 trap - EXIT
 if test "$changed" = 1 && test "$committed" = 0; then
   echo GUARDIAN_REPAIR_ROLLBACK_BEGIN=true
   for f in $FILES trade-control-fixed.mjs;do
     if test -f "$BACK/$f.absent";then rm -f "$ROOT/$f";
     elif test -f "$BACK/$f";then cp -p "$BACK/$f" "$ROOT/$f";fi
   done
   systemctl restart zl-prediction-risk-exits || true
   systemctl restart zl-prediction-trade || true
   echo GUARDIAN_REPAIR_ROLLBACK_COMPLETE=true
 fi
 rm -rf "$WORK"
 exit "$code"
}
trap rollback EXIT
test "$(id -u)" = 0
test -x "$NODE" && test -d "$ROOT"
for s in zl-prediction-trade zl-prediction-risk-exits zl-prediction-guardian-analysis;do
 systemctl is-active --quiet "$s"
done
systemctl show zl-prediction-trade -p ExecStart --value | grep -Fq 'panel-stats-shell.mjs'
grep -Fq "['control-shell.mjs']" "$ROOT/panel-stats-shell.mjs"
grep -Fq "['wrapper.mjs']" "$ROOT/control-shell.mjs"
check_idle(){
 python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=8) as r:s=json.load(r)
assert s.get('ok') is True,'STATUS_UNAVAILABLE'
assert s.get('enabled') is False,'FOLLOWING_MUST_BE_OFF'
assert not s.get('pendingAction'),'PENDING_ORDER_ABORT'
assert s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1','MODEL_CHANGED_ABORT'
o=s.get('lastOrder') or {}
assert not isinstance(o,dict) or o.get('state') not in ('SUBMISSION_UNKNOWN','RECONCILIATION_REQUIRED','SUBMITTING'),'UNCERTAIN_ORDER_ABORT'
print('GUARDIAN_REPAIR_FOLLOW_OFF=true')
PY
}
check_risk(){
 python3 - "$1" <<'PY'
import datetime,json,sys,pathlib
phase=sys.argv[1]
root=pathlib.Path('/var/lib/zl-prediction/rounds')
c=json.loads((root/'risk-control.json').read_text())
r=json.loads((root/'risk-runtime-status.json').read_text())
h=json.loads((root/'risk-worker-health.json').read_text())
now=datetime.datetime.now(datetime.timezone.utc)
def fresh(x,seconds):
 try:age=(now-datetime.datetime.fromisoformat(str(x).replace('Z','+00:00'))).total_seconds();return 0<=age<=seconds
 except:return False
assert c.get('takeProfitEnabled') is True and c.get('stopLossEnabled') is True,'FIXED_TPSL_OFF'
assert float(c.get('takeProfitPercent',-1))==95 and float(c.get('stopLossPercent',-1))==85,'USER_RISK_CONFIG_CHANGED'
assert r.get('workerRunning') is True and r.get('configApplied') is True,'RISK_WORKER_DOWN'
assert r.get('transitioning') is not True,'RISK_TRANSITION'
assert fresh(r.get('at'),10) and fresh(h.get('at'),10),'RISK_STATUS_STALE'
assert fresh(h.get('lastSuccessfulPositionsAt'),18),'POSITIONS_NOT_READ_RECENTLY'
assert h.get('positionsSeen')==0,'ACTIVE_POSITION_ABORT'
assert h.get('pid')==r.get('workerPid'),'WRONG_WORKER_PID'
if phase=='after':assert r.get('guardianDynamicExitEnabled') is False,'DYNAMIC_EXIT_STILL_ON'
print('GUARDIAN_REPAIR_RISK_'+phase.upper()+'=PASS','TP',c['takeProfitPercent'],'SL',c['stopLossPercent'])
PY
}
check_idle
check_risk before
echo GUARDIAN_REPAIR_STAGE_BEGIN=true
mkdir -p "$WORK/stage"
find "$ROOT" -maxdepth 1 -type f -name '*.mjs' -exec cp -p {} "$WORK/stage/" \;
for f in $FILES;do
 curl -fsSL --retry 2 --max-time 25 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$REV/railway-diagnostic/$f" -o "$WORK/stage/$f"
 "$NODE" --check "$WORK/stage/$f"
done
python3 - "$WORK/stage" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1]);code=(root/'wrapper.mjs').read_text()
needle='await import(generatedModuleUrl.href);'
assert code.count(needle)==1,'WRAPPER_GENERATOR_ANCHOR_CHANGED'
(root/'wrapper-check.mjs').write_text(code.replace(needle,"console.log('GUARDIAN_RUNTIME_COMPILED=true');"))
PY
"$NODE" "$WORK/stage/wrapper-check.mjs"
"$NODE" --check "$WORK/stage/trade-control-fixed.mjs"
grep -Fq 'guardianRiskReady: guardianRuntimeReadiness.ready' "$WORK/stage/trade-control-fixed.mjs"
grep -Fq 'guardianExecutionReady: guardianRuntimeReadiness.ready' "$WORK/stage/trade-control-fixed.mjs"
echo GUARDIAN_REPAIR_STAGED_GENERATOR_PASS=true
for f in $FILES trade-control-fixed.mjs;do
 if test -f "$ROOT/$f";then cp -p "$ROOT/$f" "$BACK/$f";else touch "$BACK/$f.absent";fi
done
systemctl cat zl-prediction-trade > "$BACK/trade-unit.txt"
systemctl cat zl-prediction-risk-exits > "$BACK/risk-unit.txt"
sha256sum "$BACK"/*.mjs > "$BACK/old-sha256.txt" || true
check_idle
check_risk before
changed=1
for f in risk-runner.mjs risk-worker.mjs risk-config-storage.mjs;do install -m 0644 "$WORK/stage/$f" "$ROOT/$f";done
systemctl restart zl-prediction-risk-exits
risk_ok=0
for i in $(seq 1 26);do
 if systemctl is-active --quiet zl-prediction-risk-exits && check_risk after;then risk_ok=1;break;fi
 sleep 1
done
test "$risk_ok" = 1
check_idle
for f in index.mjs wrapper.mjs guardian-fixed-readiness.mjs guardian-live-bridge.mjs control-shell.mjs guardian-main-dashboard.mjs;do
 install -m 0644 "$WORK/stage/$f" "$ROOT/$f"
done
systemctl restart zl-prediction-trade
ok=0
for i in $(seq 1 30);do
 if systemctl is-active --quiet zl-prediction-trade && \
    curl -fsS --max-time 4 http://127.0.0.1:13001/api/status -o "$WORK/status.json" 2>/dev/null;then
  if python3 - "$WORK/status.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
assert s.get('ok') is True
assert s.get('enabled') is False and not s.get('pendingAction')
assert s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1'
assert s.get('orderSignalModelReady') is True
assert s.get('guardianRiskReady') is True,s.get('guardianRiskBlockReason')
assert s.get('guardianExecutionReady') is True,s.get('guardianExecutionBlockReason')
print('GUARDIAN_REPAIR_TRADE_GATE_PASS=true')
PY
  then ok=1;break;fi
 fi
 sleep 2
done
test "$ok" = 1
check_idle
check_risk after
systemctl is-active --quiet zl-prediction-guardian-analysis
"$NODE" --check "$ROOT/trade-control-fixed.mjs"
sha256sum "$ROOT"/{index.mjs,wrapper.mjs,guardian-fixed-readiness.mjs,risk-runner.mjs,risk-worker.mjs,trade-control-fixed.mjs} | cut -c1-88
committed=1
echo GUARDIAN_REPAIR_PRODUCTION_DEPLOYED=true
echo GUARDIAN_REPAIR_FOLLOW_OWNER_OFF=true
echo GUARDIAN_REPAIR_NO_LIVE_ORDERS=true
echo GUARDIAN_REPAIR_BACKUP="$BACK"
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!='fix/guardian5-fixed-only-readiness-20261029' or not re.fullmatch('[a-f0-9]{40}',sha):
  print('GUARDIAN_REPAIR_BAD_RELEASE_REF');return 2
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 req=sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',type='RunShellScript',
  name='guardian-fixed-only-repair',command_content=REMOTE.replace('__REV__',sha),
  working_user='root',timeout=300)
 invoke=client.run_command(req).body.invoke_id
 for i in range(150):
  time.sleep(2)
  result=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=invoke)).body.invocation_result
  if result and str(result.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(result.output or '',validate=True).decode('utf8','replace')
   except Exception:out='OUTPUT_UNAVAILABLE'
   print('GUARDIAN_REPAIR_REMOTE',result.invocation_status,result.exit_code)
   print(out[-15000:])
   return 0 if str(result.invocation_status)=='Success' and int(result.exit_code)==0 and 'GUARDIAN_REPAIR_PRODUCTION_DEPLOYED=true' in out else 5
 print('GUARDIAN_REPAIR_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

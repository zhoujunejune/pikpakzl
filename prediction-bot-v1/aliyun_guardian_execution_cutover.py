#!/usr/bin/env python3
"""Guarded GUARDIAN5 production cutover: patch only model gates; preserve live order engine."""
import base64, os, re, sys, time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
REV=__REV__
ROOT=/opt/zl-prediction-live/src/railway-diagnostic
NODE=/opt/zl-prediction-node/bin/node
WORK=$(mktemp -d /tmp/guardian5-cutover.XXXXXXXX)
BACK=/var/backups/guardian5-cutover-$(date -u +%Y%m%dT%H%M%SZ)-$$
changed=0
committed=0
mkdir -p -m 0700 "$BACK"
cleanup(){
  if test "$changed" = 1 && test "$committed" = 0;then
    cp -p "$BACK/guardian-live-bridge.mjs" "$ROOT/guardian-live-bridge.mjs"
    cp -p "$BACK/wrapper.mjs" "$ROOT/wrapper.mjs"
    cp -p "$BACK/risk-runner.mjs" "$ROOT/risk-runner.mjs"
    systemctl restart zl-prediction-risk-exits || true
    systemctl restart zl-prediction-trade || true
    echo GUARDIAN_CUTOVER_ROLLBACK_COMPLETED=true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
test -x "$NODE"
test -f "$ROOT/wrapper.mjs" && test -f "$ROOT/guardian-live-bridge.mjs"
check_idle(){
python3 - <<'PY'
import json,sys,urllib.request
try:
 with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=6) as r: d=json.load(r)
except Exception as e:print('GUARDIAN_CUTOVER_STATUS_UNAVAILABLE',type(e).__name__);sys.exit(9)
if d.get('ok') is not True or d.get('enabled') is not False or d.get('pendingAction'):
 print('GUARDIAN_CUTOVER_ACTIVE_OR_PENDING_ABORT');sys.exit(10)
if d.get('orderSignalModel')!='ZL_GUARDIAN_5M_V1':
 print('GUARDIAN_CUTOVER_MODEL_NOT_SELECTED_ABORT');sys.exit(11)
print('GUARDIAN_CUTOVER_TRADE_IDLE=true')
PY
}
check_risk(){
python3 - "$1" <<'PY'
import pathlib,json,datetime,sys
phase=sys.argv[1]; root=pathlib.Path('/var/lib/zl-prediction/rounds')
try:
 r=json.loads((root/'risk-runtime-status.json').read_text())
 h=json.loads((root/'risk-worker-health.json').read_text())
 c=json.loads((root/'risk-control.json').read_text())
 now=datetime.datetime.now(datetime.timezone.utc)
 def recent(x,sec):
  if isinstance(x,(float,int)): return 0 <= now.timestamp()-(x/1000 if x>1e11 else x)<sec
  return 0 <= (now-datetime.datetime.fromisoformat(str(x).replace('Z','+00:00'))).total_seconds()<sec
 assert c.get('takeProfitEnabled') is True and c.get('stopLossEnabled') is True,'FIXED_TP_SL_NOT_BOTH_ENABLED'
 assert 1<=float(c.get('takeProfitPercent',0))<=100 and 1<=float(c.get('stopLossPercent',0))<=100,'FIXED_TP_SL_INVALID_PERCENT'
 assert r.get('workerRunning') is True and r.get('configApplied') is True and r.get('enabled') is True,'RISK_WORKER_NOT_READY'
 assert recent(r.get('at'),9) and recent(h.get('lastSuccessfulPositionsAt'),16),'RISK_HEARTBEAT_STALE'
 assert h.get('positionsSeen')==0,'OPEN_POSITIONS_ABORT'
 if phase=='after':
  assert r.get('guardianDynamicExitEnabled') is False,'DYNAMIC_EXIT_NOT_RETIRED'
  assert r.get('transitioning') is not True,'RISK_TRANSITIONING'
 print('GUARDIAN_FIXED_RISK_VERIFIED',phase,'TP',c.get('takeProfitPercent'),'SL',c.get('stopLossPercent'),'dynamic',r.get('guardianDynamicExitEnabled'))
except Exception as e:
 print('GUARDIAN_FIXED_RISK_BLOCKED',phase,type(e).__name__,str(e)[:90]);sys.exit(12)
PY
}
check_idle
check_risk before
for f in wrapper.mjs guardian-live-bridge.mjs risk-runner.mjs;do
  cp -p "$ROOT/$f" "$BACK/$f"
  curl -fsSL --retry 2 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$REV/railway-diagnostic/$f" -o "$WORK/new-$f"
  "$NODE" --check "$WORK/new-$f"
done
python3 - "$WORK" "$ROOT" <<'PY'
from pathlib import Path
import sys,re
w=Path(sys.argv[1]);root=Path(sys.argv[2])
live=(root/'guardian-live-bridge.mjs').read_text()
new=(w/'new-guardian-live-bridge.mjs').read_text()
marker='export function guardianOrderSignal('
assert live.count(marker)==1 and new.count(marker)==1,'GUARDIAN_ADAPTER_MARKER_MISMATCH'
# Keep runtime-specific registry / persistence implementation unchanged.
live_tail=live[live.index(marker):]
assert live_tail.count('export function guardianQuoteGate(')==1,'GUARDIAN_QUOTE_EXPORT_MISMATCH'
assert len(re.findall(r'^export (?:function|const) ',live_tail,re.M))==2,'GUARDIAN_UNEXPECTED_EXPORTS_ABORT'
assert 'stats.settled>=300' in live_tail and 'round+FIVE_MIN-now<25000' in live_tail,'GUARDIAN_LIVE_GATE_UNKNOWN_ABORT'
out=live[:live.index(marker)]+new[new.index(marker):]
(w/'patch-guardian-live-bridge.mjs').write_text(out)
old=(root/'wrapper.mjs').read_text()
next_src=(w/'new-wrapper.mjs').read_text()
for text in ['function guardianExitMonitorReady(now=Date.now()) {','let autoConfirmHalted = false;',
  'const GUARDIAN_ORDER_DEADLINE_MS = 275000;',
  'currentRetry.direction!==p.signal']:
 assert old.count(text)==1,('GUARDIAN_WRAPPER_MARKER_MISMATCH',text)
helper='function guardianRiskState(paths) {'
assert next_src.count(helper)==1,'GUARDIAN_NEW_READY_HELPER_MISSING'
start=old.index('function guardianExitMonitorReady(now=Date.now()) {')
end=old.index('let autoConfirmHalted = false;',start)
replacement=next_src[next_src.index(helper):next_src.index('let autoConfirmHalted = false;',next_src.index(helper))]
out=old[:start]+replacement+old[end:]
out=out.replace('const GUARDIAN_ORDER_DEADLINE_MS = 275000;','const GUARDIAN_ORDER_DEADLINE_MS = 300000;',1)
out=out.replace('currentRetry.direction!==p.signal','currentRetry.direction!==p.productionSignal',1)
out=out.replace('GUARDIAN距离结算不足25秒，本轮不再下单',
 'GUARDIAN该轮次已结束或交易所报价失效，本轮不再下单')
out=out.replace('GUARDIAN动态卖出监控未验收，或真实盘口优势不足，未下单',
 'GUARDIAN卖出监控不可用，或交易所报价无效，未下单')
assert 'GUARDIAN_ORDER_DEADLINE_MS = 300000' in out
assert out.count('function guardianExitMonitorReady(')==1
(w/'patch-wrapper.mjs').write_text(out)
print('GUARDIAN_CUTOVER_TARGETED_PATCH_READY=true')
PY
for f in wrapper.mjs guardian-live-bridge.mjs;do "$NODE" --check "$WORK/patch-$f";done
test "$(grep -Fc "GUARDIAN_DYNAMIC_EXIT_ENABLED:'false'" "$WORK/new-risk-runner.mjs")" = 1
test "$(grep -Fc 'dynamicExitEnabled: false' "$WORK/new-risk-runner.mjs")" = 2
"$NODE" --check "$WORK/new-risk-runner.mjs"
check_idle
check_risk before
changed=1
cp "$WORK/new-risk-runner.mjs" "$ROOT/risk-runner.mjs"
chown --reference="$BACK/risk-runner.mjs" "$ROOT/risk-runner.mjs"
chmod --reference="$BACK/risk-runner.mjs" "$ROOT/risk-runner.mjs"
systemctl restart zl-prediction-risk-exits
risk_healthy=0
for n in $(seq 1 22);do
 if systemctl is-active --quiet zl-prediction-risk-exits && check_risk after;then risk_healthy=1;break;fi
 sleep 1
done
test "$risk_healthy" = 1
check_idle
for f in guardian-live-bridge.mjs wrapper.mjs;do
  cp "$WORK/patch-$f" "$ROOT/$f"
  chown --reference="$BACK/$f" "$ROOT/$f"
  chmod --reference="$BACK/$f" "$ROOT/$f"
done
"$NODE" --check "$ROOT/wrapper.mjs"
"$NODE" --check "$ROOT/guardian-live-bridge.mjs"
check_idle
check_risk after
systemctl restart zl-prediction-trade
healthy=0
for n in $(seq 1 18);do
  if systemctl is-active --quiet zl-prediction-trade && curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$WORK/status.json" 2>/dev/null;then
    if python3 - "$WORK/status.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
assert s.get('ok') and s.get('enabled') is False
assert s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1'
assert not s.get('pendingAction')
assert s.get('guardianRiskReady') is True,'FIXED_EXIT_READINESS_NOT_CONFIRMED'
PY
    then healthy=1;break;fi
  fi
  sleep 2
done
test "$healthy" = 1
check_risk after
committed=1
echo GUARDIAN_CUTOVER_PRODUCTION_DEPLOYED=true
echo GUARDIAN_FIXED_ONLY_RISK_ACTIVE=true
echo GUARDIAN_CUTOVER_FOLLOW_OWNER_OFF=true
echo GUARDIAN_CUTOVER_BACKUP="$BACK"
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[0-9a-f]{40}',sha):
  print('GUARDIAN_BAD_RELEASE_REVISION');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 invoke=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
 instance_id='b67374069bb3457ba6a3a2ede9305d3f',type='RunShellScript',
 name='guardian5-selective-production-cutover',command_content=REMOTE.replace('__REV__',sha),
 working_user='root',timeout=190)).body.invoke_id
 for _ in range(90):
  time.sleep(2)
  d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=invoke)).body.invocation_result
  if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
   except Exception:out='OUTPUT_UNAVAILABLE'
   print('GUARDIAN_CUTOVER',d.invocation_status,d.exit_code)
   print(out[-11000:])
   return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'GUARDIAN_CUTOVER_PRODUCTION_DEPLOYED=true' in out else 5
 print('GUARDIAN_CUTOVER_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

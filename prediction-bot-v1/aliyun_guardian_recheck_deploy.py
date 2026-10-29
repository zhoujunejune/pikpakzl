#!/usr/bin/env python3
"""Deploy a bounded GUARDIAN lost-signal revalidation fix to Alibaba SWAS.
No trade API calls; refuse while follow is active, orders pending or positions open.
"""
import os
import base64
import re
import sys
import time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
REV=__REV__
ROOT=/opt/zl-prediction-live/src/railway-diagnostic
DEST="$ROOT/wrapper.mjs"
NODE=/opt/zl-prediction-node/bin/node
TMP=$(mktemp -d /tmp/guardian-recheck-XXXXXXXX)
BACK=/var/backups/guardian-recheck-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 0700 "$BACK"
CHANGED=0
DONE=0
cleanup(){
 if test "$CHANGED" = 1 && test "$DONE" = 0;then
  cp -p "$BACK/wrapper.mjs" "$DEST"
  systemctl restart zl-prediction-trade || true
  echo GUARDIAN_RECHECK_ROLLED_BACK=true
 fi
 rm -rf "$TMP"
}
trap cleanup EXIT
test -x "$NODE" && test -r "$DEST"
for unit in zl-prediction-trade zl-prediction-risk-exits zl-prediction-guardian-analysis;do
 systemctl is-active --quiet "$unit"
done
preflight(){
python3 - <<'PY'
import json,urllib.request,pathlib,datetime
def get(url):
 with urllib.request.urlopen(url,timeout=5) as r:return json.load(r)
s=get('http://127.0.0.1:13001/api/status')
assert s.get('ok') is True,'TRADE_STATUS_UNAVAILABLE'
assert s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1','WRONG_PRODUCTION_MODEL'
assert s.get('guardianRiskReady') is True and s.get('guardianExecutionReady') is True,'EXIT_OR_ENTRY_NOT_READY'
assert s.get('enabled') is False,'FOLLOW_ENABLED_ABORT'
p=s.get('pendingAction') or {}
assert p.get('state') not in ('READY','QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN'),'PENDING_ORDER_ABORT'
l=s.get('lastOrder') or {}
assert l.get('state') not in ('SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN','QUOTING'),'UNRECONCILED_ORDER_ABORT'
root=pathlib.Path('/var/lib/zl-prediction/rounds')
risk=json.loads((root/'risk-runtime-status.json').read_text())
health=json.loads((root/'risk-worker-health.json').read_text())
cfg=json.loads((root/'risk-control.json').read_text())
assert risk.get('workerRunning') is True and risk.get('configApplied') is True,'RISK_WORKER_UNREADY'
assert cfg.get('stopLossEnabled') is True,'EXISTING_STOP_LOSS_MUST_BE_ON'
assert health.get('positionsSeen')==0,'OPEN_POSITION_ABORT'
print('GUARDIAN_RECHECK_PREFLIGHT_PASS=true')
PY
}
preflight
cp -p "$DEST" "$BACK/wrapper.mjs"
curl -fsSL --max-time 25 --retry 2 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$REV/railway-diagnostic/wrapper.mjs" -o "$TMP/reference.mjs"
curl -fsSL --max-time 25 --retry 2 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$REV/railway-diagnostic/guardian-submit-recheck.test.mjs" -o "$TMP/guardian-submit-recheck.test.mjs"
python3 - "$DEST" "$TMP/reference.mjs" "$TMP/wrapper.mjs" <<'PY'
from pathlib import Path
import sys
live=Path(sys.argv[1]).read_text()
new=Path(sys.argv[2]).read_text()
helper='  // GUARDIAN_RECHECK_V2: retry only a missing fresh read;'
marker='  // Overlap independent signal revalidation and fresh quote retrieval.'
assert new.count(helper)==1 and new.count(marker)==1,'REFERENCE_HELPER_NOT_FOUND'
assert live.count(marker)==1 and live.count(helper)==0,'LIVE_WRAPPER_UNEXPECTED'
chunk=new[new.index(helper):new.index(marker)]
old_call='''  let [current, freshQuote] = await Promise.all([
    getSignal({ forceHttp: true }), getFreshQuote(p._internal),
  ]);
'''
call_end="  if (!selectedSignalMatches(p) || !current || current.status !== 'LOCKED'"
assert new.count(old_call)==1 and new.count(call_end)==1
call_new=new[new.index(old_call):new.index(call_end)]
old_guard='''(current.upstreamModel!==GUARDIAN_ID||current.signalId!==p.signalId||
         current.executionEligible!==true||current.direction!==p.signal))) {'''
new_guard='''(current.upstreamModel!==GUARDIAN_ID||current.signalId!==p.signalId||
         current.executionEligible!==true||current.direction!==p.productionSignal||
         mappedOrderSignal(current).orderSignal!==p.signal))) {'''
old_log='''      currentStatus: current?.status ?? null,
      source,'''
new_log='''      currentStatus: current?.status ?? null,
      currentSignalIdMatches:current?.signalId===p.signalId,
      currentUpstreamModel:current?.upstreamModel??null,
      recheckRetries:guardianRecheckRetries,
      source,'''
for key in ('current.upstreamModel!==GUARDIAN_ID','submit_blocked_signal_changed','currentStatus: current?.status'):
 ix=live.find(key)
 print('GUARDIAN_RECHECK_LIVE_CONTEXT',key,repr(live[max(0,ix-290):ix+490])[:1200] if ix>=0 else 'NOT_PRESENT')
for text,expected in [(old_call,1),(old_log,1),(new_guard,1),(new_log,0)]:
 assert live.count(text)==expected,('LIVE_ANCHOR_MISMATCH',text[:45],live.count(text))
assert new.count(new_guard)==1 and new.count(new_log)==1
patched=live.replace(marker,chunk+marker,1)
patched=patched.replace(old_call,call_new,1)
patched=patched.replace(old_log,new_log,1)
assert 'guardianRetryMissingSignal' in patched and 'signalIdMatches' in patched,'PATCH_INCOMPLETE'
Path(sys.argv[3]).write_text(patched)
print('GUARDIAN_RECHECK_STAGE_PATCH_OK=true')
PY
"$NODE" --check "$TMP/wrapper.mjs"
"$NODE" --test "$TMP/guardian-submit-recheck.test.mjs"
preflight
cp -p "$TMP/wrapper.mjs" "$DEST"
chown --reference="$BACK/wrapper.mjs" "$DEST"
chmod --reference="$BACK/wrapper.mjs" "$DEST"
CHANGED=1
systemctl restart zl-prediction-trade
READY=0
for i in $(seq 1 20);do
 if curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$TMP/status.json" 2>/dev/null;then
  if python3 - "$TMP/status.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
assert s.get('ok') is True
assert s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1'
assert s.get('guardianRiskReady') is True and s.get('guardianExecutionReady') is True
assert s.get('enabled') is False and not s.get('pendingAction')
print('GUARDIAN_RECHECK_RUNTIME_PASS=true')
PY
  then READY=1;break;fi
 fi
 sleep 2
done
test "$READY" = 1
cmp -s "$DEST" "$TMP/wrapper.mjs"
systemctl is-active --quiet zl-prediction-risk-exits
systemctl is-active --quiet zl-prediction-guardian-analysis
DONE=1
echo GUARDIAN_RECHECK_ALIYUN_DEPLOYED=true
echo GUARDIAN_RECHECK_NO_REAL_ORDERS=true
echo GUARDIAN_RECHECK_OWNER_REARM_REQUIRED=true
echo GUARDIAN_RECHECK_BACKUP="$BACK"
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch(r'[a-f0-9]{40}',sha):
  print('GUARDIAN_RECHECK_INVALID_REF');return 2
 c=Client(api.Config(
  access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 i=c.run_command(sw.RunCommandRequest(
  region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  type='RunShellScript',name='guardian-recheck-bounded-retry-fix',
  command_content=REMOTE.replace('__REV__',sha),working_user='root',timeout=170)).body.invoke_id
 for _ in range(95):
  time.sleep(2)
  d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   invoke_id=i)).body.invocation_result
  if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
   except Exception:out='OUTPUT_UNAVAILABLE'
   print('GUARDIAN_RECHECK_REMOTE',d.invocation_status,d.exit_code)
   print(out[-9500:])
   return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'GUARDIAN_RECHECK_ALIYUN_DEPLOYED=true' in out else 5
 print('GUARDIAN_RECHECK_TIMEOUT');return 6
if __name__=='__main__':
 sys.exit(main())

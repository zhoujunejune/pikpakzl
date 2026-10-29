#!/usr/bin/env python3
"""Guarded Alibaba SWAS MPC quote -9000 hotfix. No real order submission."""
import os,base64,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
REV=__REV__
ROOT=/opt/zl-prediction-live/src/railway-diagnostic
DEST="$ROOT/payment-source-priority.mjs"
NODE=/opt/zl-prediction-node/bin/node
TMP=$(mktemp -d /tmp/guardian-mpc9000-XXXXXXXX)
BACK=/var/backups/guardian-mpc9000-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 0700 "$BACK"
CHANGED=0
COMPLETE=0
cleanup(){
 if test "$CHANGED" = 1 && test "$COMPLETE" = 0;then
  cp -p "$BACK/payment-source-priority.mjs" "$DEST"
  systemctl restart zl-prediction-trade || true
  echo MPC9000_ROLLED_BACK=true
 fi
 rm -rf "$TMP"
}
trap cleanup EXIT
test -r "$DEST" && test -x "$NODE"
for name in zl-prediction-trade zl-prediction-risk-exits zl-prediction-guardian-analysis;do systemctl is-active --quiet "$name";done
check(){
python3 - <<'PY'
import json,datetime,urllib.request,pathlib
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=5) as r:s=json.load(r)
assert s.get('ok') is True and s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1','TRADE_MODEL_UNREADY'
assert s.get('guardianRiskReady') is True and s.get('guardianExecutionReady') is True,'RISK_OR_EXECUTION_NOT_READY'
p=s.get('pendingAction') or {}
now=int(datetime.datetime.now(datetime.timezone.utc).timestamp()*1000)
if p.get('round') is not None and int(p['round'])>=now//300000*300000-300000:
 assert p.get('state') not in ('READY','QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN'),'PENDING_ORDER'
last=s.get('lastOrder') or {}
assert last.get('state') not in ('SUBMISSION_UNKNOWN','SUBMITTED_PENDING_CONFIRMATION','SUBMITTING','QUOTING'),'ORDER_NOT_RECONCILED'
root=pathlib.Path('/var/lib/zl-prediction/rounds')
r=json.loads((root/'risk-runtime-status.json').read_text())
h=json.loads((root/'risk-worker-health.json').read_text())
c=json.loads((root/'risk-control.json').read_text())
assert r.get('workerRunning') is True and r.get('configApplied') is True,'EXIT_MONITOR_UNREADY'
assert c.get('takeProfitEnabled') is True and c.get('stopLossEnabled') is True,'FIXED_EXITS_DISABLED'
assert h.get('positionsSeen')==0,'OPEN_POSITION_DEPLOY_ABORT'
print('MPC9000_PREFLIGHT_PASS',s.get('enabled'))
PY
}
check
cp -p "$DEST" "$BACK/payment-source-priority.mjs"
curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$REV/railway-diagnostic/payment-source-priority.mjs" -o "$TMP/new.mjs"
python3 - "$DEST" "$TMP/new.mjs" "$TMP/patch.mjs" <<'PY'
from pathlib import Path
import sys
old=Path(sys.argv[1]).read_text(); new=Path(sys.argv[2]).read_text()
marker="  return /insufficient.{0,70}(?:balance|funds?|usdt)|"
guard="""  // Binance Prediction quote HTTP 400 / -9000: MPC funds are unavailable.
  // Exact message and code only; never treat unrelated -9000, network, 5xx or 451 as safe fallback.
  if (Number(call.code ?? call.data?.code) === -9000 &&
      /^please ensure your account has enough usdt\\.?$/.test(message.trim())) return true;
"""
assert old.count(marker)==1 and new.count(marker)==1 and new.count(guard)==1,'PATCH_ANCHOR_INVALID'
assert old.count(guard)==0,'ALREADY_PATCHED'
patched=old.replace(marker,guard+marker,1)
assert patched.replace(guard,'')==old,'OTHER_CODE_CHANGED'
Path(sys.argv[3]).write_text(patched)
print('MPC9000_PATCH_STAGE_OK=true')
PY
"$NODE" --check "$TMP/patch.mjs"
"$NODE" --input-type=module - "$TMP/patch.mjs" <<'JS'
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {explicitMpcInsufficient,eligibleSpotFallback}=await import(pathToFileURL(process.argv[2]).href);
const call={ok:false,httpStatus:400,code:-9000,error:'Please ensure your account has enough USDT.'};
assert.equal(explicitMpcInsufficient(call),true);
for(const x of [{...call,httpStatus:500},{...call,httpStatus:451},{...call,code:-9001},{...call,network:true}])assert.equal(explicitMpcInsufficient(x),false);
assert.deepEqual(eligibleSpotFallback({ok:true,items:[{accountType:'SPOT',availableBalanceDisplay:'10.00',enabled:true}]},1),
 {displayAccount:'SPOT',accountType:'SPOT',fundingSource:'CEX'});
console.log('MPC9000_REMOTE_TEST_PASS=true');
JS
check
cp -p "$TMP/patch.mjs" "$DEST"
chown --reference="$BACK/payment-source-priority.mjs" "$DEST"
chmod --reference="$BACK/payment-source-priority.mjs" "$DEST"
CHANGED=1
systemctl restart zl-prediction-trade
READY=0
for i in $(seq 1 20);do
 if curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$TMP/status.json" 2>/dev/null;then
  if python3 - "$TMP/status.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
assert s.get('ok') is True and s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1'
assert s.get('guardianRiskReady') is True and s.get('guardianExecutionReady') is True
assert s.get('enabled') is False and not s.get('pendingAction')
print('MPC9000_RUNTIME_PASS=true')
print('MPC9000_REARM_REQUIRED=true')
PY
  then READY=1;break;fi
 fi
 sleep 2
done
test "$READY" = 1
cmp -s "$DEST" "$TMP/patch.mjs"
systemctl is-active --quiet zl-prediction-risk-exits
COMPLETE=1
echo MPC9000_ALIYUN_DEPLOYED=true
echo MPC9000_NO_REAL_ORDERS=true
echo MPC9000_BACKUP="$BACK"
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 i=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  type='RunShellScript',name='guardian-mpc9000-spot-fallback-hotfix',
  command_content=REMOTE.replace('__REV__',sha),working_user='root',timeout=160)).body.invoke_id
 for _ in range(82):
  time.sleep(2)
  d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=i)).body.invocation_result
  if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
   except Exception:o='OUTPUT_UNAVAILABLE'
   print('MPC9000_REMOTE',d.invocation_status,d.exit_code)
   print(o[-7000:])
   return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'MPC9000_ALIYUN_DEPLOYED=true' in o else 5
 print('MPC9000_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

#!/usr/bin/env python3
"""Guarded, reversible Alibaba SWAS GUARDIAN -9000 quote-capacity repair; no live orders."""
import os,sys,time,base64,re
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
REV=__REV__
ROOT=/opt/zl-prediction-live/src/railway-diagnostic
DEST="$ROOT/wrapper.mjs"
NODE=/opt/zl-prediction-node/bin/node
TMP=$(mktemp -d /tmp/guardian-quote-cap-XXXXXXXX)
BACK=/var/backups/guardian-quote-cap-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 0700 "$BACK"
CHANGED=0; COMPLETE=0
cleanup(){
 if test "$CHANGED" = 1 && test "$COMPLETE" = 0;then
  cp -p "$BACK/wrapper.mjs" "$DEST"
  systemctl restart zl-prediction-trade || :
  echo GUARDIAN_QUOTE_CAP_ROLLED_BACK=true
 fi
 rm -rf "$TMP"
}
trap cleanup EXIT
preflight(){
python3 - <<'PY'
import json,urllib.request,pathlib,subprocess
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=5) as r:s=json.load(r)
assert s.get('ok') is True and s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1','GUARDIAN_NOT_SELECTED'
assert s.get('enabled') is False,'FOLLOW_ENABLED_ABORT'
assert s.get('guardianRiskReady') is True and s.get('guardianExecutionReady') is True,'RISK_OR_EXECUTION_UNREADY'
for a in (s.get('pendingAction') or {},s.get('lastOrder') or {}):
 assert a.get('state') not in ('READY','QUOTING','SUBMITTING','SUBMISSION_UNKNOWN','SUBMITTED_PENDING_CONFIRMATION'),'ACTIVE_OR_UNKNOWN_ORDER'
root=pathlib.Path('/var/lib/zl-prediction/rounds')
risk=json.loads((root/'risk-runtime-status.json').read_text())
health=json.loads((root/'risk-worker-health.json').read_text())
cfg=json.loads((root/'risk-control.json').read_text())
assert cfg.get('stopLossEnabled') is True,'STOP_LOSS_NOT_ARMED'
assert risk.get('workerRunning') is True and risk.get('configApplied') is True,'EXIT_NOT_READY'
assert health.get('positionsSeen')==0,'OPEN_POSITION_ABORT'
print('GUARDIAN_QUOTE_CAP_PREFLIGHT_PASS=true',flush=True)
PY
}
for svc in zl-prediction-trade zl-prediction-risk-exits zl-prediction-guardian-analysis;do
 systemctl is-active --quiet "$svc"
done
test -r "$DEST" && test -x "$NODE"
preflight
cp -p "$DEST" "$BACK/wrapper.mjs"
curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$REV/railway-diagnostic/wrapper.mjs" -o "$TMP/repo.mjs"
python3 - "$DEST" "$TMP/repo.mjs" "$TMP/patch.mjs" <<'PY'
from pathlib import Path
import sys
src,repo,out=map(Path,sys.argv[1:])
old=src.read_text();target=repo.read_text()
start='  // GUARDIAN_QUOTE_CAPACITY_V1_BEGIN'
end='  // GUARDIAN_QUOTE_CAPACITY_V1_END'
anchor="  if (!freshQuote.ok) {\n    p.state = isAuto ? 'AUTO_FAILED' : 'READY';"
retry_old="    if(isAuto)retryGuardianBeforePost(p,'FRESH_QUOTE_FAILED_BEFORE_POST');"
retry_new="    if(isAuto && !guardianQuoteSizeError(freshQuote))retryGuardianBeforePost(p,'FRESH_QUOTE_FAILED_BEFORE_POST');"
assert target.count(start)==1 and target.count(end)==1,'REPO_QUOTE_PATCH_MISSING'
snippet=start+target.split(start,1)[1].split(end,1)[0]+end+'\n'
assert old.count('guardianFixedReadiness().ready')>=1,'LIVE_FIXED_RISK_DRIFT'
if old.count(start)==1 and old.count(end)==1 and old.count(retry_new)==1:
 assert old.split(start,1)[1].split(end,1)[0]==target.split(start,1)[1].split(end,1)[0],'PATCH_DIFFERS'
 out.write_text(old)
 print('GUARDIAN_QUOTE_CAP_ALREADY_APPLIED=true',flush=True)
else:
 assert old.count(start)==0 and old.count(end)==0,'PARTIAL_PATCH_DETECTED'
 assert old.count(anchor)==1 and old.count(retry_old)==1,'LIVE_QUOTE_ANCHOR_DRIFT'
 patched=old.replace(anchor,snippet+anchor,1).replace(retry_old,retry_new,1)
 assert patched.replace(snippet,'').replace(retry_new,retry_old)==old,'OTHER_CODE_CHANGED'
 out.write_text(patched)
print('GUARDIAN_QUOTE_CAP_PATCH_STAGE_OK=true',flush=True)
PY
"$NODE" --check "$TMP/patch.mjs"
# Verify the helper in the actual patched file recognizes Binance's exact 4xx
# capacity errors and rejects balance, network, HTTP 5xx, and unknown errors.
"$NODE" --input-type=module - "$TMP/patch.mjs" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const raw=fs.readFileSync(process.argv[2],'utf8');
const start=raw.indexOf('  function guardianQuoteSizeError(q) {');
const end=raw.indexOf('\n  if(!freshQuote.ok && p.signalModelChoice',start);
assert(start>0&&end>start);
const fn=Function(raw.slice(start,end)+';return guardianQuoteSizeError;')();
const call={ok:false,httpStatus:400,code:-9000,error:'Your order amount is too large. Please decrease it to meet the market threshold.'};
assert.equal(fn(call),'TOO_LARGE');
assert.equal(fn({...call,error:'The market lacks enough liquidity for this trade. Please try a smaller amount.'}),'TOO_LARGE');
assert.equal(fn({...call,error:'Your order amount is too small'}),'TOO_SMALL');
for(const x of [{...call,code:-9001},{...call,httpStatus:500},{...call,network:true},{...call,ok:true},{...call,error:'Please ensure your account has enough USDT.'}]) assert.equal(fn(x),null);
assert(raw.includes("for(const pct of [90n,75n])"));
assert(raw.includes("p.configuredAmount=p.amount;"));
console.log('GUARDIAN_QUOTE_CAP_TEST_PASS=true');
JS
preflight
cmp -s "$DEST" "$TMP/patch.mjs" || {
 cp "$TMP/patch.mjs" "$DEST"
 chown --reference="$BACK/wrapper.mjs" "$DEST"
 chmod --reference="$BACK/wrapper.mjs" "$DEST"
 CHANGED=1
 systemctl restart zl-prediction-trade
}
PASS=0
for i in $(seq 1 20);do
 if preflight >/dev/null 2>&1;then PASS=1;break;fi
 sleep 2
done
test "$PASS" = 1
cmp -s "$DEST" "$TMP/patch.mjs"
for svc in zl-prediction-trade zl-prediction-risk-exits zl-prediction-guardian-analysis;do
 systemctl is-active --quiet "$svc"
done
COMPLETE=1
echo GUARDIAN_QUOTE_CAP_ALIYUN_DEPLOYED=true
echo GUARDIAN_QUOTE_CAP_NO_LIVE_ORDER_POST=true
echo GUARDIAN_QUOTE_CAP_OWNER_REARM_REQUIRED=true
echo GUARDIAN_QUOTE_CAP_BACKUP="$BACK"
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 if not (os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID') and os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET')):
  print('ALIYUN_CREDENTIALS_MISSING');return 3
 try:
  c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
   access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
   endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
  invoke=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',type='RunShellScript',
   name='guardian-quote-capacity-repair',command_content=REMOTE.replace('__REV__',sha),
   working_user='root',timeout=170)).body.invoke_id
  for _ in range(95):
   time.sleep(2)
   d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(
     region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
     invoke_id=invoke)).body.invocation_result
   if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    try:output=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
    except Exception:output='OUTPUT_UNAVAILABLE'
    print('QUOTE_CAP_RESULT',d.invocation_status,d.exit_code)
    print(output[-8000:])
    return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'GUARDIAN_QUOTE_CAP_ALIYUN_DEPLOYED=true' in output else 5
  print('QUOTE_CAP_DEPLOY_TIMEOUT');return 6
 except Exception as e:
  print('QUOTE_CAP_DEPLOY_ERROR',type(e).__name__,getattr(e,'code',''));return 7
if __name__=='__main__':sys.exit(main())

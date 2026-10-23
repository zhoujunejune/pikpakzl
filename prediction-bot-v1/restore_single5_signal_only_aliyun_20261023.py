#!/usr/bin/env python3
"""Guarded rollback-capable restore of the original 5s signal-only provider on Alibaba.
Does not edit or restart trader, wallet config, quote path, or risk exits.
"""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

BRANCH='fix/restore-single5-signal-only-20261023'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
NODE=/opt/zl-prediction-node/bin/node
MODEL=/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs
TRADE=/opt/zl-prediction-live/src/railway-diagnostic/index.mjs
test "$(id -u)" -eq 0
test -x "$NODE" && test -f "$MODEL" && test -f "$TRADE"
for unit in zl-prediction-deepseek5 zl-prediction-trade zl-prediction-v3 zl-prediction-risk-exits;do
  test "$(systemctl is-active "$unit")" = active || { echo "SINGLE5_UNIT_UNAVAILABLE=$unit";exit 3; }
done
WORK=$(mktemp -d /tmp/zl-restore5-XXXXXXXX)
trap 'rm -rf "$WORK"' EXIT
curl -fsSL --retry 2 --max-time 22 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/restore_single5_signal_only_20261023.mjs" -o "$WORK/model.mjs"
"$NODE" --check "$WORK/model.mjs"
grep -Fq 'const LIMIT_MS=5000;' "$WORK/model.mjs"
grep -Fq 'clock()<round+4450' "$WORK/model.mjs"
grep -Fq 'const FEED='"'"'http://127.0.0.1:13003/api/shadow-market-fast'"'"';' "$WORK/model.mjs"
grep -Fq "decisionRule:'LIVE_BTC_ONE_CALL_OR_REAL_PRICE_BACKUP_5S'" "$WORK/model.mjs"
test "$(grep -Fc "const ID='DEEPSEEK_5M_V1';" "$WORK/model.mjs")" -eq 1

python3 - <<'PY'
import json,urllib.request,subprocess,hashlib
from pathlib import Path
def get(port,p):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,p),timeout=8) as resp:return json.load(resp)
tr=get(13001,'/api/status')
ai=get(13029,'/api/status')
selection=get(13001,'/api/order-signal-model')
feed=get(13003,'/api/shadow-market-fast')
assert tr.get('ok') is True,'TRADE_UNAVAILABLE'
assert selection.get('model')=='DEEPSEEK_5M_V1','SIGNAL_SELECTION_CHANGED'
assert ai.get('model')=='DEEPSEEK_5M_V1' and ai.get('providerModel')=='deepseek-flash','WRONG_EXISTING_MODEL'
assert ai.get('decisionRule')=='DEEPSEEK_100MS_THEN_CURRENT_ROUND_PRICE_FALLBACK','CURRENT_SIGNAL_REVISION_CHANGED'
assert feed.get('ok') is True and feed.get('readOnly') is True,'FAST_SPOT_UNAVAILABLE'
assert 'ZL_QUOTE_SPEED_20261023' in Path('/opt/zl-prediction-live/src/railway-diagnostic/index.mjs').read_text(),'QUOTE_OPTIMIZATION_NOT_PRESENT'
assert (tr.get('pendingAction') or {}).get('state') not in ('QUOTING','SUBMITTING','SUBMISSION_UNKNOWN'),'ORDER_IN_FLIGHT'
for unit in ('zl-prediction-trade.service','zl-prediction-risk-exits.service'):
 assert subprocess.run(['systemctl','is-active','--quiet',unit]).returncode==0
print('RESTORE5_PREFLIGHT',json.dumps({'existingDecisionRule':ai['decisionRule'],
 'selectedModel':selection['model'],'ownerFollowEnabled':tr.get('enabled'),
 'pendingState':(tr.get('pendingAction') or {}).get('state'),
 'fastFeedOk':True,'quoteOptimizationKept':True}))
PY

# Switch only between rounds, after prior entry and well before next signal.
# No user follow toggle or trade service restart. Abort if quote/order is active.
python3 - "$WORK" <<'PY'
import json,sys,time,urllib.request
def status():
 with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=8) as resp:return json.load(resp)
for i in range(200):
 ms=int(time.time()*1000)%300000
 if 35000<=ms<=220000:
  t=status()
  if t.get('ok') is True and (t.get('pendingAction') or {}).get('state') not in ('QUOTING','SUBMITTING','SUBMISSION_UNKNOWN'):
   snap={'follow':t.get('enabled'),'roundMs':ms}
   from pathlib import Path
   Path(sys.argv[1]+'/owner.json').write_text(json.dumps(snap))
   print('RESTORE5_SAFE_ROUND_WINDOW',json.dumps(snap));break
 time.sleep(1)
else:raise SystemExit('RESTORE5_NO_SAFE_WINDOW_NO_CHANGE')
PY

BACKUP=/var/lib/zl-prediction/archive/source-backups/restore-single5-COMMIT_SHA
test ! -e "$BACKUP"
mkdir -p "$BACKUP"
cp -p "$MODEL" "$BACKUP/prior-model.mjs"
rollback(){
 echo 'RESTORE5_ROLLBACK_TRIGGERED=true'
 cp -p "$BACKUP/prior-model.mjs" "$MODEL" || true
 systemctl restart zl-prediction-deepseek5.service || true
}
trap rollback ERR

python3 - "$WORK/owner.json" <<'PY'
import json,sys,urllib.request,time
prior=json.load(open(sys.argv[1]))
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=8) as r:t=json.load(r)
assert t.get('enabled') is prior['follow'],'FOLLOW_CHANGED_ABORT'
assert (t.get('pendingAction') or {}).get('state') not in ('QUOTING','SUBMITTING','SUBMISSION_UNKNOWN'),'ORDER_IN_FLIGHT'
assert 35000<=int(time.time()*1000)%300000<=230000,'NOT_SAFE_ROUND_WINDOW'
PY
chown --reference="$MODEL" "$WORK/model.mjs"
chmod --reference="$MODEL" "$WORK/model.mjs"
cp -p "$WORK/model.mjs" "$MODEL"
systemctl restart zl-prediction-deepseek5.service

python3 - "$WORK/owner.json" <<'PY'
import json,sys,time,subprocess,urllib.request
prior=json.load(open(sys.argv[1]))
def get(port,p):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,p),timeout=6) as r:return json.load(r)
for n in range(32):
 try:
  ai=get(13029,'/api/status')
  if ai.get('ok') is True and ai.get('decisionRule')=='LIVE_BTC_ONE_CALL_OR_REAL_PRICE_BACKUP_5S':break
 except Exception:pass
 time.sleep(.5)
else:raise SystemExit('RESTORE5_5SECOND_SIGNAL_HEALTH_FAILED')
assert ai.get('decisionWindowEndMs',0)-ai.get('round',0)==5000
assert ai.get('maxCallsPerRound')==1 and ai.get('preRoundMaxCalls')==0
assert ai.get('providerModel')=='deepseek-flash' and ai.get('configured') is True
assert ai.get('learningDisabled') is True and ai.get('trainingDisabled') is True
tr=get(13001,'/api/status')
assert tr.get('ok') is True and tr.get('enabled') is prior['follow'],'TRADE_FOLLOW_CHANGED_ROLLBACK'
assert get(13001,'/api/order-signal-model').get('model')=='DEEPSEEK_5M_V1'
assert get(13003,'/api/shadow-market-fast').get('ok') is True
for unit in ('zl-prediction-trade.service','zl-prediction-deepseek5.service',
 'zl-prediction-risk-exits.service','zl-prediction-v3.service'):
 assert subprocess.run(['systemctl','is-active','--quiet',unit]).returncode==0,unit
print('RESTORE5_MODEL_ACTIVE=true')
print('RESTORE5_FOLLOW_PRESERVED='+str(prior['follow']).lower())
print('RESTORE5_TRADE_AND_RISK_UNTOUCHED=true')
print('RESTORE5_DEPLOY_SUCCESS=true')
PY
trap - ERR
echo "RESTORE5_BACKUP=$BACKUP"
"""

def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[0-9a-f]{40}',sha):
  print('RESTORE5_INVALID_DEPLOY_REF');return 2
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 invocation=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
  name='zl-restore-five-second-signal-only',type='RunShellScript',
  command_content=REMOTE.replace('COMMIT_SHA',sha),working_user='root',
  timeout=265)).body.invoke_id
 for _ in range(140):
  time.sleep(2)
  result=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=invocation)).body.invocation_result
  if result and str(result.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:output=base64.b64decode(result.output or '',validate=True).decode('utf8','replace')
   except Exception:output=str(result.output)
   print('RESTORE5_REMOTE',result.invocation_status,'EXIT',result.exit_code)
   print(output[-11000:])
   return 0 if int(result.exit_code)==0 else 5
 print('RESTORE5_RESULT_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

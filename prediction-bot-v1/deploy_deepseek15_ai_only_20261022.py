#!/usr/bin/env python3
"""Guarded Alibaba SWAS DeepSeek-only 15s release. Never arms trades.
Only AI prediction source and existing trade wrapper's DeepSeek deadline change.
"""
import os,sys,re,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

BRANCH='fix/deepseek15-ai-only-prod-20261022'
REGION='ap-southeast-1'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
SHELL=r"""#!/usr/bin/env bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
MODEL=/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs
WRAPPER=/opt/zl-prediction-live/src/railway-diagnostic/wrapper.mjs
NODE=/opt/zl-prediction-node/bin/node
BACK=/var/lib/zl-prediction/archive/source-backups/deepseek15-ai-only-COMMIT_SHA
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
test -x "$NODE" && test -f "$MODEL" && test -f "$WRAPPER"
for u in zl-prediction-deepseek5.service zl-prediction-trade.service zl-prediction-risk-exits.service zl-prediction-redis.service zl-futures-bot-paper.service;do
  test "$(systemctl is-active "$u")" = active
done
systemctl show zl-prediction-deepseek5.service -p ExecStart --value | grep -q 'deepseek-adaptive15-production-adapter.mjs'
systemctl show zl-prediction-trade.service -p ExecStart --value | grep -q 'wrapper.mjs'
python3 - <<'PY'
import json,hashlib,pathlib,urllib.request
def get(port,route):
 with urllib.request.urlopen('http://127.0.0.1:%s%s'%(port,route),timeout=8) as r:return json.load(r)
m=get(13029,'/api/status')
t=get(13001,'/api/status')
sel=get(13001,'/api/order-signal-model')
assert m.get('model')=='DEEPSEEK_5M_V1' and m.get('configured') is True
assert m.get('providerModel')=='deepseek-flash'
assert m.get('maxCallsPerRound')==1 and m.get('learningDisabled') is True
assert m.get('decisionWindowEndMs')-m.get('round')==5000,'CURRENT_MODEL_NOT_FIVE_SECONDS'
assert t.get('enabled') is False,'FOLLOW_CURRENTLY_ON_ABORT'
assert sel.get('model')=='DEEPSEEK_5M_V1','SELECTED_SIGNAL_MODEL_CHANGED'
pending=t.get('pendingAction') or {}
assert pending.get('state') not in ('QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN','READY'),'PENDING_TRADE_ABORT'
for file,expected in [
 ('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs','ad3b362f052a98e2bdb3db3bd5323b878d04cc462f1b79c5f7352599c64c1ca0'),
 ('/opt/zl-prediction-live/src/railway-diagnostic/wrapper.mjs','24669e298d078a731401f299fd163dc00737cff4877f398185e2dbabd57aab1a')]:
 raw=pathlib.Path(file).read_bytes()
 assert hashlib.sha256(raw).hexdigest()==expected,'LIVE_SOURCE_DRIFT_ABORT:'+pathlib.Path(file).name
print('AI15_PRECHECK_AIO5_PRICE_FALLBACK_AND_WRAPPER_HASH_MATCH=true')
print('AI15_PRECHECK_FOLLOW_OFF_ORDER_IDLE=true')
PY
curl -fsSL --retry 3 --max-time 30 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/deepseek-single5-production.mjs" \
  -o "$TMP/model.mjs"
"$NODE" --check "$TMP/model.mjs"
grep -Fq "const LIMIT_MS=15000;" "$TMP/model.mjs"
grep -Fq "DEEPSEEK_ONLY_ONE_CALL_15S_NO_PRICE_FALLBACK" "$TMP/model.mjs"
! grep -Fq "REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK" "$TMP/model.mjs"
python3 - "$WRAPPER" "$TMP/wrapper.mjs" <<'PY'
import pathlib,sys
src=pathlib.Path(sys.argv[1]).read_text()
a='const ORDER_SUBMIT_DEADLINE_MS = 15000; // BASELINE/NOVICE remain unchanged.'
b=a+'\nconst DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS = 30000; // AI 15s plus execution headroom for DeepSeek only.'
assert src.count(a)==1
src=src.replace(a,b)
a='function orderSubmitDeadlineForModel(model) {\n  return model === SELECTIVE8_MODEL ? SELECTIVE30_ORDER_DEADLINE_MS :'
b="function orderSubmitDeadlineForModel(model) {\n  return model === 'DEEPSEEK_5M_V1' ? DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS :\n    model === SELECTIVE8_MODEL ? SELECTIVE30_ORDER_DEADLINE_MS :"
assert src.count(a)==1
src=src.replace(a,b)
assert "DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS = 30000" in src
assert "const ORDER_SUBMIT_DEADLINE_MS = 15000;" in src
pathlib.Path(sys.argv[2]).write_text(src)
PY
"$NODE" --check "$TMP/wrapper.mjs"
test ! -e "$BACK"
mkdir -p "$BACK"
cp -p "$MODEL" "$BACK/old-model.mjs"
cp -p "$WRAPPER" "$BACK/old-wrapper.mjs"
INSTALLED=no
rollback(){
 code=$?
 if [ "$INSTALLED" = yes ];then
   echo "AI15_DEPLOY_ROLLBACK_AFTER_ERROR=$code"
   cp -p "$BACK/old-model.mjs" "$MODEL" || true
   cp -p "$BACK/old-wrapper.mjs" "$WRAPPER" || true
   systemctl restart zl-prediction-deepseek5.service || true
   systemctl restart zl-prediction-trade.service || true
 fi
 exit "$code"
}
trap rollback ERR
# Re-check follow and pending actions immediately before changing either process.
python3 - <<'PY'
import json,urllib.request,hashlib,pathlib
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:x=json.load(r)
assert x.get('enabled') is False,'FOLLOW_CHANGED_ABORT'
assert (x.get('pendingAction') or {}).get('state') not in ('QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN','READY')
for file,want in [
 ('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs','ad3b362f052a98e2bdb3db3bd5323b878d04cc462f1b79c5f7352599c64c1ca0'),
 ('/opt/zl-prediction-live/src/railway-diagnostic/wrapper.mjs','24669e298d078a731401f299fd163dc00737cff4877f398185e2dbabd57aab1a')]:
 assert hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()==want,'RUNTIME_SOURCE_CHANGED_ABORT'
PY
chown --reference="$MODEL" "$TMP/model.mjs"
chmod --reference="$MODEL" "$TMP/model.mjs"
chown --reference="$WRAPPER" "$TMP/wrapper.mjs"
chmod --reference="$WRAPPER" "$TMP/wrapper.mjs"
INSTALLED=yes
cp -p "$TMP/model.mjs" "$MODEL"
cp -p "$TMP/wrapper.mjs" "$WRAPPER"
systemctl restart zl-prediction-deepseek5.service
systemctl restart zl-prediction-trade.service
for i in $(seq 1 25);do
 if curl -fsS --max-time 5 http://127.0.0.1:13029/api/status -o "$TMP/ai.json" 2>/dev/null &&
    curl -fsS --max-time 5 http://127.0.0.1:13001/api/status -o "$TMP/trade.json" 2>/dev/null;then
    break
 fi
 sleep 2
done
test -s "$TMP/ai.json" && test -s "$TMP/trade.json"
python3 - "$TMP/ai.json" "$TMP/trade.json" <<'PY'
import json,pathlib,sys,subprocess,urllib.request
m=json.load(open(sys.argv[1])); t=json.load(open(sys.argv[2]))
assert m.get('ok') is True and m.get('model')=='DEEPSEEK_5M_V1'
assert m.get('configured') is True and m.get('providerModel')=='deepseek-flash'
assert m.get('maxCallsPerRound')==1
assert m.get('decisionWindowEndMs')-m.get('round')==15000
assert m.get('decisionRule')=='DEEPSEEK_ONLY_ONE_CALL_15S_NO_PRICE_FALLBACK'
assert m.get('learningDisabled') and m.get('trainingDisabled')
assert m.get('error') is None or isinstance(m.get('error'),str)
assert t.get('enabled') is False,'FOLLOW_STATE_CHANGED'
w=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic/wrapper.mjs').read_text()
assert "model === 'DEEPSEEK_5M_V1' ? DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS" in w
assert 'const DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS = 30000;' in w
assert 'const ORDER_SUBMIT_DEADLINE_MS = 15000;' in w
with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=8) as r:x=json.load(r)
assert x.get('model')=='DEEPSEEK_5M_V1'
print('AI15_PRODUCTION_MODEL_EXCLUSIVE=true')
print('AI15_PRODUCTION_DEADLINE_MS=15000')
print('AI15_PRODUCTION_DEEPSEEK_ORDER_SUBMIT_DEADLINE_MS=30000')
print('AI15_PRODUCTION_FOLLOW_REMAINS_OFF=true')
print('AI15_PRODUCTION_SELECTED_MODEL_UNCHANGED=true')
PY
for u in zl-prediction-deepseek5.service zl-prediction-trade.service zl-prediction-risk-exits.service zl-prediction-redis.service zl-futures-bot-paper.service;do
  test "$(systemctl is-active "$u")" = active
done
echo "AI15_SOURCE_BACKUP=$BACK"
echo "AI15_RELEASE_VERIFIED_SUCCESS=true"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
  print('AI15_DEPLOY_BRANCH_REJECTED');return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id=REGION,
  endpoint='swas.ap-southeast-1.aliyuncs.com'))
 cmd=SHELL.replace('COMMIT_SHA',sha)
 try:
  result=cl.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
   name='zl-deepseek15-ai-only-guarded-release',type='RunShellScript',
   command_content=cmd,working_user='root',timeout=260))
  invoke_id=result.body.invoke_id
  for _ in range(145):
   time.sleep(2)
   inv=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,
    instance_id=INSTANCE,invoke_id=invoke_id)).body.invocation_result
   if inv and str(inv.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    try:out=base64.b64decode(inv.output or '',validate=True).decode('utf8','replace')
    except Exception:out=str(inv.output)
    print('AI15_CLOUD_RELEASE_STATUS',inv.invocation_status,'EXIT',inv.exit_code)
    print(out[-11000:])
    return 0 if str(inv.invocation_status)=='Success' and int(inv.exit_code)==0 else 5
  print('AI15_CLOUD_RELEASE_TIMEOUT');return 6
 except Exception as e:
  print('AI15_CLOUD_RELEASE_EXCEPTION',type(e).__name__);return 7
if __name__=='__main__':sys.exit(main())

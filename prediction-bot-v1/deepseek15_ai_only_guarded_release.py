#!/usr/bin/env python3
"""Guarded Alibaba SWAS DeepSeek-only15 production deployment.
Only the selected AI source and existing trade wrapper deadline change.
Abort rather than interrupt an armed/following trader.
"""
import os,re,time,sys,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/deepseek15-ai-only-prod-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
model=/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs
wrapper=/opt/zl-prediction-live/src/railway-diagnostic/wrapper.mjs
node=/opt/zl-prediction-node/bin/node
test -f "$model" && test -f "$wrapper" && test -x "$node"
for unit in zl-prediction-deepseek5 zl-prediction-trade zl-prediction-risk-exits zl-prediction-redis zl-futures-bot-paper;do
 test "$(systemctl is-active "$unit")" = active
done
# We MUST NOT reset or alter an enabled production follow state.
python3 - <<'PY'
import json,urllib.request,pathlib
def get(port,path):
 with urllib.request.urlopen('http://127.0.0.1:%s%s'%(port,path),timeout=8) as r:return json.load(r)
m=get(13029,'/api/status');t=get(13001,'/api/status');s=get(13001,'/api/order-signal-model')
assert m.get('model')=='DEEPSEEK_5M_V1' and m.get('maxCallsPerRound')==1
assert m.get('decisionWindowEndMs',0)-m.get('round',0)==5000
assert m.get('learningDisabled') is True
assert s.get('model')=='DEEPSEEK_5M_V1'
assert t.get('enabled') is False,'FOLLOW_ACTIVE_ABORT_WITHOUT_TOUCHING_PRODUCTION'
assert (t.get('pendingAction') or {}).get('state') not in (
 'READY','QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN')
src=pathlib.Path('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs').read_text()
assert 'const LIMIT_MS=5000;' in src and "REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK" in src
trade=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic/wrapper.mjs').read_text()
assert "const ORDER_SUBMIT_DEADLINE_MS = 15000;" in trade
assert 'DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS' not in trade
print('AI15_RELEASE_READONLY_PREFLIGHT_SAFE_FOLLOW_OFF=true')
PY
work=$(mktemp -d /tmp/zl-ai15-prod.XXXXXXXX)
trap 'rm -rf "$work"' EXIT
uri="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/deepseek-single5-production.mjs"
curl -fsSL --retry 3 --max-time 35 "$uri" -o "$work/model.mjs"
"$node" --check "$work/model.mjs"
grep -q "DEEPSEEK_ONLY_ONE_CALL_15S_NO_PRICE_FALLBACK" "$work/model.mjs"
grep -q "DEEPSEEK_SINGLE_CALL_15S" "$work/model.mjs"
! grep -q "REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK" "$work/model.mjs"
! grep -q "const fallback=" "$work/model.mjs"
python3 - "$wrapper" "$work/wrapper.mjs" <<'PY'
import sys,pathlib
src=pathlib.Path(sys.argv[1]).read_text()
def patch(old,new):
 global src
 if src.count(old)!=1:raise SystemExit('WRAPPER_ANCHOR_AMBIGUOUS_OR_MISSING')
 src=src.replace(old,new)
head="const ORDER_SUBMIT_DEADLINE_MS = 15000; // BASELINE/NOVICE remain unchanged."
patch(head,head+"\nconst DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS = 30000; // AI decision T+15, trade submit T+30; only this selected model.")
branch="  return model === SELECTIVE8_MODEL ? SELECTIVE30_ORDER_DEADLINE_MS :"
patch(branch,"  return model === 'DEEPSEEK_5M_V1' ? DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS :\n"+branch.replace('  return ','    ',1))
old="    : '本轮第15秒订单提交窗口已截止，未发送下单请求';"
patch(old,"    : p?.signalModelChoice==='DEEPSEEK_5M_V1' ? 'DeepSeek15秒分析模式，本轮第30秒订单提交窗口已截止，未发送下单请求'\n"+old)
# Runtime wrapper is a JavaScript template; node --check wrapper.mjs alone
# cannot validate generated server code. Detect duplicate return regression.
assert "DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS :\\n  return model" not in src
assert "DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS :\\n    model === SELECTIVE8_MODEL" in src
pathlib.Path(sys.argv[2]).write_text(src)
print('AI15_WRAPPER_SCOPED_ORDER_DEADLINE_PATCH_VALID=true')
PY
"$node" --check "$work/wrapper.mjs"
backup="/var/lib/zl-prediction/archive/source-backups/deepseek-ai-only-15s-COMMIT_SHA"
test ! -e "$backup"
mkdir -p "$backup"
cp -p "$model" "$backup/original-deepseek-model.mjs"
cp -p "$wrapper" "$backup/original-trade-wrapper.mjs"
rollback(){
 echo 'AI15_RELEASE_ROLLBACK_TRIGGERED=true'
 cp -p "$backup/original-deepseek-model.mjs" "$model"
 cp -p "$backup/original-trade-wrapper.mjs" "$wrapper"
 systemctl restart zl-prediction-deepseek5.service || true
 systemctl restart zl-prediction-trade.service || true
}
trap rollback ERR
# Re-check the user switch immediately before the disruptive restart.
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=9) as r:t=json.load(r)
assert t.get('enabled') is False,'FOLLOW_NOW_ON_ABORT'
assert (t.get('pendingAction') or {}).get('state') not in ('READY','QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN')
PY
chown --reference="$model" "$work/model.mjs"
chmod --reference="$model" "$work/model.mjs"
chown --reference="$wrapper" "$work/wrapper.mjs"
chmod --reference="$wrapper" "$work/wrapper.mjs"
cp -p "$work/model.mjs" "$model"
cp -p "$work/wrapper.mjs" "$wrapper"
systemctl restart zl-prediction-deepseek5.service
systemctl restart zl-prediction-trade.service
for i in $(seq 1 30);do
 if curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$work/ai.json" 2>/dev/null &&
    curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$work/trade.json" 2>/dev/null;then break;fi
 sleep 2
done
python3 - "$work/ai.json" "$work/trade.json" <<'PY'
import sys,json,pathlib,urllib.request,subprocess
ai=json.load(open(sys.argv[1]));t=json.load(open(sys.argv[2]))
assert ai.get('ok') is True and ai.get('model')=='DEEPSEEK_5M_V1'
assert ai.get('providerModel')=='deepseek-flash'
assert ai.get('configured') is True
assert ai.get('decisionWindowEndMs',0)-ai.get('round',0)==15000
assert ai.get('decisionRule')=='DEEPSEEK_ONLY_ONE_CALL_15S_NO_PRICE_FALLBACK'
assert ai.get('maxCallsPerRound')==1 and ai.get('learningDisabled') is True
assert ai.get('trainingDisabled') is True and ai.get('statisticsDisabled') is True
assert t.get('ok') is True and t.get('enabled') is False
src=pathlib.Path('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs').read_text()
tr=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic/wrapper.mjs').read_text()
assert 'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK' not in src
assert "model === 'DEEPSEEK_5M_V1' ? DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS" in tr
with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=9) as r:s=json.load(r)
assert s.get('model')=='DEEPSEEK_5M_V1'
with urllib.request.urlopen('http://127.0.0.1:13001/api/deepseek-round-results?limit=2',timeout=9) as r:display=json.load(r)
assert display.get('ok') is True
print('AI15_PRODUCTION_DEEPSEEK_MODEL_AND_LOCK_WINDOW=true')
print('AI15_PRODUCTION_PRICE_FALLBACK_REMOVED=true')
print('AI15_PRODUCTION_ORDER_SUBMIT_WINDOW_30S_SCOPED=true')
print('AI15_PRODUCTION_DISPLAY_STATS_EXIST=true')
print('AI15_PRODUCTION_FOLLOW_SWITCH_REMAINS_OFF=true')
print('AI15_PRODUCTION_SIGNAL_SOURCE_NOT_PRICE=true')
PY
for unit in zl-prediction-deepseek5 zl-prediction-trade zl-prediction-risk-exits zl-prediction-redis zl-futures-bot-paper;do
 test "$(systemctl is-active "$unit")" = active
done
echo 'AI15_RELEASE_SUCCESS=true'
echo "AI15_ROLLBACK_ARCHIVE=$backup"
trap - ERR
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
  print('AI15_WRONG_RELEASE_REF');return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 cmd=REMOTE.replace('COMMIT_SHA',sha)
 x=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,name='zl-deepseek15-ai-only-guarded-release',type='RunShellScript',working_user='root',command_content=cmd,timeout=240)).body.invoke_id
 for _ in range(120):
  time.sleep(2)
  y=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=x)).body.invocation_result
  if y and str(y.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(y.output or '',validate=True).decode('utf8','replace')
   except Exception:out=str(y.output)
   print('AI15_PRODUCTION_RELEASE',y.invocation_status,'EXIT',y.exit_code)
   print(out[-15000:])
   return 0 if int(y.exit_code)==0 else 5
 print('AI15_PRODUCTION_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

#!/usr/bin/env python3
"""Guarded Alibaba SWAS cutover to causal DeepSeek prewarm120/current15-40/submit45.
Requires follow OFF; never enables orders; protects all existing state and unrelated bots.
"""
import os,sys,re,base64,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

BRANCH='feat/deepseek40-45s-ai-only-prod-20261025'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/usr/bin/env bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
app=/opt/zl-prediction-live/deepseek5
trade=/opt/zl-prediction-live/src/railway-diagnostic
node=/opt/zl-prediction-node/bin/node
test -d "$app" && test -d "$trade" && test -x "$node"
for unit in zl-prediction-deepseek5 zl-prediction-trade zl-prediction-v3 zl-prediction-v2 zl-futures-bot-paper;do
 test "$(systemctl is-active "$unit")" = active || { echo "PRECHECK_FAILED_SERVICE=$unit";exit 10; }
done
python3 - <<'PY'
import json,urllib.request
def get(port,path):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=8) as r:return json.load(r)
s=get(13029,'/api/status');trade=get(13001,'/api/status');sel=get(13001,'/api/order-signal-model')
assert trade.get('enabled') is False,'FOLLOW_MUST_BE_OFF'
assert sel.get('model')=='DEEPSEEK_5M_V1','SELECTED_MODEL_CHANGED'
assert s.get('model')=='DEEPSEEK_5M_V1' and s.get('providerModel')=='deepseek-flash','PROVIDER_CHANGED'
assert s.get('decisionWindowEndMs',0)-s.get('round',0)==5000,'NO_LONGER_FIVE_SECOND_VERSION'
assert s.get('maxCallsPerRound')==1,'SOURCE_VERSION_CHANGED'
print('AI45_PRECHECK_FOLLOW_OFF=true')
print('AI45_PRECHECK_EXISTING_5S=true')
PY
python3 - "$app" "$trade" <<'PY'
from pathlib import Path
import hashlib,sys
a,b=map(Path,sys.argv[1:])
expected={
 a/'deepseek-adaptive15-core.mjs':'b0aa1334259a6e62b6bc54b2593023ae161bae727bbbf379a9ab485ef66bd394',
 a/'deepseek-adaptive15-runner.mjs':'67fc7bf6025e00e66a340bebf58302aa4e52b44d2d8766e9014ba4acf64f9eac',
 a/'deepseek-adaptive15-production-adapter.mjs':'e64de304e6d3fac3c3cdba17b02673d73644742b4fc8b6e116b23156b8cc08c8',
 b/'production-signal-choice.mjs':'a8741fedcb274f756e405fc0a1ebf36f2d60fa4b3465a931ed05c6c6ca6e9122',
 b/'wrapper.mjs':'f51e1b0f3a4fd11e49fe31ecdb019050379f94375147b098317e2601e163c2a3',
}
for p,sha in expected.items():
 assert p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==sha,f'SOURCE_DRIFT_ABORT_{p.name}'
for f in ['deepseek-adaptive15-quality-store.mjs','deepseek-adaptive15-error-attribution.mjs','deepseek-5m-learner.mjs','deepseek-5m-features.mjs']:
 assert (a/f).is_file(),f'MISSING_DEPENDENCY_{f}'
print('AI45_EXACT_SOURCE_PRECHECK=true')
PY
tmp=$(mktemp -d /tmp/zl-ai45-XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/new"
for f in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 curl -fsSL --retry 2 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/$f" -o "$tmp/new/$f"
 "$node" --check "$tmp/new/$f"
done
python3 - "$trade" "$tmp/new" <<'PY'
from pathlib import Path
import sys
trade,new=map(Path,sys.argv[1:])
def one(txt,old,replacement):
 n=txt.count(old)
 if n!=1:raise RuntimeError('PATCH_ANCHOR_DRIFT:'+str(n)+':'+old[:65])
 return txt.replace(old,replacement,1)
p=(trade/'production-signal-choice.mjs').read_text()
p=one(p,"entry?.modelVersion!=='DEEPSEEK_5M_V1')",
 '''entry?.modelVersion!=='DEEPSEEK_5M_V1'||
    lock.aiVerified!==true||lock.analysisPhase!=='current'||
    lock.decisionMethod!=='DEEPSEEK_PREWARM120_LIVE40_AI_ONLY')''')
p=one(p,"ts<round||ts>=round+25000||now>=round+25000||marketAt<round||marketAt>ts||",
      "ts<round+15000||ts>=round+40000||now>=round+45000||marketAt<round||marketAt>ts||")
(new/'production-signal-choice.mjs').write_text(p)
w=(trade/'wrapper.mjs').read_text()
w=one(w,'const DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS = 30000;',
        'const DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS = 45000;')
w=w.replace('DeepSeek本轮第30秒订单提交窗口已截止','DeepSeek本轮第45秒订单提交窗口已截止')
w=w.replace('DeepSeek15秒分析模式，本轮第30秒订单提交窗口已截止','DeepSeek40秒内分析模式，本轮第45秒订单提交窗口已截止')
(new/'wrapper.mjs').write_text(w)
print('AI45_TRADE_GUARD_AI_PROOF_REQUIRED=true')
print('AI45_TRADE_EXECUTION_DEADLINE_MS=45000')
PY
"$node" --check "$tmp/new/production-signal-choice.mjs"
"$node" --check "$tmp/new/wrapper.mjs"
# Keep all historical data intact; backup ONLY executable code, never touch orders/state.
backup=/var/lib/zl-prediction/archive/source-backups/ai-only40-45-COMMIT_SHA
mkdir -p "$backup"
for f in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 cp -p "$app/$f" "$backup/$f"
done
for f in production-signal-choice.mjs wrapper.mjs;do cp -p "$trade/$f" "$backup/$f";done
rollback(){
 echo 'AI45_ROLLBACK_STARTED=true'
 for f in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do cp -p "$backup/$f" "$app/$f";done
 for f in production-signal-choice.mjs wrapper.mjs;do cp -p "$backup/$f" "$trade/$f";done
 systemctl restart zl-prediction-deepseek5 || true
 systemctl restart zl-prediction-trade || true
 echo 'AI45_ROLLBACK_ATTEMPTED=true'
}
trap rollback ERR
# Check follow has not changed while downloading new code.
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:s=json.load(r)
assert s.get('enabled') is False, 'FOLLOW_CHANGED_DEPLOY_ABORT'
PY
python3 - "$app" "$trade" "$tmp/new" <<'PY'
from pathlib import Path
import sys,os,tempfile
app,trade,src=map(Path,sys.argv[1:])
for root,names in [
  (app,['deepseek-adaptive15-core.mjs','deepseek-adaptive15-runner.mjs','deepseek-adaptive15-production-adapter.mjs']),
  (trade,['production-signal-choice.mjs','wrapper.mjs'])]:
 for name in names:
  dst=root/name;st=dst.stat(); fd,temp=tempfile.mkstemp(prefix='.ai45-',dir=str(root))
  try:
   with os.fdopen(fd,'wb') as f:f.write((src/name).read_bytes())
   os.chmod(temp,st.st_mode&0o777);os.chown(temp,st.st_uid,st.st_gid)
   os.replace(temp,dst)
  finally:
   if os.path.exists(temp):os.unlink(temp)
PY
systemctl restart zl-prediction-deepseek5
systemctl restart zl-prediction-trade
for i in $(seq 1 24);do
 if curl -fsS --max-time 2 http://127.0.0.1:13029/api/status -o "$tmp/ai.json" 2>/dev/null &&
    curl -fsS --max-time 2 http://127.0.0.1:13001/api/status -o "$tmp/trade.json" 2>/dev/null &&
    curl -fsS --max-time 2 http://127.0.0.1:13029/api/history?limit=3 -o "$tmp/history.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$tmp/ai.json" && test -s "$tmp/trade.json" && test -s "$tmp/history.json"
python3 - "$tmp/ai.json" "$tmp/trade.json" "$tmp/history.json" <<'PY'
import json,sys,time
a,t,h=[json.load(open(x)) for x in sys.argv[1:]]
assert a.get('ok') is True and a.get('model')=='DEEPSEEK_5M_V1'
assert a.get('providerModel')=='deepseek-flash'
assert a.get('decisionWindowEndMs')-a.get('round')==40000
assert a.get('maxCallsPerRound')==5
assert a.get('preRoundMaxCalls')==2
assert a.get('currentRoundMaxCalls')==3
assert a.get('prewarmStartMs')==a.get('round')-120000
assert a.get('aiDirectionalRequired') is True and a.get('noSignalAfterDeadline') is True
assert a.get('decisionRule')=='PREWARM120_NEW_ROUND15_LIVE_DEEPSEEK_ONLY40S'
assert a.get('reasoning',{}).get('enabled') is True
assert a.get('learning',{}).get('autoFeedback') is True
assert a.get('realOrderEnabled') is False
assert t.get('enabled') is False
assert h.get('ok') is True,'HISTORY_READER_NOT_RESTORED'
print('AI45_MODEL_DEADLINE_MS=40000')
print('AI45_PREWARM_MS=120000')
print('AI45_MIN_NEW_ROUND_OBSERVATION_MS=15000')
print('AI45_GENUINE_MODEL_PROOF_REQUIRED=true')
print('AI45_LEARNING_STATS_RESTORED=true')
print('AI45_FOLLOW_STILL_OFF=true')
print('AI45_HISTORY_SUMMARY=',json.dumps({k:h.get('summary',{}).get(k) for k in ('allPredictions','allOfficialSamples','allOfficialHits')},ensure_ascii=False))
PY
"$node" --input-type=module - <<'NODE'
import {validateDeepSeekProductionLive} from '/opt/zl-prediction-live/src/railway-diagnostic/production-signal-choice.mjs';
const r=1800000300000;
function signal(ms,proof=true){
 return {ok:true,model:'DEEPSEEK_5M_V1',round:r,
 readOnly:true,orders:false,productionIntegration:false,providerModel:'deepseek-flash',
 generatedAt:r+ms,expiryAt:r+270000,latest:{model:'DEEPSEEK_5M_V1',round:r,
 status:'LOCKED',direction:'UP',lockedAt:r+ms,marketAt:r+ms-150,
 aiVerified:proof,analysisPhase:'current',
 decisionMethod:'DEEPSEEK_PREWARM120_LIVE40_AI_ONLY',
 entry:{direction:'UP',modelVersion:'DEEPSEEK_5M_V1'}}};
}
if(!validateDeepSeekProductionLive(signal(35000),r+39000).ok)throw Error('GENUINE_35S_SIGNAL_REJECTED');
if(validateDeepSeekProductionLive(signal(35000,false),r+39000).ok)throw Error('UNVERIFIED_AI_ACCEPTED');
if(validateDeepSeekProductionLive(signal(14000),r+16000).ok)throw Error('PRE15_SIGNAL_ACCEPTED');
if(validateDeepSeekProductionLive(signal(40000),r+42000).ok)throw Error('LATE_AI_LOCK_ACCEPTED');
if(validateDeepSeekProductionLive(signal(35000),r+45000).ok)throw Error('AFTER_45S_ORDER_ALLOWED');
console.log('AI45_TRADE_ROUTER_STRICT_PROOF_AND_TIME_TEST=true');
NODE
for unit in zl-prediction-deepseek5 zl-prediction-trade zl-prediction-v2 zl-prediction-v3 zl-futures-bot-paper;do
 test "$(systemctl is-active "$unit")" = active || exit 40
done
echo 'AI45_PRODUCTION_VERIFY_SUCCESS=true'
echo "AI45_BACKUP=$backup"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch(r'[0-9a-f]{40}',sha):
  print('AI45_UNAPPROVED_BRANCH_OR_SHA');return 2
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id=INSTANCE,name='zl-deepseek40-ai-only45-guarded',type='RunShellScript',
  working_user='root',command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=180)).body.invoke_id
 for _ in range(104):
  time.sleep(2)
  result=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
    region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if result and str(result.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=base64.b64decode(result.output or '',validate=True).decode('utf8','replace')
   print('AI45_REMOTE_EXIT',result.exit_code,'STATUS',result.invocation_status)
   print(raw[-12000:])
   return 0 if str(result.invocation_status)=='Success' and int(result.exit_code)==0 else 5
 print('AI45_REMOTE_TIMEOUT');return 6
if __name__=='__main__':
 sys.exit(main())

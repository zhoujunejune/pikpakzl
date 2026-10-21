#!/usr/bin/env python3
"""Guarded deployment: autonomous DeepSeek final review, +25s hard model lock,
+25s trusted signal validation, honest UI. Keep trading follow OFF, all history
and trainable shadow, original 30s DeepSeek order execution buffer.
"""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/deepseek25-autonomous-20261021'
BASE_SHA='b4b9f58b2a1ec8744ba6bda9ea9da731b1a8e0fe'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
app=/opt/zl-prediction-live/deepseek5
trade=/opt/zl-prediction-live/src/railway-diagnostic
node=/opt/zl-prediction-node/bin/node
test -x "$node" && test -d "$app" && test -d "$trade"
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper zl-deepseek-shadow-online zl-deepseek-shadow15-online; do
 test "$(systemctl is-active "$svc")" = active || { echo "PRECHECK_UNIT_DOWN=$svc";exit 10; }
done
python3 - <<'PY'
import json,urllib.request
def get(port,endpoint):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}{endpoint}',timeout=7) as r:return json.load(r)
p=get(13029,'/api/status');t=get(13001,'/api/status');c=get(13001,'/api/order-signal-model')
assert p.get('model')=='DEEPSEEK_5M_V1' and p.get('providerModel')=='deepseek-flash'
assert p.get('decisionWindowEndMs',0)-p.get('round',0)==15000
assert p.get('noSignalAfterDeadline') is True
assert t.get('enabled') is False, 'FOLLOW_ENABLED_DEPLOY_ABORT'
assert c.get('model')=='DEEPSEEK_5M_V1', 'MODEL_CHANGED_DEPLOY_ABORT'
print('AUTONOMOUS25_PRECHECK_FOLLOW_OFF=true')
print('AUTONOMOUS25_OFFICIAL_BEFORE',(p.get('learning') or {}).get('allOfficialSamples'))
print('AUTONOMOUS25_WAITS_BEFORE',p.get('recordedWaitRounds'))
PY
# Existing DeepSeek order execution cutoff is 30s. Do not touch this transaction code.
python3 - "$trade" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])
w=(root/'wrapper.mjs').read_text()
assert 'const SELECTIVE30_ORDER_DEADLINE_MS = 30000;' in w, 'ORDER_BUFFER_NOT_EXPECTED'
assert 'model === SELECTIVE8_MODEL ? SELECTIVE30_ORDER_DEADLINE_MS' in w, 'ORDER_BUFFER_ROUTING_UNEXPECTED'
v=(root/'production-signal-choice.mjs').read_text()
assert v.count('ts<round||ts>=round+15000||now>=round+15000||marketAt<round||marketAt>ts||')==1, 'VALIDATOR_SOURCE_UNEXPECTED'
p=(root/'panel-stats-shell.mjs').read_text()
assert p.count('var expired=Date.now()>=currentRound+15000;')==1, 'UI_EXPIRY_SOURCE_UNEXPECTED'
print('AUTONOMOUS25_DOWNSTREAM_30S_ORDER_BUFFER_UNCHANGED=true')
PY
tmp=$(mktemp -d /tmp/zl-deepseek25-XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/base" "$tmp/new"
for file in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs deepseek-adaptive15-quality-store.mjs deepseek-adaptive15-error-attribution.mjs;do
 curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/BASE_SHA/prediction-bot-v1/$file" -o "$tmp/base/$file"
 cmp -s "$app/$file" "$tmp/base/$file" || { echo "SOURCE_HASH_MISMATCH_ABORT=$file";exit 15; }
 curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/$file" -o "$tmp/new/$file"
 "$node" --check "$tmp/new/$file"
done
python3 - "$trade" "$tmp/new" <<'PY'
from pathlib import Path
import sys
root,new=map(Path,sys.argv[1:])
v=(root/'production-signal-choice.mjs').read_text()
old='ts<round||ts>=round+15000||now>=round+15000||marketAt<round||marketAt>ts||'
assert v.count(old)==1
v=v.replace(old,'ts<round||ts>=round+25000||now>=round+25000||marketAt<round||marketAt>ts||')
(new/'production-signal-choice.mjs').write_text(v)
p=(root/'panel-stats-shell.mjs').read_text()
old='var expired=Date.now()>=currentRound+15000;'
assert p.count(old)==1
p=p.replace(old,'var expired=Date.now()>=currentRound+25000;')
old="x.reason==='DEADLINE_15S_EXPIRED'||x.timedOut?'（15秒超时WAIT）':'（主动WAIT）'"
if p.count(old)!=1:raise SystemExit('UI_WAIT_REASON_UNEXPECTED')
p=p.replace(old,"x.reason==='DEADLINE_25S_EXPIRED'||x.timedOut?'（25秒超时WAIT）':x.reason==='DEADLINE_15S_EXPIRED'?'（旧版15秒超时WAIT）':'（主动WAIT）'")
(new/'panel-stats-shell.mjs').write_text(p)
print('AUTONOMOUS25_VALIDATOR_AND_UI_PREPARED=true')
PY
"$node" --check "$tmp/new/production-signal-choice.mjs"
"$node" --check "$tmp/new/panel-stats-shell.mjs"
backup=/var/lib/zl-prediction/archive/source-backups/deepseek-autonomous25-COMMIT_SHA
mkdir -p "$backup"
for file in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs deepseek-adaptive15-quality-store.mjs deepseek-adaptive15-error-attribution.mjs;do cp -p "$app/$file" "$backup/$file";done
for file in production-signal-choice.mjs panel-stats-shell.mjs;do cp -p "$trade/$file" "$backup/$file";done
restore(){
 echo 'AUTONOMOUS25_ROLLBACK_STARTED=true'
 for file in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs deepseek-adaptive15-quality-store.mjs deepseek-adaptive15-error-attribution.mjs;do cp -p "$backup/$file" "$app/$file";done
 for file in production-signal-choice.mjs panel-stats-shell.mjs;do cp -p "$backup/$file" "$trade/$file";done
 systemctl restart zl-prediction-deepseek5.service || true
 systemctl restart zl-prediction-trade.service || true
}
trap restore ERR
# Double-check follow control immediately before changing executable code.
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:s=json.load(r)
assert s.get('enabled') is False,'FOLLOW_CHANGED_ABORT'
PY
python3 - "$app" "$trade" "$tmp/new" <<'PY'
from pathlib import Path
import os,sys,tempfile
app,trade,src=map(Path,sys.argv[1:])
for root,names in [(app,('deepseek-adaptive15-core.mjs','deepseek-adaptive15-runner.mjs',
     'deepseek-adaptive15-production-adapter.mjs','deepseek-adaptive15-quality-store.mjs',
     'deepseek-adaptive15-error-attribution.mjs')),
   (trade,('production-signal-choice.mjs','panel-stats-shell.mjs'))]:
 for name in names:
  target=root/name;st=target.stat()
  fd,tmp=tempfile.mkstemp(prefix='.deepseek25-',dir=root)
  try:
   with os.fdopen(fd,'wb') as f:f.write((src/name).read_bytes())
   os.chmod(tmp,st.st_mode&0o777);os.chown(tmp,st.st_uid,st.st_gid)
   os.replace(tmp,target)
  finally:
   if os.path.exists(tmp):os.remove(tmp)
PY
systemctl restart zl-prediction-deepseek5.service
systemctl restart zl-prediction-trade.service
for _ in $(seq 1 20);do
 if curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$tmp/ai.json" 2>/dev/null &&
    curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$tmp/trade.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$tmp/ai.json" && test -s "$tmp/trade.json"
python3 - "$tmp/ai.json" "$tmp/trade.json" <<'PY'
import json,sys
p=json.load(open(sys.argv[1]));t=json.load(open(sys.argv[2]))
assert p.get('ok') is True and p.get('model')=='DEEPSEEK_5M_V1'
assert p.get('providerModel')=='deepseek-flash'
assert p.get('decisionWindowEndMs',0)-p.get('round',0)==25000
assert p.get('noSignalAfterDeadline') is True
assert p.get('maxCallsPerRound')==3
assert p.get('aiDirectionalRequired') is False
assert p.get('decisionRule')=='PREWARM_AND_LIVE_DEEPSEEK_AUTONOMOUS_25S'
assert p.get('realOrderEnabled') is False and t.get('enabled') is False
print('AUTONOMOUS25_MODEL_DEADLINE_MS=25000')
print('AUTONOMOUS25_MODEL_CALLS_MAX=3')
print('AUTONOMOUS25_FOLLOW_STILL_OFF=true')
print('AUTONOMOUS25_OFFICIAL_AFTER',(p.get('learning') or {}).get('allOfficialSamples'))
print('AUTONOMOUS25_WAITS_AFTER',p.get('recordedWaitRounds'))
PY
"$node" --input-type=module - <<'NODE'
import {validateDeepSeekProductionLive} from '/opt/zl-prediction-live/src/railway-diagnostic/production-signal-choice.mjs';
const r=1800000300000;
function signal(ms){return {ok:true,model:'DEEPSEEK_5M_V1',round:r,
 readOnly:true,orders:false,productionIntegration:false,providerModel:'deepseek-flash',
 generatedAt:r+ms,expiryAt:r+270000,latest:{model:'DEEPSEEK_5M_V1',round:r,
 status:'LOCKED',direction:'UP',lockedAt:r+ms,marketAt:r+ms-300,
 entry:{direction:'UP',modelVersion:'DEEPSEEK_5M_V1'}}};}
if(!validateDeepSeekProductionLive(signal(20000),r+22000).ok)throw Error('VALID_20S_REJECTED');
if(validateDeepSeekProductionLive(signal(20000),r+25000).ok)throw Error('LATE_FETCH_ALLOWED');
if(validateDeepSeekProductionLive(signal(25000),r+25001).ok)throw Error('LATE_LOCK_ALLOWED');
console.log('AUTONOMOUS25_TRADER_VALIDATOR_20S_ALLOWED_25S_REJECTED=true');
NODE
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper zl-deepseek-shadow-online zl-deepseek-shadow15-online;do
 test "$(systemctl is-active "$svc")" = active || exit 39
done
echo 'AUTONOMOUS25_ALL_EXISTING_SERVICES_ACTIVE=true'
echo "AUTONOMOUS25_ROLLBACK_BACKUP=$backup"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
  print('AUTONOMOUS25_INVALID_GITHUB_REF');return 2
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id=INSTANCE,name='zl-deepseek-autonomous25-guarded-cutover',
  type='RunShellScript',working_user='root',
  command_content=REMOTE.replace('COMMIT_SHA',sha).replace('BASE_SHA',BASE_SHA),timeout=180)).body.invoke_id
 for _ in range(100):
  time.sleep(2)
  r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=r.output or ''
   try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
   except Exception:pass
   print('AUTONOMOUS25_REMOTE_EXIT',r.exit_code,'STATUS',r.invocation_status)
   print(raw[-8000:])
   return 0 if int(r.exit_code)==0 else 5
 print('AUTONOMOUS25_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

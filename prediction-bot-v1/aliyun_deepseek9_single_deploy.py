#!/usr/bin/env python3
"""Deploy only the proven unrestricted DeepSeek decision code to existing Alibaba live
services. Strict +25s stop, authenticated feed, unchanged trade controls/follow
switch, official records and CPU shadow. Requires no new infrastructure.
"""
import os,re,time,sys,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/deepseek9-one-reasoning-20261021'
BASE_SHA='7d982bb65a0aba0c977db90167ffcdada16e7184'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
app=/opt/zl-prediction-live/deepseek5
trade=/opt/zl-prediction-live/src/railway-diagnostic
node=/opt/zl-prediction-node/bin/node
test -x "$node" && test -d "$app" && test -d "$trade"
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper zl-deepseek-shadow-online zl-deepseek-shadow15-online; do
 test "$(systemctl is-active "$svc")" = active || { echo "FREE25_SERVICE_NOT_READY=$svc";exit 10; }
done
python3 - <<'PY'
import json,urllib.request
def get(p,endpoint):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(p,endpoint),timeout=7) as r:return json.load(r)
a=get(13029,'/api/status');t=get(13001,'/api/status');c=get(13001,'/api/order-signal-model')
assert a.get('model')=='DEEPSEEK_5M_V1' and a.get('providerModel')=='deepseek-flash','WRONG_AI_PROVIDER_ABORT'
assert a.get('decisionWindowEndMs',0)-a.get('round',0)==25000,'NOT_25S_BASE_ABORT'
assert a.get('maxCallsPerRound')==6 and a.get('analysisCountLimit')=='PRE2_LIVE4_TOTAL6','UNKNOWN_SOURCE_VERSION_ABORT'
assert a.get('noSignalAfterDeadline') is True
assert t.get('enabled') is False,'FOLLOW_ON_ABORT'
assert c.get('model')=='DEEPSEEK_5M_V1','MODEL_SELECTION_CHANGED_ABORT'
print('FREE25_PRECHECK_FOLLOW_OFF=true')
print('FREE25_BEFORE_OFFICIAL_SAMPLES',(a.get('learning') or {}).get('allOfficialSamples',0))
print('FREE25_BEFORE_WAIT_RECORDS',a.get('recordedWaitRounds',0))
PY
# Verify production order code remains exactly aligned, but never modify it.
python3 - "$trade" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])
v=(root/'production-signal-choice.mjs').read_text()
w=(root/'wrapper.mjs').read_text()
p=(root/'panel-stats-shell.mjs').read_text()
assert v.count('ts<round||ts>=round+25000||now>=round+25000||marketAt<round||marketAt>ts||')==1,'TRADE_VALIDATOR_CHANGED_ABORT'
assert 'SELECTIVE30_ORDER_DEADLINE_MS = 30000;' in w,'30S_EXEC_BUFFER_CHANGED_ABORT'
assert 'var expired=Date.now()>=currentRound+25000' in p,'FRONTEND_DEADLINE_CHANGED_ABORT'
print('FREE25_TRADE_VALIDATOR_AND_UI_UNMODIFIED=true')
PY
temp=$(mktemp -d /tmp/zl-deepseek-free25-XXXXXXXX)
trap 'rm -rf "$temp"' EXIT
mkdir -p "$temp/base" "$temp/new"
for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs deepseek-adaptive15-quality-store.mjs deepseek-adaptive15-error-attribution.mjs;do
 curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/BASE_SHA/prediction-bot-v1/$name" -o "$temp/base/$name"
 cmp -s "$app/$name" "$temp/base/$name" || { echo "FREE25_UNEXPECTED_SOURCE_ABORT=$name";exit 15; }
 curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/$name" -o "$temp/new/$name"
 "$node" --check "$temp/new/$name"
done
"$node" --input-type=module - "$temp/new" <<'NODE'
import {pathToFileURL} from 'node:url';
const dir=process.argv[2];
const core=await import(pathToFileURL(dir+'/deepseek-adaptive15-core.mjs'));
if(core.DEADLINE_MS!==9000)throw Error('CORE_9S_MISSING');
if(!core.finalize.toString().includes('now>=w.round+DEADLINE_MS'))throw Error('CORE_NO_EXPIRE');
if(core.finalize.toString().includes('now<w.round+8000'))throw Error('OLD_EARLIEST_8S_PRESENT');
if(!core.decodeAnalysis.toString().includes('continueAnalysis'))throw Error('MODEL_REVIEW_FREEDOM_MISSING');
console.log('FREE25_PARSE_AND_CORE_CHECKS=true');
NODE
backup=/var/lib/zl-prediction/archive/source-backups/deepseek-single9-COMMIT_SHA
mkdir -p "$backup"
for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs deepseek-adaptive15-quality-store.mjs deepseek-adaptive15-error-attribution.mjs;do
 cp -p "$app/$name" "$backup/$name"
done
restore(){
 echo 'FREE25_ROLLBACK_TRIGGERED=true'
 for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs deepseek-adaptive15-quality-store.mjs deepseek-adaptive15-error-attribution.mjs;do cp -p "$backup/$name" "$app/$name";done
 systemctl restart zl-prediction-deepseek5.service || true
}
trap restore ERR
# Never alter owner-controlled trading mode; abort if it was enabled mid-deployment.
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:s=json.load(r)
assert s.get('enabled') is False,'FOLLOW_CHANGED_ABORT'
PY
python3 - "$app" "$temp/new" <<'PY'
from pathlib import Path
import os,sys,tempfile
app,src=map(Path,sys.argv[1:])
for name in ('deepseek-adaptive15-core.mjs','deepseek-adaptive15-runner.mjs',
             'deepseek-adaptive15-production-adapter.mjs','deepseek-adaptive15-quality-store.mjs',
             'deepseek-adaptive15-error-attribution.mjs'):
 target=app/name;original=target.stat()
 fd,tmp=tempfile.mkstemp(prefix='.free25-',dir=app)
 try:
  with os.fdopen(fd,'wb') as f:f.write((src/name).read_bytes())
  os.chmod(tmp,original.st_mode&0o777)
  os.chown(tmp,original.st_uid,original.st_gid)
  os.replace(tmp,target)
 finally:
  if os.path.exists(tmp):os.remove(tmp)
PY
systemctl restart zl-prediction-deepseek5.service
for i in $(seq 1 18);do
 if curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$temp/status.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$temp/status.json"
python3 - "$temp/status.json" <<'PY'
import json,sys,urllib.request
a=json.load(open(sys.argv[1]))
assert a.get('ok') is True and a.get('model')=='DEEPSEEK_5M_V1'
assert a.get('providerModel')=='deepseek-flash'
assert a.get('decisionWindowEndMs',0)-a.get('round',0)==9000
assert a.get('noSignalAfterDeadline') is True
assert a.get('maxCallsPerRound')==1
assert a.get('preRoundMaxCalls')==0 and a.get('currentRoundMaxCalls')==1
assert a.get('analysisCountLimit')=='ONE_LIVE_HIGH_EFFORT_ANALYSIS_9S'
assert a.get('featureReady') in (True,False)
assert a.get('realOrderEnabled') is False
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:t=json.load(r)
assert t.get('enabled') is False
print('SINGLE9_LIVE_DEADLINE_MS=9000')
print('SINGLE9_LIVE_AI_CALLS_MAX=1')
print('FREE25_FOLLOW_STILL_OFF=true')
print('FREE25_OFFICIAL_SAMPLES_AFTER',(a.get('learning') or {}).get('allOfficialSamples',0))
print('FREE25_WAITS_AFTER',a.get('recordedWaitRounds',0))
PY
# Validate the new live core without touching orders or user settings.
"$node" --input-type=module - <<'NODE'
import {makeWindow,collect,decodeAnalysis,registerAnalysis,finalize} from '/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-core.mjs';
const r=1800000300000,w=makeWindow(r);
for(let i=0;i<30;i++)collect(w,{round:r-300000,at:r-30000+i*1000,price:67000+i,open:67000});
collect(w,{round:r,at:r+100,price:68000,open:68000});
for(let i=0;i<4;i++)registerAnalysis(w,decodeAnalysis(JSON.stringify({
 direction:i===3?'DOWN':'UP',confidence:.35,continueAnalysis:i<3
}),r,r+100+i*30,'current'));
const x=finalize(w,r+330,{samples:1000,downSamples:500,downHistoricalAccuracy:.01});
if(x.latest.direction!=='DOWN'||x.generatedAt!==r+330||x.orders!==false)
 throw Error('MODEL_DIRECTION_OR_EARLY_LOCK_WRONG');
console.log('FREE25_EARLY_LOCK_AND_FOUR_LIVE_ITERATIONS_VERIFIED=true');
NODE
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper zl-deepseek-shadow-online zl-deepseek-shadow15-online;do
 test "$(systemctl is-active "$svc")" = active || exit 22
done
echo 'FREE25_ALL_SERVICES_ACTIVE=true'
echo "FREE25_RECOVERY_BACKUP=$backup"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
  print('FREE25_INVALID_REF');return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 invoke=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id=INSTANCE,name='zl-deepseek25-six-calls-onlymodel-safe',
  type='RunShellScript',working_user='root',
  command_content=REMOTE.replace('COMMIT_SHA',sha).replace('BASE_SHA',BASE_SHA),timeout=180)).body.invoke_id
 for _ in range(100):
  time.sleep(2)
  x=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id=INSTANCE,invoke_id=invoke)).body.invocation_result
  if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=x.output or ''
   try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
   except Exception:pass
   print('FREE25_REMOTE_EXIT',x.exit_code,'STATUS',x.invocation_status)
   print(raw[-9000:])
   return 0 if int(x.exit_code)==0 else 5
 print('FREE25_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

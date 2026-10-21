#!/usr/bin/env python3
"""Guarded, rollback-safe FIX: all adaptive15 signals expire at +15s,
explicit WAIT and optional WAIT journal; front-end and trader guard aligned.
Owner auto-follow must be OFF. No orders, balances, futures changes.
"""
import base64,os,re,time,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/adaptive15-hard-deadline-wait-20261021'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
node=/opt/zl-prediction-node/bin/node
app=/opt/zl-prediction-live/deepseek5
trade=/opt/zl-prediction-live/src/railway-diagnostic
test -x "$node" && test -d "$app" && test -d "$trade"
for unit in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$unit")" = active || { echo "REQUIRED_ACTIVE_UNIT_MISSING=$unit";exit 10; }
done
python3 - <<'PY'
import urllib.request,json
def get(port,p):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,p),timeout=8) as r:return json.load(r)
trade=get(13001,'/api/status')
model=get(13001,'/api/order-signal-model')
deep=get(13029,'/api/status')
if trade.get('enabled') is not False:raise SystemExit('AUTO_FOLLOW_ON_ABORT')
if model.get('model')!='DEEPSEEK_5M_V1':raise SystemExit('MODEL_SELECTOR_CHANGED_ABORT')
if deep.get('model')!='DEEPSEEK_5M_V1' or deep.get('providerModel')!='deepseek-flash':
 raise SystemExit('UNEXPECTED_DEEPSEEK_MODEL_ABORT')
if deep.get('decisionWindowEndMs',0)-deep.get('round',0)!=15000:
 raise SystemExit('EXPECTED_ADAPTIVE15_NOT_ACTIVE')
print('ADAPTIVE15_DEADLINE_PREFLIGHT_FOLLOW_OFF=true')
print('ADAPTIVE15_DEADLINE_BEFORE_OFFICIAL_SAMPLES',(deep.get('learning') or {}).get('allOfficialSamples'))
PY
work=$(mktemp -d /tmp/zl-adaptive15-hardwait-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/new" "$work/backup"
for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 curl -fsSL --retry 3 --max-time 25 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/$name" \
 -o "$work/new/$name"
 "$node" --check "$work/new/$name"
done
python3 - "$trade/production-signal-choice.mjs" "$trade/panel-stats-shell.mjs" "$work/new" <<'PY'
from pathlib import Path
import re,sys
v=Path(sys.argv[1]).read_text()
p=Path(sys.argv[2]).read_text()
dest=Path(sys.argv[3])
def once(s,a,b,label):
 if s.count(a)!=1:raise SystemExit('PATCH_CONTEXT_MISMATCH_'+label)
 return s.replace(a,b,1)
v=once(v,'ts<round||ts>=round+270000||marketAt<round||marketAt>ts||',
       'ts<round||ts>=round+15000||now>=round+15000||marketAt<round||marketAt>ts||',
       'TRADE_VALIDATOR_15S')
p=once(p,
 "var rows=ledger.records.filter(function(x){return Number.isSafeInteger(x.round)&&['UP','DOWN'].includes(x.direction)});",
 "var rows=ledger.records.filter(function(x){return Number.isSafeInteger(x.round)&&['UP','DOWN','WAIT'].includes(x.direction)});",
 'DASHBOARD_INCLUDE_WAIT')
p=once(p,
 "put('rsWait','尚未全量记录');put('rsCoverage','未核定');",
 "put('rsWait',Number.isSafeInteger(status.recordedWaitRounds)?status.recordedWaitRounds+'（升级后）':'尚未全量记录');put('rsCoverage','未核定');",
 'WAIT_COUNTER')
pat=r"if\(status\.round===currentRound&&!rows\.some\(function\(x\)\{return x\.round===currentRound\}\)\)\s+rows\.unshift\(\{round:currentRound,direction:null,provider:status\.providerModel,waiting:true\}\);"
new='''if(status.round===currentRound&&!rows.some(function(x){return x.round===currentRound})){
    var expired=Date.now()>=currentRound+15000;
    var decision=status.roundDecision||{};
    var waitNow=expired||decision.status==='WAIT';
    rows.unshift({round:currentRound,direction:waitNow?'WAIT':null,provider:status.providerModel,
      waiting:!waitNow,timedOut:expired&&decision.status!=='WAIT',skipReason:decision.reason||null});
   }'''
p,n=re.subn(pat,new,p)
if n!=1:raise SystemExit('PATCH_CONTEXT_MISMATCH_CURRENT_ROUND_WAIT')
p=once(p,
 "var result=!x.direction?'NO_DECISION':!actual?'PENDING':x.hit?'HIT':'MISS';",
 "var result=x.direction==='WAIT'?'SKIPPED':!x.direction?'NO_DECISION':!actual?'PENDING':x.hit?'HIT':'MISS';",
 'WAIT_RESULT')
p=once(p,
 "var score=Number.isFinite(x.confidence)?x.confidence.toFixed(3)+'（模型自评，未校准）':'未提供';",
 "var score=x.direction==='WAIT'?'本轮跳过':Number.isFinite(x.confidence)?x.confidence.toFixed(3)+'（模型自评，未校准）':'未提供';",
 'WAIT_STRENGTH')
p=once(p,
 "var spent=Number.isFinite(x.signalLatencyMs)?(x.signalLatencyMs/1000).toFixed(2)+'s':'-';",
 "var spent=x.direction==='WAIT'?'未锁定':Number.isFinite(x.signalLatencyMs)?(x.signalLatencyMs/1000).toFixed(2)+'s':'-';",
 'WAIT_LOCK_TIME')
p=once(p,
 "+(x.waiting?'（思考中）':'')+'</td>'+",
 "+(x.waiting?'（思考中）':x.direction==='WAIT'?(x.reason==='DEADLINE_15S_EXPIRED'||x.timedOut?'（15秒超时WAIT）':'（主动WAIT）'):'')+'</td>'+",
 'EXPIRED_THINKING_BADGE')
p=once(p,
 "esc(x.waiting?'未锁定':score)",
 "esc(x.waiting?'尚未锁定':score)",
 'WAIT_DISPLAY')
(dest/'production-signal-choice.mjs').write_text(v)
(dest/'panel-stats-shell.mjs').write_text(p)
print('PATCHED_TRADE_VALIDATOR_AND_DASHBOARD=true')
PY
"$node" --check "$work/new/production-signal-choice.mjs"
"$node" --check "$work/new/panel-stats-shell.mjs"
# Before writing, verify no unexplained divergence from the actual known
# successfully deployed provider source state. Never overwrite unknown edits.
python3 - "$app" "$work" <<'PY'
from pathlib import Path
import hashlib,sys,urllib.request
app=Path(sys.argv[1]);work=Path(sys.argv[2])
for name in ('deepseek-adaptive15-core.mjs','deepseek-adaptive15-runner.mjs',
             'deepseek-adaptive15-production-adapter.mjs'):
 if not (app/name).is_file():raise SystemExit('MISSING_RUNNING_PROVIDER_'+name)
 if (app/name).read_bytes()==(work/'new'/name).read_bytes():
  raise SystemExit('ALREADY_PATCHED_PROVIDER_ABORT_'+name)
# The new status fields must not already exist in the running adapter.
text=(app/'deepseek-adaptive15-production-adapter.mjs').read_text()
if 'noSignalAfterDeadline:true' in text or 'recordedWaitRounds:waits.length' in text:
 raise SystemExit('ACTIVE_PROVIDER_SOURCE_UNEXPECTEDLY_PATCHED')
PY
backdir=/var/lib/zl-prediction/archive/source-backups/adaptive15-hardwait-COMMIT_SHA
mkdir -p "$backdir"
for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 cp -p "$app/$name" "$backdir/$name"
done
for name in production-signal-choice.mjs panel-stats-shell.mjs;do
 cp -p "$trade/$name" "$backdir/$name"
done
restore(){
 echo 'ADAPTIVE15_HARDWAIT_ROLLBACK_TRIGGERED=true'
 for n in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
  cp -p "$backdir/$n" "$app/$n"
 done
 for n in production-signal-choice.mjs panel-stats-shell.mjs;do
  cp -p "$backdir/$n" "$trade/$n"
 done
 systemctl restart zl-prediction-deepseek5.service || true
 systemctl restart zl-prediction-trade.service || true
}
trap restore ERR
# Re-check owner control at the point of commit, not just at initial preflight.
python3 - <<'PY'
import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:s=json.load(r)
if s.get('enabled') is not False:raise SystemExit('FOLLOW_TURNED_ON_ABORT')
PY
# Atomic file replacement while preserving permissions and user/group.
python3 - "$app" "$trade" "$work/new" <<'PY'
from pathlib import Path
import os,sys,tempfile
app,trade,src=map(Path,sys.argv[1:])
for folder,names in [(app,['deepseek-adaptive15-core.mjs','deepseek-adaptive15-runner.mjs',
                              'deepseek-adaptive15-production-adapter.mjs']),
                     (trade,['production-signal-choice.mjs','panel-stats-shell.mjs'])]:
 for name in names:
  target=folder/name;new=src/name
  st=target.stat()
  fd,tmp=tempfile.mkstemp(prefix='.deadlinefix-',dir=folder)
  try:
   with os.fdopen(fd,'wb') as f:f.write(new.read_bytes())
   os.chmod(tmp,st.st_mode&0o777)
   os.chown(tmp,st.st_uid,st.st_gid)
   os.replace(tmp,target)
  finally:
   if os.path.exists(tmp):os.remove(tmp)
PY
systemctl restart zl-prediction-deepseek5.service
systemctl restart zl-prediction-trade.service
for _ in $(seq 1 17);do
 if curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$work/ai.json" 2>/dev/null &&
    curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$work/trade.json" 2>/dev/null;then
   break
 fi
 sleep 2
done
test -s "$work/ai.json" && test -s "$work/trade.json"
python3 - "$work/ai.json" "$work/trade.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]));t=json.load(open(sys.argv[2]))
assert m['ok'] is True and m['model']=='DEEPSEEK_5M_V1'
assert m['decisionWindowEndMs']-m['round']==15000
assert m['realOrderEnabled'] is False and m['noSignalAfterDeadline'] is True
assert m['roundDecision']['decisionDeadlineMs']==m['round']+15000
assert 'recordedWaitRounds' in m
assert t.get('enabled') is False
print('HARDWAIT_BACKEND_15SEC_ACTIVE=true')
print('HARDWAIT_FOLLOW_REMAINS_OFF=true')
print('HARDWAIT_RECORDED_WAIT_ROUNDS',m.get('recordedWaitRounds'))
print('HARDWAIT_OFFICIAL_LEARNING_SAMPLES',(m.get('learning') or {}).get('allOfficialSamples'))
PY
# Test actual trade validator on synthetic 14s valid, 15s forbidden, and late lock.
"$node" --input-type=module - <<'NODE'
import {validateDeepSeekProductionLive} from '/opt/zl-prediction-live/src/railway-diagnostic/production-signal-choice.mjs';
const r=1800000300000;
const make=(ms)=>({ok:true,model:'DEEPSEEK_5M_V1',round:r,
 providerModel:'deepseek-flash',readOnly:true,orders:false,productionIntegration:false,
 generatedAt:r+ms,expiryAt:r+270000,
 latest:{model:'DEEPSEEK_5M_V1',round:r,status:'LOCKED',direction:'UP',
 lockedAt:r+ms,marketAt:r+Math.max(0,ms-1000),entry:{direction:'UP',modelVersion:'DEEPSEEK_5M_V1'}}});
if(!validateDeepSeekProductionLive(make(10000),r+14000).ok)throw Error('EARLY_LOCK_BLOCKED');
if(validateDeepSeekProductionLive(make(10000),r+15000).ok)throw Error('STALE_AT_15_ALLOWED');
if(validateDeepSeekProductionLive(make(16000),r+16500).ok)throw Error('LATE_LOCK_ALLOWED');
console.log('HARDWAIT_TRADER_ACCEPTS_ONLY_PRE15S_LOCKS=true');
NODE
for unit in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$unit")" = active || exit 44
done
echo 'HARDWAIT_ALL_SERVICES_ACTIVE=true'
echo 'HARDWAIT_DASHBOARD_WAIT_NOT_THINKING_AFTER15=true'
echo "HARDWAIT_RESTORE_BACKUP=$backdir"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
  print('HARDWAIT_INVALID_REF');return 2
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
   access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
   region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 invoke=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
   instance_id=INSTANCE,name='zl-adaptive15-hardwait-production-fix',
   type='RunShellScript',working_user='root',
   command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=180)).body.invoke_id
 for _ in range(95):
  time.sleep(2)
  r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
    instance_id=INSTANCE,invoke_id=invoke)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   out=r.output or ''
   try:out=base64.b64decode(out,validate=True).decode('utf8','replace')
   except Exception:pass
   print('HARDWAIT_ALIBABA_REMOTE_EXIT',r.exit_code,'STATUS',r.invocation_status)
   print(out[-6900:])
   return 0 if int(r.exit_code)==0 else 5
 print('HARDWAIT_ALIBABA_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

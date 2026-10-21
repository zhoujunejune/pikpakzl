#!/usr/bin/env python3
"""Atomic, backup/rollback FAST10 provider cutover while owner auto-follow is OFF.

Only changes ExecStart of zl-prediction-deepseek5.service to an ADDITIVE new
provider script. No old sources, learner data, order engine or futures modified.
"""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='feat/deepseek-prewarm-fast10-20261021'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" = 0
for u in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$u")" = active || { echo "FAST10_REQUIRED_UNIT_DOWN=$u";exit 11; }
done
app=/opt/zl-prediction-live/deepseek5
unit=/etc/systemd/system/zl-prediction-deepseek5.service
node=/opt/zl-prediction-node/bin/node
test -x "$node" && test -f "$unit" && test -d "$app"
python3 - <<'PY'
import json,urllib.request
def get(port,path):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=7) as r:return json.load(r)
s=get(13001,'/api/status')
c=get(13001,'/api/order-signal-model')
d=get(13029,'/api/status')
if s.get('enabled') is not False:raise SystemExit('AUTO_FOLLOW_ACTIVE_ABORT')
if c.get('model')!='DEEPSEEK_5M_V1':raise SystemExit('PRODUCTION_MODEL_MISMATCH')
if d.get('model')!='DEEPSEEK_5M_V1' or d.get('providerModel')!='deepseek-flash' or d.get('configured') is not True:
 raise SystemExit('UNEXPECTED_EXISTING_DEEPSEEK')
if (d.get('decisionWindowEndMs',0)-d.get('round',0))!=270000:
 raise SystemExit('PRODUCTION_ALREADY_MODIFIED_ABORT')
print('PREDEPLOY_FOLLOW_OFF=true')
print('PREDEPLOY_LEARNED_SAMPLES', (d.get('learning') or {}).get('allOfficialSamples'))
PY
old=/opt/zl-prediction-live/deepseek5/deepseek-5m-engine.mjs
new=/opt/zl-prediction-live/deepseek5/deepseek-fast10-production-adapter.mjs
python3 - <<'PY'
from pathlib import Path
s=Path('/etc/systemd/system/zl-prediction-deepseek5.service').read_text()
old='/opt/zl-prediction-live/deepseek5/deepseek-5m-engine.mjs'
if s.count('ExecStart=')!=1 or s.count(old)!=1 or 'deepseek-fast10-production-adapter' in s:
 raise SystemExit('UNEXPECTED_PRODUCTION_UNIT_ABORT')
for p in ['deepseek-5m-engine.mjs','deepseek-5m-learner.mjs','deepseek-5m-features.mjs']:
 if not Path('/opt/zl-prediction-live/deepseek5',p).is_file():
  raise SystemExit('MISSING_REQUIRED_PRODUCTION_MODULE')
PY
work=$(mktemp -d /tmp/zl-fast10-switch-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
for name in deepseek-fast10-shadow-core.mjs deepseek-fast10-shadow-runner.mjs deepseek-fast10-production-adapter.mjs;do
 curl -fsSL --retry 2 --max-time 25 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/$name" -o "$work/$name"
 "$node" --check "$work/$name"
done
# Existing model/learner sources are not overwritten.
# New file deployment is additive; abort on collisions.
for name in deepseek-fast10-shadow-core.mjs deepseek-fast10-shadow-runner.mjs deepseek-fast10-production-adapter.mjs;do
 test ! -e "$app/$name" || { echo "FAST10_EXISTING_FILE_COLLISION=$name";exit 19; }
done
for name in deepseek-fast10-shadow-core.mjs deepseek-fast10-shadow-runner.mjs deepseek-fast10-production-adapter.mjs;do
 install -m 0640 -o zl-pred -g zl-pred "$work/$name" "$app/$name"
done
# Import and instantiate production adapter against ACTUAL installed learner.
FAST10_TMPSTATE="$work/signal.json" FAST10_TMPLEARN="$work/learning.json" "$node" --input-type=module - <<'NODE'
import {createFast10ProductionProvider} from '/opt/zl-prediction-live/deepseek5/deepseek-fast10-production-adapter.mjs';
const instance=createFast10ProductionProvider({env:{
 LLM_STATE_FILE:process.env.FAST10_TMPSTATE,
 DEEPSEEK_LEARNING_FILE:process.env.FAST10_TMPLEARN,
 DEEPSEEK_MODEL:'deepseek-flash'
}});
const s=instance.status();
if(s.model!=='DEEPSEEK_5M_V1'||s.realOrderEnabled!==false||
 s.decisionWindowEndMs-s.round!==10000||s.learning.modelWeightsFineTuned!==false)
 throw Error('FAST10_ACTUAL_LEARNER_IMPORT_FAILED');
console.log('FAST10_ACTIVE_DEPENDENCIES_COMPATIBLE=true');
NODE
bkp=/var/lib/zl-prediction/archive/source-backups/fast10-cutover-COMMIT_SHA
mkdir -p "$bkp"
cp -p "$unit" "$bkp/unit.original"
# Backup current signal file for audit only; never overwrite live signal during rollback.
if test -f /var/lib/zl-prediction/deepseek5/signal.json;then
 cp -p /var/lib/zl-prediction/deepseek5/signal.json "$bkp/signal.before"
fi
restore(){
 echo 'FAST10_ROLLBACK_TRIGGERED=true'
 cp -p "$bkp/unit.original" "$unit"
 systemctl daemon-reload
 systemctl restart zl-prediction-deepseek5.service || true
 echo "FAST10_ROLLBACK_DEEPSEEK_ACTIVE=$(systemctl is-active zl-prediction-deepseek5.service||true)"
}
trap restore ERR
python3 - <<'PY'
from pathlib import Path
import os
p=Path('/etc/systemd/system/zl-prediction-deepseek5.service')
s=p.read_text()
old='/opt/zl-prediction-live/deepseek5/deepseek-5m-engine.mjs'
new='/opt/zl-prediction-live/deepseek5/deepseek-fast10-production-adapter.mjs'
if s.count(old)!=1:raise SystemExit('FAST10_UNIT_RACE_ABORT')
tmp=p.with_name(p.name+'.fast10.tmp')
tmp.write_text(s.replace(old,new,1))
os.chmod(tmp,0o644)
os.replace(tmp,p)
PY
systemctl daemon-reload
systemctl restart zl-prediction-deepseek5.service
for i in $(seq 1 18);do
 if curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$work/current.json" 2>/dev/null;then break;fi
 sleep 1
done
test -s "$work/current.json"
python3 - "$work/current.json" <<'PY'
import json,sys,urllib.request
d=json.load(open(sys.argv[1]))
assert d.get('ok') is True and d.get('model')=='DEEPSEEK_5M_V1'
assert d.get('providerModel')=='deepseek-flash' and d.get('configured') is True
assert d.get('decisionWindowEndMs')-d.get('round')==10000
assert d.get('maxCallsPerRound')==2
assert d.get('realOrderEnabled') is False and d.get('tradeIntegration') is False
def g(p):
 with urllib.request.urlopen('http://127.0.0.1:13001'+p,timeout=7) as r:return json.load(r)
c=g('/api/order-signal-model')
s=g('/api/status')
assert c.get('model')=='DEEPSEEK_5M_V1' and s.get('enabled') is False
print('FAST10_PRODUCTION_SIGNAL_WINDOW=10sec')
print('FAST10_AUTO_FOLLOW_LEFT_OFF=true')
print('FAST10_ORDER_ROUTER_UNCHANGED=true')
print('FAST10_OFFICIAL_FEEDBACK_SAMPLES',(d.get('learning') or {}).get('allOfficialSamples'))
PY
for u in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$u")" = active || exit 28
done
echo 'FAST10_NEW_PROVIDER_RUNNING=true'
echo 'FAST10_FUTURES_AND_TRADE_SERVICES_UNTOUCHED=true'
echo "FAST10_REVERT_UNIT_BACKUP=$bkp/unit.original"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[0-9a-f]{40}',sha):
  print('FAST10_WRONG_GITHUB_REF');return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
   access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
   region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   name='zl-fast10-production-provider-switch-follow-off-only',
   type='RunShellScript',working_user='root',command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=185)).body.invoke_id
 for _ in range(95):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(
    region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
    invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=r.output or ''
   try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
   except Exception:pass
   print('FAST10_ALIBABA_CHANGE_EXIT',r.exit_code,'STATUS',str(r.invocation_status))
   print(raw[-4800:])
   return 0 if int(r.exit_code)==0 else 5
 print('FAST10_ALIBABA_CHANGE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

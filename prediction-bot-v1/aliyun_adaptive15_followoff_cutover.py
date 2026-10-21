#!/usr/bin/env python3
"""Guarded isolated DeepSeek provider swap FAST10 -> adaptive15.
Only when production follow is OFF; backup/auto-rollback. No order/futures edits.
No overwrite of existing DeepSeek model, official learner, case memory or FAST10.
"""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='feat/deepseek-adaptive15-experience-20261021'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
app=/opt/zl-prediction-live/deepseek5
unit=/etc/systemd/system/zl-prediction-deepseek5.service
node=/opt/zl-prediction-node/bin/node
test -x "$node" && test -f "$unit" && test -d "$app"
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
  test "$(systemctl is-active "$svc")" = active || { echo "REQUIRED_SERVICE_INACTIVE=$svc";exit 14; }
done
python3 - <<'PY'
import urllib.request,json
def read(port,url):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}'+url,timeout=8) as r:return json.load(r)
p=read(13001,'/api/status')
c=read(13001,'/api/order-signal-model')
m=read(13029,'/api/status')
if p.get('enabled') is not False:raise SystemExit('FOLLOW_ENABLED_CANCEL_DEPLOYMENT')
if c.get('model')!='DEEPSEEK_5M_V1':raise SystemExit('UNEXPECTED_SELECTED_MODEL')
if m.get('model')!='DEEPSEEK_5M_V1' or m.get('providerModel')!='deepseek-flash':
 raise SystemExit('UNEXPECTED_ACTIVE_PROVIDER')
if m.get('decisionWindowEndMs',0)-m.get('round',0)!=10000:
 raise SystemExit('EXPECTED_FAST10_NOT_ACTIVE')
print('ADAPTIVE15_PREDEPLOY_FOLLOW_OFF=true')
print('ADAPTIVE15_PREDEPLOY_OFFICIAL_SAMPLES',(m.get('learning') or {}).get('allOfficialSamples'))
print('ADAPTIVE15_PREDEPLOY_PREDICTIONS',(m.get('learning') or {}).get('predictions'))
PY
python3 - <<'PY'
from pathlib import Path
p=Path('/etc/systemd/system/zl-prediction-deepseek5.service')
text=p.read_text()
old='/opt/zl-prediction-live/deepseek5/deepseek-fast10-production-adapter.mjs'
if text.count('ExecStart=')!=1 or text.count(old)!=1:
 raise SystemExit('PRODUCTION_UNIT_HAS_CHANGED_ABORT')
for file in ['deepseek-5m-learner.mjs','deepseek-5m-features.mjs','deepseek-fast10-production-adapter.mjs']:
 if not Path('/opt/zl-prediction-live/deepseek5',file).exists():
  raise SystemExit('DEPENDENCY_MISSING_'+file)
PY
work=$(mktemp -d /tmp/zl-adaptive15-switch-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 curl -fsSL --retry 2 --max-time 20 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/$name" -o "$work/$name"
 "$node" --check "$work/$name"
 test ! -e "$app/$name" || { echo "TARGET_EXISTS_ABORT=$name";exit 21; }
done
for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 install -o zl-pred -g zl-pred -m 0640 "$work/$name" "$app/$name"
done
# Source compatibility tested against ACTUAL, not Github-only, installed learner.
ADAPT_TMP_STATE="$work/no-real-signal.json" ADAPT_TMP_LEARN="$work/no-real-learner.json" "$node" --input-type=module - <<'NODE'
import {createAdaptive15ProductionProvider}
 from '/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs';
const p=createAdaptive15ProductionProvider({env:{
 LLM_STATE_FILE:process.env.ADAPT_TMP_STATE,
 DEEPSEEK_LEARNING_FILE:process.env.ADAPT_TMP_LEARN,
 DEEPSEEK_MODEL:'deepseek-flash'
}});
const r=p.status();
if(r.model!=='DEEPSEEK_5M_V1'||r.decisionWindowEndMs-r.round!==15000
 ||r.realOrderEnabled!==false||r.learning.modelWeightsFineTuned!==false)
 throw Error('REAL_LEARNER_ADAPTIVE15_COMPATIBILITY_FAILED');
console.log('ADAPTIVE15_ACTUAL_LEARNER_IMPORT_OK=true');
NODE
backup=/var/lib/zl-prediction/archive/source-backups/adaptive15-cutover-COMMIT_SHA
mkdir -p "$backup"
cp -p "$unit" "$backup/unit.before"
if test -f /var/lib/zl-prediction/deepseek5/signal.json;then
 cp -p /var/lib/zl-prediction/deepseek5/signal.json "$backup/signal.before"
fi
if test -f /var/lib/zl-prediction/deepseek5/learning.json;then
 cp -p /var/lib/zl-prediction/deepseek5/learning.json "$backup/learning.before"
fi
restore(){
 echo 'ADAPTIVE15_ROLLBACK_START=true'
 cp -p "$backup/unit.before" "$unit"
 systemctl daemon-reload
 systemctl restart zl-prediction-deepseek5.service || true
 echo "ADAPTIVE15_ROLLBACK_PROVIDER=$(systemctl is-active zl-prediction-deepseek5.service||true)"
}
trap restore ERR
# Recheck follow immediately before production process restart.
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=6) as r:s=json.load(r)
if s.get('enabled') is not False:raise SystemExit('FOLLOW_CHANGED_ABORT')
PY
python3 - <<'PY'
from pathlib import Path
import os
p=Path('/etc/systemd/system/zl-prediction-deepseek5.service')
s=p.read_text()
old='/opt/zl-prediction-live/deepseek5/deepseek-fast10-production-adapter.mjs'
new='/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs'
if s.count(old)!=1:raise SystemExit('UNEXPECTED_UNIT_CONCURRENT_CHANGE')
t=p.with_name(p.name+'.adaptive15.tmp')
t.write_text(s.replace(old,new,1))
os.chmod(t,0o644)
os.replace(t,p)
PY
systemctl daemon-reload
systemctl restart zl-prediction-deepseek5.service
for _ in $(seq 1 20);do
 if curl -fsS --max-time 2 http://127.0.0.1:13029/api/status -o "$work/live.json" 2>/dev/null;then break;fi
 sleep 1
done
test -s "$work/live.json"
python3 - "$work/live.json" <<'PY'
import json,sys,urllib.request
s=json.load(open(sys.argv[1]))
assert s['ok'] is True and s['model']=='DEEPSEEK_5M_V1'
assert s['providerModel']=='deepseek-flash'
assert s['configured'] is True
assert s['decisionWindowEndMs']-s['round']==15000
assert s['decisionRule']=='TWO_PASS_PREWARM_ADAPTIVE15_WAIT_ALLOWED'
assert s['realOrderEnabled'] is False and s['tradeIntegration'] is False
assert s['learning']['modelWeightsFineTuned'] is False
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=6) as r:c=json.load(r)
assert c.get('enabled') is False
assert c.get('orderSignalModel')=='DEEPSEEK_5M_V1'
print('ADAPTIVE15_LIVE_PROVIDER_WINDOW_SEC=15')
print('ADAPTIVE15_REAL_FOLLOW_STAYS_OFF=true')
print('ADAPTIVE15_POSTDEPLOY_OFFICIAL_SAMPLES',s['learning'].get('allOfficialSamples'))
print('ADAPTIVE15_POSTDEPLOY_PREDICTIONS',s['learning'].get('predictions'))
PY
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$svc")" = active || exit 23
done
echo 'ADAPTIVE15_PRODUCTION_PROVIDER_STARTED=true'
echo 'ADAPTIVE15_TRADER_AND_FUTURES_SERVICES_NOT_CHANGED=true'
echo "ADAPTIVE15_BACKUP_LOCATION=$backup/unit.before"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
  print('ADAPTIVE15_SOURCE_NOT_PINNED');return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
    access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
    region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
    instance_id=INSTANCE,name='zl-adaptive15-provider-follow-off-only',
    type='RunShellScript',working_user='root',
    command_content=SCRIPT.replace('COMMIT_SHA',sha),timeout=170)).body.invoke_id
 for _ in range(90):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   data=r.output or ''
   try:data=base64.b64decode(data,validate=True).decode('utf8','replace')
   except Exception:pass
   print('ADAPTIVE15_REMOTE_EXIT',r.exit_code,'STATUS',r.invocation_status)
   print(data[-4900:])
   return 0 if int(r.exit_code)==0 else 5
 print('ADAPTIVE15_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

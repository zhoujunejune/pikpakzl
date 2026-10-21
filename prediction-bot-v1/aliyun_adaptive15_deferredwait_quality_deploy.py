#!/usr/bin/env python3
"""Atomic, rollback-protected production AI-only update.
Requires auto-follow OFF. Leaves trade router, learner, model weights, futures unmodified.
"""
import os,base64,time,re,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='feat/adaptive15-deferred-wait-learning-pnl-20261021'
BASE_SHA='3ab10d2c33dfdf509e03047d89913380106457a4'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
app=/opt/zl-prediction-live/deepseek5
node=/opt/zl-prediction-node/bin/node
test -x "$node" && test -d "$app"
for u in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$u")" = active || { echo "PRECHECK_SERVICE_DOWN=$u";exit 11; }
done
python3 - <<'PY'
import urllib.request,json
def read(port,route):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}{route}',timeout=8) as r:return json.load(r)
a=read(13029,'/api/status')
b=read(13001,'/api/status')
c=read(13001,'/api/order-signal-model')
if b.get('enabled') is not False:raise SystemExit('AUTO_FOLLOW_ON_ABORT')
if c.get('model')!='DEEPSEEK_5M_V1':raise SystemExit('PRODUCTION_SELECTOR_CHANGED')
if a.get('model')!='DEEPSEEK_5M_V1' or a.get('providerModel')!='deepseek-flash':
 raise SystemExit('PRODUCTION_DEEPSEEK_CHANGED')
if a.get('decisionWindowEndMs',0)-a.get('round',0)!=15000:
 raise SystemExit('HARD_DEADLINE_NOT_15_SECONDS')
if a.get('noSignalAfterDeadline') is not True:raise SystemExit('NO_LATE_LOCK_GUARD')
print('DEFERRED_WAIT_PRECHECK_FOLLOW_OFF=true')
print('DEFERRED_WAIT_PRECHECK_OFFICIAL_SAMPLES',(a.get('learning') or {}).get('allOfficialSamples'))
PY
work=$(mktemp -d /tmp/zl-deferredwait-upgrade-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/new" "$work/old"
for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-production-adapter.mjs;do
 curl -fsSL --retry 2 --max-time 30 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/BASE_SHA/prediction-bot-v1/$name" \
 -o "$work/old/$name"
 cmp -s "$app/$name" "$work/old/$name" ||
  { echo "UNREVIEWED_LIVE_SOURCE_ABORT=$name";exit 12; }
done
for name in deepseek-adaptive15-error-attribution.mjs deepseek-adaptive15-quality-store.mjs;do
 test ! -e "$app/$name" || { echo "EXISTING_NEW_MODULE_ABORT=$name";exit 13; }
done
for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-production-adapter.mjs \
  deepseek-adaptive15-error-attribution.mjs deepseek-adaptive15-quality-store.mjs;do
 curl -fsSL --retry 2 --max-time 30 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/$name" \
 -o "$work/new/$name"
 "$node" --check "$work/new/$name"
done
# Duplicate code in a throwaway dir for integration sanity; import full provider
# only after all required files are installed on live host.
backup=/var/lib/zl-prediction/archive/source-backups/deferredwait-quality-COMMIT_SHA
mkdir -p "$backup"
for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-production-adapter.mjs;do
 cp -p "$app/$name" "$backup/$name"
done
restore(){
 echo 'DEFERRED_WAIT_ROLLBACK_TRIGGERED=true'
 for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-production-adapter.mjs;do
  cp -p "$backup/$name" "$app/$name"
 done
 rm -f "$app/deepseek-adaptive15-error-attribution.mjs" "$app/deepseek-adaptive15-quality-store.mjs"
 systemctl restart zl-prediction-deepseek5.service || true
}
trap restore ERR
python3 - <<'PY'
import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:s=json.load(r)
if s.get('enabled') is not False:raise SystemExit('FOLLOW_CHANGED_BEFORE_WRITE')
PY
for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-production-adapter.mjs \
  deepseek-adaptive15-error-attribution.mjs deepseek-adaptive15-quality-store.mjs;do
 install -o zl-pred -g zl-pred -m 0640 "$work/new/$name" "$app/$name.tmp"
 mv -f "$app/$name.tmp" "$app/$name"
done
# Verify against installed, divergent production learner without modifying it.
ADAPT_TMP_LEARN="$work/learner.json" ADAPT_TMP_STATE="$work/state.json" \
ADAPT_TMP_QUALITY="$work/quality.json" "$node" --input-type=module - <<'NODE'
import {createAdaptive15ProductionProvider} from '/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs';
const p=createAdaptive15ProductionProvider({env:{
 DEEPSEEK_MODEL:'deepseek-flash',DEEPSEEK_API_KEY:'',
 DEEPSEEK_LEARNING_FILE:process.env.ADAPT_TMP_LEARN,
 LLM_STATE_FILE:process.env.ADAPT_TMP_STATE,
 DEEPSEEK_QUALITY_JOURNAL_FILE:process.env.ADAPT_TMP_QUALITY
}});
const s=p.status();
if(s.model!=='DEEPSEEK_5M_V1'||s.decisionWindowEndMs-s.round!==15000
 ||s.noSignalAfterDeadline!==true||s.strategyQuality?.economics?.realizedNetPnl!==null)
 throw Error('PRODUCTION_DEPENDENCY_TEST_FAILED');
console.log('DEFERRED_WAIT_PRODUCTION_DEPENDENCIES_OK=true');
NODE
systemctl restart zl-prediction-deepseek5.service
for _ in $(seq 1 17);do
 if curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$work/status" 2>/dev/null;then break;fi
 sleep 1
done
test -s "$work/status"
python3 - "$work/status" <<'PY'
import json,sys,urllib.request
s=json.load(open(sys.argv[1]))
assert s['ok'] is True and s['model']=='DEEPSEEK_5M_V1'
assert s['providerModel']=='deepseek-flash'
assert s['decisionWindowEndMs']-s['round']==15000
assert s['noSignalAfterDeadline'] is True
assert s['realOrderEnabled'] is False
assert s['strategyQuality']['economics']['realizedNetPnl'] is None
assert s['strategyQuality']['economics']['available'] is False
assert s['strategyQuality']['learningType']=='CASE_MEMORY_AND_RULE_FEEDBACK_NOT_LLM_WEIGHT_TRAINING'
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=8) as r:p=json.load(r)
assert p.get('enabled') is False
print('DEFERRED_WAIT_PRODUCTION_UPGRADE_SUCCESS=true')
print('DEFERRED_WAIT_REALIZED_NET_PROFIT_UNKNOWN=true')
print('DEFERRED_WAIT_FOLLOW_REMAINS_OFF=true')
print('DEFERRED_WAIT_OFFICIAL_SAMPLES',(s.get('learning') or {}).get('allOfficialSamples'))
print('DEFERRED_WAIT_QUALITY_AUDIT_SAMPLES',s['strategyQuality']['signal']['officiallySettled'])
PY
for u in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$u")" = active || exit 25
done
echo 'DEFERRED_WAIT_TRADER_FUTURES_UNCHANGED=true'
echo "DEFERRED_WAIT_ROLLBACK_BACKUP=$backup"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
  print('WRONG_GITHUB_SOURCE_ABORT');return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
   access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
   region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
    name='zl-adaptive15-deferredwait-official-quality-no-orders',
    type='RunShellScript',working_user='root',
    command_content=REMOTE.replace('COMMIT_SHA',sha).replace('BASE_SHA',BASE_SHA),timeout=170)).body.invoke_id
 for _ in range(95):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   data=r.output or ''
   try:data=base64.b64decode(data,validate=True).decode('utf8','replace')
   except Exception:pass
   print('DEFERRED_WAIT_REMOTE_EXIT',r.exit_code,'STATUS',r.invocation_status)
   print(data[-4700:])
   return 0 if int(r.exit_code)==0 else 5
 print('DEFERRED_WAIT_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

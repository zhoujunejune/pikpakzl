#!/usr/bin/env python3
"""Guarded production return to DeepSeek-first with live price fallback at t+100ms.
Only restart standalone AI signal service, never trade/futures/risk. No orders.
"""
import os,re,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

BRANCH='fix/deepseek100ms-fallback-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
node=/opt/zl-prediction-node/bin/node
app=/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs
test -f "$app" && test -x "$node" && test "$(id -u)" = 0
for unit in zl-prediction-deepseek5 zl-prediction-trade zl-prediction-risk-exits zl-deepseek-results-display-only zl-futures-bot-paper;do
 test "$(systemctl is-active "$unit")" = active || {
  echo "FAST100_REQUIRED_UNIT_NOT_RUNNING=$unit";exit 3;
 }
done
work=$(mktemp -d /tmp/zl-fast100-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
python3 - "$work" <<'PY'
import urllib.request,json,sys,pathlib
from pathlib import Path
w=Path(sys.argv[1])
def get(port,path):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}'+path,timeout=8) as r:return json.load(r)
m=get(13029,'/api/status')
t=get(13001,'/api/status')
sel=get(13001,'/api/order-signal-model')
history=get(13045,'/api/round-results?limit=1')
assert m.get('model')=='DEEPSEEK_5M_V1'
assert m.get('providerModel')=='deepseek-flash' and m.get('configured') is True
assert m.get('decisionRule')=='DEEPSEEK_ONLY_ONE_CALL_15S_NO_PRICE_FALLBACK'
assert m.get('decisionWindowEndMs',0)-m.get('round',0)==15000
assert m.get('learningDisabled') is True and m.get('maxCallsPerRound')==1
assert sel.get('model')=='DEEPSEEK_5M_V1'
assert t.get('ok') is True and isinstance(t.get('enabled'),bool)
assert history.get('ok') is True and history.get('schema')=='ROUND_RESULTS_DISPLAY_ONLY_V1'
source=pathlib.Path('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs').read_text()
assert 'if(saved?.round!==round&&clock()<round+LIMIT_MS)' in source,'UNEXPECTED_PRODUCTION_MODEL_DRIFT'
assert 'const LIMIT_MS=15000' in source
assert 'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK' not in source
w.joinpath('before.json').write_text(json.dumps({
 'followEnabled':t['enabled'],
 'model':sel['model'],
 'recordCount':history.get('summary',{}).get('rounds')},ensure_ascii=False))
print('FAST100_PRECHECK_ACTIVE_FOLLOW',t['enabled'])
print('FAST100_PRECHECK_ORIGINAL_AI15_VERIFIED=true')
PY
source="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/deepseek-single5-production.mjs"
curl -fsSL --retry 3 --max-time 25 "$source" -o "$work/new.mjs"
"$node" --check "$work/new.mjs"
grep -Fq 'const AI_LIMIT_MS=100;' "$work/new.mjs"
grep -Fq 'const FALLBACK_END_MS=15000;' "$work/new.mjs"
grep -Fq 'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK' "$work/new.mjs"
grep -Fq 'DEEPSEEK_100MS_THEN_CURRENT_ROUND_PRICE_FALLBACK' "$work/new.mjs"
! grep -Fq "decisionRule:'DEEPSEEK_ONLY_ONE_CALL_15S_NO_PRICE_FALLBACK'" "$work/new.mjs"
# Don't restart while signals and live orders may be going out during T+0-30 seconds.
python3 - <<'PY'
import time
for i in range(185):
 elapsed=int(time.time()*1000)%300000
 if 37000<=elapsed<=235000:
  print('FAST100_DEPLOY_SAFE_AFTER_ROUND_MS',elapsed);break
 time.sleep(1)
else:raise SystemExit('FAST100_SAFE_DEPLOY_WINDOW_UNAVAILABLE')
PY
# Recheck that selected model and owner-controlled follow state have not changed.
python3 - "$work/before.json" <<'PY'
import json,sys,urllib.request
b=json.load(open(sys.argv[1]))
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=8) as r:return json.load(r)
t=get('/api/status');s=get('/api/order-signal-model')
assert t.get('enabled') is b['followEnabled'],'OWNER_SWITCH_CHANGED_DURING_DEPLOY_ABORT'
assert s.get('model')==b['model']=='DEEPSEEK_5M_V1','OWNER_SELECTED_DIFFERENT_MODEL_ABORT'
print('FAST100_OWNER_SWITCH_AND_SELECTION_UNTOUCHED=true')
PY
backup="/var/lib/zl-prediction/archive/source-backups/deepseek-fast100-COMMIT_SHA"
test ! -e "$backup"
mkdir -p "$backup"
cp -p "$app" "$backup/original.mjs"
rollback(){
 echo 'FAST100_ROLLBACK_TRIGGERED=true'
 cp -p "$backup/original.mjs" "$app"
 systemctl restart zl-prediction-deepseek5.service || true
}
trap rollback ERR
chown --reference="$app" "$work/new.mjs"
chmod --reference="$app" "$work/new.mjs"
cp -p "$work/new.mjs" "$app"
systemctl restart zl-prediction-deepseek5.service
for i in $(seq 1 40);do
 if curl -fsS --max-time 5 'http://127.0.0.1:13029/api/status' -o "$work/after.json" 2>/dev/null;then break;fi
 sleep 1
done
test -s "$work/after.json"
python3 - "$work/before.json" "$work/after.json" <<'PY'
import json,urllib.request,subprocess,sys
b=json.load(open(sys.argv[1]));m=json.load(open(sys.argv[2]))
def get(port,route):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,route),timeout=10) as r:return json.load(r)
assert m.get('ok') is True and m.get('model')=='DEEPSEEK_5M_V1'
assert m.get('providerModel')=='deepseek-flash' and m.get('configured') is True
assert m.get('decisionWindowEndMs',0)-m.get('round',0)==100
assert m.get('fallbackMarketDeadlineMs',0)-m.get('round',0)==15000
assert m.get('decisionRule')=='DEEPSEEK_100MS_THEN_CURRENT_ROUND_PRICE_FALLBACK'
assert m.get('maxCallsPerRound')==1 and m.get('learningDisabled') is True
assert m.get('trainingDisabled') is True and m.get('statisticsDisabled') is True
t=get(13001,'/api/status')
assert t.get('enabled') is b['followEnabled'],'FOLLOW_SWITCH_CHANGED'
assert get(13001,'/api/order-signal-model').get('model')=='DEEPSEEK_5M_V1'
h=get(13045,'/api/round-results?limit=1')
assert h.get('ok') is True and h.get('schema')=='ROUND_RESULTS_DISPLAY_ONLY_V1'
assert h.get('summary',{}).get('rounds',0)>=b['recordCount']
for unit in ('zl-prediction-deepseek5.service','zl-prediction-trade.service',
 'zl-prediction-risk-exits.service','zl-deepseek-results-display-only.service','zl-futures-bot-paper.service'):
 assert subprocess.run(['systemctl','is-active','--quiet',unit]).returncode==0,unit
print('FAST100_PRODUCTION_AI_DEADLINE_MS',100)
print('FAST100_PRODUCTION_REAL_PRICE_FALLBACK_POLICY_ENABLED=true')
print('FAST100_PRODUCTION_CURRENT_ROUND_QUOTE_REQUIRED=true')
print('FAST100_PRODUCTION_FALLBACK_GRACE_END_MS',15000)
print('FAST100_PRODUCTION_FOLLOW_STATE_UNCHANGED',t.get('enabled'))
print('FAST100_PRODUCTION_HISTORY_PRESERVED',h['summary']['rounds'])
print('FAST100_PRODUCTION_OTHER_SERVICES_NOT_RESTARTED=true')
PY
echo 'FAST100_PRODUCTION_RELEASE_SUCCESS=true'
echo "FAST100_ROLLBACK_BACKUP=$backup"
trap - ERR
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
  print('FAST100_BAD_RELEASE_REF');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 cmd=REMOTE.replace('COMMIT_SHA',sha)
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
  name='zl-restore-fast100-realprice-guarded-release',type='RunShellScript',
  command_content=cmd,working_user='root',timeout=260)).body.invoke_id
 for _ in range(150):
  time.sleep(2)
  result=c.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if result and str(result.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(result.output or '',validate=True).decode('utf8','replace')
   except Exception:out=str(result.output)
   print('FAST100_REMOTE_RESULT',result.invocation_status,'EXIT',result.exit_code)
   print(out[-13000:])
   return 0 if int(result.exit_code)==0 else 5
 print('FAST100_RESULT_UNKNOWN');return 6
if __name__=='__main__':sys.exit(main())

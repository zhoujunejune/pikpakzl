#!/usr/bin/env python3
"""Guarded production fix: preserve DeepSeek15 AI signal per new 5m round.
This deployment restarts only the AI model service; never touches trade switch,
risk exits, Binance orders, account credentials or futures services.
"""
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/deepseek15-crossround-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
node=/opt/zl-prediction-node/bin/node
app=/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs
test -x "$node" && test -f "$app"
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
test "$(systemctl is-active zl-prediction-trade.service)" = active
python3 - <<'PY'
import pathlib,json,hashlib,urllib.request
p=pathlib.Path('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs')
s=p.read_text()
assert hashlib.sha256(p.read_bytes()).hexdigest()=='7a3556600fe67cd7b9349245f8fc3ca8dc4a200e5e0713f848c95ca4d8fe7a1b','PRODUCTION_AI_SOURCE_DRIFT'
assert 'if(!saved&&clock()<round+LIMIT_MS)' in s
with urllib.request.urlopen('http://127.0.0.1:13029/api/status',timeout=6) as r:m=json.load(r)
assert m.get('configured') is True and m.get('decisionRule')=='DEEPSEEK_ONLY_ONE_CALL_15S_NO_PRICE_FALLBACK'
assert m.get('decisionWindowEndMs',0)-m.get('round',0)==15000
with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=6) as r:sel=json.load(r)
assert sel.get('model')=='DEEPSEEK_5M_V1'
print('CROSSROUND_LIVE_SOURCE_AND_SELECTED_MODEL_VERIFIED=true')
PY
temp=$(mktemp -d /tmp/zl-crossround.XXXXXXXX)
trap 'rm -rf "$temp"' EXIT
curl -fsSL --retry 2 --max-time 25 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/deepseek-single5-production.mjs" -o "$temp/new.mjs"
"$node" --check "$temp/new.mjs"
grep -Fq 'if(saved?.round!==round&&clock()<round+LIMIT_MS)' "$temp/new.mjs"
! grep -Fq 'if(!saved&&clock()<round+LIMIT_MS)' "$temp/new.mjs"
! grep -Fq 'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK' "$temp/new.mjs"
python3 - <<'PY'
import time
for i in range(165):
 ms=int(time.time()*1000)%300000
 if 36000 <= ms <= 230000:
  print('CROSSROUND_AI_ONLY_SAFE_RESTART_WINDOW_MS',ms);break
 time.sleep(1)
else:raise SystemExit('CROSSROUND_NO_SAFE_RESTART_WINDOW')
PY
backup=/var/lib/zl-prediction/archive/source-backups/deepseek15-crossround-COMMIT_SHA
test ! -e "$backup"
mkdir -p "$backup"
cp -p "$app" "$backup/original.mjs"
rollback(){
 echo 'CROSSROUND_ROLLBACK_TRIGGERED=true'
 cp -p "$backup/original.mjs" "$app"
 systemctl restart zl-prediction-deepseek5.service || true
}
trap rollback ERR
chown --reference="$app" "$temp/new.mjs"
chmod --reference="$app" "$temp/new.mjs"
cp -p "$temp/new.mjs" "$app"
systemctl restart zl-prediction-deepseek5.service
for i in $(seq 1 35);do
 if curl -fsS --max-time 4 http://127.0.0.1:13029/api/status -o "$temp/ai.json" 2>/dev/null;then break;fi
 sleep 1
done
python3 - "$temp/ai.json" <<'PY'
import json,sys,urllib.request,pathlib,subprocess
m=json.load(open(sys.argv[1]))
assert m.get('ok') is True and m.get('configured') is True
assert m.get('decisionRule')=='DEEPSEEK_ONLY_ONE_CALL_15S_NO_PRICE_FALLBACK'
assert m.get('decisionWindowEndMs',0)-m.get('round',0)==15000
assert m.get('maxCallsPerRound')==1
assert m.get('learningDisabled') is True
assert m.get('trainingDisabled') is True
s=pathlib.Path('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs').read_text()
assert 'if(saved?.round!==round&&clock()<round+LIMIT_MS)' in s
assert 'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK' not in s
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=6) as r:t=json.load(r)
assert t.get('ok') is True
with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=6) as r:x=json.load(r)
assert x.get('model')=='DEEPSEEK_5M_V1'
for unit in ('zl-prediction-trade.service','zl-prediction-risk-exits.service',
 'zl-deepseek-results-display-only.service','zl-futures-bot-paper.service'):
 assert subprocess.run(['systemctl','is-active','--quiet',unit]).returncode==0,unit
print('CROSSROUND_PRODUCTION_AI_ONLY_15S=true')
print('CROSSROUND_PRODUCTION_OLD_SAVED_SIGNAL_CANNOT_BLOCK_NEXT_ROUND=true')
print('CROSSROUND_USER_FOLLOW_ENABLED_UNCHANGED_BY_AI_RESTART=',t.get('enabled'))
print('CROSSROUND_UNRELATED_SERVICES_HEALTHY=true')
PY
echo 'CROSSROUND_PRODUCTION_FIX_SUCCESS=true'
echo "CROSSROUND_ROLLBACK_ARCHIVE=$backup"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 id=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
 name='zl-crossround-ai15-guarded-production-fix',type='RunShellScript',
 working_user='root',command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=240)).body.invoke_id
 for _ in range(130):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=id)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:msg=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:msg=str(r.output)
   print('CROSSROUND_REMOTE_RESULT',r.invocation_status,'EXIT',r.exit_code)
   print(msg[-14000:])
   return 0 if int(r.exit_code)==0 else 5
 print('CROSSROUND_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

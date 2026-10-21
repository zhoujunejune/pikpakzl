#!/usr/bin/env python3
"""Replace ONLY DeepSeek pre-analysis 15s source to prefer genuine UP/DOWN.
Preserve technical WAIT, true +15s stop, old history, trader, futures and shadow.
Guarded by follow-OFF and exact GitHub source comparisons; restores on failure.
"""
import base64,os,re,time,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/deepseek15-max-directional-20261021'
BASE_SHA='8474acbefaf10d6c9bc48b629283b365c30e928d'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
app=/opt/zl-prediction-live/deepseek5
node=/opt/zl-prediction-node/bin/node
test -x "$node" && test -d "$app"
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper zl-deepseek-shadow-online zl-deepseek-shadow15-online;do
 test "$(systemctl is-active "$svc")" = active || { echo "REQUIRED_SERVICE_DOWN=$svc";exit 10; }
done
python3 - <<'PY'
import urllib.request,json
def get(port,route):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}{route}',timeout=8) as r:return json.load(r)
p=get(13029,'/api/status');t=get(13001,'/api/status');m=get(13001,'/api/order-signal-model')
if t.get('enabled') is not False:raise SystemExit('FOLLOW_ENABLED_ABORT')
if m.get('model')!='DEEPSEEK_5M_V1':raise SystemExit('MODEL_SELECTOR_CHANGED_ABORT')
if p.get('model')!='DEEPSEEK_5M_V1' or p.get('providerModel')!='deepseek-flash':
 raise SystemExit('CURRENT_MODEL_NOT_EXPECTED')
if p.get('decisionWindowEndMs',0)-p.get('round',0)!=15000 or p.get('noSignalAfterDeadline') is not True:
 raise SystemExit('HARD_15S_DEADLINE_MISSING_ABORT')
if p.get('aiDirectionalRequired') is True:raise SystemExit('DIRECTIONAL_UPGRADE_ALREADY_PRESENT')
print('DIRECTIONAL15_PRECHECK_FOLLOW_OFF=true')
print('DIRECTIONAL15_PRESERVED_OFFICIAL_BEFORE',(p.get('learning') or {}).get('allOfficialSamples'))
print('DIRECTIONAL15_PRESERVED_WAIT_JOURNAL_BEFORE',p.get('recordedWaitRounds'))
PY
work=$(mktemp -d /tmp/zl-deepseek15-dir-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/base" "$work/updated"
for file in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 curl -fsSL --retry 2 --max-time 30 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/BASE_SHA/prediction-bot-v1/$file" -o "$work/base/$file"
 cmp -s "$app/$file" "$work/base/$file" || {
  echo "UNEXPECTED_INSTALLED_SOURCE_ABORT=$file";exit 12;
 }
 curl -fsSL --retry 2 --max-time 30 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/$file" -o "$work/updated/$file"
 "$node" --check "$work/updated/$file"
done
backup=/var/lib/zl-prediction/archive/source-backups/deepseek-directional15-COMMIT_SHA
mkdir -p "$backup"
for file in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 cp -p "$app/$file" "$backup/$file"
done
restore(){
 echo 'DIRECTIONAL15_ROLLBACK_STARTED=true'
 for file in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
  cp -p "$backup/$file" "$app/$file"
 done
 systemctl restart zl-prediction-deepseek5.service || true
}
trap restore ERR
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:s=json.load(r)
if s.get('enabled') is not False:raise SystemExit('FOLLOW_CHANGED_ABORT')
PY
# Changes only these three AI source files. Do not alter trader, Binance keys,
# existing official learner, historical state, financial balances or CPU shadows.
python3 - "$app" "$work/updated" <<'PY'
from pathlib import Path
import os,sys,tempfile
target,src=map(Path,sys.argv[1:])
for name in ('deepseek-adaptive15-core.mjs','deepseek-adaptive15-runner.mjs',
             'deepseek-adaptive15-production-adapter.mjs'):
 p=target/name;n=src/name;st=p.stat()
 fd,tmp=tempfile.mkstemp(prefix='.dir15-',dir=target)
 try:
  with os.fdopen(fd,'wb') as f:f.write(n.read_bytes())
  os.chmod(tmp,st.st_mode&0o777);os.chown(tmp,st.st_uid,st.st_gid)
  os.replace(tmp,p)
 finally:
  if os.path.exists(tmp):os.remove(tmp)
PY
systemctl restart zl-prediction-deepseek5.service
for _ in $(seq 1 18);do
 if curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$work/new.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$work/new.json"
python3 - "$work/new.json" <<'PY'
import json,sys,urllib.request
s=json.load(open(sys.argv[1]))
assert s.get('ok') is True and s.get('model')=='DEEPSEEK_5M_V1'
assert s.get('providerModel')=='deepseek-flash'
assert s.get('decisionWindowEndMs',0)-s.get('round',0)==15000
assert s.get('noSignalAfterDeadline') is True
assert s.get('aiDirectionalRequired') is True
assert s.get('skipOnLowConfidence') is False
assert s.get('skipOnWeakHistoricalDirection') is False
assert s.get('decisionRule')=='TWO_PASS_PREWARM_DIRECTIONAL_WITH_TECHNICAL_WAIT'
assert s.get('realOrderEnabled') is False
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:t=json.load(r)
assert t.get('enabled') is False
print('DIRECTIONAL15_LIVE_AI_REQUIRED_UP_DOWN=true')
print('DIRECTIONAL15_LIVE_HARD_STOP_MS=15000')
print('DIRECTIONAL15_LIVE_FOLLOW_STILL_OFF=true')
print('DIRECTIONAL15_PRESERVED_OFFICIAL_AFTER',(s.get('learning') or {}).get('allOfficialSamples'))
print('DIRECTIONAL15_PRESERVED_WAIT_JOURNAL_AFTER',s.get('recordedWaitRounds'))
PY
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper zl-deepseek-shadow-online zl-deepseek-shadow15-online;do
 test "$(systemctl is-active "$svc")" = active || exit 21
done
echo 'DIRECTIONAL15_EXISTING_TRADER_FUTURES_AND_SHADOWS_UNCHANGED=true'
echo "DIRECTIONAL15_PREVIOUS_VERSION_BACKUP=$backup"
trap - ERR
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
   access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
   region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
  name='zl-deepseek15-strong-directional-with-failclosed',
  type='RunShellScript',working_user='root',
  command_content=REMOTE.replace('COMMIT_SHA',sha).replace('BASE_SHA',BASE_SHA),timeout=180)).body.invoke_id
 for _ in range(95):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=r.output or ''
   try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
   except Exception:pass
   print('DIRECTIONAL15_REMOTE_EXIT',r.exit_code,'STATUS',r.invocation_status)
   print(raw[-5800:])
   return 0 if int(r.exit_code)==0 else 5
 print('DIRECTIONAL15_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

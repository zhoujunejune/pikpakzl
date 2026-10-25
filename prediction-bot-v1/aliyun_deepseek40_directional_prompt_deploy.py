#!/usr/bin/env python3
"""Safe AI40 prompt-only cutover: compare real UP/DOWN evidence, no synthetic signals."""
import os,sys,re,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

BRANCH='feat/deepseek40-45s-ai-only-prod-20261025'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/usr/bin/env bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
app=/opt/zl-prediction-live/deepseek5
core="$app/deepseek-adaptive15-core.mjs"
node=/opt/zl-prediction-node/bin/node
test -x "$node" && test -f "$core"
for service in zl-prediction-trade zl-prediction-deepseek5 zl-prediction-v2 zl-prediction-v3 zl-futures-bot-paper;do
 test "$(systemctl is-active "$service")" = active || { echo "MODEL40_SERVICE_INACTIVE=$service";exit 14; }
done
python3 - <<'PY'
import json,urllib.request,hashlib
from pathlib import Path
def get(port,p):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}{p}',timeout=7) as res:return json.load(res)
trade=get(13001,'/api/status')
ai=get(13029,'/api/status')
assert trade.get('enabled') is False, 'FOLLOW_MUST_REMAIN_OFF'
assert trade.get('orderSignalModel')=='DEEPSEEK_5M_V1', 'MODEL_CHANGED'
assert ai.get('decisionRule')=='PREWARM120_NEW_ROUND15_LIVE_DEEPSEEK_ONLY40S'
assert ai.get('aiDirectionalRequired') is True
assert ai.get('maxCallsPerRound')==5
assert get(13029,'/api/history?limit=1').get('ok') is True
core=Path('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-core.mjs')
expected='df54b6d0de4d3f4eb84211a0b5bfeb43e2bf7adbd1737296ecbf54b473e3fe33'
assert hashlib.sha256(core.read_bytes()).hexdigest()==expected,'CORE_DRIFT_ABORT'
assert "WAIT is a valid final decision for weak evidence" in core.read_text(),'OLD_PROMPT_UNEXPECTED'
print('MODEL40_PRECHECK_FOLLOW_OFF=true')
print('MODEL40_OLD_PROMPT_SHA_VALID=true')
PY
temp=$(mktemp -d /tmp/zl-deepseek40-rank-XXXXXXXX)
trap 'rm -rf "$temp"' EXIT
curl -fsSL --retry 2 --max-time 35 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/deepseek-adaptive15-core.mjs" -o "$temp/deepseek-adaptive15-core.mjs"
"$node" --check "$temp/deepseek-adaptive15-core.mjs"
python3 - "$temp/deepseek-adaptive15-core.mjs" <<'PY'
import sys
s=open(sys.argv[1]).read()
assert s.count('export const DEADLINE_MS=40000;')==1
assert s.count('export const COLLECT_MS=120000;')==1
assert 'rank UP and DOWN using verified live opening price' in s
assert 'Do not default to WAIT just because short-term BTC outcomes are uncertain' in s
assert 'Never invent a directional edge' in s
assert "preferActionableDirectionalRanking:pass==='current'" in s
assert "if(current.direction==='WAIT')return recordWait(w,'DEEPSEEK_CHOSE_WAIT',now);" in s
assert "if(!current||current.at<w.round+15000||current.at>=w.round+DEADLINE_MS)" in s
print('MODEL40_REQUIRED_AI_ONLY_AND_WAIT_GUARDS_PRESERVED=true')
PY
backup=/var/lib/zl-prediction/archive/source-backups/deepseek40-prompt-compare-COMMIT_SHA
mkdir -p "$backup"
cp -p "$core" "$backup/deepseek-adaptive15-core.mjs"
rollback(){
 echo 'MODEL40_PROMPT_ROLLBACK_STARTED=true'
 cp -p "$backup/deepseek-adaptive15-core.mjs" "$core"
 systemctl restart zl-prediction-deepseek5.service || true
 echo 'MODEL40_PROMPT_ROLLBACK_ATTEMPTED=true'
}
trap rollback ERR
python3 - <<'PY'
import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as res:s=json.load(res)
assert s.get('enabled') is False,'FOLLOW_CHANGED_ABORT'
PY
python3 - "$core" "$temp/deepseek-adaptive15-core.mjs" <<'PY'
from pathlib import Path
import sys,os,tempfile
dest,src=map(Path,sys.argv[1:])
st=dest.stat();fd,tmp=tempfile.mkstemp(prefix='.ai40-prompt-',dir=str(dest.parent))
try:
 with os.fdopen(fd,'wb') as f:f.write(src.read_bytes())
 os.chmod(tmp,st.st_mode&0o777)
 os.chown(tmp,st.st_uid,st.st_gid)
 os.replace(tmp,dest)
finally:
 if os.path.exists(tmp):os.unlink(tmp)
PY
# Model-only restart; the trade / web frontend is never restarted.
systemctl restart zl-prediction-deepseek5.service
for k in $(seq 1 25);do
 if curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$temp/ai.json" 2>/dev/null &&
  curl -fsS --max-time 3 http://127.0.0.1:13029/api/history?limit=1 -o "$temp/history.json" 2>/dev/null &&
  curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$temp/trade.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$temp/ai.json" && test -s "$temp/history.json" && test -s "$temp/trade.json"
python3 - "$temp/ai.json" "$temp/history.json" "$temp/trade.json" <<'PY'
import json,sys
a,h,t=map(lambda x:json.load(open(x)),sys.argv[1:])
assert a.get('ok') and a.get('model')=='DEEPSEEK_5M_V1'
assert a.get('decisionRule')=='PREWARM120_NEW_ROUND15_LIVE_DEEPSEEK_ONLY40S'
assert a.get('maxCallsPerRound')==5 and a.get('aiDirectionalRequired') is True
assert a.get('reasoning',{}).get('enabled') is True
assert a.get('learning',{}).get('autoFeedback') is True
assert h.get('ok') is True
assert t.get('enabled') is False
print('MODEL40_UPDOWN_RANKING_DEPLOYED=true')
print('MODEL40_AI_ONLY_NO_FALLBACK=true')
print('MODEL40_HISTORY_PRESERVED=true')
print('MODEL40_FOLLOW_STILL_OFF=true')
PY
for service in zl-prediction-trade zl-prediction-deepseek5 zl-prediction-v2 zl-prediction-v3 zl-futures-bot-paper;do
 test "$(systemctl is-active "$service")" = active || exit 22
done
echo 'MODEL40_BACKEND_SERVICES_OK=true'
echo "MODEL40_BACKUP=$backup"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch(r'[0-9a-f]{40}',sha):
  print('MODEL40_WRONG_RELEASE_REF');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
 instance_id=INSTANCE,name='zl-ai40-two-sided-llm-prompt-guarded',
 type='RunShellScript',working_user='root',
 command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=180)).body.invoke_id
 for _ in range(97):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
  instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   output=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   print('MODEL40_RELEASE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(output[-9200:])
   return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 else 5
 print('MODEL40_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

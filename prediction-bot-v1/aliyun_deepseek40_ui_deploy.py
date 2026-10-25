#!/usr/bin/env python3
"""Guarded, presentation-only deploy for Alibaba DeepSeek 40/45s UI. No order or AI changes."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

BRANCH='feat/deepseek40-45s-ai-only-prod-20261025'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
app=/opt/zl-prediction-live/src/railway-diagnostic
panel="$app/panel-stats-shell.mjs"
module="$app/ai40-dashboard-inject.mjs"
node=/opt/zl-prediction-node/bin/node
test -x "$node" && test -f "$panel" && ! test -e "$module"
for svc in zl-prediction-trade zl-prediction-deepseek5 zl-prediction-v2 zl-prediction-v3 zl-futures-bot-paper;do
 test "$(systemctl is-active "$svc")" = active || { echo "AI40_UI_SERVICE_MISSING=$svc";exit 10; }
done
python3 - <<'PY'
import json,urllib.request,hashlib
from pathlib import Path
def get(port,route):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,route),timeout=8) as r:return json.load(r)
s=get(13029,'/api/status');trade=get(13001,'/api/status')
assert trade.get('enabled') is False, 'FOLLOW_MUST_REMAIN_OFF'
assert s.get('model')=='DEEPSEEK_5M_V1'
assert s.get('decisionRule')=='PREWARM120_NEW_ROUND15_LIVE_DEEPSEEK_ONLY40S'
assert s.get('aiDirectionalRequired') is True
p=Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
assert hashlib.sha256(p.read_bytes()).hexdigest()=='3494ade54a34d1682e7dc383edee93f8aafc8a3a617771dc258349ff7bbad889','PANEL_SOURCE_CHANGED_ABORT'
with urllib.request.urlopen('http://127.0.0.1:13001/',timeout=8) as res:
 html=res.read().decode('utf8','replace')
assert 'id="roundResultsOnlyCard"' in html and 'id="zlDeepSeek40Card"' not in html
assert Path('/etc/caddy/Caddyfile').read_text().count('handle_path /deepseek/*')>=1
print('AI40_UI_SOURCE_GUARD_SUCCESS=true')
print('AI40_UI_CURRENT_AI40_CONFIRMED=true')
print('AI40_UI_FOLLOW_OFF_CONFIRMED=true')
PY
work=$(mktemp -d /tmp/zl-ai40-display-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 3 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/ai40-dashboard-inject.mjs" -o "$work/ai40-dashboard-inject.mjs"
"$node" --check "$work/ai40-dashboard-inject.mjs"
python3 - "$panel" "$work/panel-stats-shell.mjs" <<'PY'
from pathlib import Path
import sys
source=Path(sys.argv[1]).read_text()
assert source.count("import http from 'node:http';")==1
assert source.count('function injectStats(html) { return html; }')==1
patched=source.replace("import http from 'node:http';",
 "import http from 'node:http';\nimport {injectAi40Dashboard} from './ai40-dashboard-inject.mjs';",1)
patched=patched.replace('function injectStats(html) { return html; }',
 'function injectStats(html) { return injectAi40Dashboard(html); }',1)
assert patched.count('injectAi40Dashboard')==2
Path(sys.argv[2]).write_text(patched)
print('AI40_UI_ONLY_HTML_INTERCEPT_CHANGED=true')
PY
"$node" --check "$work/panel-stats-shell.mjs"
# Snapshot presentation-only source, leave trading, keys, model & order buffers untouched.
backup=/var/lib/zl-prediction/archive/source-backups/ai40-front-COMMIT_SHA
mkdir -p "$backup"
cp -p "$panel" "$backup/panel-stats-shell.mjs"
rollback(){
 echo 'AI40_UI_ROLLBACK_STARTED=true'
 cp -p "$backup/panel-stats-shell.mjs" "$panel"
 rm -f "$module"
 systemctl restart zl-prediction-trade.service || true
 echo 'AI40_UI_ROLLBACK_ATTEMPTED=true'
}
trap rollback ERR
python3 - <<'PY'
import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=8) as r:s=json.load(r)
assert s.get('enabled') is False,'FOLLOW_CHANGED_ABORT'
PY
python3 - "$panel" "$module" "$work" <<'PY'
from pathlib import Path
import os,tempfile,sys
panel,module,tmp=map(Path,sys.argv[1:])
def write_atomic(dest,data,mode=None,owner=None):
 fd,temp=tempfile.mkstemp(prefix='.ai40-',dir=str(dest.parent))
 try:
  with os.fdopen(fd,'wb') as f:f.write(data)
  if mode is not None:os.chmod(temp,mode)
  if owner is not None:os.chown(temp,*owner)
  os.replace(temp,dest)
 finally:
  if os.path.exists(temp):os.unlink(temp)
st=panel.stat()
write_atomic(module,(tmp/module.name).read_bytes(),mode=st.st_mode&0o777,owner=(st.st_uid,st.st_gid))
write_atomic(panel,(tmp/panel.name).read_bytes(),mode=st.st_mode&0o777,owner=(st.st_uid,st.st_gid))
PY
systemctl restart zl-prediction-trade.service
for i in $(seq 1 20);do
 if curl -fsS --max-time 4 http://127.0.0.1:13001/ -o "$work/page.html" 2>/dev/null &&
   curl -fsS --max-time 4 http://127.0.0.1:13001/api/status -o "$work/status.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$work/page.html" && test -s "$work/status.json"
python3 - "$work/page.html" "$work/status.json" <<'PY'
from pathlib import Path
import sys,json,re
page=Path(sys.argv[1]).read_text()
trade=json.loads(Path(sys.argv[2]).read_text())
assert page.count('id="zlDeepSeek40Card"')==1
assert '提前120秒预分析' in page and '15～40秒' in page and '45秒' in page
assert 'id="roundResultsOnlyCard"' in page
assert 'data-legacy-five-second' in page
assert 'PREWARM120_NEW_ROUND15_LIVE_DEEPSEEK_ONLY40S' in page
assert '/deepseek/api/status' in page and '/deepseek/api/history' in page
assert trade.get('enabled') is False and trade.get('orderSignalModel')=='DEEPSEEK_5M_V1'
print('AI40_UI_INJECTED_ON_REAL_FRONTEND=true')
print('AI40_UI_LEGACY_5S_SEPARATELY_COLLAPSED=true')
print('AI40_UI_REAL_LLM_STATUS_AND_LEARNING_VISIBLE=true')
print('AI40_UI_FOLLOW_STILL_OFF=true')
PY
for svc in zl-prediction-trade zl-prediction-deepseek5 zl-prediction-v2 zl-prediction-v3 zl-futures-bot-paper;do
 test "$(systemctl is-active "$svc")" = active || exit 40
done
echo 'AI40_UI_ALL_OTHER_SERVICES_ACTIVE=true'
echo "AI40_UI_BACKUP=$backup"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch(r'[a-f0-9]{40}',sha):
  print('AI40_UI_INVALID_BRANCH');return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id=INSTANCE,name='zl-ai40-frontend-only-guarded',type='RunShellScript',
  working_user='root',command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=160)).body.invoke_id
 for _ in range(90):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   print('AI40_UI_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(raw[-8000:])
   return 0 if int(r.exit_code)==0 else 5
 print('AI40_UI_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

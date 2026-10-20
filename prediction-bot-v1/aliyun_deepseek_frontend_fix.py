#!/usr/bin/env python3
"""Deploy ONLY DeepSeek-safe frontend statistics; no trading model or orders edited."""
import os,re,base64,time,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,urllib.request,urllib.error,subprocess,pathlib
for unit in ('zl-prediction-trade','zl-prediction-v2','zl-prediction-panel','zl-prediction-native-models','zl-prediction-deepseek5'):
 p=subprocess.run(['systemctl','show',unit,'--property=LoadState,ActiveState,ExecStart','--no-pager'],capture_output=True,text=True)
 for line in p.stdout.splitlines():
  if line.startswith('ExecStart='):line=line.split(' ;',1)[0][:220]
  print('FRONTEND_UNIT',unit,line[:230])
s=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
if s.is_file():
 txt=s.read_text()
 print('FRONTEND_FILE_EXISTS=true')
 print('FRONTEND_DEEPSEEK_RENDER_INSTALLED', 'async function renderDeepSeekRoundStats' in txt)
 print('FRONTEND_DEEPSEEK_HISTORY_FETCH_INSTALLED', "/deepseek/api/history" in txt)
else:print('FRONTEND_FILE_EXISTS=false')
for route in ('/api/status','/api/history'):
 try:
  with urllib.request.urlopen('http://127.0.0.1:13029'+route,timeout=8) as response:
   code=response.status;body=json.load(response)
 except urllib.error.HTTPError as e:code=e.code;body={}
 except Exception:code=0;body={}
 print('FRONTEND_DEEPSEEK',route,'HTTP',code,'MODEL',body.get('model'),'RECORDS',len(body.get('records',[])))
try:
 with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=8) as r:d=json.load(r)
 print('FRONTEND_PRODUCTION_SELECTED',d.get('model'))
except Exception as e:print('FRONTEND_PRODUCTION_ERROR',type(e).__name__)
PY
if [ "IS_PREVIEW" = 1 ];then
 echo 'FRONTEND_DRY_RUN_ONLY=true'
 exit 0
fi
test "$(systemctl is-active zl-prediction-trade)" = active
test "$(curl -s --max-time 6 -o /dev/null -w '%{http_code}' http://127.0.0.1:13029/api/history)" = 200
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=7) as r:d=json.load(r)
assert d.get('model')=='DEEPSEEK_5M_V1' and [m.get('id') for m in d.get('models',[])]==['DEEPSEEK_5M_V1']
with urllib.request.urlopen('http://127.0.0.1:13029/api/history',timeout=7) as r:h=json.load(r)
assert h.get('model')=='DEEPSEEK_5M_V1' and h.get('ok') is True and isinstance(h.get('records'),list)
print('FRONTEND_PREDEPLOY_DEEPSEEK_READY=true')
PY
temp=$(mktemp /tmp/zl-deepseek-panel.XXXXXXXX.mjs)
trap 'rm -f "$temp"' EXIT
curl -fsSL --retry 3 --max-time 35 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/railway-diagnostic/panel-stats-shell.mjs" -o "$temp"
/opt/zl-prediction-node/bin/node --check "$temp"
grep -q 'async function renderDeepSeekRoundStats' "$temp"
grep -q "/deepseek/api/history" "$temp"
dst=/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs
test -f "$dst"
backup=/var/lib/zl-prediction/archive/source-backups/deepseek-panel-$(date -u +%Y%m%dT%H%M%SZ).mjs
mkdir -p "$(dirname "$backup")"
cp -p "$dst" "$backup"
staged="$dst".deepseek-ui-pending
cp -p "$temp" "$staged"
chown --reference="$dst" "$staged"
chmod --reference="$dst" "$staged"
mv -f "$staged" "$dst"
if ! systemctl restart zl-prediction-trade.service;then
 cp -p "$backup" "$dst"
 systemctl restart zl-prediction-trade.service || true
 echo 'FRONTEND_RESTORED_AFTER_RESTART_FAILURE=true'
 exit 6
fi
python3 - <<'PY'
import urllib.request,json,time
for i in range(25):
 try:
  with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=7) as r:j=json.load(r)
  if j.get('model')=='DEEPSEEK_5M_V1':
   print('FRONTEND_PRODUCTION_MODEL_UNCHANGED=true');break
 except Exception:time.sleep(2)
else:raise SystemExit('FRONTEND_PRODUCTION_UNAVAILABLE')
PY
echo 'FRONTEND_DEEPSEEK_STATS_CODE_INSTALLED=true'
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch(r'[0-9a-f]{40}',sha):
  print('FRONTEND_REF_INVALID');return 2
 dry=os.environ.get('DEEPSEEK_UI_PREVIEW')=='1'
 cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
    access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',
    endpoint='swas.ap-southeast-1.aliyuncs.com'))
 script=SCRIPT.replace('COMMIT_SHA',sha).replace('IS_PREVIEW','1' if dry else '0')
 try:
  inv=cli.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
    instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='zl-deepseek-panel-'+('audit' if dry else 'frontend-deploy'),
    type='RunShellScript',working_user='root',command_content=script,timeout=190)).body.invoke_id
  for _ in range(80):
   time.sleep(2)
   x=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
     instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
   if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    s=x.output or ''
    try:s=base64.b64decode(s,validate=True).decode('utf8','replace')
    except Exception:pass
    print('FRONTEND_ALI_STATUS',x.invocation_status,'EXIT',x.exit_code)
    print(s[-11500:])
    return 0 if str(x.invocation_status)=='Success' and int(x.exit_code)==0 else 4
  print('FRONTEND_TIMEOUT');return 5
 except Exception as e:
  print('FRONTEND_ERROR',type(e).__name__);return 6
if __name__=='__main__':sys.exit(main())

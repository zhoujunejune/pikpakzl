#!/usr/bin/env python3
"""Restore the pre-DeepSeek-UI Alibaba panel from its verified local backup.
Emergency availability restoration only. No trading, model, or secret changes.
"""
import os,sys,re,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
dst=/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs
test -f "$dst"
backup=$(find /var/lib/zl-prediction/archive/source-backups -maxdepth 1 -type f -name 'deepseek-panel-*.mjs' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
test -n "$backup"
test -f "$backup"
/opt/zl-prediction-node/bin/node --check "$backup"
grep -q 'const statsScript' "$backup"
if grep -q 'async function renderDeepSeekRoundStats' "$backup";then
 echo 'EMERGENCY_BACKUP_IS_NOT_ORIGINAL=true'
 exit 4
fi
cp -p "$backup" "$dst"
echo 'PANEL_ORIGINAL_FILE_RESTORED=true'
systemctl restart zl-prediction-trade.service
python3 - <<'PY'
import urllib.request,json,time
for i in range(45):
 try:
  with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=6) as res:
   data=json.load(res)
  if data.get('model')=='DEEPSEEK_5M_V1':
   print('PANEL_PRODUCTION_SELECTOR_RESPONDING=true')
   break
 except Exception:
  time.sleep(2)
else:raise SystemExit('PANEL_RESTORE_STATUS_NOT_READY')
print('PANEL_EMERGENCY_ROLLBACK_COMPLETED=true')
PY
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch(r'[0-9a-f]{40}',sha):return 2
 cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',
  endpoint='swas.ap-southeast-1.aliyuncs.com'))
 try:
  i=cli.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   type='RunShellScript',name='zl-emergency-prediction-panel-rollback',
   working_user='root',command_content=SCRIPT,timeout=260)).body.invoke_id
  for _ in range(110):
   time.sleep(2)
   r=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(
    region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
    invoke_id=i)).body.invocation_result
   if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    try:s=base64.b64decode(r.output or '',validate=True).decode('utf-8','replace')
    except Exception:s=r.output or ''
    print('PANEL_RESTORE_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
    print(s[-3500:])
    return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 else 5
  return 6
 except Exception as e:
  print('PANEL_RESTORE_ERROR',type(e).__name__);return 7
if __name__=='__main__':sys.exit(main())

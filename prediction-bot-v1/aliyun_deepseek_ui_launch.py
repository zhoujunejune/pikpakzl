#!/usr/bin/env python3
"""SWAS preauthorized deployment runner for the read-only DeepSeek stats panel hotfix."""
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[a-f0-9]{40}',sha):
  print('UI_DEPLOY_REF_INVALID');return 2
 dry=os.getenv('DEEPSEEK_UI_DRY_RUN')=='1'
 command=r"""#!/bin/bash
set -euo pipefail
tmp=$(mktemp -d /tmp/zl-deepseek-ui.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT
root="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA"
curl -fsSL --retry 3 --max-time 35 "$root/prediction-bot-v1/aliyun_deepseek_ui_hotfix.py" -o "$tmp/hotfix.py"
curl -fsSL --retry 3 --max-time 35 "$root/railway-diagnostic/panel-stats-shell.mjs" -o "$tmp/panel-stats-shell.mjs"
python3 -m py_compile "$tmp/hotfix.py"
python3 "$tmp/hotfix.py" --donor "$tmp/panel-stats-shell.mjs" DRY_FLAG
""".replace('COMMIT_SHA',sha).replace('DRY_FLAG','--dry-run' if dry else '')
 try:
  cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
  invoke=cli.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='zl-deepseek-ui-'+('dryrun' if dry else 'hotfix'),type='RunShellScript',working_user='root',command_content=command,timeout=200)).body.invoke_id
  for _ in range(80):
   time.sleep(3)
   r=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=invoke)).body.invocation_result
   if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    out=r.output or ''
    try:out=base64.b64decode(out,validate=True).decode('utf8','replace')
    except Exception:pass
    print('UI_REMOTE_STATUS',str(r.invocation_status),'EXIT',r.exit_code)
    print(out[-6200:])
    return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 else 5
  print('UI_REMOTE_TIMEOUT');return 6
 except Exception as e:
  print('UI_REMOTE_FAILURE',type(e).__name__);return 7

if __name__=='__main__':sys.exit(main())

#!/usr/bin/env python3
"""Run the already-authenticated SWAS DeepSeek adaptive deadline patch."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch(r'[a-f0-9]{40}',sha):
  print('DEEPSEEK_DYNAMIC_REF_INVALID');return 2
 dry=os.getenv('DEEPSEEK_DYNAMIC_DRY_RUN')=='1'
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 command=r"""#!/bin/bash
set -Eeuo pipefail
f=$(mktemp /tmp/zl-deepseek-dynamic.XXXXXXXX.py)
trap 'rm -f "$f"' EXIT
curl -fsSL --retry 3 --max-time 30 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/aliyun_deepseek_dynamic_window.py" -o "$f"
python3 -m py_compile "$f"
DEEPSEEK_DYNAMIC_DRY_RUN=DRY_VALUE python3 "$f"
""".replace('COMMIT_SHA',sha).replace('DRY_VALUE','1' if dry else '0')
 try:
  inv=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   name='zl-deepseek-dynamic-'+('preflight' if dry else 'production'),
   type='RunShellScript',working_user='root',command_content=command,timeout=240)).body.invoke_id
  for _ in range(78):
   time.sleep(3)
   r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
    instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
   if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    out=r.output or ''
    try:out=base64.b64decode(out,validate=True).decode('utf-8','replace')
    except Exception:pass
    print('DEEPSEEK_DYNAMIC_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
    print(out[-6800:])
    return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 else 5
  return 6
 except Exception as e:
  print('DEEPSEEK_DYNAMIC_LAUNCH_ERROR',type(e).__name__);return 7
if __name__=='__main__':sys.exit(main())

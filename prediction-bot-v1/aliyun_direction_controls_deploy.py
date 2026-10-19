#!/usr/bin/env python3
"""Deploy PIN-free direction controls behind Alibaba's existing HTTPS login."""
import os,time,sys,base64,re
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REGION='ap-southeast-1';INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
SOURCE_SHA='a079daf29cea937442dba0d0f8937c7f7f13742b'
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[0-9a-f]{40}',sha):return 2
 key=os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_ID');secret=os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET')
 if not key or not secret:return 3
 client=Client(api.Config(access_key_id=key,access_key_secret=secret,region_id=REGION,
  endpoint='swas.ap-southeast-1.aliyuncs.com'))
 script='''#!/bin/bash
set -Eeuo pipefail
f=$(mktemp)
trap 'rm -f "$f"' EXIT
curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/zhoujunejune/pikpakzl/INSTALL_SHA/prediction-bot-v1/aliyun_direction_controls_install.sh -o "$f"
bash -n "$f"
export DIRECTION_SOURCE_SHA=PINNED_SOURCE_SHA
bash "$f"
'''.replace('INSTALL_SHA',sha).replace('PINNED_SOURCE_SHA',SOURCE_SHA)
 try:
  task=client.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
   name='zl-prediction-direction-no-pin',type='RunShellScript',
   command_content=script,working_user='root',timeout=420))
  for _ in range(120):
   time.sleep(3)
   r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
    region_id=REGION,instance_id=INSTANCE,invoke_id=task.body.invoke_id)).body.invocation_result
   if not r:continue
   status=str(r.invocation_status)
   if status in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    output=r.output or ''
    try:output=base64.b64decode(output,validate=True).decode('utf8','replace')
    except Exception:pass
    print('DIRECTION_DEPLOY_STATUS',status,'EXIT',r.exit_code)
    print(output[-6000:])
    return 0 if status=='Success' and int(r.exit_code)==0 else 5
  print('DIRECTION_DEPLOY_TIMEOUT');return 6
 except Exception as e:
  print('DIRECTION_DEPLOY_ERROR',type(e).__name__);return 7
if __name__=='__main__':sys.exit(main())

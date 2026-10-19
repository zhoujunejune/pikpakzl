#!/usr/bin/env python3
"""Retire the progress visualization on Alibaba, not its shared order backend."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SOURCE_SHA='a079daf29cea937442dba0d0f8937c7f7f13742b'
REGION='ap-southeast-1'; INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[0-9a-f]{40}',sha):
  print('FLOW_REMOVAL_WRONG_SOURCE');return 2
 key=os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID');secret=os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET')
 if not key or not secret:print('FLOW_REMOVAL_NO_ALIBABA_CREDS');return 3
 client=Client(api.Config(access_key_id=key,access_key_secret=secret,
  region_id=REGION,endpoint='swas.ap-southeast-1.aliyuncs.com'))
 script='''#!/bin/bash
set -Eeuo pipefail
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsSL --retry 3 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/INSTALL_SHA/prediction-bot-v1/aliyun_remove_trade_progress.sh" -o "$TMP"
bash -n "$TMP"
export FLOW_SOURCE_SHA=SOURCE_SHA
bash "$TMP"
'''.replace('INSTALL_SHA',sha).replace('SOURCE_SHA',SOURCE_SHA)
 try:
  job=client.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
   name='zl-retire-trade-progress-ui',type='RunShellScript',
   command_content=script,working_user='root',timeout=360))
  for _ in range(115):
   time.sleep(3)
   r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
    region_id=REGION,instance_id=INSTANCE,invoke_id=job.body.invoke_id)).body.invocation_result
   if not r:continue
   status=str(r.invocation_status)
   if status in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    raw=r.output or ''
    try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
    except Exception:pass
    print('FLOW_REMOVAL_DEPLOY_STATUS',status,'EXIT',r.exit_code)
    print(raw[-6300:])
    return 0 if status=='Success' and int(r.exit_code)==0 else 5
  print('FLOW_REMOVAL_DEPLOY_TIMEOUT');return 6
 except Exception as e:
  print('FLOW_REMOVAL_DEPLOY_FAILURE',type(e).__name__);return 7
if __name__=='__main__':sys.exit(main())

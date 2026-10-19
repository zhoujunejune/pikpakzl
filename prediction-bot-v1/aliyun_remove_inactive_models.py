#!/usr/bin/env python3
"""Owner-approved Alibaba cleanup of retired models (no exchange order mutation)."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SOURCE_SHA='5cc579e7cc70239a3d90a054d034f620adfd0d16'
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 cmd='''#!/bin/bash
set -Eeuo pipefail
f=$(mktemp)
trap 'rm -f "$f"' EXIT
curl -fsSL --retry 3 --max-time 35 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/INSTALL_SHA/prediction-bot-v1/aliyun_remove_inactive_models.sh" -o "$f"
bash -n "$f"
export PRED_CLEANUP_SHA=SOURCE_SHA
bash "$f"
'''.replace('INSTALL_SHA',sha).replace('SOURCE_SHA',SOURCE_SHA)
 run=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  name='zl-remove-retired-prediction-models',type='RunShellScript',
  command_content=cmd,working_user='root',timeout=700))
 for _ in range(160):
  time.sleep(4)
  result=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   invoke_id=run.body.invoke_id)).body.invocation_result
  if not result:continue
  status=str(result.invocation_status)
  if status in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(result.output or '',validate=True).decode('utf8','replace')
   except Exception:out=result.output or ''
   print('CLEANUP_DEPLOY_STATUS',status,'EXIT',result.exit_code)
   print(out[-12000:])
   return 0 if status=='Success' and int(result.exit_code)==0 else 5
 print('CLEANUP_DEPLOY_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

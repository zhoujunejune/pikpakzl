#!/usr/bin/env python3
"""Restore owner-configurable Binance Prediction TP/SL using Alibaba SWAS."""
import os,re,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REGION='ap-southeast-1';INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
SOURCE_SHA='f295b1624c0af5a4ff1b7b31571d0ca4c7503a2b'
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[0-9a-f]{40}',sha):
  print('RISK_WRONG_BRANCH');return 2
 key=os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID');secret=os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET')
 if not key or not secret:print('RISK_DEPLOYMENT_CREDENTIALS_MISSING');return 3
 cl=Client(api.Config(access_key_id=key,access_key_secret=secret,
  region_id=REGION,endpoint='swas.ap-southeast-1.aliyuncs.com'))
 cmd='''#!/bin/bash
set -Eeuo pipefail
t=$(mktemp)
trap 'rm -f "$t"' EXIT
curl -fsSL --retry 3 --max-time 35 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/__OPS_SHA__/prediction-bot-v1/aliyun_fix_risk_controls.sh" -o "$t"
bash -n "$t"
export RISK_SOURCE_SHA=__PIN_SHA__
bash "$t"
'''.replace('__OPS_SHA__',sha).replace('__PIN_SHA__',SOURCE_SHA)
 try:
  inv=cl.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
   name='zl-alibaba-restore-tp-sl-persistence',type='RunShellScript',
   command_content=cmd,working_user='root',timeout=480))
  for _ in range(145):
   time.sleep(3)
   result=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,
    instance_id=INSTANCE,invoke_id=inv.body.invoke_id)).body.invocation_result
   if not result:continue
   status=str(result.invocation_status)
   if status in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    try:out=base64.b64decode(result.output or '',validate=True).decode('utf8','replace')
    except Exception:out=result.output or ''
    print('RISK_DEPLOY_STATUS',status,'EXIT',result.exit_code)
    print(out[-7900:])
    return 0 if status=='Success' and int(result.exit_code)==0 else 5
  print('RISK_DEPLOY_TIMEOUT');return 6
 except Exception as e:
  print('RISK_DEPLOY_ERROR',type(e).__name__)
  return 7
if __name__=='__main__':sys.exit(main())

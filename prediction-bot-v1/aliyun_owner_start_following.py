#!/usr/bin/env python3
"""Secure SWAS installation of owner-clickable Binance Prediction auto-follow."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SHA='e808f32ed5e398f97da8188516a91178e0a3a17f'
REGION='ap-southeast-1'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
def main():
 branch=os.environ.get('GITHUB_REF_NAME','')
 ops_sha=os.environ.get('GITHUB_SHA','')
 if branch!='feature/zl-futures-bot-v1' or not re.fullmatch('[a-f0-9]{40}',ops_sha):return 2
 key=os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_ID')
 secret=os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET')
 if not key or not secret:return 3
 client=Client(api.Config(access_key_id=key,access_key_secret=secret,region_id=REGION,
  endpoint='swas.ap-southeast-1.aliyuncs.com'))
 script='''#!/bin/bash
set -Eeuo pipefail
f=$(mktemp)
trap 'rm -f "$f"' EXIT
curl -fsSL --retry 3 --max-time 35 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/__OPS_SHA__/prediction-bot-v1/aliyun_owner_start_following.sh" -o "$f"
bash -n "$f"
export FOLLOW_SOURCE_SHA=__APP_SHA__
bash "$f"
'''.replace('__OPS_SHA__',ops_sha).replace('__APP_SHA__',SHA)
 try:
  cmd=client.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
   name='zl-allow-owner-click-autofollow',type='RunShellScript',command_content=script,
   working_user='root',timeout=500))
  for _ in range(145):
   time.sleep(3)
   res=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,
    instance_id=INSTANCE,invoke_id=cmd.body.invoke_id)).body.invocation_result
   if not res:continue
   status=str(res.invocation_status)
   if status in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    try:out=base64.b64decode(res.output or '',validate=True).decode('utf8','replace')
    except Exception:out=res.output or ''
    print('FOLLOW_DEPLOY_STATUS',status,'EXIT',res.exit_code)
    print(out[-9000:])
    return 0 if status=='Success' and int(res.exit_code)==0 else 5
  print('FOLLOW_DEPLOY_TIMEOUT');return 6
 except Exception as e:
  print('FOLLOW_DEPLOY_FAILED',type(e).__name__)
  return 7
if __name__=='__main__':sys.exit(main())

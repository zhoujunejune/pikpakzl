#!/usr/bin/env python3
"""Audit sandbox settings of running risk worker, without changing service."""
import os,re,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/risk-sell-journal-erofs-20261023'
REMOTE="""#!/bin/bash
set -eu
for k in ProtectSystem ReadWritePaths ReadOnlyPaths StateDirectory User Group; do
  v=$(systemctl show zl-prediction-risk-exits.service --property="$k" --value)
  echo "JOURNAL_SANDBOX_$k=$v"
done
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[0-9a-f]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',
 endpoint='swas.ap-southeast-1.aliyuncs.com'))
 i=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
 instance_id='b67374069bb3457ba6a3a2ede9305d3f',
 name='zl-tpsl-readonly-mount-debug',type='RunShellScript',
 working_user='root',command_content=REMOTE,timeout=60)).body.invoke_id
 for _ in range(40):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=i)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:msg=base64.b64decode(r.output or '').decode(errors='replace')
   except Exception:msg=str(r.output)
   print('JOURNAL_SANDBOX_REMOTE',r.invocation_status,'exit',r.exit_code)
   print(msg[-3500:])
   return 0 if int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':raise SystemExit(main())

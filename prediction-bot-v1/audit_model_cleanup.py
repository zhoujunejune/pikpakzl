#!/usr/bin/env python3
import os,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
reg='ap-southeast-1';instance='b67374069bb3457ba6a3a2ede9305d3f'
sha=os.getenv('GITHUB_SHA')
if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1':sys.exit(2)
client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id=reg,endpoint='swas.ap-southeast-1.aliyuncs.com'))
script='''#!/bin/bash
set -Eeuo pipefail
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/zhoujunejune/pikpakzl/SHA/prediction-bot-v1/audit_model_cleanup.sh -o "$tmp"
bash "$tmp"
'''.replace('SHA',sha)
inv=client.run_command(sw.RunCommandRequest(region_id=reg,instance_id=instance,name='zl-audit-irrelevant-model-storage',type='RunShellScript',command_content=script,working_user='root',timeout=240))
for i in range(65):
 time.sleep(3)
 q=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=reg,instance_id=instance,invoke_id=inv.body.invoke_id)).body.invocation_result
 if q and str(q.invocation_status) in ('Success','Failed','ExecutionTimeout','Aborted','ExitCodeNonzero'):
  try:out=base64.b64decode(q.output,validate=True).decode('utf8','replace')
  except:out=q.output or ''
  print('PRUNE_AUDIT_EXIT',q.exit_code,'STATUS',q.invocation_status)
  print(out[-22000:])
  sys.exit(0 if str(q.invocation_status)=='Success' and int(q.exit_code)==0 else 3)
sys.exit(4)

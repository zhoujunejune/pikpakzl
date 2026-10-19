#!/usr/bin/env python3
import os,time,base64,sys,re
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
sha=os.getenv('GITHUB_SHA','')
if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[0-9a-f]{40}',sha):sys.exit(2)
client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
script='''#!/bin/bash
set -Eeuo pipefail
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL --retry 3 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/INSTALL_SHA/prediction-bot-v1/audit_risk_controls.sh" -o "$tmp"
bash -n "$tmp"
bash "$tmp"
'''.replace('INSTALL_SHA',sha)
inv=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='zl-risk-config-readonly-diagnosis',type='RunShellScript',command_content=script,working_user='root',timeout=220))
for _ in range(72):
 time.sleep(3)
 r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv.body.invoke_id)).body.invocation_result
 if r and str(r.invocation_status) in ('Success','Failed','ExecutionTimeout','Aborted','ExitCodeNonzero'):
  try:out=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
  except:out=r.output or ''
  print('RISK_AUDIT_EXIT',r.exit_code,'status',r.invocation_status);print(out[-13000:])
  sys.exit(0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 else 4)
sys.exit(5)

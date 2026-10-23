#!/usr/bin/env python3
"""Read-only Alibaba production quote-speed deployment verification."""
import os,re,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='audit/aliyun-speed-path-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,subprocess,urllib.request
from pathlib import Path
f=Path('/opt/zl-prediction-live/src/railway-diagnostic/index.mjs')
s=f.read_text()
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=8) as r:
 status=json.load(r)
checks={
 'installed':s.count('ZL_QUOTE_SPEED_20261023')>=2,
 'quoteTimeout2400':"timeoutMs: 2400" in s,
 'quoteRetry1600':"timeoutMs: 1600" in s,
 'connectionPrewarm':"quote_connection_prepared" in s,
 'quoteOnlyTimeoutCondition':"if (!quoteCall.ok && quoteCall.network && quoteCall.timeout" in s,
 'productionApiHealthy':status.get('ok') is True,
 'productionTradeActive':subprocess.run(['systemctl','is-active','--quiet','zl-prediction-trade.service']).returncode==0,
 'signalServiceActive':subprocess.run(['systemctl','is-active','--quiet','zl-prediction-deepseek5.service']).returncode==0,
 'riskServiceActive':subprocess.run(['systemctl','is-active','--quiet','zl-prediction-risk-exits.service']).returncode==0,
 'followEnabled':status.get('enabled'),
 'signalModel':status.get('orderSignalModel'),
}
print('QUOTE_SPEED_POST_DEPLOY_VERIFY',json.dumps(checks,ensure_ascii=False),flush=True)
assert all(checks[k] for k in ('installed','quoteTimeout2400','quoteRetry1600',
 'connectionPrewarm','quoteOnlyTimeoutCondition','productionApiHealthy',
 'productionTradeActive','signalServiceActive','riskServiceActive'))
print('QUOTE_SPEED_POST_DEPLOY_PASS=true')
PY
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cli.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
  name='zl-quote-speed-postdeploy-readonly',type='RunShellScript',
  working_user='root',command_content=REMOTE,timeout=40)).body.invoke_id
 for _ in range(28):
  time.sleep(2)
  result=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(
    region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if result and str(result.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(result.output or '',validate=True).decode('utf-8','replace')
   except Exception:out=str(result.output)
   print('QUOTE_SPEED_POST_DEPLOY_REMOTE',result.invocation_status,'EXIT',result.exit_code)
   print(out[-5000:])
   return 0 if int(result.exit_code)==0 else 5
 print('QUOTE_SPEED_POST_DEPLOY_RESULT_UNCONFIRMED')
 return 6
if __name__=='__main__':sys.exit(main())

#!/usr/bin/env python3
"""Launch verified SWAS restore from 9s to 25s/6 calls with no trading mode change."""
import os,re,time,base64,sys,urllib.request
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
branch='rollback/deepseek25-six-calls-20261021'
sha=os.environ.get('GITHUB_SHA','')
assert os.environ.get('GITHUB_REF_NAME')==branch
assert re.fullmatch(r'[a-f0-9]{40}',sha)
url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/prediction-bot-v1/restore_deepseek25_six.sh'
with urllib.request.urlopen(url,timeout=20) as response:script=response.read().decode('utf8')
assert 'ROLLBACK_PRODUCTION_25S=true' in script and 'trap recover9 ERR' in script
remote="bash -s <<'RESTORE_25S_SIX_CALLS'\n"+script+"\nRESTORE_25S_SIX_CALLS\n"
client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
call=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
 instance_id='b67374069bb3457ba6a3a2ede9305d3f',
 name='zl-deepseek-restore25-six-reviews-safe',
 type='RunShellScript',working_user='root',command_content=remote,timeout=180)).body.invoke_id
for _ in range(110):
 time.sleep(2)
 result=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
  region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=call)).body.invocation_result
 if result and str(result.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
  try:output=base64.b64decode(result.output or '',validate=True).decode('utf8','replace')
  except Exception:output=str(result.output)
  print('RESTORE25_REMOTE_STATUS',result.invocation_status,'EXIT',result.exit_code)
  print(output[-12000:])
  sys.exit(0 if int(result.exit_code)==0 else 5)
sys.exit('RESTORE25_REMOTE_CONFIRMATION_TIMEOUT')

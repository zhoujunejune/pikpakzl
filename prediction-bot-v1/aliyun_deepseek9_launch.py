#!/usr/bin/env python3
"""Dispatch guarded one-call 9s rollout to existing Alibaba SWAS instance."""
import os,re,time,base64,sys,urllib.request
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
branch='fix/deepseek9-one-reasoning-20261021'
target=os.environ.get('GITHUB_SHA','')
assert os.environ.get('GITHUB_REF_NAME')==branch
assert re.fullmatch(r'[a-f0-9]{40}',target)
base='7d982bb65a0aba0c977db90167ffcdada16e7184'
uri='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+target+'/prediction-bot-v1/deepseek9_guarded_apply.sh'
with urllib.request.urlopen(uri,timeout=20) as response:script=response.read().decode('utf8')
assert 'SINGLE9_CONFIG_ACTIVE=true' in script and 'trap rollback ERR' in script
remote="bash -s <<'SINGLE9_DEPLOY_SCRIPT'\nexport BASE_SHA="+base+' TARGET_SHA='+target+'\n'+script+"\nSINGLE9_DEPLOY_SCRIPT\n"
client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
id=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
 instance_id='b67374069bb3457ba6a3a2ede9305d3f',
 name='zl-deepseek-one-analysis-nine-second-safe-release',
 type='RunShellScript',working_user='root',command_content=remote,timeout=190)).body.invoke_id
for i in range(115):
 time.sleep(2)
 result=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
  region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=id)).body.invocation_result
 if result and str(result.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
  try:output=base64.b64decode(result.output or '',validate=True).decode('utf8','replace')
  except Exception:output=str(result.output)
  print('SINGLE9_REMOTE_STATUS',result.invocation_status,'EXIT',result.exit_code)
  print(output[-10000:])
  sys.exit(0 if int(result.exit_code)==0 else 5)
sys.exit('SINGLE9_DEPLOY_NOT_CONFIRMED_TIMEOUT')

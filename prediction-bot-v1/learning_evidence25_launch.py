#!/usr/bin/env python3
"""Deploy DeepSeek learning evidence to existing Alibaba SWAS without paid resources."""
import os,re,time,base64,sys,urllib.request
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
branch='feat/deepseek-learning-evidence25-20261021'
sha=os.environ.get('GITHUB_SHA','')
assert os.environ.get('GITHUB_REF_NAME')==branch and re.fullmatch('[0-9a-f]{40}',sha)
url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/prediction-bot-v1/learning_evidence25_apply.sh'
with urllib.request.urlopen(url,timeout=20) as f: script=f.read().decode('utf8')
assert 'LEARNING25_ONLINE=true' in script
base='7d982bb65a0aba0c977db90167ffcdada16e7184'
remote="bash -s <<'LEARN_PROOF'\nexport BASE_SHA="+base+' LEARN_SHA='+sha+'\n'+script+"\nLEARN_PROOF\n"
client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
id=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
 instance_id='b67374069bb3457ba6a3a2ede9305d3f',
 name='zl-deepseek-learning-evidence-noextraapi',
 type='RunShellScript',working_user='root',command_content=remote,timeout=170)).body.invoke_id
for i in range(105):
 time.sleep(2)
 x=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
  region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=id)).body.invocation_result
 if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
  try:raw=base64.b64decode(x.output or '',validate=True).decode('utf8','replace')
  except Exception:raw=str(x.output)
  print('LEARN25_DEPLOY',x.invocation_status,x.exit_code)
  print(raw[-7000:])
  sys.exit(0 if int(x.exit_code)==0 else 5)
sys.exit('LEARN25_UNCONFIRMED_TIMEOUT')

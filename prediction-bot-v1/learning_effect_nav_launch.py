#!/usr/bin/env python3
"""Guarded existing Alibaba dashboard update, no order or model modifications."""
import os,re,time,base64,sys,urllib.request
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
branch='feat/deepseek-learning-evidence25-20261021'
sha=os.environ.get('GITHUB_SHA','')
assert os.environ.get('GITHUB_REF_NAME')==branch and re.fullmatch('[a-f0-9]{40}',sha)
url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/prediction-bot-v1/learning_effect_nav_apply.sh'
with urllib.request.urlopen(url,timeout=20) as f:script=f.read().decode('utf8')
assert 'LEARNING_NAV_PUBLISHED=true' in script and 'trap rollback ERR' in script
cmd="bash -s <<'ZL_LEARNING_UI_25'\nexport LEARNING_NAV_SHA="+sha+"\n"+script+"\nZL_LEARNING_UI_25\n"
client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
i='b67374069bb3457ba6a3a2ede9305d3f'
job=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=i,
 name='zl-learning-nav-guarded-readonly',
 type='RunShellScript',working_user='root',command_content=cmd,timeout=180)).body.invoke_id
for _ in range(100):
 time.sleep(2)
 r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
  region_id='ap-southeast-1',instance_id=i,invoke_id=job)).body.invocation_result
 if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
  try:output=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
  except Exception:output=str(r.output)
  print('LEARNING_NAV_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
  print(output[-9000:])
  sys.exit(0 if int(r.exit_code)==0 else 5)
sys.exit('LEARNING_NAV_REMOTE_TIMEOUT')

#!/usr/bin/env python3
"""Release guarded production-only DeepSeek quote/EV decision on existing SWAS."""
import os,re,time,base64,sys,urllib.request
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
branch='feat/deepseek-live-quote-reasoning25-20261022'
sha=os.environ.get('GITHUB_SHA','')
assert os.environ.get('GITHUB_REF_NAME')==branch and re.fullmatch('[a-f0-9]{40}',sha)
url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/prediction-bot-v1/apply_live_quote_cognition25.sh'
with urllib.request.urlopen(url,timeout=20) as x:script=x.read().decode('utf8')
assert 'DEEPSEEK_CURRENT_ROUND_REAL_QUOTE_PRODUCTION_PUBLISHED=true' in script
assert 'OWNER_FOLLOW_ACTIVE_MUST_PAUSE_BEFORE_DEPLOY' in script
cmd="bash -s <<'ZL_AI_REAL_QUOTE_25'\nexport QUOTE_COGNITION_SHA="+sha+"\n"+script+"\nZL_AI_REAL_QUOTE_25\n"
client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
instance='b67374069bb3457ba6a3a2ede9305d3f'
id=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=instance,
 name='zl-deepseek-real-current-round-quotes-25s',type='RunShellScript',working_user='root',
 command_content=cmd,timeout=180)).body.invoke_id
for _ in range(105):
 time.sleep(2)
 x=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
  region_id='ap-southeast-1',instance_id=instance,invoke_id=id)).body.invocation_result
 if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
  try:out=base64.b64decode(x.output or '',validate=True).decode('utf8','replace')
  except Exception:out=str(x.output)
  print('DEEPSEEK_QUOTE_COGNITION_PRODUCTION_DEPLOY',x.invocation_status,'EXIT',x.exit_code)
  print(out[-8000:])
  sys.exit(0 if int(x.exit_code)==0 else 5)
sys.exit('DEEPSEEK_QUOTE_COGNITION_UNCONFIRMED')

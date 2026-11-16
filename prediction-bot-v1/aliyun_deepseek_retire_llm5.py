#!/usr/bin/env python3
"""Deactivate only unused older LLM provider, keeping the current DeepSeek service online."""
import os,time,re,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import urllib.request,json
def get(port,path):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=7) as r:return json.load(r)
m=get(13001,'/api/order-signal-model')
h=get(13029,'/api/status')
assert m.get('model')=='DEEPSEEK_5M_V1'
assert [x.get('id') for x in m.get('models',[])]==['DEEPSEEK_5M_V1']
assert h.get('model')=='DEEPSEEK_5M_V1' and h.get('configured') is True
assert get(13029,'/api/history?limit=3').get('model')=='DEEPSEEK_5M_V1'
assert get(13002,'/api/round-stats').get('ok') is True
print('RETIRED_LLM_PREFLIGHT_EXCLUSIVE_DEEPSEEK=true')
PY
test "$(systemctl is-active zl-prediction-deepseek5)" = active
test "$(systemctl is-active zl-futures-bot-paper)" = active
status=$(systemctl is-active zl-prediction-llm5 || true)
if [ "$status" = active ];then
 systemctl stop zl-prediction-llm5
 systemctl disable zl-prediction-llm5
 echo 'RETIRED_LLM5_STOPPED_AND_DISABLED=true'
else
 echo "RETIRED_LLM5_ALREADY_$status=true"
fi
if ! python3 - <<'PY'
import urllib.request,json
def get(port,path):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=8) as r:return json.load(r)
assert get(13001,'/api/order-signal-model')['model']=='DEEPSEEK_5M_V1'
assert get(13029,'/api/status')['model']=='DEEPSEEK_5M_V1'
assert get(13029,'/api/history?limit=3')['model']=='DEEPSEEK_5M_V1'
assert get(13002,'/api/round-stats')['ok'] is True
print('RETIRED_LLM5_DEEPSEEK_UNAFFECTED=true')
PY
then
 systemctl enable --now zl-prediction-llm5 || true
 echo 'RETIRED_LLM5_ROLLBACK_STARTED=true'
 exit 8
fi
test "$(systemctl is-active zl-prediction-deepseek5)" = active
test "$(systemctl is-active zl-futures-bot-paper)" = active
echo 'RETIRED_LLM5_ONLY_DEEPSEEK_RETAINS_MODEL_SERVICE=true'
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 try:
  inv=cli.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   type='RunShellScript',working_user='root',name='zl-retire-obsolete-llm5-not-deepseek',
   command_content=SCRIPT,timeout=115)).body.invoke_id
  for _ in range(50):
   time.sleep(2)
   r=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(
    region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
   if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    try:out=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
    except Exception:out=r.output or ''
    print('RETIRED_LLM_RESULT',r.invocation_status,'EXIT',r.exit_code)
    print(out[-4900:])
    return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 else 5
  return 6
 except Exception as e:
  print('RETIRED_LLM_ERROR',type(e).__name__)
  return 7
if __name__=='__main__':sys.exit(main())

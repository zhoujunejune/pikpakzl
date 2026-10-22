#!/usr/bin/env python3
"""Read-only Alibaba SWAS audit for five-second cutover compatibility."""
import os,base64,sys,time,json
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

remote=r"""#!/bin/bash
set -euo pipefail
python3 - <<'PY'
import json,subprocess,urllib.request,hashlib,os
def get(port,route):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%s%s'%(port,route),timeout=4) as x:
   return json.load(x)
 except Exception as e:return {'error':type(e).__name__}
trade=get(13001,'/api/status')
signal=get(13029,'/api/status')
market=get(13003,'/api/shadow-market-data')
sel=get(13001,'/api/order-signal-model')
print('FAST5_LIVE_AUDIT='+json.dumps({
 'signal':{k:signal.get(k) for k in ('model','providerModel','configured','maxCallsPerRound','decisionWindowEndMs','round','analysisModelCalls','analysisCountLimit','learningDisabled','trainingDisabled','statisticsDisabled')},
 'trade':{k:trade.get(k) for k in ('enabled','pendingAction','lastOrderState')},
 'selector':{k:sel.get(k) for k in ('model','ok')},
 'market':{'ok':market.get('ok'),'symbol':market.get('symbol'),'readOnly':market.get('readOnly'),'roundStartMs':(market.get('latest')or{}).get('roundStartMs'),'eventMs':(market.get('latest')or{}).get('eventMs'),'marketFeedConnected':(market.get('latest')or{}).get('marketFeedConnected')},
},ensure_ascii=False))
units=['zl-prediction-deepseek5.service','zl-prediction-trade.service','zl-prediction-panel.service','zl-deepseek-shadow15-online.service','zl-prediction-shadow15.service']
for unit in units:
 out=subprocess.run(['systemctl','show',unit,'-p','ActiveState','-p','FragmentPath','--no-pager'],capture_output=True,text=True)
 print('FAST5_UNIT',unit,out.stdout.replace('\\n',' | ')[:400])
for file in ['/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs',
 '/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-runner.mjs',
 '/opt/zl-prediction-live/src/railway-diagnostic/wrapper.mjs']:
 if os.path.isfile(file):
  with open(file,'rb') as f:sha=hashlib.sha256(f.read()).hexdigest()
  print('FAST5_SOURCE',file,sha)
PY
"""
assert os.environ.get('GITHUB_REF_NAME')=='feat/deepseek-single5-no-learning-20261022'
client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',
 endpoint='swas.ap-southeast-1.aliyuncs.com'))
instance='b67374069bb3457ba6a3a2ede9305d3f'
r=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=instance,
 name='zl-five-second-read-only-inspect',type='RunShellScript',
 working_user='root',command_content=remote,timeout=90))
id=r.body.invoke_id
for _ in range(55):
 time.sleep(2)
 x=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
  region_id='ap-southeast-1',instance_id=instance,invoke_id=id)).body.invocation_result
 if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
  try:out=base64.b64decode(x.output or '',validate=True).decode('utf8','replace')
  except Exception:out=str(x.output)
  print('FAST5_ALIYUN_READ_ONLY_AUDIT',x.invocation_status,'EXIT',x.exit_code)
  print(out[-11000:])
  sys.exit(0 if int(x.exit_code)==0 else 5)
sys.exit('FAST5_ALIYUN_READ_ONLY_AUDIT_UNCONFIRMED')

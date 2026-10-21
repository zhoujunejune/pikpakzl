#!/usr/bin/env python3
"""Read-only SWAS audit of live Binance Prediction DeepSeek order gate."""
import os,time,base64,json,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
remote=r"""#!/bin/bash
set -eu
python3 - <<'PY'
import pathlib,urllib.request,json,hashlib,re,datetime
def api(port,p):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,p),timeout=4) as r:return json.load(r)
 except Exception as e:return {'error':type(e).__name__}
state=api(13029,'/api/status');trade=api(13001,'/api/status');select=api(13001,'/api/order-signal-model')
root=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
f=root/'wrapper.mjs'
s=f.read_text() if f.exists() else ''
ind=(root/'index.mjs').read_text() if (root/'index.mjs').exists() else ''
def excerpt(s,keys):
 lines=s.splitlines();return [{'line':i+1,'text':line.strip()[:200]} for i,line in enumerate(lines) if any(z in line for z in keys)][:38]
print('ZL_TRADE_VALUE_READONLY='+json.dumps({
 'checked':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'model':state.get('providerModel'),'window':state.get('decisionWindowEndMs',0)-state.get('round',0),
 'maxCalls':state.get('maxCallsPerRound'),'history':state.get('learning'),
 'followEnabled':trade.get('enabled'),'selected':select,
 'wrapperExists':f.exists(),'wrapperSha256':hashlib.sha256(s.encode()).hexdigest(),
 'wrapperLines':excerpt(s,['EV_FILTER_ENABLED','orderSubmitDeadlineForModel','const EV_MIN_EDGE','if (EV_FILTER_ENABLED)','p.signalModelChoice','quote.chance','source ===']),
 'indexLines':excerpt(ind,['SELECTIVE8_MODEL','DEEPSEEK_5M_V1','SIGNAL_MODEL_NAME','roundStats','productionSignal','p.signalModelChoice']),
 'helpers':{'trade-value-gate.mjs':(root/'trade-value-gate.mjs').exists()},
 'changed':False
},ensure_ascii=False,separators=(',',':')))
PY
"""
client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
instance='b67374069bb3457ba6a3a2ede9305d3f'
id=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=instance,
 name='zl-readonly-deepseek-profit-decision-audit',type='RunShellScript',working_user='root',
 command_content="bash -s <<'ZL_READ_ONLY'\n"+remote+"\nZL_READ_ONLY\n",timeout=95)).body.invoke_id
for _ in range(60):
 time.sleep(2)
 x=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
  region_id='ap-southeast-1',instance_id=instance,invoke_id=id)).body.invocation_result
 if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
  try:raw=base64.b64decode(x.output or '',validate=True).decode('utf8','replace')
  except Exception:raw=str(x.output)
  print('VALUE_AUDIT',x.invocation_status,x.exit_code)
  for line in raw.splitlines():
   if line.startswith('ZL_TRADE_VALUE_READONLY='):print(line)
  if int(x.exit_code)!=0:print(raw[-1200:])
  sys.exit(0 if int(x.exit_code)==0 else 5)
sys.exit('READONLY_AUDIT_TIMEOUT')

#!/usr/bin/env python3
"""Independent read-only verification of DeepSeek-only production trade authority."""
import os,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
remote=r"""#!/bin/bash
set -eu
python3 - <<'PY'
import urllib.request,json,pathlib,subprocess,datetime
def get(port,path):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=7) as r:return json.load(r)
d=get(13029,'/api/status');t=get(13001,'/api/status')
choice=get(13001,'/api/order-signal-model')
root=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
app=pathlib.Path('/opt/zl-prediction-live/deepseek5')
w=(root/'wrapper.mjs').read_text()
g=(root/'trade-control-fixed.mjs').read_text()
core=(app/'deepseek-adaptive15-core.mjs').read_text()
run=(app/'deepseek-adaptive15-runner.mjs').read_text()
adapter=(app/'deepseek-adaptive15-production-adapter.mjs').read_text()
flags={
 'wrapperAITradeDecisions':('deepseek_direct_trade_choice' in w),
 'generatedAITradeDecisions':('deepseek_direct_trade_choice' in g),
 'noNumericQuoteDecision':('decideLiveTradeValue' not in w and 'decideLiveTradeValue' not in g),
 'noLegacyEVFilter':('EV_FILTER_ENABLED' not in w and 'EV_FILTER_ENABLED' not in g),
 'realQuoteCallback':('getLiveQuoteContext' in adapter and 'verifiedBinanceExecutableQuotes' in core),
 'tradeOpinionInModelOutput':('aiTradeOpinion' in adapter and 'tradeOpinion' in core),
 'retained25s':('DEADLINE_MS=25000' in core),
 'retainedSixCalls':('MAX_AI_CALLS_PER_ROUND=6' in run),
 'productionSourceCorrect':(d.get('model')=='DEEPSEEK_5M_V1' and choice.get('model')=='DEEPSEEK_5M_V1'),
 'followStillOff':t.get('enabled') is False,
 'sampleCountPreserved':d.get('learning',{}).get('allOfficialSamples',0)>=224,
 'tradeServiceActive':(subprocess.run(['systemctl','is-active','zl-prediction-trade.service'],capture_output=True,text=True).stdout.strip()=='active'),
 'aiServiceActive':(subprocess.run(['systemctl','is-active','zl-prediction-deepseek5.service'],capture_output=True,text=True).stdout.strip()=='active')
}
print('DEEPSEEK_DIRECT_PRODUCTION_AUDIT='+json.dumps({
 'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'flags':flags,'allPassed':all(flags.values()),
 'model':d.get('providerModel'),'historicalOfficialSamples':d.get('learning',{}).get('allOfficialSamples'),
 'follow':t.get('enabled'),'lastOrderState':(t.get('lastOrder') or {}).get('state')
},ensure_ascii=False,separators=(',',':')))
assert all(flags.values()),'PRODUCTION_DEPLOY_INCOMPLETE'
PY
"""
client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
instance='b67374069bb3457ba6a3a2ede9305d3f'
id=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=instance,
name='zl-direct-deepseek-trade-authority-readonly-check',type='RunShellScript',working_user='root',
command_content="bash -s <<'AUDIT'\n"+remote+"\nAUDIT\n",timeout=90)).body.invoke_id
for _ in range(50):
 time.sleep(2)
 r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
 region_id='ap-southeast-1',instance_id=instance,invoke_id=id)).body.invocation_result
 if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
  try:txt=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
  except Exception:txt=str(r.output)
  print('DEEPSEEK_DIRECT_PRODUCTION_AUDIT_STATE',r.invocation_status,r.exit_code)
  print(txt[-5500:])
  sys.exit(0 if int(r.exit_code)==0 else 5)
sys.exit('PRODUCTION_AUDIT_UNCONFIRMED')

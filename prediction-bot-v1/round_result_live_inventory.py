#!/usr/bin/env python3
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REMOTE=r"""#!/bin/bash
set -euo pipefail
python3 - <<'PY'
import urllib.request,json,time
def fetch(port,route):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,route),timeout=6) as r:return json.load(r)
 except Exception as e:return {'error':str(e)[:100]}
s=fetch(13002,'/api/round-stats')
x=fetch(13029,'/api/status')
t=fetch(13001,'/api/status')
print('ROUND_RESULT_SOURCE=',json.dumps({'ok':s.get('ok'),'settlementSource':s.get('settlementSource'),'recordCount':len(s.get('records') or []),'topKeys':list(s)[:25],'error':s.get('error')},ensure_ascii=False))
rows=s.get('records') or []
for z in rows[-3:]:
 print('ROUND_RESULT_SAMPLE=',json.dumps({'roundStartMs':z.get('roundStartMs'),'productionActual':z.get('productionActual'),'productionSettledAt':z.get('productionSettledAt'),'settledAt':z.get('settledAt'),'officialSettlementAudit':z.get('officialSettlementAudit') is not None,'resolutionEvidence':z.get('resolutionEvidence') is not None,'fields':list(z)[:25]},ensure_ascii=False))
print('MODEL_CURRENT=',json.dumps({k:x.get(k) for k in ['model','round','maxCallsPerRound','configured','learningDisabled','statisticsDisabled','lastSignal','lastDecision','lastMarketAt']},ensure_ascii=False))
print('TRADE_STATUS=',json.dumps({k:t.get(k) for k in ['enabled','signalModel','round','lastOrderState']},ensure_ascii=False))
try:
 with urllib.request.urlopen('http://127.0.0.1:13001/',timeout=5) as r:p=r.read(350000).decode('utf8','replace')
 print('PANEL_STATE=',json.dumps({'htmlLength':len(p),'hasAccuracyCard':('id="roundStatsCard"' in p),'hasTradeControls':('riskControlsAnchor' in p),'hasDeepseekProxy':('/deepseek/api/status' in p)},ensure_ascii=False))
except Exception as e:print('PANEL_ERROR='+str(e)[:150])
PY
"""
def run():
 sha=os.getenv('GITHUB_SHA','')
 assert os.getenv('GITHUB_REF_NAME')=='feat/deepseek5-round-results-panel-20261022'
 assert re.fullmatch('[0-9a-f]{40}',sha)
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 id=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='zl-round-result-readonly-inventory',type='RunShellScript',working_user='root',command_content=REMOTE,timeout=90)).body.invoke_id
 for _ in range(55):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=id)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:s=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:s=str(r.output)
   print('ROUND_INVENTORY_STATUS',r.invocation_status,'EXIT',r.exit_code);print(s[-8500:])
   return 0 if int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':sys.exit(run())

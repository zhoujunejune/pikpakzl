#!/usr/bin/env python3
"""Read-only risk readiness diagnosis: no credentials, orders or account data logged."""
import base64,os,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -eu
python3 - <<'PY'
import datetime,json,pathlib,urllib.request
r=pathlib.Path('/var/lib/zl-prediction/rounds')
files=['risk-runtime-status.json','risk-worker-health.json','risk-control.json','guardian5/guardian-risk-ready.json']
data={}
for f in files:
 try:data[f]=json.loads((r/f).read_text())
 except Exception as e:print('RISK_READONLY_FILE_ERROR',f,type(e).__name__)
now=datetime.datetime.now(datetime.timezone.utc)
def age(s):
 try:
  if isinstance(s,(int,float)):
   return round(now.timestamp()-(s/1000 if s>10**11 else s),2)
  return round((now-datetime.datetime.fromisoformat(str(s).replace('Z','+00:00'))).total_seconds(),2)
 except Exception:return 'INVALID'
x=data.get(files[0],{})
y=data.get(files[1],{})
z=data.get(files[3],{})
c=data.get(files[2],{})
print('GUARDIAN_RISK_READONLY_SUMMARY',json.dumps({
 'statusPresent':files[0] in data,
 'healthPresent':files[1] in data,
 'controlPresent':files[2] in data,
 'guardianReadyPresent':files[3] in data,
 'runtimeAgeSec':age(x.get('at')),
 'positionsAgeSec':age(y.get('lastSuccessfulPositionsAt')),
 'positionsSeen':y.get('positionsSeen'),
 'lastQuoteAgeSec':age(y.get('lastQuoteAt')),
 'lastQuoteChecks':y.get('quoteChecks'),
 'lastQuoteErrors':y.get('quoteErrors'),
 'lastSellEvent':y.get('lastSellEvent'),
 'markerAgeSec':age(z.get('at')),
 'workerRunning':x.get('workerRunning') is True,
 'configApplied':x.get('configApplied') is True,
 'guardianDynamicExitEnabled':x.get('guardianDynamicExitEnabled') is True,
 'controlDynamicExitEnabled':c.get('dynamicExitEnabled'),
 'controlFixedTpEnabled':c.get('takeProfitEnabled'),
 'controlFixedSlEnabled':c.get('stopLossEnabled'),
 'controlFixedTpPercent':c.get('takeProfitPercent'),
 'controlFixedSlPercent':c.get('stopLossPercent'),
 'controlSource':c.get('source'),
 'guardianMarkerModelMatch':z.get('model')=='ZL_GUARDIAN_5M_V1',
 'markerEnabled':z.get('enabled') is True,
 'markerRealSellQuote':z.get('realSellQuote') is True,
 'markerOrderRegistry':z.get('orderRegistry') is True
},sort_keys=True))
try:
 with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=5) as u:d=json.load(u)
 print('GUARDIAN_TRADE_READONLY_SUMMARY',json.dumps({
   'ok':d.get('ok'),
   'followingEnabled':d.get('enabled'),
   'selectedModel':d.get('orderSignalModel'),
   'orderSignalModelReady':d.get('orderSignalModelReady'),
   'autoConfirmEnabled':d.get('autoConfirmEnabled'),
   'autoConfirmHalted':d.get('autoConfirmHalted'),
   'guardianRiskReady':d.get('guardianRiskReady'),
   'pendingAction':d.get('pendingAction') is not None,
   'pendingActionState':(d.get('pendingAction') or {}).get('state') if isinstance(d.get('pendingAction'),dict) else None,
   'currentOrderSignalStatus':(d.get('orderSignal') or {}).get('status') if isinstance(d.get('orderSignal'),dict) else None,
   'currentOrderSignalEligible':(d.get('orderSignal') or {}).get('executionEligible') if isinstance(d.get('orderSignal'),dict) else None,
 },sort_keys=True))
except Exception as e:print('GUARDIAN_TRADE_STATUS_ERROR',type(e).__name__)
# Print small, filtered code context around sell-quote readiness, without credentials.
src=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
for name in ('guardian-risk-integration.mjs','risk-worker.mjs','risk-runner.mjs','risk-config-storage.mjs'):
 try:
  lines=(src/name).read_text().splitlines()
  for i,line in enumerate(lines):
   if any(x in line for x in ('guardianRiskHeartbeat(', 'realSellQuote:', 'guardianRiskQuote(', 'GUARDIAN_DYNAMIC_EXIT_ENABLED', 'dynamicExitEnabled:', 'function defaultConfig', 'function readConfig', 'function startWorker', 'function effectiveGuardian', 'function guardianOpenExposure', 'GUARDIAN_UI_APPROVED', 'previousGuardianActive')):
    print('GUARDIAN_RISK_SOURCE',name,'line',i+1)
    for j in range(max(0,i-4),min(len(lines),i+8)):
     ss=lines[j].strip()
     if len(ss)>220:ss=ss[:220]
     if not any(t in ss.lower() for t in ('api_key','secret','authorization','token=')):
      print('GUARDIAN_RISK_SOURCE_LINE',j+1,ss)
 except Exception as e:print('GUARDIAN_RISK_SOURCE_ERROR',name,type(e).__name__)
# Identify obsolete dynamic-risk widgets on live HTML; no account data logged.
import pathlib,urllib.request
root=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
names=('guardian-main-dashboard.mjs','control-shell.mjs','panel-stats-shell.mjs')
terms=('zlGDynamicTP','zlGDynamicSL','gdCard','GUARDIAN 专属动态风控',
 'GUARDIAN 动态止盈止损','关闭动态止盈止损','动态移动止盈','动态止损','现有固定止盈','现有固定止损')
for name in names:
 try:
  text=(root/name).read_text()
  print('GUARDIAN_UI_LIVE_SOURCE',name,{key:text.count(key) for key in terms})
 except Exception as e:print('GUARDIAN_UI_LIVE_ERROR',name,type(e).__name__)
for port,url in ((13001,'/'),(13001,'/guardian/')):
 try:
  with urllib.request.urlopen('http://127.0.0.1:'+str(port)+url,timeout=6) as response:
   html=response.read(300000).decode('utf-8','replace')
  print('GUARDIAN_UI_LIVE_HTML',url,{key:html.count(key) for key in terms})
 except Exception as e:print('GUARDIAN_UI_HTML_ERROR',url,type(e).__name__)
# Read narrow public presentation-only snippets to identify obsolete cards.
from pathlib import Path
ui=Path('/opt/zl-prediction-live/src/railway-diagnostic/guardian-main-dashboard.mjs').read_text()
for phrase in ('GUARDIAN 专属动态风控','关闭动态止盈止损','动态移动止盈','zlGDynamicTP'):
 p=ui.find(phrase)
 if p>=0:
  sample=ui[max(0,p-320):min(len(ui),p+850)]
  sample=sample.replace('\n','↵')
  print('GUARDIAN_UI_REMOVE_CONTEXT',phrase,repr(sample))
# Structural view of the dynamic-only JavaScript block to avoid modifying unrelated handlers.
from pathlib import Path
t=Path('/opt/zl-prediction-live/src/railway-diagnostic/guardian-main-dashboard.mjs').read_text()
for key in ('guardianToggle','var riskBusy','function renderToggle','window.zlGuardianToggleRisk','/api/guardian-dynamic-risk','var loading=false','async function load()','const SCRIPT'):
 print('GUARDIAN_UI_SCRIPT_MARKER',key,t.count(key),t.find(key))
ls=t.splitlines()
for n,line in enumerate(ls):
 if any(k in line for k in ('guardianToggle','riskBusy','renderToggle','zlGuardianToggleRisk','/api/guardian-dynamic-risk','function loadRisk','var loading','async function load()','zlGDynamicTP','zlGDynamicSL')):
  print('GUARDIAN_UI_SCRIPT_LINE',n+1,line.strip()[:190])
# Show the narrow remaining dashboard loader structure; no accounts or secrets.
from pathlib import Path
ls=Path('/opt/zl-prediction-live/src/railway-diagnostic/guardian-main-dashboard.mjs').read_text().splitlines()
for i in range(109,min(154,len(ls))):
 line=ls[i]
 if any(k in line.lower() for k in ('key','secret','authorization','password')):continue
 print('GUARDIAN_UI_LOADER',i+1,line[:260])
PY
"""
def main():
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 invoke=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',type='RunShellScript',
  name='guardian5-readonly-risk-health',command_content=SCRIPT,
  working_user='root',timeout=40)).body.invoke_id
 for _ in range(35):
  time.sleep(2)
  d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=invoke)).body.invocation_result
  if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
   except Exception:o='OUTPUT_NOT_UTF8'
   print('GUARDIAN_RISK_READONLY_RUN',d.invocation_status,d.exit_code)
   print('GUARDIAN_DIAGNOSTIC_BEGIN')
   print(o[:2800])
   print('GUARDIAN_DIAGNOSTIC_TAIL')
   print(o[-5000:])
   return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 else 4
 return 5
if __name__=='__main__':sys.exit(main())

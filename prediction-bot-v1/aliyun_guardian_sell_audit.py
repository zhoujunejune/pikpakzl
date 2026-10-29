#!/usr/bin/env python3
import os,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT="""#!/bin/bash
set -e
python3 - <<'PY'
import urllib.request,json,datetime
def g(port,path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=6) as r:return json.load(r)
 except Exception as e:return {'error':type(e).__name__}
s=g(13001,'/api/status')
a=g(13049,'/api/status')
r=g(13001,'/api/guardian-dynamic-risk')
print('TRADE',{k:s.get(k) for k in ['ok','enabled','orderSignalModel','autoConfirmEnabled','orderSignalModelReady','pendingAction','error']})
print('GUARDIAN',{k:a.get(k) for k in ['ok','model','latest','stats','automaticTradeEligibility']})
print('DYNAMIC',{k:r.get(k) for k in ['ok','requestedEnabled','effectiveEnabled','reason']})
for row in (a.get('records') or [])[:5]:
 print('SIGNAL',{k:row.get(k) for k in ['round','at','predictedDirection','status','reason']})
import subprocess
log=subprocess.run(['journalctl','-u','zl-prediction-trade','--since','3 hours ago','-o','cat','-n','2000','--no-pager'],capture_output=True,text=True,timeout=15)
keep={'event','round','state','error','reason','blockReason','code','httpStatus','source','model','upstreamModel','attempt','enabled','signal','executionEligible','calibrationReady','qualityGate','stage'}
events=[]
for line in log.stdout.splitlines():
 try:
  obj=json.loads(line.strip())
  event=str(obj.get('event',''))
  if not any(word in event for word in ['guardian','auto_submit','intent_prepare','signal','order_submit','fresh_quote','trade_follow','order_control']):continue
  events.append({k:v for k,v in obj.items() if k in keep})
 except (ValueError,TypeError):continue
print('RELEVANT_TRADE_EVENTS_COUNT',len(events))
for row in events[-50:]:
 print('RELEVANT_TRADE_EVENT',json.dumps(row,ensure_ascii=False)[:650])
import pathlib,hashlib,os
risk=g(13001,'/api/risk-control')
print('RISK_CONFIG',{k:risk.get(k) for k in ['ok','takeProfitEnabled','stopLossEnabled','guardianDynamicEnabled','persistenceHealthy','source','updatedAt']})
for name in ['zl-prediction-risk-exits','zl-prediction-trade','zl-prediction-guardian-analysis']:
 info=subprocess.run(['systemctl','show',name,'-p','ActiveState','-p','MainPID','-p','ExecMainStartTimestamp'],capture_output=True,text=True).stdout.strip().replace('\\n',';')
 print('UNIT',name,info[:300])
for name in ['guardian-live-bridge.mjs','risk-worker.mjs','guardian-risk-integration.mjs','risk-runner.mjs','control-shell.mjs']:
 p=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')/name
 if not p.is_file():print('LIVE_CODE',name,'MISSING');continue
 raw=p.read_bytes();code=raw.decode('utf8','replace')
 sha=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\\0'+raw).hexdigest()
 print('LIVE_CODE',name,'sha',sha,'bytes',len(raw),'guardian',('GUARDIAN' in code),'guardOrders',('guardianRegisterIntent' in code or 'guardianRiskQuote' in code),'safeSell',('risk_sell_unknown' in code))
paths=['/tmp/risk-runtime-status.json','/tmp/guardian-risk-ready.json','/tmp/risk-worker-health.json','/var/lib/zl-prediction/guardian5/guardian-live-orders.json']
for path in paths:
 try:
  obj=json.loads(pathlib.Path(path).read_text())
  if path.endswith('guardian-live-orders.json'):
   data=obj.get('entries',[])
   print('RISK_FILE',path,{'exists':True,'model':obj.get('model'),'count':len(data),'statuses':{v:sum(x.get('status')==v for x in data) for v in ['INTENT_PREPARED','SUBMITTED']}})
  else:
   keep=['model','at','enabled','guardianDynamicExitEnabled','guardianDynamicExitDesired','guardianUiControlApproved','workerRunning','configApplied','persistenceHealthy','lastTickFinishedAt','lastSuccessfulPositionsAt','lastQuoteAt','quoteChecks','quoteErrors','positionsSeen','realSellQuote','orderRegistry']
   print('RISK_FILE',path,{k:obj.get(k) for k in keep if k in obj})
 except Exception as e:print('RISK_FILE',path,'UNAVAILABLE',type(e).__name__)
rr=subprocess.run(['journalctl','-u','zl-prediction-risk-exits','--since','2 hours ago','-n','1200','-o','cat','--no-pager'],capture_output=True,text=True,timeout=15)
ev=[]
for line in rr.stdout.splitlines():
 try:
  j=json.loads(line.strip());e=str(j.get('event',''))
  if not any(t in e for t in ['guardian','risk_sell','risk_check','risk_runtime','risk_triggered','risk_positions','risk_wallet','risk_tick']):continue
  ev.append({k:j.get(k) for k in ['event','at','enabled','guardianDynamicExitEnabled','reason','error','code','positionsSeen','workerRunning'] if k in j})
 except Exception:pass
print('RISK_JOURNAL_COUNT',len(ev))
for e in ev[-20:]:print('RISK_JOURNAL',e)

print('SIGNAL_AUDIT_COMPLETE')
PY
"""
def main():
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='guardian-signal-read-only',type='RunShellScript',command_content=SCRIPT,working_user='root',timeout=60)).body.invoke_id
 for _ in range(50):
  time.sleep(2)
  d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(d.output or '')
   print(d.invocation_status,d.exit_code);print(o[-12000:])
   return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 else 5
 return 6
if __name__=='__main__':
 raise SystemExit(main())

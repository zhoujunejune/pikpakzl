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

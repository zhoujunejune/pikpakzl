#!/usr/bin/env python3
"""Read-only verification of the NEXT full post-deployment 5-minute prediction round."""
import base64,os,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as om
S=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,time,datetime,urllib.request
def get(port,route):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%s%s'%(port,route),timeout=12) as r:return json.load(r)
 except Exception as e:return {'ok':False,'error':type(e).__name__}
start=int(time.time()*1000)
next_round=(start//300000+1)*300000
until=next_round+34000
if until-start>340000:raise SystemExit('SCHEDULE_OUT_OF_RANGE')
print('NEXT_ROUND_START_UTC',datetime.datetime.fromtimestamp(next_round/1000,datetime.timezone.utc).isoformat())
while int(time.time()*1000)<until:
 time.sleep(min(6,(until-int(time.time()*1000))/1000))
rows=get(13002,'/api/round-stats')
choices=get(13001,'/api/order-signal-model')
row=next((x for x in rows.get('records',[]) if x.get('roundStartMs')==next_round),{})
live=get(13002,'/api/production-signal').get('live') or {}
print('MODEL_CHOSEN',choices.get('model'))
print('ACTIVE_SOURCES',json.dumps([x.get('source') for x in rows.get('activeSignalModels',[])]))
print('WATCHED_ROUND',next_round)
print('WATCHED_RECORD',json.dumps({k:row.get(k) for k in ('productionModel','productionSource','productionPrediction','productionDelayMs','productionModelVersion','productionInputVersion','productionExecutionEligible','productionResult','productionActual','productionCurrentRoundFeatureCount')},ensure_ascii=False))
print('LIVE_AFTER_DEADLINE',json.dumps({k:live.get(k) for k in ('round','status','waitReason','model','source','executionEligible','fast8Quality')},ensure_ascii=False)[:3300])
print('V2_POLL_ERROR',(rows.get('health') or {}).get('lastSignalError'))
print('V2_POLL_LAST_OK',(rows.get('health') or {}).get('lastSignalOkAt'))
print('EXPECTED_VERSION_ACTIVE',choices.get('model')=='SELECTIVE_V2_30S_CURRENT_ROUND_V2')
print('WATCHED_RESULT','QUALIFIED_UP_DOWN' if row.get('productionPrediction') in ('UP','DOWN') and row.get('productionModel')=='SELECTIVE_V2_30S_CURRENT_ROUND_V2' else 'NO_QUALIFIED_SIGNAL_THIS_ROUND')
PY
"""
def main():
 key=os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_ID')
 secret=os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET')
 if not key or not secret:print('MISSING_SECRET');return 2
 cl=Client(om.Config(access_key_id=key,access_key_secret=secret,region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 job=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='zl-prediction-next-round-live-verification',type='RunShellScript',command_content=S,working_user='root',timeout=390))
 for _ in range(110):
  time.sleep(4)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=job.body.invoke_id)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=r.output or ''
   try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
   except Exception:pass
   print('ROUND_VERIFY_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(raw[-7500:])
   return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 else 5
 print('ROUND_VERIFY_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

#!/usr/bin/env python3
"""Capture per-second Selective30 evidence during next full decision window."""
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
  with urllib.request.urlopen('http://127.0.0.1:%s%s'%(port,route),timeout=7) as r:return json.load(r)
 except Exception as e:return {'ok':False,'error':type(e).__name__}
start=int(time.time()*1000)
next_round=(start//300000+1)*300000
print('CAPTURE_ROUND_START_UTC',datetime.datetime.fromtimestamp(next_round/1000,datetime.timezone.utc).isoformat())
delay=(next_round+22000-start)/1000
if delay>340:raise SystemExit('WRONG_NEXT_ROUND')
if delay>0:time.sleep(delay)
seen=[]
for i in range(10):
 live=get(13002,'/api/production-signal').get('live') or {}
 v3=get(13003,'/api/local-predictions').get('live') or {}
 f=v3.get('facts') or {}
 e=(live.get('fast8Quality') or {}).get('evidence') or {}
 row={
  'sec':round((int(time.time()*1000)-next_round)/1000,2),
  'signalStatus':live.get('status'),'model':live.get('model'),
  'signalSource':live.get('source'),'direction':(live.get('signal') or {}).get('direction'),
  'waitReason':live.get('waitReason'),
  'evidence':e,
  'V3RoundMatch':v3.get('round')==next_round,
  'v3AgeMs':int(time.time()*1000)-int(v3.get('factsCalculatedAt') or 0),
  'currentScore':f.get('currentScore'),
  'currentTrendScore':f.get('currentTrendScore'),
  'momentum15':f.get('normalizedMomentum15s'),
  'liveScore':f.get('liveScore'),
  'quoteUpMid':f.get('predictionMarketUpMid'),
  'absorptionRisk':f.get('absorptionRisk')}
 print('CAPTURE_DECISION_WINDOW',json.dumps(row,ensure_ascii=False)[:2500],flush=True)
 seen.append(row)
 if live.get('status')=='LOCKED':break
 time.sleep(1)
v2=get(13002,'/api/round-stats')
r=next((x for x in v2.get('records',[]) if x.get('roundStartMs')==next_round),{})
print('CAPTURE_FINAL_ROW',json.dumps({k:r.get(k) for k in ('roundStartMs','productionModel','productionPrediction','productionSource','productionDelayMs')},ensure_ascii=False))
print('CAPTURE_OUTCOME','LOCKED' if r.get('productionPrediction') in ('UP','DOWN') else 'NO_LOCK')
PY
"""
def main():
 key=os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_ID');secret=os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET')
 if not key or not secret:print('MISSING_AUTH');return 2
 cl=Client(om.Config(access_key_id=key,access_key_secret=secret,region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 req=sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='zl-selective30-signal-evidence-trace',type='RunShellScript',command_content=S,working_user='root',timeout=415)
 job=cl.run_command(req)
 for _ in range(108):
  time.sleep(4)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=job.body.invoke_id)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=r.output or ''
   try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
   except Exception:pass
   print('CAPTURE_RUN_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(raw[-16000:])
   return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 else 5
 print('CAPTURE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

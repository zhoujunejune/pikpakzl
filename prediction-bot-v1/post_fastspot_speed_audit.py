#!/usr/bin/env python3
"""Read-only postdeploy latency/correctness measurement: no orders or user changes."""
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/fast-feed-and-trigger-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,subprocess,time,statistics,urllib.request,collections,hashlib
from datetime import datetime
from zoneinfo import ZoneInfo
tz=ZoneInfo('Asia/Singapore')
def get(port,path):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}'+path,timeout=4) as r:return json.load(r)
def stat(vals):
 if not vals:return {'count':0}
 v=sorted(vals);n=len(v)
 return {'count':n,'min':v[0],'p50':v[(n-1)//2],'p90':v[int((n-1)*.9)],'max':v[-1]}
print('POSTFAST_AUDIT_AT',datetime.now(tz).isoformat())
feed=[]
for i in range(20):
 t=time.perf_counter()
 try:
  f=get(13003,'/api/shadow-market-fast')
  delay=round((time.perf_counter()-t)*1000,2)
  q=f.get('latest') or {}
  feed.append({'ok':f.get('ok'),'latencyMs':delay,'ageMs':q.get('ageMs'),
   'currentRound':q.get('roundStartMs')==(int(time.time()*1000)//300000)*300000})
 except Exception as e:feed.append({'ok':False,'reason':type(e).__name__})
 time.sleep(.05)
ok=[x for x in feed if x.get('ok')]
print('POSTFAST_SPOT_GET_RESPONSE_MS',json.dumps(stat([x['latencyMs'] for x in ok])))
print('POSTFAST_SPOT_EVENT_AGE_MS',json.dumps(stat([x['ageMs'] for x in ok if isinstance(x.get('ageMs'),int)])))
print('POSTFAST_SPOT_HEALTH',json.dumps({'successful':len(ok),'total':len(feed),'currentRoundCount':sum(1 for x in ok if x.get('currentRound'))}))
logs=subprocess.run(['journalctl','-u','zl-prediction-deepseek5.service',
 '--since','2026-10-22 16:12:00 UTC','--no-pager','-o','cat','-n','3500'],
 capture_output=True,text=True,timeout=15).stdout
rows=[];bad=[];methods=collections.Counter()
for line in logs.splitlines():
 try:v=json.loads(line)
 except:continue
 if v.get('event')=='deepseek100ms_locked':
  when=v.get('round',0)
  if not isinstance(when,int) or when<1792600000000:continue
  e={'timeLocal':datetime.fromtimestamp(when/1000,tz).strftime('%H:%M'),
   'elapsedMs':v.get('elapsedMs'),'method':v.get('method'),
   'overTargetMs':v.get('overTargetMs'),'marketAtMs':v.get('marketAtMs')}
  rows.append(e);methods[v.get('method')]+=1
 elif v.get('event')=='deepseek100ms_round_unavailable':
  bad.append({'round':v.get('round'),'reason':v.get('reason')})
records={z['timeLocal']:z for z in rows}
unique=list(records.values())
print('POSTFAST_NEW_SIGNAL_RESULTS',json.dumps(unique[-25:],ensure_ascii=False))
print('POSTFAST_NEW_SIGNAL_LATENCY_MS',json.dumps(stat([e['elapsedMs'] for e in unique if isinstance(e.get('elapsedMs'),int)])))
print('POSTFAST_NEW_SIGNAL_METHODS',json.dumps(dict(methods)))
print('POSTFAST_NEW_UNAVAILABLE',json.dumps(bad[-5:]))
ai=get(13029,'/api/status')
tr=get(13001,'/api/status')
s=get(13001,'/api/order-signal-model')
print('POSTFAST_AI_CONFIG',json.dumps({
 'rule':ai.get('decisionRule'),'aiWindowMs':ai.get('decisionWindowEndMs',0)-ai.get('round',0),
 'model':ai.get('providerModel'),'maxCalls':ai.get('maxCallsPerRound'),
 'lastDecision':ai.get('lastDecision')},ensure_ascii=False))
print('POSTFAST_TRADE_CONFIG',json.dumps({
 'selectedModel':s.get('model'),'followEnabled':tr.get('enabled'),
 'autoConfirmEnabled':tr.get('autoConfirmEnabled')}))
from pathlib import Path
t=Path('/opt/zl-prediction-live/src/railway-diagnostic/index.mjs').read_text()
a=Path('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs').read_text()
f=Path('/opt/zl-prediction-live/src/fast-signal-engine/index.mjs').read_text()
print('POSTFAST_PATCH_INSPECTION',json.dumps({
 'tradeFast120ms':'deepseek_fast_local_poll' in t,
 'trade1200msFallback':'setInterval(prepareWorker, 1200);' in t,
 'aiUsesFastSpot':"const FEED='http://127.0.0.1:13003/api/shadow-market-fast';" in a,
 'fastEndpoint':"url.pathname==='/api/shadow-market-fast'" in f,
 'ownerFollowOff':tr.get('enabled') is False}))
print('POSTFAST_AUDIT_COMPLETE=true')
PY
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 i=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,name='zl-fastspot-speed-readonly-audit',type='RunShellScript',working_user='root',command_content=REMOTE,timeout=90)).body.invoke_id
 for _ in range(55):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=i)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('POSTFAST_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(o[-12000:])
   return 0 if int(r.exit_code)==0 else 5
 print('POSTFAST_RESULT_UNKNOWN');return 6
if __name__=='__main__':sys.exit(main())

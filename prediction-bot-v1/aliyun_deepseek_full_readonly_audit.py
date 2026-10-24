#!/usr/bin/env python3
"""One-shot, read-only production audit. Never prints API credentials or market prices."""
import os,base64,time,json,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -euo pipefail
python3 - <<'PY'
import json,time,urllib.request,datetime,pathlib,subprocess
now=int(time.time()*1000)
out={'checkedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
     'roundElapsedSec':(now%300000)//1000}
def fetch(port,path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=8) as r:
   return json.load(r)
 except Exception as ex:
  return {'fetchError':type(ex).__name__}
def safe_age(ts):
 try:
  x=int(ts)
  return now-x if x>0 else None
 except: return None
def report_status():
 s=fetch(13029,'/api/status')
 keys=['ok','model','providerModel','configured','round','tries','maxCallsPerRound',
       'decisionWindowEndMs','busy','error','waitReason','nextReviewAt',
       'reasoning','featuresVersion','featureReady','lastApiLatencyMs','lastApiTokens',
       'realOrderEnabled','tradeIntegration']
 v={k:s.get(k) for k in keys}
 v['roundElapsedSec']=out['roundElapsedSec']
 sig=s.get('signal') or {}
 last=s.get('lastSignal') or {}
 v['currentSignal']={k:(sig.get('latest') or {}).get(k) for k in ['direction','lockedAt','confidence']}
 v['signalRound']=sig.get('round')
 v['lastSignal']=last
 v['lastSignalAgeMs']=safe_age(last.get('round'))
 v['learning']=s.get('learning')
 v['fetchError']=s.get('fetchError')
 out['modelStatus']=v
def report_history():
 h=fetch(13029,'/api/history?limit=100')
 rows=h.get('records') or []
 valid=[r for r in rows if r.get('actual') in ('UP','DOWN') and r.get('direction') in ('UP','DOWN')]
 def sample(rs):
  n=len(rs); hits=sum(r.get('direction')==r.get('actual') for r in rs)
  return {'samples':n,'hits':hits,'accuracy':round(hits/n,4) if n else None}
 def by_side(side):
  return sample([r for r in valid if r.get('direction')==side])
 last=valid[:]
 out['history']={
  'ok':h.get('ok'),'model':h.get('model'),'officialSource':h.get('officialSource'),
  'generatedAgeMs':safe_age(h.get('generatedAt')),'summary':h.get('summary'),
  'fetchedRows':len(rows),'fetchedSettled':len(valid),
  'cumulativePredictions':(h.get('summary') or {}).get('predictions'),
  'cumulativeSettled':(h.get('summary') or {}).get('allOfficialSamples'),
  'historyLimitIsRecent100':True,
  'pendingAgeMinutes':[
    round((int(time.time()*1000)-x.get('round'))/60000,1)
    for x in rows if x.get('actual') is None and isinstance(x.get('round'),int)
  ][:12],
  'last20Settled':sample(last[:20]),'last50Settled':sample(last[:50]),
  'last100Settled':sample(last[:100]),'up':by_side('UP'),'down':by_side('DOWN'),
  'latestRow':({k:rows[0].get(k) for k in
     ['round','direction','actual','hit','signalLatencyMs','provider','attemptCount']}
    if rows else None),
  'latestSettledRow':({k:valid[0].get(k) for k in
     ['round','direction','actual','hit','signalLatencyMs']}
    if valid else None),'fetchError':h.get('fetchError')}
def sample_bars(c):
 rows=c if isinstance(c,list) else (c.get('rows') or c.get('items') or c.get('candles') or [] if isinstance(c,dict) else [])
 closed=[x for x in rows if isinstance(x,dict) and x.get('closed') is True]
 last=closed[-1] if closed else {}
 return {'total':len(rows),'closed':len(closed),
         'ready35':len(closed)>=35,
         'lastClosedStartAgeMs':safe_age(last.get('startMs') or last.get('openTime'))}
def report_timing():
 h=fetch(13029,'/api/history?limit=100')
 rows=h.get('records') or []
 elapsed=sorted([r.get('signalLatencyMs') for r in rows if isinstance(r.get('signalLatencyMs'),(int,float)) and r.get('signalLatencyMs')>=0])
 tries=[r.get('attemptCount') for r in rows if isinstance(r.get('attemptCount'),int)]
 out['signalTiming']={
  'sampleCount':len(elapsed),
  'lockedBy30Sec':sum(x<=30000 for x in elapsed),
  'lockedBy90Sec':sum(x<=90000 for x in elapsed),
  'lockedBy270Sec':sum(x<=270000 for x in elapsed),
  'medianLatencySec':round(elapsed[len(elapsed)//2]/1000,1) if elapsed else None,
  'minLatencySec':round(elapsed[0]/1000,1) if elapsed else None,
  'maxLatencySec':round(elapsed[-1]/1000,1) if elapsed else None,
  'meanAttempts':round(sum(tries)/len(tries),2) if tries else None}
def report_market():
 m=fetch(13003,'/api/shadow-market-data')
 latest=m.get('latest') or {}
 q={'feedOk':m.get('ok'),'readOnly':m.get('readOnly'),
    'symbol':m.get('symbol'),'eventAgeMs':safe_age(latest.get('eventMs')),
    'roundMatches':latest.get('roundStartMs')==(now//300000)*300000,
    'priceAvailable':isinstance(latest.get('lastPrice'),(int,float))
      and isinstance(latest.get('roundOpenPrice'),(int,float)),
    'marketFeedConnected':latest.get('marketFeedConnected'),
    'fetchError':m.get('fetchError')}
 cs=m.get('candles') or {}
 q['bars1m']=sample_bars(cs.get('1m'))
 q['bars5m']=sample_bars(cs.get('5m'))
 q['validMarketFresh18s']=q['eventAgeMs'] is not None and -1000<=q['eventAgeMs']<=18000
 q['featuresReady35']=q['bars1m']['ready35'] and q['bars5m']['ready35']
 out['market']=q
def report_official():
 r=fetch(13002,'/api/round-stats')
 rows=r.get('records') or []
 valid=[x for x in rows if isinstance(x,dict) and
     x.get('productionActual') in ('UP','DOWN') and
     (x.get('productionSettledAt') is not None or x.get('settledAt') is not None) and
     (x.get('officialSettlementAudit') is not None or x.get('resolutionEvidence') is not None)]
 out['official']={'ok':r.get('ok'),'source':r.get('settlementSource'),'records':len(rows),
                  'eligibleSettlementRecords':len(valid),
                  'lastRecordRound':rows[-1].get('roundStartMs') if rows and isinstance(rows[-1],dict) else None,
                  'fetchError':r.get('fetchError')}
def report_route():
 c=fetch(13001,'/api/order-signal-model')
 s=fetch(13001,'/api/status')
 d=fetch(13001,'/api/direction-mode')
 out['productionRoute']={
  'selectedModel':c.get('model'),
  'choices':[x.get('id') for x in c.get('models',[]) if isinstance(x,dict)],
  'followEnabled':s.get('enabled'),
  'orderSignalModel':s.get('orderSignalModel'),
  'statusOk':s.get('ok'),
  'signalSourceMode':s.get('productionSignalSourceMode'),
  'directionModeNames':list((d.get('modes') or {}).keys())[:8],
  'selectError':c.get('fetchError'),'statusError':s.get('fetchError'),
  'directionError':d.get('fetchError')}
def report_units():

 units={}
 for unit in ['zl-prediction-v3','zl-prediction-v2','zl-prediction-deepseek5','zl-prediction-trade']:
  v=subprocess.run(['systemctl','is-active',unit],text=True,capture_output=True,timeout=3)
  units[unit]=v.stdout.strip() or v.stderr.strip()[:40]
 out['services']=units
 files={}
 for key,p in [('learning','/var/lib/zl-prediction/deepseek5/learning.json'),
   ('engine','/opt/zl-prediction-live/deepseek5/deepseek-5m-engine.mjs'),
   ('features','/opt/zl-prediction-live/deepseek5/deepseek-5m-features.mjs'),
   ('learner','/opt/zl-prediction-live/deepseek5/deepseek-5m-learner.mjs')]:
  f=pathlib.Path(p)
  files[key]={'exists':f.is_file(),'ageHours':round((time.time()-f.stat().st_mtime)/3600,2) if f.is_file() else None}
 out['localFiles']=files
report_status()
report_history()
report_timing()
report_market()
report_official()
report_route()
report_units()
print('ZL_DEEPSEEK_READONLY_AUDIT='+json.dumps(out,separators=(',',':'),ensure_ascii=False))
PY
"""
def main():
 cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cli.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  name='zl-deepseek-performance-feature-feedback-readonly',
  type='RunShellScript',working_user='root',command_content=SCRIPT,timeout=90)).body.invoke_id
 for _ in range(40):
  time.sleep(2)
  r=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=r.output or ''
   try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
   except Exception:pass
   print('REMOTE_EXEC_STATUS',r.invocation_status,'EXIT',r.exit_code)
   for line in raw.splitlines():
    if line.startswith('ZL_DEEPSEEK_READONLY_AUDIT='):print(line)
   if 'ZL_DEEPSEEK_READONLY_AUDIT=' not in raw:print('AUDIT_NO_JSON',raw[-800:])
   return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 else 5
 print('AUDIT_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

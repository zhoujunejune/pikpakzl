#!/usr/bin/env python3
"""Read-only inspection of settled DeepSeek 5m forecasts, segmented by recent horizon."""
import os,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
remote=r"""#!/bin/bash
set -eu
python3 - <<'PY'
import urllib.request,json,pathlib,datetime,collections,statistics,subprocess
def get(port,path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=8) as r:return json.load(r)
 except Exception as e:return {'error':type(e).__name__}
d=get(13029,'/api/status')
h=get(13029,'/api/history?limit=100')
q=get(13029,'/api/quality')
e=get(13029,'/api/learning-effect')
t=get(13001,'/api/status')
raw=json.load(open('/var/lib/zl-prediction/deepseek5/learning.json'))
records=raw.get('predictions',[])
valid=lambda r:r.get('actual') in ('UP','DOWN') and r.get('direction') in ('UP','DOWN') and r.get('round')
settled=sorted([r for r in records if valid(r)],key=lambda x:x['round'])
def segment(rows):
 n=len(rows)
 if not n:return {'n':0}
 hits=sum(bool(r['direction']==r['actual']) for r in rows)
 sides={}
 for direction in ('UP','DOWN'):
  a=[r for r in rows if r['direction']==direction]
  sides[direction]={'n':len(a),'hits':sum(x['direction']==x['actual'] for x in a),
   'rate':round(sum(x['direction']==x['actual'] for x in a)/len(a),4) if a else None}
 actuals=collections.Counter(r['actual'] for r in rows)
 lat=[r.get('signalLatencyMs') for r in rows if isinstance(r.get('signalLatencyMs'),(int,float))]
 regimes={}
 for regime in ('TREND_UP','TREND_DOWN','MIXED','UNKNOWN'):
  a=[r for r in rows if r.get('featureRegime')==regime]
  if a:regimes[regime]={'n':len(a),'hits':sum(x['direction']==x['actual'] for x in a)}
 return {'n':n,'hits':hits,'misses':n-hits,'rate':round(hits/n,4),
  'start':rows[0]['round'],'end':rows[-1]['round'],
  'upDown':sides,'actual':dict(actuals),'regimes':regimes,
  'latency':{'medianMs':int(statistics.median(lat)) if lat else None,
   'over20s':sum(x>=20000 for x in lat),'over24s':sum(x>=24000 for x in lat)},
  'alwaysMajorityBaseline':round(max(actuals.values())/n,4) if actuals else None}
sums={}
for n in (20,30,50,75,100,150,200):
 sums[str(n)]=segment(settled[-n:])
for n in (20,50,100):
 sums['previous'+str(n)]=segment(settled[-(2*n):-n])
sums['all']=segment(settled)
# Daily official settlement performance, target round in Asia/Singapore.
days={}
for r in settled:
 k=datetime.datetime.fromtimestamp(r['round']/1000,datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y-%m-%d')
 days.setdefault(k,[]).append(r)
daily={k:segment(v) for k,v in sorted(days.items())[-8:]}
recent=settled[-50:]
streak=0
for r in reversed(settled):
 if r['direction']!=r['actual']:streak+=1
 else:break
# Decision-status and health information without sensitive order data.
feed={k:d.get(k) for k in ['model','providerModel','round','maxCallsPerRound','decisionWindowEndMs','featureReady','lastApiLatencyMs','error','waitReason','missedRounds','skippedRounds','tries','lastDecision']}
learning=d.get('learning',{})
feed['learning']={k:learning.get(k) for k in ('allOfficialSamples','officialSamples','recentAccuracy','upDown','regimes','comparableOfficialCases','lastError','autoFeedback','modelWeightsFineTuned','unsettled')}
quality={k:q.get(k) for k in ('errors','mistakes','officiallySettled','learningEvidence','controlledExperiment','officialHitRate','lastOfficialUpdateAt','strategyVersion') if k in q}
# Journal only aggregate event types, no payload of orders or secret config.
p=subprocess.run(['journalctl','-u','zl-prediction-trade.service','--since','24 hours ago','--no-pager','-o','cat'],capture_output=True,text=True,timeout=20)
types=collections.Counter()
interesting=['auto_submit_triggered','fresh_quote_failed','submit_blocked_signal_changed',
 'api_order_submitted_pending_confirmation','auto_order_attempt_result',
 'deepseek_direct_trade_choice','deepseek_live_trade_value','order_reconciliation_required']
for line in p.stdout.splitlines():
 if not any(x in line for x in interesting):continue
 idx=line.find('{')
 if idx<0:continue
 try:z=json.loads(line[idx:])
 except:continue
 if z.get('event') in interesting:
  event=z.get('event')
  if event=='auto_order_attempt_result':
   event=event+(':OK' if z.get('ok') else ':FAIL')
  types[event]+=1
# Compare lock-time buckets using the same officially settled predictions.
def latency_table(rows):
 out={}
 for lo,hi,tag in [(0,12000,'under12s'),(12000,20000,'12-20s'),(20000,24000,'20-24s'),(24000,25001,'24-25s')]:
  a=[r for r in rows if isinstance(r.get('signalLatencyMs'),(int,float)) and lo<=r['signalLatencyMs']<hi]
  out[tag]={'n':len(a),'correct':sum(x['direction']==x['actual'] for x in a),
            'rate':round(sum(x['direction']==x['actual'] for x in a)/len(a),4) if a else None}
 return out
lateImpact={'recent100':latency_table(settled[-100:]),
            'previous100':latency_table(settled[-200:-100]),
            'recent150':latency_table(settled[-150:])}
# Measure categorical interactions: UP/DOWN accuracy by observed market regime.
def cross_table(rows):
 out={}
 for rg in ('TREND_UP','TREND_DOWN','MIXED','UNKNOWN'):
  out[rg]={}
  for direction in ('UP','DOWN'):
   a=[r for r in rows if r.get('featureRegime')==rg and r['direction']==direction]
   out[rg][direction]={'n':len(a),'hits':sum(x['direction']==x['actual'] for x in a),
     'rate':round(sum(x['direction']==x['actual'] for x in a)/len(a),4) if a else None}
 return out
cross={'recent50':cross_table(settled[-50:]),'recent150':cross_table(settled[-150:]),
       'previous100':cross_table(settled[-200:-100])}
out={'checkedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'serviceActive':{x:subprocess.run(['systemctl','is-active',x],capture_output=True,text=True).stdout.strip() for x in ['zl-prediction-deepseek5.service','zl-prediction-trade.service']},
 'followEnabled':t.get('enabled'),'tradeMode':t.get('mode'),'model':feed,
 'settledPredictionHistorySize':len(settled),'unsettledPredictionHistorySize':len(records)-len(settled),
 'summaryByHorizon':sums,'daily':daily,'consecutiveRecentMisses':streak,
 'latestTenSettled':[{'round':r['round'],'direction':r['direction'],'actual':r['actual'],
   'hit':r['direction']==r['actual'],'regime':r.get('featureRegime'),'latencyMs':r.get('signalLatencyMs')} for r in settled[-10:]],
 'quality':quality,'timingCorrelations':lateImpact,'trendDirectionCross':cross,'learningEffectEvidence':e.get('evidence'),'journalEvents24h':dict(types),
 'historyEndpointOk':h.get('ok') is True,'sourceType':'OFFICIAL_SETTLEMENT_ONLY_FORECAST_NOT_TRADES'}
print('ZL_DEEPSEEK_ACCURACY_READONLY='+json.dumps(out,ensure_ascii=False,separators=(',',':')))
PY
"""
client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
instance='b67374069bb3457ba6a3a2ede9305d3f'
invoke=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=instance,
 name='zl-readonly-deepseek-settled-horizon-accuracy',type='RunShellScript',working_user='root',
 command_content="bash -s <<'ZL_READONLY'\n"+remote+"\nZL_READONLY\n",timeout=90)).body.invoke_id
for _ in range(65):
 time.sleep(2)
 r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id=instance,invoke_id=invoke)).body.invocation_result
 if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
  try:out=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
  except Exception:out=str(r.output)
  print('ZL_ACCURACY_AUDIT_STATUS',r.invocation_status,r.exit_code)
  for line in out.splitlines():
   if 'ZL_DEEPSEEK_ACCURACY_READONLY=' in line:print(line[line.index('ZL_DEEPSEEK_ACCURACY_READONLY='):])
  if int(r.exit_code)!=0:print(out[-2400:])
  sys.exit(0 if int(r.exit_code)==0 else 5)
sys.exit('ACCURACY_READONLY_AUDIT_TIMEOUT')

#!/usr/bin/env python3
"""Read-only SWAS DeepSeek official forecast accuracy trend diagnostic. No orders, no writes."""
import base64,os,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REMOTE=r"""#!/bin/bash
set -eu
python3 - <<'PY'
import json,pathlib,datetime,collections,urllib.request,subprocess,math
now=datetime.datetime.now(datetime.timezone.utc)
root=pathlib.Path('/var/lib/zl-prediction/deepseek5')
p=root/'learning.json'
j=json.loads(p.read_text()) if p.exists() else {}
allrows=[v for v in j.get('predictions',[]) if v.get('direction') in ('UP','DOWN') and isinstance(v.get('round'),int)]
settled=sorted([v for v in allrows if v.get('actual') in ('UP','DOWN') and v.get('hit') in (True,False)],key=lambda x:x['round'])
preds=sorted(allrows,key=lambda x:x['round'])
boundary=1792629278000 # 2026-10-21T17:34:38Z (direction-only release)
def window(items):
 n=len(items)
 h=sum(1 for x in items if x.get('hit') is True)
 result={'n':n,'wins':h,'losses':n-h,'accuracy':round(h/n,4) if n else None}
 for side in ('UP','DOWN'):
  a=[x for x in items if x.get('direction')==side]
  nh=sum(x.get('hit') is True for x in a)
  result[side]={'n':len(a),'wins':nh,'accuracy':round(nh/len(a),4) if a else None}
 regimes={}
 for regime in ['TREND_UP','TREND_DOWN','MIXED','UNKNOWN']:
  a=[x for x in items if x.get('featureRegime')==regime]
  if a: regimes[regime]={'n':len(a),'wins':sum(x.get('hit') is True for x in a),'accuracy':round(sum(x.get('hit') is True for x in a)/len(a),4)}
 result['regimes']=regimes
 if n: result.update(fromRound=items[0]['round'],toRound=items[-1]['round'])
 return result
def get(port,path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=6) as r:return json.load(r)
 except Exception as e:return {'error':type(e).__name__}
def command(cmd):
 try:
  p=subprocess.run(cmd,capture_output=True,text=True,timeout=8)
  return p.stdout.strip()
 except Exception as e:return 'ERROR_'+type(e).__name__
def losers(rows):
 best=cur=0
 for x in rows:
  if not x.get('hit'):cur+=1;best=max(best,cur)
  else:cur=0
 return best,cur
latest40=settled[-40:]
before=[x for x in settled if x['round']<boundary]
after=[x for x in settled if x['round']>=boundary]
waiting=[x for x in preds if not x.get('actual')]
trade=get(13001,'/api/status');deep=get(13029,'/api/status')
quality=get(13029,'/api/learning-effect')
hist=get(13029,'/api/history?limit=100')
q=quality.get('evidence',{}) if isinstance(quality,dict) else {}
events=collections.Counter()
sampleLogs=[]
for svc in ('zl-prediction-deepseek5.service','zl-prediction-trade.service'):
 try:
  logs=command(['journalctl','-u',svc,'--since','2 hours ago','--no-pager','-o','cat']).splitlines()
  for line in logs:
   if any(z in line for z in ['DEEPSEEK_HTTP_','FEED_HTTP_','STALE_OR_INVALID_MARKET','DEADLINE_25S_EXPIRED','auto_order_attempt_result','auto_submit_triggered','fresh_quote_failed','submit_blocked_signal_changed','PREDICTION_GET_QUOTE_FAILED','BINANCE']):
    i=line.find('{')
    if i<0:continue
    try:d=json.loads(line[i:])
    except Exception:continue
    k=d.get('event')
    if k:
     events[k]+=1
     if k in ('auto_order_attempt_result','fresh_quote_failed','submit_blocked_signal_changed') and len(sampleLogs)<8:
      sampleLogs.append({z:d.get(z) for z in ('event','httpStatus','ok','state','error','round') if z in d})
 except Exception as e:events['log_error_'+type(e).__name__]+=1
last=settled[-12:]
best,current=losers(settled[-100:])
report={
 'asOfUtc':now.isoformat(),
 'nPredictions':len(preds),'nOfficialSettled':len(settled),
 'overview':window(settled),'last10':window(settled[-10:]),
 'last20':window(settled[-20:]),'last30':window(settled[-30:]),
 'last50':window(settled[-50:]),'last100':window(settled[-100:]),
 'prior50':window(settled[-100:-50]) if len(settled)>=100 else None,
 'prior100':window(settled[-200:-100]) if len(settled)>=200 else None,
 'afterRelease':window(after),'beforeReleaseLast50':window(before[-50:]),
 'last100MaxLossStreak':best,'currentLossStreakAmongLast100':current,
 'recent12':[{'round':x['round'],'dir':x['direction'],'actual':x['actual'],'hit':x['hit'],'regime':x.get('featureRegime'),
              'lockLatencyMs':x.get('signalLatencyMs'),'calls':x.get('attemptCount')} for x in last],
 'unsettledCount':len(waiting),'unsettledLast5': [{'round':x['round'],'direction':x['direction']} for x in waiting[-5:]],
 'recentPredictionCoverage':{'latestHistoryRecords':len(hist.get('records',[])) if isinstance(hist,dict) else None,
                             'waitRecordsLast100':sum(1 for x in hist.get('records',[]) if x.get('direction')=='WAIT') if isinstance(hist,dict) else None},
 'production':{'providerModel':deep.get('providerModel'),'error':deep.get('error'),'configured':deep.get('configured'),
               'maxCalls':deep.get('maxCallsPerRound'),'learningLastError':(deep.get('learning') or {}).get('lastError'),
               'latestRoundDecision':deep.get('roundDecision'),'enabled':trade.get('enabled'),
               'pendingState':(trade.get('pendingAction') or {}).get('state'),
               'lastOrderState':(trade.get('lastOrder') or {}).get('state')},
 'trainingEvidence':{'comparableOfficialCases':(deep.get('learning') or {}).get('comparableOfficialCases'),
                    'lastRecordedFeatures':q.get('featureSnapshotCount'),
                    'historicalFeedbackRounds':q.get('roundsWithHistoricalFeedbackOffered'),
                    'modelWeightsFineTuned':(deep.get('learning') or {}).get('modelWeightsFineTuned')},
 'services':{u:command(['systemctl','is-active',u]) for u in ('zl-prediction-deepseek5.service','zl-prediction-trade.service')},
 'journalEvents2h':dict(events),'failedOrderExamples':sampleLogs,
 'readOnly':True}
print('ZL_DEEPSEEK_ACCURACY_TREND='+json.dumps(report,ensure_ascii=False,separators=(',',':')))
PY
"""
def main():
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 instance='b67374069bb3457ba6a3a2ede9305d3f'
 task=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=instance,name='zl-deepseek-prediction-accuracy-trend-readonly',type='RunShellScript',working_user='root',command_content="bash -s <<'ZL_RO'\n"+REMOTE+"\nZL_RO\n",timeout=100)).body.invoke_id
 for _ in range(65):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id=instance,invoke_id=task)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:s=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:s=str(r.output)
   print('TREND_AUDIT_COMMAND',r.invocation_status,'EXIT',r.exit_code)
   for line in s.splitlines():
    if 'ZL_DEEPSEEK_ACCURACY_TREND=' in line:
     print(line[line.index('ZL_DEEPSEEK_ACCURACY_TREND='):])
   if int(r.exit_code)!=0:print('DIAGNOSTIC_ERROR',s[-1500:])
   return 0 if int(r.exit_code)==0 else 5
 print('TREND_AUDIT_TIMED_OUT');return 7
if __name__=='__main__':sys.exit(main())

#!/usr/bin/env python3
"""Read-only 7-day Alibaba Prediction TP/SL journal analysis.
Returns only grouped aggregates. Quote-based results are NOT realized fills.
No keys, wallets, raw IDs, or orders are requested or output.
"""
import os,re,base64,time,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='audit/long-horizon-tpsl-20261023'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,subprocess,collections,statistics,time,datetime,math,urllib.request
from zoneinfo import ZoneInfo
NOW=int(time.time()*1000)
TZ=ZoneInfo('Asia/Singapore')
fmt=lambda ms:datetime.datetime.fromtimestamp(ms/1000,TZ).strftime('%m-%d %H:%M')
def stat(a):
 a=sorted(x for x in a if isinstance(x,(int,float)) and math.isfinite(x))
 if not a:return {'n':0}
 return {'n':len(a),'mean':round(statistics.mean(a),3),'median':round(statistics.median(a),3),
  'p10':round(a[int((len(a)-1)*.1)],3),'p90':round(a[int((len(a)-1)*.9)],3)}
print('LONGTP_ASOF_LOCAL',datetime.datetime.now(TZ).isoformat())
def local(port,path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%s%s'%(port,path),timeout=9) as r:return json.load(r)
 except Exception as e:return {'error':type(e).__name__}
ctrl=local(13001,'/api/risk-control');status=local(13001,'/api/status')
print('LONGTP_CURRENT_CONFIG',{k:ctrl.get(k) for k in ('takeProfitEnabled','takeProfitPercent',
 'stopLossEnabled','stopLossPercent','persistenceHealthy')})
print('LONGTP_CURRENT_EXEC',{k:(ctrl.get('execution')or{}).get(k) for k in
 ('enabled','workerRunning','configApplied')})
print('LONGTP_FOLLOW',status.get('enabled'))
res=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service','--since','7 days ago',
 '--no-pager','-o','cat','-n','200000'],capture_output=True,text=True,timeout=85)
print('LONGTP_JOURNAL_BYTES',len(res.stdout),'returncode',res.returncode)
counts=collections.Counter();days=collections.defaultdict(collections.Counter)
positions=collections.defaultdict(lambda:{'quotes':[],'submits':[],'events':collections.Counter(),
 'triggers':[],'fills':0,'failedPosts':0,'retries':0,'firstAt':None,'lastAt':None})
unknownToken=0;invalidQuote=0;allRounds=0
for line in res.stdout.splitlines():
 try:
  e=json.loads(line);kind=e.get('event')
  if not isinstance(kind,str) or not kind.startswith('risk_'):continue
 except Exception:continue
 counts[kind]+=1
 timestamp=e.get('at')
 try:t=datetime.datetime.fromisoformat(str(timestamp).replace('Z','+00:00')).timestamp()*1000
 except Exception:t=None
 if t is None:continue
 day=fmt(t)[:5];days[day][kind]+=1
 token=e.get('tokenId')
 if not token:unknownToken+=1;continue
 p=positions[str(token)]
 if p['firstAt'] is None:p['firstAt']=t
 p['lastAt']=t
 p['events'][kind]+=1
 if kind=='risk_triggered':p['triggers'].append({'at':t,'reason':e.get('reason')})
 if kind=='risk_sell_fill_confirmed':p['fills']+=1
 if kind=='risk_sell_final_failed_retry_scheduled':p['retries']+=1
 if kind in ('risk_sell_failed','risk_sell_unknown','risk_sell_exception'):p['failedPosts']+=1
 if kind=='risk_check':
  try:
   cost=float(e['totalCost']);q=float(e['currentSellAmount'])
   tp=float(e['tpTarget']);sl=float(e['slTarget'])
   if not all(math.isfinite(v) for v in (cost,q,tp,sl)) or cost<=0:raise ValueError
   stop=round(100*(1-sl/cost))
   if not 0<=stop<=100:raise ValueError
   p['quotes'].append({'at':t,'cost':cost,'q':q,'tp':tp,'sl':sl,'stop':stop})
  except Exception:invalidQuote+=1
 if kind=='risk_sell_submitted':
  try:
   cost=float(e['totalCost']);q=float(e['currentSellAmount'])
   if cost<=0 or not math.isfinite(q):raise ValueError
   p['submits'].append({'at':t,'cost':cost,'q':q,'grossReturnPct':(q/cost-1)*100,
     'reason':e.get('reason')})
  except Exception:pass
print('LONGTP_EVENT_COUNTS',json.dumps(dict(counts),ensure_ascii=False)[:7000])
print('LONGTP_DAYS',json.dumps({k:{
 'checks':v['risk_check'],'triggered':v['risk_triggered'],
 'submissions':v['risk_sell_submitted'],'finalFillsConfirmed':v['risk_sell_fill_confirmed'],
 'failedOrUnknown':sum(v[k] for k in ('risk_sell_failed','risk_sell_unknown','risk_sell_exception')),
 'postsubmitRetries':v['risk_sell_final_failed_retry_scheduled']}
 for k,v in sorted(days.items())},ensure_ascii=False))
print('LONGTP_DISTINCT_POSITION_COUNT',len(positions),'invalidQuotes',invalidQuote)
summitted=[(token,v) for token,v in positions.items() if v['submits']]
finalSubmits=[(token,v,v['submits'][-1]) for token,v in summitted]
print('LONGTP_SUBMITTED_DISTINCT',len(finalSubmits),'individualSubmits',sum(len(v['submits']) for _,v in summitted),
 'positionsRepeated',sum(len(v['submits'])>1 for _,v in summitted))
def settingFor(v,ts):
 prev=[q for q in v['quotes'] if q['at']<=ts]
 if not prev:return None
 return prev[-1]['stop']
bySetting=collections.defaultdict(list)
for token,p,last in finalSubmits:
 stop=settingFor(p,last['at'])
 bySetting[str(stop) if stop is not None else 'UNKNOWN'].append((p,last))
for setting,groups in sorted(bySetting.items()):
 latest=[]
 for p,last in groups:
  latest.append(last)
 vals=[x['grossReturnPct'] for x in latest]
 print('LONGTP_STOP_SETTING',setting,json.dumps({
  'distinctSellPositions':len(groups),
  'rawSellSubmissions':sum(len(p['submits']) for p,_ in groups),
  'finalQuoteTP':sum(x['reason']=='TAKE_PROFIT' for x in latest),
  'finalQuoteSL':sum(x['reason']=='STOP_LOSS' for x in latest),
  'meanGrossQuotedReturnPct':stat(vals),
  'grossQuoteProfitablePct':round(100*sum(x>0 for x in vals)/len(vals),2) if vals else None,
  'historyFillConfirmed':sum(p['fills']>0 for p,_ in groups),
  'postSubmitRetryPositions':sum(p['retries']>0 for p,_ in groups),
  'initialDate':fmt(min(x['at'] for x in latest)),
  'lastDate':fmt(max(x['at'] for x in latest)),
  'disclaimer':'QUOTE_ONLY_NOT_REALIZED_NOT_NET'},ensure_ascii=False))
# Replay each actual quote observed before its *last* submission. Full
# unobserved future paths after actual exit are censored. No causality claim.
for stopSetting in (35,55,70):
 group=[(p,last) for p,last in bySetting.get(str(stopSetting),[]) if p['quotes']]
 if not group:continue
 grid={}
 for tpPct in (20,25,30,35):
  for slPct in (25,30,35,40,45,50,55,70):
   pnls=[];total=0;tpN=0;slN=0;censored=0
   for p,last in group:
    steps=[x for x in p['quotes'] if x['at']<=last['at']]
    if not steps:continue
    total+=1;exit=None
    # Original take profit was configured at 35% for these samples;
    # mathematical reconstruction if candidate TP differs.
    for q in steps:
     newTP=q['cost']+(q['tp']-q['cost'])*tpPct/35
     newSL=q['cost']*(1-slPct/100)
     if q['q']>=newTP:
      exit=('TP',(q['q']/q['cost']-1)*100);break
     if q['q']<=newSL:
      exit=('SL',(q['q']/q['cost']-1)*100);break
    if exit:
     pnls.append(exit[1])
     if exit[0]=='TP':tpN+=1
     else:slN+=1
    else:censored+=1
   grid[f'{tpPct}/{slPct}']={'observedExitN':len(pnls),'censoredN':censored,
    'tp':tpN,'sl':slN,'meanGrossQuotedReturnPct':round(statistics.mean(pnls),2) if pnls else None}
 print('LONGTP_QUOTE_REPLAY_GROUP',stopSetting,
  json.dumps({'positions':len(group),'simulation':'only pre-original-sale observable quotes',
   'grid':grid},ensure_ascii=False))
# For all positions, explicit executable TP/SL threshold and used quote checks
# for a few recent trades, but avoid token/order IDs.
latest=sorted(finalSubmits,key=lambda x:x[2]['at'])[-18:]
print('LONGTP_RECENT_SELL_SUMMARY',json.dumps([{
 'time':fmt(last['at']),'stopSetting':settingFor(p,last['at']),
 'decision':last['reason'],'grossQuotedReturnPct':round(last['grossReturnPct'],2),
 'nSubmitted':len(p['submits']),'postsubmitFailures':p['retries'],
 'fillConfirmedByHistory':p['fills']>0}
 for tok,p,last in latest],ensure_ascii=False))
print('LONGTP_COMPARISON_COMPLETE=true')
PY
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
 instance_id='b67374069bb3457ba6a3a2ede9305d3f',
 name='zl-long-term-risk-quote-only-analysis',type='RunShellScript',
 working_user='root',command_content=REMOTE,timeout=150)).body.invoke_id
 for _ in range(100):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('LONGTP_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(o[-52000:])
   return 0 if int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':raise SystemExit(main())

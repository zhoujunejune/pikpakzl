#!/usr/bin/env python3
"""Read-only current Alibaba 5s DeepSeek model outcome performance by Singapore/Beijing hour.
No exchange orders, API keys, wallet identifiers, PII, or raw position data read/printed.
"""
import os,re,time,sys,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='audit/deepseek5-hourly-performance-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import datetime,json,urllib.request,urllib.error,collections,statistics
from zoneinfo import ZoneInfo
TZ=ZoneInfo('Asia/Singapore')
def read(port,url):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%s%s'%(port,url),timeout=12) as x:return json.load(x)
 except Exception as e:return {'ok':False,'error':type(e).__name__,'route':url,'port':port}
d=read(13045,'/api/round-results?limit=300')
m=read(13029,'/api/status')
t=read(13001,'/api/status')
external=read(13001,'/api/deepseek-round-results?limit=300')
o=read(13002,'/api/round-stats')
print('PERFORMANCE_AUDIT_CLOCK='+datetime.datetime.now(TZ).isoformat())
print('PERFORMANCE_AUDIT_MODEL='+json.dumps({k:m.get(k) for k in
 ('ok','model','providerModel','configured','round','maxCallsPerRound',
  'learningDisabled','trainingDisabled','statisticsDisabled','lastDecision')},ensure_ascii=False))
print('PERFORMANCE_AUDIT_AI_RUNTIME='+json.dumps({k:m.get(k) for k in ('round','lastDecision','analysisModelCalls','busy',
 'lastApiLatencyMs','aiTokens','error','featureReady','waitReason','decisionWindowEndMs',
 'missedRounds','skippedRounds','lastSignal')},ensure_ascii=False))
from pathlib import Path
import subprocess,os
cmd=subprocess.run(['journalctl','-u','zl-prediction-deepseek5.service','--since','10 hours ago',
 '--no-pager','-o','cat','-n','5000'],capture_output=True,text=True,timeout=15)
events=collections.Counter()
locked=collections.Counter()
locked_elapsed=[]
for line in cmd.stdout.splitlines():
 try:x=json.loads(line)
 except:continue
 ev=x.get('event')
 if ev:
  events[ev]+=1
  if ev=='deepseek_single5_locked':
   locked[str(x.get('method','UNKNOWN'))]+=1
   if isinstance(x.get('elapsedMs'),(int,float)):locked_elapsed.append(x['elapsedMs'])
print('PERFORMANCE_AUDIT_AI_JOURNAL='+json.dumps({
 'eventCounts':dict(events),'lockedMethods':dict(locked),
 'locksObserved':len(locked_elapsed),
 'minLockMs':min(locked_elapsed) if locked_elapsed else None,
 'maxLockMs':max(locked_elapsed) if locked_elapsed else None,
 'availableLogs':cmd.returncode==0},ensure_ascii=False))
print('PERFORMANCE_AUDIT_FOLLOW='+json.dumps({'enabled':t.get('enabled'),'model':t.get('orderSignalModel'),'statusOk':t.get('ok')},ensure_ascii=False))
print('PERFORMANCE_AUDIT_RESULTS_SERVICE='+json.dumps({'ok':d.get('ok'),
 'schema':d.get('schema'),'source':d.get('source'),
 'generatedAt':d.get('generatedAt'),'settlementLastAt':d.get('settlementLastAt'),
 'readError':d.get('readError'),'writeError':d.get('writeError'),
 'roundsReported':(d.get('summary') or {}).get('rounds'),
 'roundsReturned':len(d.get('records') or []),
 'publicSameCount':len(external.get('records') or []),
 'independentServiceHealthy':d.get('ok') is True,
 'publicApiHealthy':external.get('ok') is True},ensure_ascii=False))
if d.get('ok') is not True or d.get('schema')!='ROUND_RESULTS_DISPLAY_ONLY_V1' or not isinstance(d.get('records'),list):
 raise SystemExit('PRODUCTION_RESULTS_NOT_AVAILABLE_NO_INFERENCE')
rows=[r for r in d['records'] if isinstance(r,dict)]
rows.sort(key=lambda r:r.get('round',0))
def hour(r):return datetime.datetime.fromtimestamp(r['round']/1000,TZ).hour
def day(r):return datetime.datetime.fromtimestamp(r['round']/1000,TZ).strftime('%Y-%m-%d')
def bucket(r,window):return (hour(r)//window)*window
def summarize(rows):
 settled=[r for r in rows if r.get('status')=='LOCKED' and r.get('direction') in ('UP','DOWN') and r.get('actual') in ('UP','DOWN') and isinstance(r.get('hit'),bool)]
 hits=sum(1 for r in settled if r['hit'])
 locked=[r for r in rows if r.get('status')=='LOCKED']
 no=[r for r in rows if r.get('status')=='NO_SIGNAL']
 unseen=[r for r in rows if r.get('status')=='NOT_OBSERVED']
 pending=[r for r in locked if r.get('actual') not in ('UP','DOWN')]
 ai=[r for r in settled if r.get('decisionMethod')=='DEEPSEEK_SINGLE_CALL_5S']
 backup=[r for r in settled if r.get('decisionMethod')=='REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK']
 def hit_pct(items):
  return round(100*sum(1 for r in items if r['hit'])/len(items),2) if items else None
 latencies=[r.get('latencyMs') for r in locked if isinstance(r.get('latencyMs'),(int,float))]
 return {'rounds':len(rows),'signals':len(locked),'noSignal':len(no),'notObserved':len(unseen),
 'pending':len(pending),'settled':len(settled),'wins':hits,'losses':len(settled)-hits,
 'hitRatePct':hit_pct(settled),
 'aiSettled':len(ai),'aiHits':sum(1 for r in ai if r['hit']),'aiHitRatePct':hit_pct(ai),
 'backupSettled':len(backup),'backupHits':sum(1 for r in backup if r['hit']),
 'backupHitRatePct':hit_pct(backup),
 'signalCoveragePct':round(100*len(locked)/(len(locked)+len(no)),2) if len(locked)+len(no) else None,
 'meanSignalMs':round(statistics.mean(latencies)) if latencies else None,
 'maxSignalMs':max(latencies) if latencies else None}
print('PERFORMANCE_AUDIT_ALL='+json.dumps(summarize(rows),ensure_ascii=False))
if rows:
 print('PERFORMANCE_AUDIT_TIME_WINDOW='+json.dumps({'first':datetime.datetime.fromtimestamp(rows[0]['round']/1000,TZ).isoformat(),
  'last':datetime.datetime.fromtimestamp(rows[-1]['round']/1000,TZ).isoformat(),
  'days':dict(collections.Counter(day(r) for r in rows)),'latestRecordStatus':rows[-1].get('status')},ensure_ascii=False))
for target_day in sorted(set(day(r) for r in rows)):
 dayrows=[r for r in rows if day(r)==target_day]
 print('PERFORMANCE_AUDIT_DAY='+json.dumps({'date':target_day,**summarize(dayrows)},ensure_ascii=False))
 for block in (1,2,3,4):
  slots=collections.defaultdict(list)
  for r in dayrows:slots[bucket(r,block)].append(r)
  for h,rr in sorted(slots.items()):
   print('PERFORMANCE_AUDIT_TIME_BUCKET='+json.dumps({'date':target_day,'hours':block,
      'label':'%02d:00-%02d:59'%(h,h+block-1),**summarize(rr)},ensure_ascii=False))
 for kind in ('DEEPSEEK_SINGLE_CALL_5S','REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK'):
  print('PERFORMANCE_AUDIT_METHOD='+json.dumps({'date':target_day,'method':kind,
      **summarize([r for r in dayrows if r.get('decisionMethod')==kind])},ensure_ascii=False))
 for direction in ('UP','DOWN'):
  print('PERFORMANCE_AUDIT_DIRECTION='+json.dumps({'date':target_day,'direction':direction,
      **summarize([r for r in dayrows if r.get('direction')==direction])},ensure_ascii=False))
official=[]
for r in o.get('records') or []:
 if (isinstance(r,dict) and isinstance(r.get('roundStartMs'),int) and
     r.get('productionActual') in ('UP','DOWN') and
     (r.get('officialSettlementAudit') is not None or r.get('resolutionEvidence') is not None)):
  official.append((r['roundStartMs'],r['productionActual']))
official=dict(official)
matched=[r for r in rows if r.get('round') in official and r.get('status')=='LOCKED']
mismatch=[r for r in matched if r.get('actual') in ('UP','DOWN') and r.get('actual')!=official[r['round']]]
waiting=[r for r in matched if r.get('actual') not in ('UP','DOWN')]
print('PERFORMANCE_AUDIT_OFFICIAL='+json.dumps({'sourceOk':o.get('ok'),
 'source':o.get('settlementSource'),'officialRowsAvailable':len(official),
 'comparableLocalRounds':len(matched),'mismatches':len(mismatch),
 'officialSettledButLocalWaiting':len(waiting)},ensure_ascii=False))
print('PERFORMANCE_AUDIT_COMPLETE=true')
PY
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
  print('INVALID_PERFORMANCE_AUDIT_REF');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 invoke=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
  name='zl-deepseek5-hourly-official-performance-readonly',type='RunShellScript',working_user='root',
  command_content=REMOTE,timeout=160)).body.invoke_id
 for _ in range(95):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id=INSTANCE,invoke_id=invoke)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:out=str(r.output)
   print('PERFORMANCE_AUDIT_CLOUD_RESULT',r.invocation_status,'EXIT',r.exit_code)
   print(out[-30000:])
   return 0 if int(r.exit_code)==0 else 5
 print('PERFORMANCE_AUDIT_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

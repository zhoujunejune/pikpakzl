#!/usr/bin/env python3
"""Read-only audit of recent TP/SL latency and failed SELL recovery.
Only aggregates and pseudonymous positions are emitted, no wallet/token/order IDs.
"""
import os,re,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='audit/risk-latency-1642-20261023'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,subprocess,time,collections,statistics,datetime,urllib.request
from zoneinfo import ZoneInfo
tz=ZoneInfo('Asia/Singapore')
at=int(time.time()*1000)
fmt=lambda ms:datetime.datetime.fromtimestamp(ms/1000,tz).strftime('%m-%d %H:%M:%S.%f')[:-3]
def summarize(a):
 a=sorted(a);n=len(a)
 return {'n':n,'p50':round(statistics.median(a),1),'p90':a[int(.9*(n-1))],
  'min':a[0],'max':a[-1]} if n else {'n':0}
print('LIVE_SPEED_AUDIT_AT',fmt(at))
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=7) as r:return json.load(r)
r=get('/api/risk-control');t=get('/api/status')
print('LIVE_SPEED_CONFIG',{k:r.get(k) for k in ('takeProfitEnabled','takeProfitPercent',
 'stopLossEnabled','stopLossPercent','persistenceHealthy')})
print('LIVE_SPEED_WORKER',{k:(r.get('execution') or {}).get(k) for k in ('enabled',
 'ready','workerRunning','configApplied','persistenceHealthy')})
print('LIVE_SPEED_FOLLOW',t.get('enabled'))
cmd=['journalctl','-u','zl-prediction-risk-exits.service','--since','165 minutes ago',
 '--no-pager','-o','json','-n','35000']
raw=subprocess.run(cmd,capture_output=True,text=True,timeout=18)
rows=[];pseudonyms={}
for line in raw.stdout.splitlines():
 try:
  obj=json.loads(line);v=json.loads(obj.get('MESSAGE',''))
  event=v.get('event')
  if not isinstance(event,str) or not event.startswith('risk_'):continue
  tm=int(obj.get('__REALTIME_TIMESTAMP',0))//1000
  if tm<at-165*60000 or tm>at+15000:continue
 except Exception:continue
 token=str(v.get('tokenId') or '')
 pos=None
 if token:
  if token not in pseudonyms:pseudonyms[token]='P'+str(len(pseudonyms)+1)
  pos=pseudonyms[token]
 rows.append({'t':tm,'event':event,'pos':pos,
   'reason':v.get('reason') if v.get('reason') in (
    'TAKE_PROFIT','STOP_LOSS','POST_SUBMISSION_TERMINAL_FAILURE',
    'ORDER_STILL_PENDING','EXACT_ORDER_NOT_YET_IN_HISTORY',
    'PARTIAL_FILL_BLOCKS_RETRY') else None,
   'retryMs':v.get('retryMs') if isinstance(v.get('retryMs'),(int,float)) else None})
rows.sort(key=lambda x:x['t'])
print('LIVE_SPEED_COUNTS',dict(collections.Counter(x['event'] for x in rows)))
by=collections.defaultdict(list)
for v in rows:
 if v['pos']:by[v['pos']].append(v)
latest=[]
for pos,items in by.items():
 submitted=[x for x in items if x['event']=='risk_sell_submitted']
 failed=[x for x in items if x['event'] in ('risk_sell_failed',
 'risk_sell_final_failed_retry_scheduled','risk_sell_unknown',
 'risk_sell_exception','risk_sell_not_submitted_journal_unavailable')]
 trigger=[x for x in items if x['event']=='risk_triggered']
 if not trigger and not submitted and not failed:continue
 latest.append({
 'pos':pos,'firstTrigger':fmt(trigger[0]['t']) if trigger else None,
 'triggerN':len(trigger),'submissionN':len(submitted),
 'firstSubmitted':fmt(submitted[0]['t']) if submitted else None,
 'lastSubmitted':fmt(submitted[-1]['t']) if submitted else None,
 'failureEvents':[(x['event'],fmt(x['t'])) for x in failed],
 'confirmedFilledN':sum(x['event']=='risk_sell_fill_confirmed' for x in items),
 'finalPendingN':sum(x['event']=='risk_sell_finality_pending' for x in items),
 'latestEvent':items[-1]['event'],
 'lastEventAt':fmt(items[-1]['t'])})
print('LIVE_SPEED_LATEST_POSITIONS',json.dumps(latest[-20:],ensure_ascii=False))
for kind in ('risk_sell_final_failed_retry_scheduled','risk_sell_failed',
 'risk_sell_unknown','risk_sell_not_submitted_journal_unavailable'):
 matched=[x for x in rows if x['event']==kind]
 segments=[]
 for v in matched[-15:]:
  nexts=[x for x in by.get(v['pos'],[]) if x['t']>v['t']]
  ct=next((x for x in nexts if x['event']=='risk_check'),None)
  tr=next((x for x in nexts if x['event']=='risk_triggered'),None)
  sb=next((x for x in nexts if x['event']=='risk_sell_submitted'),None)
  cf=next((x for x in nexts if x['event']=='risk_sell_fill_confirmed'),None)
  segments.append({'pos':v['pos'],'failureAt':fmt(v['t']),'retryMs':v.get('retryMs'),
   'quoteRecheckedAt':fmt(ct['t']) if ct else None,
   'newTriggerAt':fmt(tr['t']) if tr else None,
   'nextSellSubmittedAt':fmt(sb['t']) if sb else None,
   'nextSellConfirmedAt':fmt(cf['t']) if cf else None,
   'latencyToResubmitMs':sb['t']-v['t'] if sb else None})
 print('LIVE_SPEED_RECOVERY_'+kind,json.dumps(segments,ensure_ascii=False))
timings=[]
for items in by.values():
 for trigger in (x for x in items if x['event']=='risk_triggered'):
  later=next((x for x in items if x['event'] in ('risk_sell_submitted',
   'risk_sell_failed','risk_sell_unknown','risk_sell_exception',
   'risk_sell_not_submitted_journal_unavailable') and 0<=x['t']-trigger['t']<=10000),None)
  if later and later['event']=='risk_sell_submitted':
   timings.append(later['t']-trigger['t'])
print('LIVE_SPEED_TRIGGER_TO_SUBMITTED_MS',summarize(timings))
gaps=[b['t']-a['t'] for a,b in zip(rows,rows[1:]) if a['event']=='risk_check' and
 b['event']=='risk_check' and b['pos']==a['pos'] and b['t']-a['t']<=5000]
print('LIVE_SPEED_SAME_POSITION_QUOTE_CHECK_GAP_MS',summarize(gaps))
print('LIVE_SPEED_AUDIT_SUCCESS=true')
PY
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 invoke=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  name='zl-risk-recovery-and-latency-readonly',type='RunShellScript',
  working_user='root',command_content=REMOTE,timeout=120)).body.invoke_id
 for _ in range(74):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   invoke_id=invoke)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(r.output or '').decode(errors='replace')
   except Exception:out=str(r.output)
   print('LIVE_SPEED_REMOTE_STATUS',r.invocation_status,'exit',r.exit_code)
   print(out[-23000:])
   return 0 if int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':raise SystemExit(main())

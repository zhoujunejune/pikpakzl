#!/usr/bin/env python3
"""Read-only audit of most recent Alibaba Prediction TP/SL failures and retries.
Outputs only per-run pseudonymous token labels and timeline, never token/order/wallet
IDs, trading amounts, API keys, raw log errors or actual user account info.
"""
import os,re,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='audit/risk-failures-retries-20261023'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import collections,datetime,json,subprocess,urllib.request,time,math,os,re
from zoneinfo import ZoneInfo
TZ=ZoneInfo('Asia/Singapore')
now=int(time.time()*1000)
def get(port,path):
 try:
  with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=8) as r:return json.load(r)
 except Exception as e:return {'ok':False,'errorType':type(e).__name__}
def fmt(ts):
 return datetime.datetime.fromtimestamp(ts/1000,TZ).strftime('%m-%d %H:%M:%S.%f')[:-3]
print('RETRY_AUDIT_ASOF',fmt(now))
ctl=get(13001,'/api/risk-control')
status=get(13001,'/api/status')
print('RETRY_AUDIT_CONTROL',json.dumps({
 'riskConfigOk':ctl.get('ok'),
 'takeProfitEnabled':ctl.get('takeProfitEnabled'),
 'takeProfitPercent':ctl.get('takeProfitPercent'),
 'stopLossEnabled':ctl.get('stopLossEnabled'),
 'stopLossPercent':ctl.get('stopLossPercent'),
 'execution':{k:(ctl.get('execution') or {}).get(k) for k in ('enabled','workerRunning','configApplied','persistenceHealthy')},
 'followEnabled':status.get('enabled'),
 'configSaved':ctl.get('persistenceHealthy')},ensure_ascii=False))
u=subprocess.run(['systemctl','show','zl-prediction-risk-exits.service',
 '-p','ActiveState','-p','ExecMainStartTimestamp','--no-pager'],capture_output=True,text=True,timeout=5)
print('RETRY_AUDIT_RISK_UNIT',u.stdout.replace('\n',' ').strip()[:300])
from pathlib import Path
work=Path('/opt/zl-prediction-live/src/railway-diagnostic/risk-worker.mjs')
try:
 s=work.read_text()
 print('RETRY_AUDIT_LIVE_SOURCE',json.dumps({
  'safeRetryScheduler': 'function scheduleKnownFailure(' in s,
  'unknownOrderReconcile': 'async function reconcileUnknownSell(' in s,
  'exactQuoteVerification': 'reconcileExactUnknownOrder(' in s,
  'poll300': 'AUTO_TAKE_PROFIT_POLL_MS || 300' in s,
  'freshPriceBeforeSecondSell':'getSellQuote(wallet, position, topic)' in s,
  'blockUnknown':'if (state?.statusUnknown)' in s},ensure_ascii=False))
except Exception as e:print('RETRY_AUDIT_LIVE_SOURCE_ERROR',type(e).__name__)
query=['journalctl','-u','zl-prediction-risk-exits.service','--since','12 hours ago',
 '--no-pager','-o','json','-n','80000']
p=subprocess.run(query,capture_output=True,text=True,timeout=35)
print('RETRY_AUDIT_JOURNAL_READ_OK',p.returncode==0,'bytes',len(p.stdout))
EVENTS={
 'risk_worker_started','risk_runtime_worker_started','risk_runtime_worker_exited',
 'risk_check','risk_triggered','risk_retry_scheduled','risk_sell_quote_failed',
 'risk_sell_failed','risk_sell_exception','risk_sell_unknown','risk_sell_submitted',
 'risk_unknown_reconcile_pending','risk_unknown_reconcile_error',
 'risk_unknown_reconciled_rejected','risk_unknown_order_found',
 'risk_positions_error','risk_wallet_error','risk_tick_exception','risk_invalid_position'
}
rows=[]; labels={};errors=collections.Counter();counts=collections.Counter()
for line in p.stdout.splitlines():
 try:
  src=json.loads(line)
  v=json.loads(src.get('MESSAGE',''))
  if not isinstance(v,dict):continue
  ev=v.get('event')
  if ev not in EVENTS:continue
  ts=int(src.get('__REALTIME_TIMESTAMP',0))//1000
  if ts<now-12*3600000 or ts>now+120000:continue
 except Exception:continue
 token=v.get('tokenId')
 alias=None
 if token is not None:
  key=str(token)
  if key not in labels:labels[key]='P'+str(len(labels)+1)
  alias=labels[key]
 rec={'t':ts,'event':ev,'p':alias}
 for key in ('reason','stage','code','httpStatus','retryMs','failures','network',
  'historyOk','activeOk','retrySellBlocked','freshQuoteRequired',
  'unknownSellPolicy','pollMs','retrySlowAfterFailures'):
  z=v.get(key)
  # None or short numeric/enum values only, never raw API failure messages
  if z is None:continue
  if key in ('code','reason','stage','unknownSellPolicy'):
   if not isinstance(z,str) or len(z)>70 or not re.match(r'^[A-Z0-9_ -]+$',z):continue
  elif not isinstance(z,(bool,int,float)):continue
  rec[key]=z
 rows.append(rec)
 counts[ev]+=1
rows.sort(key=lambda z:z['t'])
print('RETRY_AUDIT_COUNTS_12H',json.dumps(dict(counts),ensure_ascii=False))
print('RETRY_AUDIT_DISTINCT_POSITIONS_SEEN',len(labels))
started=[r for r in rows if r['event']=='risk_worker_started']
print('RETRY_AUDIT_STARTS_LAST',json.dumps([dict(r,t=fmt(r['t'])) for r in started[-5:]],ensure_ascii=False))
problemKinds={
 'risk_sell_quote_failed','risk_sell_failed','risk_sell_exception','risk_sell_unknown',
 'risk_positions_error','risk_wallet_error','risk_tick_exception',
 'risk_unknown_reconcile_error','risk_invalid_position'
}
problems=[r for r in rows if r['event'] in problemKinds]
print('RETRY_AUDIT_LAST_PROBLEMS',json.dumps([
 {**{k:v for k,v in r.items() if k!='t'},'time':fmt(r['t'])} for r in problems[-35:]
 ],ensure_ascii=False))
# Exact same position and strictly later event; if a failure at t, the
# scheduler can have been logged milliseconds earlier (before failure logged).
# Correlate 1-second neighborhood and subsequent quote CHECK / SELL events.
by=collections.defaultdict(list)
for r in rows:
 if r['p'] is not None:by[r['p']].append(r)
positionFailures=[r for r in problems if r['p'] is not None]
failureSamples=[]
for r in positionFailures[-45:]:
 seq=by[r['p']]
 within=[z for z in seq if z['t']>=r['t']-1500 and z['t']<=r['t']+45*60*1000]
 schedules=[z for z in within if z['event']=='risk_retry_scheduled' and abs(z['t']-r['t'])<=1700]
 following=[z for z in within if z['t']>r['t'] and z['event'] in (
  'risk_check','risk_triggered','risk_sell_submitted','risk_sell_failed',
  'risk_sell_unknown','risk_unknown_order_found','risk_unknown_reconciled_rejected',
  'risk_unknown_reconcile_pending','risk_sell_quote_failed','risk_retry_scheduled')]
 recheck=next((z for z in following if z['event']=='risk_check'),None)
 submit=next((z for z in following if z['event']=='risk_sell_submitted'),None)
 reTrigger=next((z for z in following if z['event']=='risk_triggered'),None)
 resolved=next((z for z in following if z['event'] in ('risk_unknown_order_found','risk_unknown_reconciled_rejected')),None)
 still=following[-1] if following else None
 failureSamples.append({
  'time':fmt(r['t']),'position':r['p'],'kind':r['event'],
  'reason':r.get('reason'),'stage':r.get('stage'),'code':r.get('code'),
  'httpStatus':r.get('httpStatus'),
  'retryScheduled':len(schedules)>0,
  'retryMs':schedules[-1].get('retryMs') if schedules else None,
  'subsequentQuoteCheck':bool(recheck),
  'quoteCheckDelayMs':recheck['t']-r['t'] if recheck else None,
  'subsequentThresholdTrigger':bool(reTrigger),
  'submittedAnotherSell':bool(submit),
  'sellSubmitDelayMs':submit['t']-r['t'] if submit else None,
  'exchangeUnknownResolved':resolved['event'] if resolved else None,
  'lastRelatedEvent':still['event'] if still else None,
  'lastRelatedAt':fmt(still['t']) if still else None,
 })
print('RETRY_AUDIT_PER_FAILURE_TIMELINES',json.dumps(failureSamples[-40:],ensure_ascii=False))
print('RETRY_AUDIT_FAILURE_RECHECK_TOTALS',json.dumps({
 'allPositionFailures12H':len(positionFailures),
 'recentCorrelated':len(failureSamples),
 'quoteFailures12H':sum(r['event']=='risk_sell_quote_failed' for r in positionFailures),
 'realSellFailures12H':sum(r['event']=='risk_sell_failed' for r in positionFailures),
 'unknownSell12H':sum(r['event']=='risk_sell_unknown' for r in positionFailures),
 'scheduledInRecent':sum(x['retryScheduled'] for x in failureSamples),
 'checkedAgainRecent':sum(x['subsequentQuoteCheck'] for x in failureSamples),
 'resubmittedSellRecent':sum(x['submittedAnotherSell'] for x in failureSamples),
 },ensure_ascii=False))
recent=rows[-35:]
print('RETRY_AUDIT_LAST_NONCHECK_EVENTS',json.dumps([
 {**{k:v for k,v in r.items() if k!='t'},'time':fmt(r['t'])}
 for r in [x for x in rows if x['event']!='risk_check'][-35:]],ensure_ascii=False))
print('RETRY_AUDIT_COMPLETE=true')
PY
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[0-9a-f]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 i=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
 instance_id=INSTANCE,name='zl-tpsl-failure-retry-live-readonly-audit',
 type='RunShellScript',working_user='root',command_content=REMOTE,timeout=150)).body.invoke_id
 for _ in range(89):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
  instance_id=INSTANCE,invoke_id=i)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('RETRY_AUDIT_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(o[-27000:])
   return 0 if int(r.exit_code)==0 else 5
 print('RETRY_AUDIT_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

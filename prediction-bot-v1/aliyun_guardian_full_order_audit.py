#!/usr/bin/env python3
"""Read-only production audit for Guardian 5m order entry; never trade or print secrets."""
import base64,json,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REMOTE=r'''#!/bin/bash
set -u
python3 - <<'PY'
import json,os,subprocess,urllib.request,datetime,pathlib,hashlib,collections
now=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
print('AUDIT_TIME_SHANGHAI',now.isoformat(timespec='seconds'))
def get(port,path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=6) as r:
   return json.load(r)
 except Exception as e:
  return {'ok':False,'readError':type(e).__name__}
for name,unit in [('TRADE','zl-prediction-trade'),('RISK','zl-prediction-risk-exits'),('GUARDIAN','zl-prediction-guardian-analysis'),('CADDY','caddy'),('FEED','zl-prediction-v3'),('CONTROL2','zl-prediction-v2')]:
 p=subprocess.run(['systemctl','is-active',unit],capture_output=True,text=True)
 print('AUDIT_UNIT',name,p.stdout.strip() or 'unknown')
s=get(13001,'/api/status')
for k in ['ok','enabled','orderSignalModel','orderSignalModelReady','guardianExecutionReady','guardianRiskReady','directionModeReady','autoConfirmEnabled','autoConfirmHalted','autoConfirmStopOnError','autoConfirmCooldownMs','amount','model','error']:
 v=s.get(k)
 if k in ('amount',):v='SET' if v not in (None,'',0) else 'NOT_SET'
 print('AUDIT_TRADE_STATUS',k,repr(v)[:90])
p=s.get('pendingAction') or {};last=s.get('lastOrder') or {}
for name,x in [('PENDING',p),('LAST_ORDER',last)]:
 print('AUDIT_'+name,json.dumps({k:x.get(k) for k in ('round','state','status','code','httpStatus','blockReason','paymentAccount','orderAttempts','maxOrderAttempts') if k in x},ensure_ascii=False,default=str)[:600])
print('AUDIT_DIRECTION_MODES',json.dumps((s.get('directionModes') or {}).get('FAST5_SPOT_MOMENTUM_V1',{}),ensure_ascii=False)[:300])
g=get(13049,'/api/status')
st=g.get('stats') or {};latest=g.get('latest') or {}
print('AUDIT_GUARDIAN_STATUS',json.dumps({
 'ok':g.get('ok'),'configured':g.get('configured'),'model':g.get('model'),
 'latestDirection':latest.get('direction'),'latestStatus':latest.get('status'),
 'round':g.get('round'),'observedAgeMs':int(time.time()*1000)-(g.get('observedAt') or 0),
 'lastTickAgeMs':int(time.time()*1000)-(g.get('lastTickAt') or 0),
 'busy':g.get('busy'),'analysisErrorType':str(g.get('error') or '')[:65],
 'recentRecords':len(g.get('records') or []),'settled':st.get('settled'),
 'automaticTradeEligible':(g.get('automaticTradeEligibility') or {}).get('eligible')
},ensure_ascii=False,default=str)[:1100])
for port,endpoint in [(13001,'/healthz'),(13049,'/healthz'),(13003,'/api/shadow-market-data'),(13001,'/api/risk-control')]:
 d=get(port,endpoint)
 if endpoint=='/api/risk-control':
  keys=('ok','stopLossEnabled','takeProfitEnabled','persistenceHealthy','workerRunning','error')
 elif endpoint=='/api/shadow-market-data':
  data=d.get('latest') or {}
  print('AUDIT_FEED_LATEST',json.dumps({'ok':d.get('ok'),'symbol':d.get('symbol'),
    'eventAgeMs':int(time.time()*1000)-int(data.get('eventMs') or 0),
    'roundStartMs':data.get('roundStartMs'),'lastPricePresent':bool(data.get('lastPrice'))},default=str))
  continue
 else:keys=('ok','error')
 print('AUDIT_ENDPOINT',port,endpoint,json.dumps({k:d.get(k) for k in keys},ensure_ascii=False,default=str)[:450])
root=pathlib.Path('/var/lib/zl-prediction/rounds')
for fn in ('risk-runtime-status.json','risk-worker-health.json','risk-control.json'):
 try:
  d=json.loads((root/fn).read_text())
  keys=('at','lastSuccessfulPositionsAt','lastTickFinishedAt','workerRunning','enabled','configApplied','positionsSeen','stopLossEnabled','takeProfitEnabled','guardianDynamicExitEnabled','persistenceHealthy')
  print('AUDIT_RISK_FILE',fn,json.dumps({k:d.get(k) for k in keys if k in d},ensure_ascii=False,default=str)[:700])
 except Exception as e:print('AUDIT_RISK_FILE_ERROR',fn,type(e).__name__)
src=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
for fn in ('wrapper.mjs','index.mjs','guardian-live-bridge.mjs','payment-source-priority.mjs','production-signal-choice.mjs'):
 try:
  t=(src/fn).read_text()
  print('AUDIT_SOURCE',fn,'sha256',hashlib.sha256(t.encode()).hexdigest(),
    'RECHECK_V2',('GUARDIAN_RECHECK_V2' in t),
    'GUARDIAN_CONNECTOR',('GUARDIAN_LIVE_CONNECTOR_V1' in t),
    'MPC_FALLBACK',('please ensure your account has enough usdt' in t),
    'GUARDIAN_BRANCH',('GUARDIAN_ID' in t))
 except Exception as e:print('AUDIT_SOURCE_ERROR',fn,type(e).__name__)
# Limit journal to selected structured, relevant events. No wallet IDs, order IDs, token IDs or keys.
rx='api_intent_ready|auto_submit_triggered|guardian_signal_recheck_completed|submit_blocked_signal_changed|fresh_quote_failed|fresh_quote_ready|order_submit_attempt_denied|api_order_submit_attempt|api_order_submitted_pending_confirmation|prediction_wallet_quote_insufficient_spot_fallback|intent_prepare_failed|guardian_order_registration_failed_after_buy|order_submit_deadline_expired|guardian_feed_unavailable|order_submission_unknown|auto_confirm_failed|order_post_failed|risk_|guardian_'
cmd=['journalctl','-u','zl-prediction-trade','--since','6 hours ago','-g',rx,'--no-pager','-o','json','-n','3000']
try:
 p=subprocess.run(cmd,capture_output=True,text=True,timeout=24)
 counts=collections.Counter();events=[];rounds=collections.defaultdict(list)
 for line in p.stdout.splitlines():
  try:
   raw=json.loads(line)
   x=json.loads(raw.get('MESSAGE',''))
   if not isinstance(x,dict) or not isinstance(x.get('event'),str):continue
   ev=x['event'];counts[ev]+=1
   ts=datetime.datetime.fromtimestamp(int(raw['__REALTIME_TIMESTAMP'])/1e6,datetime.timezone(datetime.timedelta(hours=8))).strftime('%m-%d %H:%M:%S')
   rd=x.get('round')
   vals={k:x[k] for k in ('code','httpStatus','state','source','paymentAccount','spotQuoteOk','retries','signalRecovered','signalIdMatches','currentSignalIdMatches','recheckRetries','reason','blockedReason','error') if k in x and isinstance(x[k],(str,int,float,bool))}
   for key in ('error','reason','blockedReason'):
    if key in vals:vals[key]=str(vals[key])[:95]
   record={'at':ts,'event':ev,'round':rd,'info':vals}
   events.append(record)
   if isinstance(rd,int):rounds[rd].append(ev)
  except (ValueError,TypeError,KeyError,OverflowError):continue
 print('AUDIT_JOURNAL',json.dumps({'returnCode':p.returncode,'selectedEvents':sum(counts.values()),'eventCounts':dict(counts),'stderrType':p.stderr.strip()[:90]},ensure_ascii=False)[:3000])
 for row in events[-45:]:print('AUDIT_EVENT',json.dumps(row,ensure_ascii=False,separators=(',',':'))[:480])
 for rd,evs in list(rounds.items())[-20:]:print('AUDIT_ROUND',rd,json.dumps(evs[-16:]))
except Exception as e:print('AUDIT_JOURNAL_ERROR',type(e).__name__)
print('AUDIT_COMPLETE_READONLY=true')
PY
'''
def main():
 if not os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_ID') or not os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET'):
  print('AUDIT_CREDENTIALS_UNAVAILABLE');return 2
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 try:
  i=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
    instance_id='b67374069bb3457ba6a3a2ede9305d3f',type='RunShellScript',
    name='guardian-full-readonly-entry-audit',command_content=REMOTE,
    working_user='root',timeout=90)).body.invoke_id
  for _ in range(45):
   time.sleep(2)
   x=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
     region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=i)).body.invocation_result
   if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ClientNotRunning'):
    try:output=base64.b64decode(x.output or '',validate=True).decode('utf-8','replace')
    except Exception:output='UNREADABLE_REMOTE_OUTPUT'
    print('GUARDIAN_FULL_AUDIT',x.invocation_status,x.exit_code)
    print(output[-22000:])
    return 0 if str(x.invocation_status)=='Success' and int(x.exit_code)==0 else 4
  print('GUARDIAN_AUDIT_TIMEOUT');return 5
 except Exception as e:
  print('GUARDIAN_AUDIT_ERROR',type(e).__name__,str(getattr(e,'code','UNKNOWN'))[:80]);return 6
if __name__=='__main__':sys.exit(main())

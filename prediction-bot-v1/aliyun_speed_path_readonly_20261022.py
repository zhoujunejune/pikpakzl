#!/usr/bin/env python3
"""Read-only production stage-latency audit. Outputs timing metrics, NEVER orders,
keys, wallet, quote IDs, positions or API credentials. No restart.
"""
import os,re,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='audit/aliyun-speed-path-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,urllib.request,time,subprocess,collections,statistics,math,os
from datetime import datetime
from zoneinfo import ZoneInfo
TZ=ZoneInfo('Asia/Singapore')
now=int(time.time()*1000)
def get(port,uri):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%s%s'%(port,uri),timeout=7) as x:return json.load(x)
 except Exception as e:return {'ok':False,'errorClass':type(e).__name__}
ai=get(13029,'/api/status')
trade=get(13001,'/api/status')
select=get(13001,'/api/order-signal-model')
control=get(13001,'/healthz')
feed=get(13003,'/api/shadow-market-data')
f=feed.get('latest') or {}
print('SPEED_AUDIT_TIME',datetime.now(TZ).isoformat(),flush=True)
print('SPEED_AUDIT_MODEL',json.dumps({
 k:ai.get(k) for k in ('model','configured','providerModel','decisionRule','decisionWindowEndMs',
 'round','fallbackMarketDeadlineMs','lastApiLatencyMs','analysisModelCalls','maxCallsPerRound',
 'busy','featureReady','lastDecision')},ensure_ascii=False))
print('SPEED_AUDIT_USER_SWITCH',json.dumps({
 'selectedModel':select.get('model'),'followEnabled':trade.get('enabled'),
 'autoConfirmEnabled':trade.get('autoConfirmEnabled'),'pendingState':(trade.get('pendingAction') or {}).get('state'),
 'lastOrderState':trade.get('lastOrderState'),
 'transport':{k:v for k,v in (control.get('signalTransport') or {}).items()
              if k in ('redisConnected','websocketConnected','lastAt','lastReceivedAt','lastError')},
 'tradeStatusOk':trade.get('ok')},ensure_ascii=False))
print('SPEED_AUDIT_MARKET_FEED',json.dumps({
 'ok':feed.get('ok'),'connected':f.get('marketFeedConnected'),
 'pricePresent':bool(f.get('lastPrice')),'openPresent':bool(f.get('roundOpenPrice')),
 'roundMatches':f.get('roundStartMs')==now//300000*300000,
 'eventLagMs':now-f['eventMs'] if isinstance(f.get('eventMs'),int) else None},ensure_ascii=False))
wanted_model={'deepseek100ms_locked','deepseek100ms_price_fallback',
 'deepseek100ms_analysis_failed','deepseek100ms_round_unavailable',
 'deepseek15_locked','deepseek15_round_unavailable','deepseek_single5_locked'}
wanted_trade={'api_intent_ready','auto_submit_triggered','fresh_quote_ready',
 'api_order_submit_attempt','api_order_submitted_pending_confirmation',
 'api_order_failed','auto_order_attempt_result','order_status_updated',
 'fresh_quote_failed','intent_prepare_failed',
 'order_submit_deadline_expired','submit_blocked_signal_changed',
 'order_retry_requote_failed','api_order_retry',
 'locked_signal_redis_subscriber_ready','locked_signal_websocket_connected',
 'signal_poll_interval_aligned','locked_signal_redis_message_invalid',
 'locked_signal_websocket_message_invalid'}
results=[]
counts=collections.Counter()
samples=collections.defaultdict(list)
for unit,allowed in (('zl-prediction-deepseek5.service',wanted_model),
 ('zl-prediction-trade.service',wanted_trade)):
  cmd=['journalctl','-u',unit,'--since','4 hours ago','--no-pager','-o','json','-n','16000']
  proc=subprocess.run(cmd,capture_output=True,text=True,timeout=20)
  for line in proc.stdout.splitlines():
   try:
    src=json.loads(line)
    value=json.loads(src.get('MESSAGE',''))
    if not isinstance(value,dict):continue
   except:continue
   event=value.get('event')
   if event not in allowed:continue
   when=int(src.get('__REALTIME_TIMESTAMP',0))//1000
   if when<now-4*3600000 or when>now+60000:continue
   round_number=value.get('round')
   if not isinstance(round_number,int) or round_number<1000000000000:round_number=None
   counts[(unit,event)]+=1
   row={'service':'AI' if 'deepseek5' in unit else 'TRADE',
     'event':event,'atMs':when,'round':round_number}
   if round_number is not None:row['sinceRoundMs']=when-round_number
   for field in ('elapsedMs','apiLatencyMs','marketEventLagMs','aiLatencyMs','overTargetMs',
     'quoteLatencyMs','triggerToQuoteMs','submitLatencyMs','orderAttempts',
     'attempt','quoteRemainingMs','quoteRemainingAtSubmitMs'):
    z=value.get(field)
    if isinstance(z,(float,int)) and math.isfinite(z):
     if abs(z)<3000000:row[field]=round(z,2) if isinstance(z,float) else z
   if event.endswith('locked') or event=='deepseek100ms_price_fallback':
    row['method']=value.get('method')
    if event.endswith('locked'): row['direction']=value.get('direction')
   if event.endswith('_failed') or event.endswith('_unavailable'): 
    if isinstance(value.get('code'),(str,int)):row['code']=str(value['code'])[:35]
    if isinstance(value.get('reason'),str) and len(value['reason'])<70 and not any(s in value['reason'].upper() for s in ('TOKEN','KEY','SECRET','WALLET')):row['reason']=value['reason']
   results.append(row)
   for field in ('elapsedMs','apiLatencyMs','marketEventLagMs','overTargetMs',
     'quoteLatencyMs','triggerToQuoteMs','submitLatencyMs','quoteRemainingAtSubmitMs'):
    if isinstance(row.get(field),(float,int)) and row[field]>=0 and row[field]<1000000:
     samples[(event,field)].append(row[field])
  print('SPEED_AUDIT_JOURNAL_STATUS',unit,'readOk',proc.returncode==0,
   'events',sum(v for (u,_),v in counts.items() if u==unit))
print('SPEED_AUDIT_COUNTS',json.dumps({
 ('AI:' if 'deepseek5' in u else 'TRADE:')+e:n for (u,e),n in sorted(counts.items())},ensure_ascii=False))
def stat(v):
 v=sorted(v);n=len(v)
 return {'n':n,'min':v[0],'p50':v[int((n-1)*.5)],'p90':v[int((n-1)*.9)],
  'max':v[-1]}
print('SPEED_AUDIT_STAGE_LATENCIES_MS',json.dumps({
 e+'.'+field:stat(v) for (e,field),v in samples.items() if len(v)>0},ensure_ascii=False))
# An event's journald entry timestamp is when it was logged, not Binance execution time.
byround=collections.defaultdict(dict)
for row in sorted(results,key=lambda x:x['atMs']):
 if row.get('round') is not None and row['event'] not in byround[row['round']]:
  byround[row['round']][row['event']]=row['atMs']
intervals=collections.defaultdict(list)
for r,m in byround.items():
 for a,b in (('deepseek15_locked','api_intent_ready'),
  ('deepseek15_locked','auto_submit_triggered'),
  ('deepseek15_locked','api_order_submitted_pending_confirmation'),
  ('deepseek100ms_locked','api_intent_ready'),
  ('api_intent_ready','auto_submit_triggered'),
  ('auto_submit_triggered','fresh_quote_ready'),
  ('fresh_quote_ready','api_order_submit_attempt'),
  ('api_order_submit_attempt','api_order_submitted_pending_confirmation'),
  ('api_order_submit_attempt','api_order_failed'),
  ('deepseek100ms_locked','api_order_submitted_pending_confirmation')):
  if a in m and b in m:
   d=m[b]-m[a]
   if 0<=d<=60000:intervals[a+' -> '+b].append(d)
print('SPEED_AUDIT_CROSS_STAGE_MS',json.dumps({k:stat(v) for k,v in intervals.items()},ensure_ascii=False))
recent=[r for r in sorted(byround) if r>=now-2*3600000][-20:]
compact=[]
for r in recent:
 events=[x for x in results if x.get('round')==r]
 events.sort(key=lambda x:x['atMs'])
 compact.append({'timeLocal':datetime.fromtimestamp(r/1000,TZ).strftime('%H:%M'),
  'events':[{k:v for k,v in e.items() if k in ('event','sinceRoundMs','elapsedMs',
    'apiLatencyMs','marketEventLagMs','quoteLatencyMs','triggerToQuoteMs',
    'submitLatencyMs','method','code','reason')} for e in events[:12]]})
print('SPEED_AUDIT_RECENT_ROUNDS',json.dumps(compact[-15:],ensure_ascii=False))

from pathlib import Path
index=Path('/opt/zl-prediction-live/src/railway-diagnostic/index.mjs')
wrapper=Path('/opt/zl-prediction-live/src/railway-diagnostic/wrapper.mjs')
if index.exists():
 src=index.read_text()
 a=src.find('async function getSignal(')
 z=src.find('async function getPaymentBalances(',a) if a>=0 else -1
 part=src[a:z] if a>=0 and z>a else ''
 print('SPEED_AUDIT_LIVE_SIGNAL_ROUTING',json.dumps({
   'indexSourceExists':True,'getSignalFound':a>=0,
   'deepseekModelStringInGetSignal': 'DEEPSEEK_5M_V1' in part,
   'hardReturnUnlessSelective8': 'if(choice.model!==SELECTIVE8_MODEL)return null;' in part,
   'genericFallbackBranch':"NOVICE_LOCAL_URL" in part,
   'nativeDeepseek13029SignalRoute': '13029' in part,
   'poll1200ms':'setInterval(prepareWorker, 1200);' in src,
   'prepareThrottled2500ms':'Date.now() - lastPrepareAttemptAt < 2500' in src,
   'selectedDeepseekNameInEntireIndex':'DEEPSEEK_5M_V1' in src,
   'totalSourceBytes':len(src),
   'modelRoutingOrder':{
     'deepseekMentionPos':part.find('DEEPSEEK_5M_V1'),
     'hardSelectiveReturnPos':part.find('if(choice.model!==SELECTIVE8_MODEL)return null;'),
     'firstDeepseekBranchBeforeReturn':0<=part.find('DEEPSEEK_5M_V1')<part.find('if(choice.model!==SELECTIVE8_MODEL)return null;'),
     'deepseekSourceHttpLocal':part.count('127.0.0.1:13029'),
     'signalWiringExcerpt':part[max(0,part.find('DEEPSEEK_5M_V1')-220):part.find('DEEPSEEK_5M_V1')+370]
        if 'DEEPSEEK_5M_V1' in part else None}
 },ensure_ascii=False))
if wrapper.exists():
 wr=wrapper.read_text()
 print('SPEED_AUDIT_LIVE_WRAPPER',json.dumps({
 'hasDeepseekOrderWindow30s':'DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS = 30000' in wr,
 'hasSignalRoutePatching':"async function getSignal" in wr or "if(choice.model!==SELECTIVE8_MODEL)return null" in wr,
 'hasAutoConfirm':"auto_submit_triggered" in wr,
 'sourceBytes':len(wr)},ensure_ascii=False))
for unit in ('zl-prediction-trade.service','zl-prediction-deepseek5.service'):
 u=subprocess.run(['systemctl','show',unit,'-p','ExecMainStartTimestamp','-p','ActiveState','--no-pager'],
  capture_output=True,text=True,timeout=4).stdout
 print('SPEED_AUDIT_SERVICE_STATE',unit,u.strip().replace('\n',' ')[:210])

import re
choice=Path('/opt/zl-prediction-live/src/railway-diagnostic/production-signal-choice.mjs')
if choice.exists():
 cs=choice.read_text()
 names={}
 for name in ('SELECTIVE8_MODEL','BASE_MODEL','EDGE_MODEL','NOVICE_MODEL','DYNAMIC_MODEL'):
  match=re.search(r'(?:const|let|var)\s+'+name+r"\s*=\s*['\"]([^'\"]+)['\"]",cs)
  names[name]=match.group(1) if match else ('defined_elsewhere' if name in cs else 'not_found')
 print('SPEED_AUDIT_LIVE_MODEL_CONSTANTS',json.dumps(names,ensure_ascii=False))
if index.exists():
 src=index.read_text()
 for name in ('SELECTIVE8_LOCAL_URL','SIGNAL_MODEL_NAME','SIGNAL_WS_URL','SIGNAL_REDIS_CHANNEL'):
  match=re.search(r'const\s+'+name+r'\s*=\s*([^;\n]{1,220})',src)
  val=match.group(1).strip() if match else 'not_found'
  if name in ('SIGNAL_WS_URL','SIGNAL_REDIS_CHANNEL'):val='configured_in_environment'
  print('SPEED_AUDIT_LIVE_SIGNAL_CONSTANT',name,val[:240])
 print('SPEED_AUDIT_NATIVE_FAST100_DIRECT_CONSUMPTION',('13029' in src))

print('SPEED_AUDIT_SPOT_UNIT_FILES')
for unit in subprocess.run(['systemctl','list-units','--type=service','--all','--no-legend','--no-pager'],
 capture_output=True,text=True,timeout=6).stdout.splitlines():
 if any(word in unit.lower() for word in ('market','feed','collector','shadow','signal','redis')):
  print('SPEED_AUDIT_SPOT_UNIT',unit[:150])
net=subprocess.run(['ss','-ltnp','sport = :13003'],capture_output=True,text=True,timeout=5).stdout
print('SPEED_AUDIT_SPOT_PORT',net[:700].replace('\n',' '))
from pathlib import Path
import re
pidMatch=re.search(r'pid=(\d+)',net)
if pidMatch:
 proc=Path('/proc/'+pidMatch.group(1))
 try:
  argv=[x.decode(errors='replace') for x in proc.joinpath('cmdline').read_bytes().split(b'\0') if x]
  # Print only file paths and app flags, nothing from env
  print('SPEED_AUDIT_SPOT_PID',pidMatch.group(1),'cwd',str(proc.joinpath('cwd').resolve()),
    'entrypointFiles',[v for v in argv if v.endswith(('.mjs','.js','.py'))][:6])
  for v in argv:
   if v.endswith(('.mjs','.js','.py')) and Path(v).exists():
    code=Path(v).read_text()
    print('SPEED_AUDIT_SPOT_SOURCE',{ 'name':Path(v).name,'len':len(code),
      'cache1800':'1800' in code,'setInterval': 'setInterval' in code,
      'spotLagMs':'eventMs' in code,
      'hasKlinePull':'/api/v3/klines' in code,
      'usesWs':('WebSocket' in code or 'ws.on(' in code)})
 except Exception as e:print('SPEED_AUDIT_SPOT_PROC_FAIL',type(e).__name__)

if pidMatch:
 try:
  pid=pidMatch.group(1)
  print('SPEED_AUDIT_SPOT_CGROUP',Path('/proc/'+pid+'/cgroup').read_text().strip()[:700])
  f=Path('/opt/zl-prediction-live/src/fast-signal-engine/index.mjs')
  sh=Path('/opt/zl-prediction-live/src/fast-signal-engine/shadow-market-readonly.mjs')
  print('SPEED_AUDIT_SPOT_LIVE_FILES',{'index':f.exists(),'shadow':sh.exists()})
  if f.exists():print('SPEED_AUDIT_SPOT_INDEX_ANCHORS',
   {'apiShadowRoute':"url.pathname === '/api/shadow-market-data'" in f.read_text(),
    'fastRouteAlready':"url.pathname==='/api/shadow-market-fast'" in f.read_text(),
    'liveSnapshotReader':'createReadOnlyMarketFeed({ live: payload })' in f.read_text()})
  if sh.exists():print('SPEED_AUDIT_SPOT_SHADOW_ANCHORS',
   {'cache1800':'const CACHE_MS = 1800;' in sh.read_text(),
    'spotFunction':'function spot() {' in sh.read_text(),
    'returnRead': '  return {\\n    async read() {' in sh.read_text(),
    'readSpotAlready':'readSpot() {' in sh.read_text()})
 except Exception as e:print('SPEED_AUDIT_SPOT_EXTRA_ERROR',type(e).__name__)
# Latest successful live order audit: read only, de-identified, no order values.
def read_timeline(unit,allowed):
 proc=subprocess.run(['journalctl','-u',unit,'--since','12 hours ago','--no-pager','-o','json','-n','40000'],
  capture_output=True,text=True,timeout=30)
 output=[]
 for line in proc.stdout.splitlines():
  try:
   rec=json.loads(line); e=json.loads(rec.get('MESSAGE',''))
   if not isinstance(e,dict) or e.get('event') not in allowed:continue
   at=int(rec.get('__REALTIME_TIMESTAMP','0'))//1000
   if at<now-12*3600000 or at>now+60000:continue
   output.append((at,e))
  except (ValueError,TypeError,KeyError):pass
 return output,proc.returncode
sig_allowed={'deepseek15_locked','deepseek100ms_locked','deepseek_single5_locked'}
trade_allowed={'api_order_submitted_pending_confirmation','order_status_updated',
  'api_order_submit_attempt','auto_order_attempt_result'}
signal_events,signal_code=read_timeline('zl-prediction-deepseek5.service',sig_allowed)
trade_events,trade_code=read_timeline('zl-prediction-trade.service',trade_allowed)
signals={}
for at,e in signal_events:
 r=e.get('round')
 if isinstance(r,int):signals.setdefault(r,[]).append((at,e.get('event')))
submitted={}
status_updates={}
for at,e in trade_events:
 oid=e.get('orderId')
 if oid is None:continue
 oid=str(oid)
 if e.get('event')=='api_order_submitted_pending_confirmation':
  r=e.get('round')
  if isinstance(r,int):
   if oid not in submitted or at<submitted[oid][0]:submitted[oid]=(at,r)
 elif e.get('event')=='order_status_updated':
  status_updates.setdefault(oid,[]).append((at,str(e.get('state') or ''),
    str(e.get('status') or ''),e.get('fillPercentage'),e.get('filledUsdtAmount')))
def is_confirmed(x):
 at,state,status,pct,amt=x
 good=state=='CONFIRMED_FILLED' or status.upper() in ('FILLED','SUCCESS','COMPLETED','COMPLETE')
 try:good=good or (pct is not None and float(pct)>=1) or (amt is not None and float(amt)>0)
 except (ValueError,TypeError):pass
 return good and state!='RECONCILIATION_REQUIRED'
def stamp(at):
 return datetime.fromtimestamp(at/1000,TZ).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
out=[]
for oid,updates in status_updates.items():
 valid=sorted(x for x in updates if is_confirmed(x))
 if not valid:continue
 success=valid[0]
 if oid not in submitted:continue
 submit_ms,round_number=submitted[oid]
 possible=[(t,name) for t,name in signals.get(round_number,[]) if round_number<=t<=submit_ms]
 signal_ms,sig_event=(max(possible) if possible else (None,None))
 out.append((success[0],{'roundLocal':stamp(round_number),'signalLocal':stamp(signal_ms) if signal_ms else None,
  'signalEvent':sig_event,'submittedLocal':stamp(submit_ms),
  'confirmedFilledLocal':stamp(success[0]),'signalToSubmitMs':submit_ms-signal_ms if signal_ms else None,
  'signalToFilledMs':success[0]-signal_ms if signal_ms else None,
  'submitToFilledMs':success[0]-submit_ms,
  'confirmedState':success[1],'confirmedStatus':success[2]}))
out.sort(key=lambda x:x[0],reverse=True)
print('LATEST_FILLED_AUDIT_READ_STATUS',json.dumps({'aiJournalOk':signal_code==0,
 'tradeJournalOk':trade_code==0,'hours':12,'signalEvents':len(signal_events),
 'submitEvents':len(submitted),'statusUpdates':sum(map(len,status_updates.values())),
 'matchedConfirmedFilledOrders':len(out)},ensure_ascii=False))
print('LATEST_FILLED_AUDIT_LAST_5',json.dumps([x[1] for x in out[:5]],ensure_ascii=False))
if not out:
 recent_submits=sorted([(at,r) for at,r in submitted.values()],reverse=True)[:3]
 print('LATEST_FILLED_AUDIT_RECENT_SUBMITS',json.dumps([
  {'submitLocal':stamp(at),'roundLocal':stamp(r),
   'signalEventCount':len(signals.get(r,[]))} for at,r in recent_submits],ensure_ascii=False))

# Inspect existing service logs only for any official exchange timestamps.
timestamp_fields=('createTime','modifyTime','terminalTime','fillTime','tradeTime',
 'executionTime','executedAt','filledAt','exchangeTime','transactionTime')
time_presence={}
for unit in ('zl-prediction-trade.service','zl-prediction-deepseek5.service'):
 logs=subprocess.run(['journalctl','-u',unit,'--since','12 hours ago','-o','json',
   '--no-pager','-n','40000'],capture_output=True,text=True,timeout=25)
 counter=collections.Counter()
 numeric_examples={}
 for row in logs.stdout.splitlines():
  try:
   record=json.loads(row)
   val=json.loads(record.get('MESSAGE',''))
   if not isinstance(val,dict):continue
   def collect(obj,depth=0):
    if not isinstance(obj,dict) or depth>2:return
    for k,v in obj.items():
     if k in timestamp_fields:
      counter[k]+=1
      if k not in numeric_examples and isinstance(v,(int,float)):
       numeric_examples[k]=datetime.fromtimestamp(v/(1000 if v>1e12 else 1),TZ).isoformat() if v>0 else 'zero'
     elif isinstance(v,dict):collect(v,depth+1)
   collect(val)
  except Exception:pass
 time_presence[unit]={'fieldsSeen':dict(counter),'sampleTimesOnly':numeric_examples}
print('EXCHANGE_TIMESTAMP_IN_EXISTING_LOGS',json.dumps(time_presence,ensure_ascii=False))

print('SPEED_AUDIT_COMPLETE=true')
PY
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
  print('INVALID_SPEED_AUDIT_REF');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
  name='zl-readonly-signal-quote-order-latency-audit',type='RunShellScript',
  command_content=REMOTE,working_user='root',timeout=150)).body.invoke_id
 for _ in range(85):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('SPEED_AUDIT_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(o[-28000:])
   return 0 if int(r.exit_code)==0 else 5
 print('SPEED_AUDIT_RESULT_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

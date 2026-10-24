#!/usr/bin/env python3
"""Read-only stop-out reversal study using on-host trade/risk event metadata.
Output only sanitized round, direction, stop setting & quote PnL; no credentials,
wallets, order IDs, position IDs, API requests, changes or restarts.
"""
import os,re,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='audit/stop35-reversal-20261025'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,subprocess,time,collections,math,urllib.request
now=int(time.time()*1000)
def journal(unit):
 result=subprocess.run(['journalctl','-u',unit,'--since','40 hours ago','--no-pager',
  '-o','json','-n','45000'],capture_output=True,text=True,timeout=50)
 events=[]
 for row in result.stdout.splitlines():
  try:
   z=json.loads(row)
   e=json.loads(z.get('MESSAGE',''))
   if not isinstance(e,dict):continue
   ts=int(z['__REALTIME_TIMESTAMP'])//1000
   events.append((ts,e))
  except (ValueError,TypeError,KeyError):pass
 return events,result.returncode
risk,rc=journal('zl-prediction-risk-exits.service')
trade,tc=journal('zl-prediction-trade.service')
# Index actual submitted buy directions by 5-minute period, without exposing IDs.
buys=collections.defaultdict(list)
for at,e in trade:
 if e.get('event')!='api_order_submitted_pending_confirmation':continue
 r=e.get('round');d=e.get('direction')
 if isinstance(r,int) and d in ('UP','DOWN') and r<=at<r+300000:
  buys[r].append((at,d))
entryQuotes=collections.defaultdict(list)
for at,e in trade:
 if e.get('event')!='fresh_quote_ready':continue
 try:
  roundMs=int(e['round']);price=float(e['chance'])
  if 0<price<1 and roundMs<=at<roundMs+300000:entryQuotes[roundMs].append((at,price))
 except (ValueError,TypeError,KeyError):pass
stopchecks=collections.defaultdict(list)
quoteTracks=collections.defaultdict(list)
stoptriggers=collections.defaultdict(list)
sell=collections.defaultdict(list)
workerStarts=[]
for at,e in risk:
 event=e.get('event');token=e.get('tokenId')
 if event=='risk_worker_started':workerStarts.append((at,e.get('takeProfitEnabled')))
 if not isinstance(token,(str,int)) or not token:continue
 if event=='risk_check':
  try:
   cost=float(e['totalCost']);sl=float(e['slTarget'])
   q=float(e['currentSellAmount'])
   if cost>0 and math.isfinite(sl) and math.isfinite(q):
    pct=round((1-sl/cost)*100)
    stopchecks[str(token)].append((at,pct))
    quoteTracks[str(token)].append((at,(q/cost-1)*100))
  except (ValueError,TypeError,KeyError):pass
 if event=='risk_triggered' and e.get('reason')=='STOP_LOSS':
  stoptriggers[str(token)].append(at)
 if event=='risk_sell_submitted' and e.get('reason')=='STOP_LOSS':
  try:
   cost=float(e['totalCost']);q=float(e['currentSellAmount'])
   if cost>0 and math.isfinite(q):sell[str(token)].append((at,(q/cost-1)*100))
  except (ValueError,TypeError,KeyError):pass
for l in (workerStarts,):l.sort(key=lambda x:x[0])
results=[];reason=collections.Counter()
for token,sales in sell.items():
 sale_at,pnl=min(sales)
 r=sale_at//300000*300000
 if r+300000>now:reason['unfinished_round']+=1;continue
 entries=[(ts,d) for ts,d in buys.get(r,[]) if ts<=sale_at]
 if len(set(d for _,d in entries))!=1:reason['no_unique_buy_direction']+=1;continue
 buy_at,d=min(entries)
 if not 0<=sale_at-buy_at<300000:reason['invalid_timing']+=1;continue
 checks=[(ts,pct) for ts,pct in stopchecks.get(token,[]) if ts<=sale_at and sale_at-ts<=120000]
 if not checks:reason['stop_setting_unknown']+=1;continue
 pct=checks[-1][1]
 if pct<1 or pct>100:reason['stop_setting_invalid']+=1;continue
 lastWorker=[(ts,x) for ts,x in workerStarts if ts<=sale_at]
 tp_disabled=lastWorker[-1][1] is False if lastWorker else None
 results.append({'r':r,'d':d,'s':sale_at,'sl':pct,'pnl':round(pnl,3),
  'tpOff':tp_disabled,'entryOffsetMs':buy_at-r})
reason['joinedStopPositions']=len(results)
reason['allDistinctSubmittedStops']=len(sell)
reason['workerStarts']=len(workerStarts)
reason['journalRiskEvents']=len(risk)
reason['journalTradeEvents']=len(trade)
reason['historicalBuys']=sum(map(len,buys.values()))
reason['loggerHealthy']=int(tc==0 and rc==0)
# Reconstruct observed quote-path drawdowns of all tracked OPEN positions.
# Never use imaginary prices after a sale. Exclude snapshots starting late.
thresholdRows=[]
trackSkip=collections.Counter()
for tok,samples in quoteTracks.items():
 grouped=collections.defaultdict(list)
 for at,pnl in samples:grouped[at//300000*300000].append((at,pnl))
 for rnd,snapshots in grouped.items():
  if rnd+300000>now:trackSkip['round_open']+=1;continue
  entries=[(at,d) for at,d in buys.get(rnd,[]) if at<rnd+300000]
  if len(set(d for _,d in entries))!=1 or not entries:
   trackSkip['buy_direction_unavailable']+=1;continue
  enter,side=min(entries)
  sample=sorted([(at,pnl) for at,pnl in snapshots if enter<=at<rnd+300000])
  if not sample:trackSkip['no_quotes_after_entry']+=1;continue
  if sample[0][0]-enter>45000:
   trackSkip['first_quote_late']+=1;continue
  settingBefore=[(at,p) for at,p in stopchecks[tok] if enter<=at<=sample[-1][0]]
  setting=settingBefore[0][1] if settingBefore else None
  hits={}
  for cutoff in (20,25,30,35,40,45,50,55,60,70,80,90):
   first=next((at for at,pnl in sample if pnl<=-cutoff),None)
   if first is not None:hits[str(cutoff)]=int(first-rnd)
  trackSell=sorted(sell.get(tok,[]))
  sold=bool(trackSell and rnd<=trackSell[0][0]<rnd+300000)
  thresholdRows.append({'r':rnd,'d':side,'setting':setting,'firstQuoteAfterEntryMs':sample[0][0]-enter,
   'quoteChecks':len(sample),'minSeenPct':round(min(p for at,p in sample),2),
   'hitsMs':hits,'soldAtStop':sold,'entryOffsetMs':enter-rnd})
print('STOP35_QUOTE_TRACK_META',json.dumps({'positionsWithChecks':len(quoteTracks),
 'joinedCompleteEarlyQuotePaths':len(thresholdRows),'skipped':dict(trackSkip)}),flush=True)
print('STOP35_QUOTE_TRACK_ROWS',json.dumps(sorted(thresholdRows,key=lambda q:q['r'])[-250:],
 separators=(',',':'),ensure_ascii=False),flush=True)

# Read-only counterfactual using only observed pre-exit quotes. Buy quote price
# is an approximate payout ratio, NOT verified actual fill price.
priceRows=[]
for tok,samples in quoteTracks.items():
 grouped=collections.defaultdict(list)
 for at,pnl in samples:grouped[at//300000*300000].append((at,pnl))
 for rnd,snapshots in grouped.items():
  if rnd+300000>now:continue
  entries=[(at,d) for at,d in buys.get(rnd,[]) if at<rnd+300000]
  if not entries or len(set(d for _,d in entries))!=1:continue
  enter,side=min(entries)
  sample=sorted((at,pnl) for at,pnl in snapshots if enter<=at<rnd+300000)
  if not sample or sample[0][0]-enter>45000:continue
  previous=[(at,price) for at,price in entryQuotes.get(rnd,[]) if at<=enter and enter-at<=10000]
  if not previous:continue
  qPrice=previous[-1][1]
  hitQuotes={}
  for threshold in (25,30,35,40,45,50,55,60,70,80,90):
   hit=next((pnl for at,pnl in sample if pnl<=-threshold),None)
   if hit is not None:hitQuotes[str(threshold)]=round(hit,2)
  priceRows.append({'r':rnd,'d':side,'entryQ':round(qPrice,5),
   'hits':hitQuotes,'observedMin':round(min(pnl for at,pnl in sample),2)})
print('STOP35_PNL_META',json.dumps({'withPriorBuyQuote':len(priceRows),
 'allEarlyTracked':len(thresholdRows),'historicalQuoteEvents':sum(map(len,entryQuotes.values()))}))
print('STOP35_PNL_PATH_ROWS',json.dumps(sorted(priceRows,key=lambda q:q['r'])[-250:],separators=(',',':')))

print('STOP35_META',json.dumps(dict(reason),ensure_ascii=False),flush=True)
print('STOP35_ROUND_ROWS',json.dumps(sorted(results,key=lambda x:x['r'])[-250:],
 separators=(',',':'),ensure_ascii=False),flush=True)
try:
 with urllib.request.urlopen('http://127.0.0.1:13001/api/risk-control',timeout=7) as r:cfg=json.load(r)
 print('STOP35_LIVE_CONFIG',json.dumps({k:cfg.get(k) for k in ('takeProfitEnabled',
  'stopLossEnabled','stopLossPercent','persistenceHealthy')},ensure_ascii=False))
except Exception as exc:
 print('STOP35_LIVE_CONFIG_UNAVAILABLE',type(exc).__name__)
print('STOP35_READONLY_COMPLETE=true')
PY
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
  print('STOP35_INVALID_REF');return 2
 cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cli.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
  name='zl-stop35-reversal-readonly',type='RunShellScript',working_user='root',
  command_content=REMOTE,timeout=150)).body.invoke_id
 for _ in range(95):
  time.sleep(2)
  r=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:out=str(r.output)
   print('STOP35_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(out[-28000:])
   return 0 if int(r.exit_code)==0 else 5
 print('STOP35_RESULT_UNCONFIRMED')
 return 6
if __name__=='__main__':sys.exit(main())

#!/usr/bin/env python3
"""Read-only audit: 5m prediction CURRENT production direction hit rates and TP/SL exits.
No order modification, keys, token ids, positions or order amounts printed.
"""
import os,re,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='audit/current-tpsl-winrate-20261023'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,urllib.request,subprocess,collections,statistics,datetime,pathlib,math
from zoneinfo import ZoneInfo
tz=ZoneInfo('Asia/Singapore')
now=int(datetime.datetime.now(tz).timestamp()*1000)
def get(port,path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%s%s'%(port,path),timeout=9) as r:return json.load(r)
 except Exception as e:return {'ok':False,'errorType':type(e).__name__}
def summ(rows):
 n=len(rows)
 if not n:return {'n':0}
 r=sorted(rows)
 return {'n':n,'min':round(r[0],3),'p50':round(statistics.median(r),3),'mean':round(statistics.mean(r),3),
  'p90':round(r[int((n-1)*.9)],3),'max':round(r[-1],3)}
def rate(rows):
 n=len(rows)
 w=sum(x.get('direction')==x.get('actual') for x in rows)
 return {'n':n,'win':w,'loss':n-w,'ratePct':round(w/n*100,2) if n else None}
def direction(v):
 v=str(v or '').upper()
 return v if v in ('UP','DOWN') else None
print('TPWIN_AT_LOCAL',datetime.datetime.now(tz).isoformat())
model=get(13029,'/api/status')
trade=get(13001,'/api/status')
cfg=get(13001,'/api/risk-control')
selected=get(13001,'/api/order-signal-model')
print('TPWIN_SELECTED',json.dumps({'model':selected.get('model'),
 'modelProvider':model.get('providerModel'),'rule':model.get('decisionRule'),
 'lastDecision':model.get('lastDecision'),'followEnabled':trade.get('enabled')},ensure_ascii=False))
print('TPWIN_CONFIG',json.dumps({k:cfg.get(k) for k in ('takeProfitEnabled','takeProfitPercent','stopLossEnabled','stopLossPercent','source','persistenceHealthy')},ensure_ascii=False))
p=get(13045,'/api/round-results?limit=500')
records=p.get('records')
if not isinstance(records,list):records=[]
print('TPWIN_PANEL_OVERVIEW',json.dumps({'ok':p.get('ok'),'schema':p.get('schema'),
 'source':p.get('source'),'summary':p.get('summary'),'recordsN':len(records),
 'availableRowKeys':sorted(set().union(*(r.keys() for r in records[:8] if isinstance(r,dict))))},ensure_ascii=False)[:3500])
# Detect settlement formats, ensure strict one prediction per known round.
settleNames=('actual','actualDirection','officialResult','officialDirection','settlementDirection',
 'finalDirection','winner','winningDirection','outcome','result')
methodNames=('decisionMethod','method','signalMethod','source','strategy','model')
valid=[]
settledStatus=collections.Counter()
methods=collections.Counter()
for r in records:
 if not isinstance(r,dict):continue
 rd=r.get('round')
 if not isinstance(rd,int) or rd<1700000000000:continue
 d=direction(r.get('direction') or r.get('signalDirection'))
 actual=next((direction(r.get(k)) for k in settleNames if direction(r.get(k))),None)
 meth=next((str(r[k]) for k in methodNames if isinstance(r.get(k),str) and r[k]),'UNLABELED')
 settledStatus[str(r.get('status'))]+=1
 methods[meth]+=1
 if d and actual:valid.append({'round':rd,'direction':d,'actual':actual,'method':meth,'source':'panel'})
print('TPWIN_PANEL_STATUS_COUNTS',dict(settledStatus))
print('TPWIN_PANEL_METHOD_COUNTS',dict(methods))
print('TPWIN_PANEL_SETTLED_COUNT',len(valid))
# Separate alternative live model's journal records from earlier unrelated models.
# settlement ground truth is official record, not a guessed BTC price close.
samplePaths=[
 '/var/lib/zl-prediction/deepseek5/learning.json',
 '/var/lib/zl-prediction/deepseek5/round-results.json',
 '/var/lib/zl-prediction/deepseek5/history.json']
for path in samplePaths:
 f=pathlib.Path(path)
 if not f.exists():continue
 try:
  raw=json.loads(f.read_text())
  print('TPWIN_STORE_METADATA',path,
   {'topKeys':list(raw)[:16] if isinstance(raw,dict) else type(raw).__name__,
    'predictionN':len(raw.get('predictions',[])) if isinstance(raw,dict) and isinstance(raw.get('predictions'),list) else None})
  v=raw.get('predictions',[]) if isinstance(raw,dict) else []
  if v:print('TPWIN_STORE_ROW_KEYS',sorted(set().union(*(x.keys() for x in v[-5:] if isinstance(x,dict)))))
  cnt=0
  for r in v:
   if not isinstance(r,dict):continue
   rd=r.get('round')
   d=direction(r.get('direction'))
   a=direction(r.get('actual'))
   if isinstance(rd,int) and d and a:
    method=next((str(r[k]) for k in ('decisionMethod','method','source') if r.get(k)), 'UNLABELED')
    valid.append({'round':rd,'direction':d,'actual':a,'method':method,'source':'learning_store'})
    cnt+=1
  print('TPWIN_STORE_SETTLED',cnt)
 except Exception as e:print('TPWIN_STORE_ERROR',path,type(e).__name__)
# Deduplicate by round with panel priority, preserve attribution to original method.
valid.sort(key=lambda x:(x['round'],0 if x['source']=='panel' else 1))
first={}
for r in valid:
 if r['round'] not in first:first[r['round']]=r
valid=sorted(first.values(),key=lambda x:x['round'])
cut=now-24*3600*1000
start=1792678500000  # first t+100ms trial 2026-10-22 22:15 SG
last=[r for r in valid if r['round']>=start]
recent=[r for r in valid if r['round']>=cut]
print('TPWIN_ALL_SETTLED',rate(valid))
print('TPWIN_RECENT24H_SETTLED',rate(recent))
print('TPWIN_AFTER_100MS_RELEASE_SETTLED',rate(last))
print('TPWIN_LAST20_SETTLED',rate(valid[-20:]))
print('TPWIN_LAST50_SETTLED',rate(valid[-50:]))
for tag,rows in [('LAST24H',recent),('POST100MS',last),('LAST50',valid[-50:])]:
 by=collections.defaultdict(list)
 for r in rows:by[r['method']].append(r)
 print('TPWIN_SEGMENT_'+tag,json.dumps({str(k):rate(v) for k,v in by.items()},ensure_ascii=False))
print('TPWIN_LATEST20_ROUND_RESULTS',json.dumps([
 {'roundLocal':datetime.datetime.fromtimestamp(r['round']/1000,tz).strftime('%m-%d %H:%M'),
  'predicted':r['direction'],'actual':r['actual'],'hit':r['direction']==r['actual'],
  'method':r['method'],'source':r['source']} for r in valid[-20:]],ensure_ascii=False))
# User's actual risk engine quote checks and submits. SELL POST != filled
journal=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
 '--since','24 hours ago','-o','cat','--no-pager','-n','20000'],
 capture_output=True,text=True,timeout=22).stdout
types=collections.Counter()
checks=[];exits=[]
# Infer configured stop from each position's observed quote-derived target
# before SELL; no order IDs, token IDs, or wallet fields leave the server.
lastStopByToken={}
stopStats=collections.defaultdict(list)
for line in journal.splitlines():
 try:
  z=json.loads(line)
  if not isinstance(z,dict):continue
  event=z.get('event')
  if not str(event).startswith('risk_'):continue
 except:continue
 types[event]+=1
 if event=='risk_check':
  try:
   cost=float(z.get('totalCost'));sl=float(z.get('slTarget'))
   if cost>0 and sl>=0 and z.get('tokenId'):
    stopPct=round((1-sl/cost)*100)
    if 1<=stopPct<=100:lastStopByToken[str(z['tokenId'])]=stopPct
  except Exception:pass
 if event=='risk_check':
  try:
   cost=float(z.get('totalCost'))
   amt=float(z.get('currentSellAmount'))
   tp=float(z.get('tpTarget'))
   sl=float(z.get('slTarget'))
   if cost>0 and math.isfinite(amt):
    checks.append({'grossReturnPct':(amt/cost-1)*100,'triggeredTP':bool(z.get('tpTriggered')),
      'triggeredSL':bool(z.get('slTriggered')),'ratioTpToCost':tp/cost if tp>0 else None,
      'ratioSlToCost':sl/cost if sl>=0 else None})
  except Exception:pass
 if event=='risk_sell_submitted':
  try:
   cost=float(z['totalCost']);amt=float(z['currentSellAmount'])
   if cost>0:
    stop=lastStopByToken.get(str(z.get('tokenId')))
    rec={'reason':z.get('reason'),'grossExpectedReturnPct':round((amt/cost-1)*100,2),
     'stopSetting':stop}
    exits.append(rec)
    stopStats[str(stop) if stop is not None else 'UNKNOWN'].append(rec)
  except Exception:pass
print('TPWIN_RISK_EVENT_COUNTS',dict(types))
print('TPWIN_RISK_QUOTE_CHECKS',json.dumps({
 'n':len(checks),'grossReturnPct':summ([x['grossReturnPct'] for x in checks]),
 'tpTriggeredChecks':sum(x['triggeredTP'] for x in checks),
 'slTriggeredChecks':sum(x['triggeredSL'] for x in checks)}))
print('TPWIN_RISK_SELL_SUBMITTED',json.dumps({
 'n':len(exits),
 'byReason':dict(collections.Counter(x['reason'] for x in exits)),
 'quotedGrossReturnsPct':summ([x['grossExpectedReturnPct'] for x in exits]),
 'detailLast12':exits[-12:]},ensure_ascii=False))
print('TPWIN_RISK_EXIT_BY_STOP_SETTING',json.dumps({
 key:{'submittedN':len(v),
 'tpSubmits':sum(x['reason']=='TAKE_PROFIT' for x in v),
 'slSubmits':sum(x['reason']=='STOP_LOSS' for x in v),
 'quotedGrossReturnPct':summ([x['grossExpectedReturnPct'] for x in v]),
 'tpQuoteReturnPct':summ([x['grossExpectedReturnPct'] for x in v if x['reason']=='TAKE_PROFIT']),
 'slQuoteReturnPct':summ([x['grossExpectedReturnPct'] for x in v if x['reason']=='STOP_LOSS'])}
 for key,v in sorted(stopStats.items())},ensure_ascii=False))

# Counterfactual on only current 55%-SL settled/SELL-submitted positions:
# replay quotes observed by this risk worker BEFORE the actual first SELL.
# Moving the SL nearer needs no future quotes beyond actual exit.
# This is gross quoted liquidation PnL, not executed Binance fill price.
hist=collections.defaultdict(list)
finished=set()
replays=[]
for line in journal.splitlines():
 try:
  z=json.loads(line)
  ev=z.get('event')
  token=str(z.get('tokenId') or '')
  if not token:continue
 except Exception:continue
 if ev=='risk_check' and token not in finished:
  try:
   cost=float(z.get('totalCost'));amount=float(z.get('currentSellAmount'))
   sl=float(z.get('slTarget'));tp=float(z.get('tpTarget'))
   if all(math.isfinite(x) for x in (cost,amount,sl,tp)) and cost>0 and tp>0 and sl>=0:
    slPct=int(round((1-sl/cost)*100))
    if 1<=slPct<=100:
     hist[token].append({'cost':cost,'amount':amount,'tp':tp,'stop':slPct})
  except Exception:pass
 if ev=='risk_sell_submitted' and token not in finished:
  finished.add(token)
  path=hist.get(token,[])
  try:
   cost=float(z.get('totalCost'));amount=float(z.get('currentSellAmount'))
   setting=path[-1]['stop'] if path else None
   if not(setting==55 and cost>0):continue
   tp=path[-1]['tp']
   # Include submitted quote (sometimes refreshed shortly after risk_check).
   steps=path+[{'cost':cost,'amount':amount,'tp':tp,'stop':55}]
   row={'actualExitReason':z.get('reason'),'actualGrossPct':(amount/cost-1)*100,
      'quotedChecks':len(steps)}
   for candidate in (40,45,50,55):
    outcome=None
    for q in steps:
     if q['amount']>=q['tp']:
      outcome={'type':'TP','gross':(q['amount']/q['cost']-1)*100};break
     if q['amount']<=q['cost']*(1-candidate/100):
      outcome={'type':'SL','gross':(q['amount']/q['cost']-1)*100};break
    row[str(candidate)]=outcome
   replays.append(row)
  except Exception:pass
print('TPWIN_CURRENT55_QUOTE_REPLAY',json.dumps({
 'n':len(replays),
 'originalExit':dict(collections.Counter(x['actualExitReason'] for x in replays)),
 'quoteChecksMedian':statistics.median([x['quotedChecks'] for x in replays]) if replays else None,
 'candidates':{
   str(candidate):{
    'replayedN':sum(x.get(str(candidate)) is not None for x in replays),
    'TP':sum((x.get(str(candidate)) or {}).get('type')=='TP' for x in replays),
    'SL':sum((x.get(str(candidate)) or {}).get('type')=='SL' for x in replays),
    'grossExpectedReturnPct':summ([x[str(candidate)]['gross'] for x in replays
      if x.get(str(candidate)) is not None]),
    'incomplete':sum(x.get(str(candidate)) is None for x in replays)}
   for candidate in (40,45,50,55)}},ensure_ascii=False))

# Additional feasible counterfactual grid: TP<=35% (higher TP would require
# price paths AFTER the original sale and therefore is unobservable here).
# Quote targets are estimated from current 35% max-profit rule; exact Binance
# fills and fees are NOT known. Optimize only as descriptive in-sample evidence.
grid={}
for tpPercent in (20,25,30,35):
 for stopPercent in (35,40,45,50,55):
  result=[]
  for sample in replays:
   # Need each original position's quote time series; use ephemeral
   # recomputation below from hist and first-submitted quotes by token.
   pass
# Reconstruct completed quotes by token from the same already read journal.
byToken=collections.defaultdict(list)
completed=set()
samples=[]
for line in journal.splitlines():
 try:
  z=json.loads(line)
  token=str(z.get('tokenId') or '')
  ev=z.get('event')
  if not token or token in completed:continue
 except:continue
 if ev=='risk_check':
  try:
   cost=float(z['totalCost']);amount=float(z['currentSellAmount'])
   rawTp=float(z['tpTarget']);rawSl=float(z['slTarget'])
   if cost>0 and rawTp>cost and all(map(math.isfinite,(cost,amount,rawTp,rawSl))):
    setting=round((1-rawSl/cost)*100)
    byToken[token].append((cost,amount,rawTp,setting))
  except Exception:pass
 elif ev=='risk_sell_submitted':
  completed.add(token)
  h=byToken.get(token,[])
  if not h or h[-1][3]!=55:continue
  try:
   cost=float(z['totalCost']);amount=float(z['currentSellAmount'])
   if cost>0:h=h+[(cost,amount,h[-1][2],55)]
   samples.append(h)
  except Exception:pass
for tpPercent in (20,25,30,35):
 for stopPercent in (35,40,45,50,55):
  vals=[];types=collections.Counter();missing=0
  for steps in samples:
   found=None
   for cost,amount,currentTp,setting in steps:
    tpThreshold=cost+(currentTp-cost)*tpPercent/35
    if amount>=tpThreshold:
     found=('TP',(amount/cost-1)*100);break
    if amount<=cost*(1-stopPercent/100):
     found=('SL',(amount/cost-1)*100);break
   if found:
    types[found[0]]+=1;vals.append(found[1])
   else:missing+=1
  grid[f'{tpPercent}/{stopPercent}']={'tpN':types['TP'],'slN':types['SL'],
   'quotesN':len(vals),'incomplete':missing,
   'avgGrossQuotedReturnPct':round(statistics.mean(vals),3) if vals else None}
print('TPWIN_CURRENT55_TP_SL_GRID',json.dumps({
 'samplePositions':len(samples),'grid':grid,
 'method':'historic visible quotes to original SELL only; not live fills'},ensure_ascii=False))
print('TPWIN_AUDIT_COMPLETE=true')
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
  name='zl-live-current-winrate-and-tpsl-ro',type='RunShellScript',
  working_user='root',command_content=REMOTE,timeout=135)).body.invoke_id
 for _ in range(80):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('TPWIN_REMOTE_RESULT',r.invocation_status,'EXIT',r.exit_code)
   print(o[-25000:])
   return 0 if int(r.exit_code)==0 else 5
 print('TPWIN_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

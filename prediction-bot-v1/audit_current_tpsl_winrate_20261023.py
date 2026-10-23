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
   if cost>0:exits.append({'reason':z.get('reason'),'grossExpectedReturnPct':round((amt/cost-1)*100,2)})
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

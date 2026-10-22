#!/usr/bin/env python3
"""Read-only Binance Prediction TP/SL stage latency and health audit.
Never issue POST/order operations. Suppress wallet/token/order ids.
"""
import os,time,base64,re,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='audit/risk-exit-speed-20261023'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,urllib.request,subprocess,time,statistics,collections,pathlib,os,datetime
from zoneinfo import ZoneInfo
TZ=ZoneInfo('Asia/Singapore')
def query(port,route):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,route),timeout=8) as r:return json.load(r)
 except Exception as e:return {'ok':False,'errorClass':type(e).__name__}
def summarize(v):
 v=sorted(v);n=len(v)
 return {'n':n,'min':v[0],'p50':v[int((n-1)*.5)],'p90':v[int((n-1)*.9)],'max':v[-1]} if n else {'n':0}
def relevant(e):
 return e.startswith(('risk_','risk_runtime_'))
print('RISK_SPEED_TIME',datetime.datetime.now(TZ).isoformat())
for unit in ('zl-prediction-risk-exits.service','zl-prediction-trade.service','zl-prediction-v3.service','zl-futures-bot-paper.service'):
 result=subprocess.run(['systemctl','show',unit,'-p','ActiveState','-p','SubState','-p','NRestarts','-p','ExecMainStartTimestamp','--no-pager'],capture_output=True,text=True).stdout
 print('RISK_SPEED_UNIT',unit,result.strip().replace('\n',' ')[:330])
risk=query(13001,'/api/risk-control')
print('RISK_SPEED_CONFIG',json.dumps({k:risk.get(k) for k in ('ok','takeProfitEnabled','takeProfitPercent','stopLossEnabled','stopLossPercent','persistenceHealthy','source','enabled','configApplied')},ensure_ascii=False))
print('RISK_SPEED_RUNTIME',json.dumps(risk.get('execution') or {},ensure_ascii=False)[:1500])
status=query(13001,'/api/status')
print('RISK_SPEED_TRADING_SWITCH',{'followEnabled':status.get('enabled'),'ok':status.get('ok')})
for path in ['/tmp/risk-worker-health.json','/tmp/risk-runtime-status.json','/tmp/risk-control.json']:
 try:
  v=json.loads(pathlib.Path(path).read_text())
  keys=['at','lastTickStartedAt','lastTickFinishedAt','lastSuccessfulPositionsAt',
    'positionsSeen','lastQuoteAt','quoteChecks','quoteErrors','lastSellEventAt',
    'lastSellEvent','lastErrorAt','lastError','workerRunning','configApplied',
    'enabled','persistedConfigFound','persistenceHealthy','configurationSource',
    'takeProfitEnabled','takeProfitPercent','stopLossEnabled','stopLossPercent']
  print('RISK_SPEED_HEALTH_FILE',path,{k:v.get(k) for k in keys if k in v})
 except Exception as e:print('RISK_SPEED_HEALTH_FILE',path,'UNAVAILABLE',type(e).__name__)
root=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
for filename in ('risk-worker.mjs','risk-runner.mjs'):
 p=root/filename
 try:
  s=p.read_text()
  import re
  bounds={
   'pollMin300': 'Math.max(300' in s,
   'defaultPoll500':'AUTO_TAKE_PROFIT_POLL_MS || 500' in s,
   'sequentialPositionLoop':'for (const position of positionsResult.positions)' in s,
   'sequentialQuote':'const quoteResult = await getSellQuote' in s,
   'paymentPrefetch': 'const paymentReady = getPaymentRoute()' in s,
   'riskRetryFloor1000':'Math.max(1000' in s,
   'httpGetTimeout8000':'AbortSignal.timeout(8000)' in s,
   'httpPostTimeout10000':'AbortSignal.timeout(10000)' in s,
   'hasNativeTimingFields':'quoteLatencyMs' in s,
  }
  print('RISK_SPEED_LIVE_SOURCE',filename,'chars',len(s),'checks',json.dumps(bounds))
 except Exception as e:print('RISK_SPEED_LIVE_SOURCE',filename,'ERROR',type(e).__name__)
# Environment only selected non-sensitive configuration values, never any raw key or secret.
scan=subprocess.run(['pgrep','-af','risk-worker.mjs'],capture_output=True,text=True).stdout
import re
ids=[]
for m in re.finditer(r'^(\d+)\s+([^\n]*)',scan,re.M):
 if 'pgrep -af' in m.group(2) or 'python3' in m.group(2):continue
 ids.append(int(m.group(1)))
for pid in ids[:3]:
 try:
  proc=pathlib.Path('/proc')/str(pid)/'environ'
  env=proc.read_bytes().split(b'\0')
  allowed=(b'AUTO_RISK_POLL_MS',b'AUTO_TAKE_PROFIT_POLL_MS',b'AUTO_RISK_RETRY_MS',b'AUTO_RISK_SCOPE')
  config={}
  for raw in env:
   if b'=' not in raw:continue
   k,v=raw.split(b'=',1)
   if k in allowed:config[k.decode()]=v.decode('utf8','replace')[:40]
  print('RISK_SPEED_WORKER_ENV',config)
 except Exception as e:print('RISK_SPEED_WORKER_ENV_ERROR',type(e).__name__)
# Do not expose tokenIDs, orderIds, amounts, wallet addresses or account details in logs.
cmd=['journalctl','-u','zl-prediction-risk-exits.service','--since','8 hours ago',
 '--no-pager','-o','json','-n','20000']
p=subprocess.run(cmd,capture_output=True,text=True,timeout=19)
events=[]
for line in p.stdout.splitlines():
 try:
  x=json.loads(line);v=json.loads(x.get('MESSAGE',''))
  if not isinstance(v,dict) or not relevant(v.get('event','')):continue
  stamp=int(x.get('__REALTIME_TIMESTAMP',0))//1000
  if stamp<1_000_000_000_000:continue
  events.append({'at':stamp,'event':v['event'],
    'reason':v.get('reason') if v.get('reason') in ('STOP_LOSS','TAKE_PROFIT') else None,
    'pollMs':v.get('pollMs'),'retryMs':v.get('retryMs'),
    'network':v.get('network'),'code':str(v.get('code',''))[:25]})
 except Exception:continue
events.sort(key=lambda z:z['at'])
counts=collections.Counter(x['event'] for x in events)
print('RISK_SPEED_EVENT_COUNTS',json.dumps(counts,ensure_ascii=False))
print('RISK_SPEED_WORKER_STARTED',json.dumps([{k:v for k,v in e.items() if k in ('at','pollMs','retryMs')} for e in events if e['event']=='risk_worker_started'][-5:]))
# Quote polling intervals observed from journal. Counts include multiple positions,
# so characterize as worker event gaps, not pure API latencies.
for kind in ('risk_check','risk_triggered','risk_sell_submitted','risk_sell_failed',
 'risk_sell_quote_failed','risk_sell_unknown','risk_positions_error','risk_wallet_error'):
 xs=[x for x in events if x['event']==kind]
 delta=[b['at']-a['at'] for a,b in zip(xs,xs[1:]) if 0<=b['at']-a['at']<=30000]
 print('RISK_SPEED_EVENT_GAPS',kind,json.dumps(summarize(delta)))
print('RISK_SPEED_LATEST_EVENT_TYPES',json.dumps([{
 'timeLocal':datetime.datetime.fromtimestamp(e['at']/1000,TZ).strftime('%m-%d %H:%M:%S.%f')[:-3],
 'event':e['event'],'reason':e['reason'],'code':e['code'],'network':e['network']
 } for e in events[-45:]],ensure_ascii=False))
# Trigger to SELL submission. Pair nearest next SELL event, across a limited
# window; don't assume a specific token without token IDs, and label approximate.
trigger_to_submit=[]
for e in events:
 if e['event']!='risk_triggered':continue
 future=next((x for x in events if x['at']>=e['at'] and x['at']-e['at']<=12000 and x['event'] in ('risk_sell_submitted','risk_sell_failed','risk_sell_unknown')),None)
 if future:trigger_to_submit.append({'durationMs':future['at']-e['at'],'outcome':future['event'],'trigger':e['reason']})
print('RISK_SPEED_TRIGGER_TO_SELL_CANDIDATES',json.dumps({
 'latency':summarize([x['durationMs'] for x in trigger_to_submit]),
 'byOutcome':dict(collections.Counter(x['outcome'] for x in trigger_to_submit)),
 'latest':trigger_to_submit[-15:]},ensure_ascii=False))
print('RISK_SPEED_COMPLETE=true')
PY
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
 name='zl-prediction-tp-sl-speed-readonly-audit',type='RunShellScript',working_user='root',command_content=REMOTE,timeout=145)).body.invoke_id
 for _ in range(82):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('RISK_SPEED_CLOUD_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(o[-27000:])
   return 0 if int(r.exit_code)==0 else 5
 print('RISK_SPEED_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

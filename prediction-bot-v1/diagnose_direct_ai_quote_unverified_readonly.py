#!/usr/bin/env python3
"""Read-only production diagnosis for MODEL_OR_QUOTE_EVIDENCE_UNVERIFIED. No orders."""
import os,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -eu
python3 - <<'PY'
import urllib.request,json,subprocess,pathlib,datetime,collections
def fetch(port,path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=4) as r:
   return json.load(r)
 except Exception as e:return {'error':type(e).__name__}
def tailjournal(unit):
 p=subprocess.run(['journalctl','-u',unit,'--since','75 minutes ago','-o','cat','--no-pager'],capture_output=True,text=True,timeout=15)
 out=[]
 for ln in p.stdout.splitlines():
  ix=ln.find('{')
  if ix<0:continue
  try:d=json.loads(ln[ix:])
  except:continue
  ev=d.get('event')
  if ev in ('deepseek_direct_trade_choice','deepseek_quote_preview_unavailable','fresh_quote_ready','fresh_quote_failed','auto_submit_triggered','submit_blocked_signal_changed'):
   out.append({k:d[k] for k in ['event','round','decision','reason','verified','productionDirection','orderDirection','quoteChance','source','error'] if k in d})
 return out
m=fetch(13029,'/api/status')
t=fetch(13001,'/api/status')
s=fetch(13001,'/api/order-signal-model')
state=pathlib.Path('/var/lib/zl-prediction/deepseek5/signal.json')
signal={}
if state.exists():
 try:signal=json.loads(state.read_text())
 except Exception as e:signal={'readError':str(type(e).__name__)}
last=signal.get('latest') or {}
keep=['round','direction','lockedAt','aiTradeOpinion','aiTradeReason',
'aiQuoteObservedAt','aiQuoteUpChance','aiQuoteDownChance','selectedModelConfidence','reason']
ts=t.get('pendingAction') or {}
ev=tailjournal('zl-prediction-trade')
lastSignals=[x for x in ev if x.get('event')=='deepseek_direct_trade_choice']
pred=m.get('signal') or {}
clockRound=m.get('round')
data={
 'timeUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'followEnabled':t.get('enabled'),
 'model':m.get('providerModel'),
 'signalRound':signal.get('round'),'currentRound':clockRound,
 'latestStoredDeepSeek':{k:last.get(k) for k in keep},
 'storedAiQuoteEvidencePresent':all(isinstance(last.get(k),(int,float)) for k in ('aiQuoteObservedAt','aiQuoteUpChance','aiQuoteDownChance')),
 'statusSignalCurrent':m.get('signal') is not None,
 'modelCallsCurrent':m.get('analysisModelCalls'),
 'lastError':m.get('error'),
 'orderChoice':s.get('model'),
 'currentPending':{k:ts.get(k) for k in ['state','round','signal','productionSignal','tradeValueDecision','tradeValueReason','blockReason','error']},
 'eventCounts':dict(collections.Counter(x['event'] for x in ev)),
 'latestUnverified':lastSignals[-8:],
 'lastQuoteErrors':[x for x in ev if x.get('event') in ('deepseek_quote_preview_unavailable','fresh_quote_failed')][-8:],
 'services':{u:subprocess.run(['systemctl','is-active',u],capture_output=True,text=True).stdout.strip()
 for u in ['zl-prediction-trade.service','zl-prediction-deepseek5.service']},
}
print('ZL_DIRECT_AI_QUOTE_DIAG='+json.dumps(data,ensure_ascii=False,separators=(',',':')))
PY
"""
client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
instance='b67374069bb3457ba6a3a2ede9305d3f'
id=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=instance,name='zl-deepseek-unverified-readonly',
type='RunShellScript',working_user='root',command_content="bash -s <<'READ_ONLY'\n"+SCRIPT+"\nREAD_ONLY\n",timeout=85)).body.invoke_id
for _ in range(48):
 time.sleep(2)
 r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
  region_id='ap-southeast-1',instance_id=instance,invoke_id=id)).body.invocation_result
 if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
  try:out=base64.b64decode(r.output or '',validate=True).decode('utf-8','replace')
  except Exception:out=str(r.output)
  print('DIRECT_AI_UNVERIFIED_DIAG_STATE',r.invocation_status,'EXIT',r.exit_code)
  for line in out.splitlines():
   if line.startswith('ZL_DIRECT_AI_QUOTE_DIAG='):print(line)
  if int(r.exit_code)!=0:print(out[-900:])
  sys.exit(0 if int(r.exit_code)==0 else 5)
sys.exit('DIRECT_AI_UNVERIFIED_DIAG_TIMEOUT')

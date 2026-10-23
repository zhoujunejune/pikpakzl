#!/usr/bin/env python3
"""Read-only independent running Alibaba adaptive-risk health and latency validation."""
import os,re,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/risk-adaptive-fast-confirm-20261023'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,subprocess,urllib.request,datetime,time,collections,statistics,pathlib
from zoneinfo import ZoneInfo
sg=ZoneInfo('Asia/Singapore')
now=datetime.datetime.now(sg)
print('POST_ADAPTIVE_AUDIT_AT',now.isoformat())
def get(p):
 with urllib.request.urlopen('http://127.0.0.1:13001'+p,timeout=7) as r:return json.load(r)
c=get('/api/risk-control')
t=get('/api/status')
ex=c.get('execution') or {}
print('POST_ADAPTIVE_CONTROLS',{k:c.get(k) for k in
 ('takeProfitEnabled','takeProfitPercent','stopLossEnabled','stopLossPercent','persistenceHealthy')})
print('POST_ADAPTIVE_HEALTH',{k:ex.get(k) for k in
 ('enabled','ready','workerRunning','configApplied','persistenceHealthy')})
print('POST_ADAPTIVE_FOLLOW_ENABLED',t.get('enabled'))
from pathlib import Path
s=Path('/opt/zl-prediction-live/src/railway-diagnostic/risk-worker.mjs').read_text()
print('POST_ADAPTIVE_LIVE_CODE',{
 'fast200':'const NEAR_TARGET_FAST_POLL_MS = 200;' in s,
 'baseline300':'AUTO_TAKE_PROFIT_POLL_MS || 300' in s,
 'status2500':'const SUBMITTED_RECONCILE_MS = 2500;' in s,
 'realQuoteOnly':'isNearRealQuoteThreshold(targets, evaluation)' in s,
 'noOverlapping':'if ((!TAKE_PROFIT_ENABLED && !STOP_LOSS_ENABLED) || workerBusy) return;' in s,
 'safeStateBeforePost':'persistPendingSellState(); // must succeed BEFORE sending a real SELL' in s,
 'finalStateChecks':'safeToRetryUnfilledSubmitted({' in s})
assert 'const NEAR_TARGET_FAST_POLL_MS = 200;' in s
assert 'const SUBMITTED_RECONCILE_MS = 2500;' in s
assert c.get('takeProfitEnabled') and c.get('stopLossEnabled')
assert c.get('takeProfitPercent')==35 and c.get('stopLossPercent')==35
assert c.get('persistenceHealthy') and ex.get('workerRunning') and ex.get('configApplied')
state=Path('/var/lib/zl-prediction/risk-sell-recovery/pending-v1.json')
j=json.loads(state.read_text())
print('POST_ADAPTIVE_PENDING_JOURNAL',{
 'exists':state.exists(),'valid':j.get('schema')==1,
 'outstandingN':len(j.get('outstanding') or [])})
assert j.get('schema')==1 and isinstance(j.get('outstanding'),list)
raw=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
 '--since','2026-10-23 09:06:00 UTC','--no-pager','-o','cat','-n','18000'],
 capture_output=True,text=True,timeout=14)
counts=collections.Counter()
quoteFetch=[];postLatency=[];fastN=0;slowN=0;starts=[];rechecks=[];lastError=[]
for line in raw.stdout.splitlines():
 try:
  v=json.loads(line)
  ev=v.get('event')
  if not isinstance(ev,str):continue
  counts[ev]+=1
  if ev=='risk_worker_started':
   starts.append({k:v.get(k) for k in ('pollMs','fastPollMs','nearTargetDistancePct',
    'submittedCheckMs','takeProfitPercent','stopLossPercent')})
  if ev=='risk_check':
   (fastN if v.get('fastNearTarget') else slowN)
   if v.get('fastNearTarget'):fastN+=1
   else:slowN+=1
   if isinstance(v.get('quoteFetchMs'),(float,int)):quoteFetch.append(v['quoteFetchMs'])
  if ev=='risk_sell_submitted' and isinstance(v.get('exchangePostResponseMs'),(int,float)):
   postLatency.append(v['exchangePostResponseMs'])
  if ev in ('risk_sell_journal_unavailable','risk_sell_state_persist_failed',
   'risk_sell_not_submitted_journal_unavailable','risk_tick_exception','risk_wallet_error',
   'risk_positions_error','risk_sell_exception'):
   lastError.append(ev)
 except Exception:pass
def summary(x):
 if not x:return {'n':0}
 s=sorted(x);return {'n':len(x),'p50':statistics.median(s),
  'p90':s[int(.9*(len(s)-1))],'max':s[-1]}
print('POST_ADAPTIVE_START_BANNERS',starts[-3:])
print('POST_ADAPTIVE_COUNTS',{k:v for k,v in counts.items() if k in (
 'risk_check','risk_triggered','risk_sell_submitted','risk_sell_fill_confirmed',
 'risk_sell_final_failed_retry_scheduled','risk_sell_journal_ready',
 'risk_sell_journal_unavailable','risk_sell_not_submitted_journal_unavailable',
 'risk_sell_quote_failed','risk_tick_exception','risk_wallet_error','risk_positions_error')})
print('POST_ADAPTIVE_NEAR_TARGET_QUOTES',{'fast':fastN,'normal':slowN})
print('POST_ADAPTIVE_QUOTE_FETCH_LATENCY_MS',summary(quoteFetch))
print('POST_ADAPTIVE_POST_RESPONSE_MS',summary(postLatency))
print('POST_ADAPTIVE_NEW_ERRORS',lastError[-15:])
assert starts and starts[-1].get('fastPollMs')==200 and starts[-1].get('submittedCheckMs')==2500
assert counts['risk_sell_journal_ready']>=1,'NO_POST_RESTART_PROOF_JOURNAL_WRITABLE'
for service in ('zl-prediction-risk-exits.service','zl-prediction-trade.service',
 'zl-prediction-v3.service','zl-prediction-deepseek5.service',
 'zl-futures-bot-paper.service'):
 assert subprocess.run(['systemctl','is-active','--quiet',service]).returncode==0,service
print('POST_ADAPTIVE_AUDIT_SUCCESS=true')
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
 name='zl-risk-adaptive-postdeploy-health-readonly',type='RunShellScript',
 working_user='root',command_content=REMOTE,timeout=90)).body.invoke_id
 for _ in range(60):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '').decode(errors='replace')
   except Exception:o=str(r.output)
   print('POST_ADAPTIVE_REMOTE',r.invocation_status,'exit',r.exit_code)
   print(o[-10000:])
   return 0 if int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':raise SystemExit(main())

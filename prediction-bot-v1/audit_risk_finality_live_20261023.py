#!/usr/bin/env python3
"""Independent read-only post-release TP-SL SELL-finality deployment verification."""
import os,sys,re,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/risk-sell-postsubmit-recovery-20261023'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,urllib.request,subprocess,collections,os,stat,datetime
from pathlib import Path
from zoneinfo import ZoneInfo
print('POSTSELL_VERIFY_AT',datetime.datetime.now(ZoneInfo('Asia/Singapore')).isoformat())
def get(p):
 with urllib.request.urlopen('http://127.0.0.1:13001'+p,timeout=8) as r:return json.load(r)
c=get('/api/risk-control');s=get('/api/status')
print('POSTSELL_VERIFY_RISK_CONFIG',json.dumps({k:c.get(k) for k in
 ('takeProfitEnabled','takeProfitPercent','stopLossEnabled','stopLossPercent','persistenceHealthy')},ensure_ascii=False))
print('POSTSELL_VERIFY_EXECUTION',json.dumps({k:(c.get('execution')or{}).get(k) for k in
 ('enabled','workerRunning','configApplied','persistenceHealthy')},ensure_ascii=False))
print('POSTSELL_VERIFY_FOLLOW_ENABLED',s.get('enabled'))
src=Path('/opt/zl-prediction-live/src/railway-diagnostic/risk-worker.mjs').read_text()
helper=Path('/opt/zl-prediction-live/src/railway-diagnostic/risk-sell-finality.mjs').read_text()
checks={'hasPostSubmitFinality':'async function reconcileSubmittedSell(' in src,
 'hasCrashRestore':'restorePendingSellState();' in src,
 'prePostDurableFence':'persistPendingSellState(); // must succeed BEFORE sending a real SELL' in src,
 'safeZeroFillReconcile':'safeToRetryUnfilledSubmitted({' in src,
 'noDuplicateUnknown':'if (state?.statusUnknown)' in src,
 'noDuplicateSubmitted':'if(state?.submitted){' in src,
 'sameQuoteExpiryGuard':'const QUOTE_MIN_REMAINING_MS = 250;' in src,
 'strictOrderIdClassifier':'classifySubmittedRiskSellOrder' in helper,
 'samePoll300':'AUTO_TAKE_PROFIT_POLL_MS || 300' in src}
print('POSTSELL_VERIFY_LIVE_CODE',json.dumps(checks))
f=Path('/var/lib/zl-prediction/risk-sell-recovery/pending-v1.json')
data=json.loads(f.read_text())
print('POSTSELL_VERIFY_JOURNAL',json.dumps({
 'exists':f.exists(),'mode':oct(stat.S_IMODE(f.stat().st_mode)),
 'schema':data.get('schema'),'outstandingCount':len(data.get('outstanding',[])),
 'outstandingTypes':dict(collections.Counter('unknown' if v.get('statusUnknown') else
   'submitted' if v.get('submitted') else 'inflight' if v.get('inFlight') else 'other'
   for k,v in data.get('outstanding',[])))},ensure_ascii=False))
assert all(checks.values())
assert f.exists() and stat.S_IMODE(f.stat().st_mode)==0o600 and data.get('schema')==1
logs=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
 '--since','35 minutes ago','-o','cat','--no-pager','-n','20000'],
 capture_output=True,text=True,timeout=18).stdout
counts=collections.Counter();started=[]
for line in logs.splitlines():
 try:
  v=json.loads(line);event=v.get('event')
  if not isinstance(event,str):continue
 except Exception:continue
 counts[event]+=1
 if event=='risk_worker_started':
  started.append({k:v.get(k) for k in ('at','pollMs','retryMs','takeProfitPercent',
    'stopLossPercent','acceptedSellPolicy','pendingSellRecovery')})
print('POSTSELL_VERIFY_STARTS',json.dumps(started[-3:],ensure_ascii=False))
print('POSTSELL_VERIFY_EVENTS',json.dumps({k:v for k,v in counts.items()
 if k in ('risk_check','risk_triggered','risk_sell_submitted',
 'risk_sell_fill_confirmed','risk_sell_final_failed_retry_scheduled',
 'risk_sell_finality_pending','risk_unknown_reconciled_rejected',
 'risk_sell_unknown','risk_retry_scheduled','risk_sell_failed','risk_tick_exception',
 'risk_runtime_worker_exited','risk_worker_started')},ensure_ascii=False))
assert started and started[-1].get('acceptedSellPolicy')=='RECHECK_BINANCE_ORDER_ID_TERMINAL_STATUS_AND_RETRY_ONLY_ZERO_FILL'
for unit in ('zl-prediction-risk-exits.service','zl-prediction-trade.service',
 'zl-prediction-v3.service','zl-prediction-deepseek5.service','zl-futures-bot-paper.service'):
 assert subprocess.run(['systemctl','is-active','--quiet',unit]).returncode==0,unit
print('POSTSELL_INDEPENDENT_VERIFY_COMPLETE=true')
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
 name='zl-risk-sell-finality-postrelease-readonly',
 type='RunShellScript',working_user='root',command_content=REMOTE,timeout=105)).body.invoke_id
 for _ in range(70):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('POSTSELL_READONLY_RESULT',r.invocation_status,'EXIT',r.exit_code)
   print(o[-10000:])
   return 0 if int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':sys.exit(main())

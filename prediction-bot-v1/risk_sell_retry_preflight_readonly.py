#!/usr/bin/env python3
"""Read-only preflight for safe risk worker upgrade on Alibaba Cloud."""
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/risk-sell-safe-retry-20261023'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,urllib.request,subprocess,time,difflib,pathlib,hashlib
from datetime import datetime
from zoneinfo import ZoneInfo
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=8) as r:return json.load(r)
r=get('/api/risk-control')
s=get('/api/status')
print('SELLRETRY_PREFLIGHT_AT',datetime.now(ZoneInfo('Asia/Singapore')).isoformat())
print('SELLRETRY_PREFLIGHT_TP_SL',r.get('takeProfitPercent'),r.get('stopLossPercent'))
print('SELLRETRY_PREFLIGHT_RISK_ENABLED',json.dumps({k:r.get(k) for k in ('takeProfitEnabled','stopLossEnabled','updatedAt','source','persistenceHealthy')},ensure_ascii=False))
print('SELLRETRY_PREFLIGHT_FOLLOW_ON',s.get('enabled'))
print('SELLRETRY_PREFLIGHT_WORKER_HEALTH',{k:(r.get('execution')or{}).get(k) for k in ('enabled','workerRunning','configApplied','persistenceHealthy')})
print('SELLRETRY_PREFLIGHT_PENDING_ACTION_STATE',(s.get('pendingAction') or {}).get('state'))
p=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic/risk-worker.mjs')
a=p.read_text()
u='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/37105215f4b1dc71408c2837a3bf44d633a2cc89/railway-diagnostic/risk-worker.mjs'
try:
 with urllib.request.urlopen(u,timeout=15) as f:b=f.read().decode()
 changes=[]
 for tag,a0,a1,b0,b1 in difflib.SequenceMatcher(a=a.splitlines(),b=b.splitlines(),autojunk=False).get_opcodes():
  if tag!='equal':
   # source code only, not env values
   changes.append({'kind':tag,'liveLine':a0+1,'baselineLine':b0+1,'liveSnippet':' '.join(a.splitlines()[a0:a1])[:220],'baseSnippet':' '.join(b.splitlines()[b0:b1])[:220]})
 print('SELLRETRY_PREFLIGHT_WORKER_DIFFS',json.dumps(changes[:14],ensure_ascii=False))
 print('SELLRETRY_PREFLIGHT_MATCHES_BASE',a==b)
except Exception as e:print('SELLRETRY_PREFLIGHT_BASE_COMPARE_UNAVAILABLE',type(e).__name__)
logs=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
 '--since','60 seconds ago','-o','cat','--no-pager','-n','500'],
 capture_output=True,text=True,timeout=11).stdout
counts={}
for line in logs.splitlines():
 try:
  event=json.loads(line).get('event')
  if not isinstance(event,str) or not event.startswith('risk_'):continue
  if event in ('risk_check','risk_triggered','risk_sell_unknown','risk_sell_submitted',
    'risk_sell_failed','risk_positions_error','risk_quote_failed','risk_retry_scheduled'):
   counts[event]=counts.get(event,0)+1
 except:continue
print('SELLRETRY_PREFLIGHT_LAST60_RISK_EVENTS',json.dumps(counts))

recent=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
 '--since','15 minutes ago','-o','cat','--no-pager','-n','800'],
 capture_output=True,text=True,timeout=11).stdout
started=[]
for line in recent.splitlines():
 try:
  q=json.loads(line)
  if q.get('event')=='risk_worker_started':
   started.append({k:q.get(k) for k in ('pollMs','retryMs','unknownSellPolicy',
     'takeProfitPercent','stopLossPercent','retrySlowAfterFailures')})
 except:continue
print('SELLRETRY_PREFLIGHT_WORKER_STARTS',json.dumps(started[-7:],ensure_ascii=False))
print('SELLRETRY_PREFLIGHT_WORKER_SOURCE_RETRY_POLICY',
 {'hasNewReconcile': 'reconcileUnknownSell(' in a,
  'hasRetryScheduler':'scheduleKnownFailure(' in a,
  'hasNewHelperImport':"from './risk-sell-retry.mjs'" in a})
print('SELLRETRY_PREFLIGHT_UNIT_CURRENT',subprocess.run(
 ['systemctl','is-active','zl-prediction-risk-exits.service'],
 capture_output=True,text=True,timeout=5).stdout.strip())
print('SELLRETRY_PREFLIGHT_READONLY_COMPLETE=true')
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
 name='zl-risk-sellretry-preflight-readonly',type='RunShellScript',
 working_user='root',command_content=REMOTE,timeout=135)).body.invoke_id
 for _ in range(80):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('SELLRETRY_PREFLIGHT_REMOTE_RESULT',r.invocation_status,r.exit_code)
   print(o[-13000:])
   return 0 if int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':sys.exit(main())

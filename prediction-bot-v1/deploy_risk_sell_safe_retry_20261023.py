#!/usr/bin/env python3
"""Guarded Binance Prediction TP/SL worker update. No trades sent by deploy."""
import os,re,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/risk-sell-safe-retry-20261023'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
unit=zl-prediction-risk-exits.service
root=/opt/zl-prediction-live/src/railway-diagnostic
file="$root/risk-worker.mjs"
helper="$root/risk-sell-retry.mjs"
node=/opt/zl-prediction-node/bin/node
test -x "$node" && test -f "$file" && test "$(systemctl is-active "$unit")" = active
for service in zl-prediction-trade zl-prediction-v3 zl-prediction-deepseek5 zl-futures-bot-paper;do
 test "$(systemctl is-active "$service")" = active || exit 3
done
W=$(mktemp -d /tmp/zl-safe-retry.XXXXXXXX)
trap 'rm -rf "$W"' EXIT
export W
python3 - <<'PY'
import os,urllib.request,difflib
from pathlib import Path
w=Path(os.environ['W'])
prefix='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'
versions={
 'base':'02ab8e05eaccfb7af1819c67cd887dfa16f11788',
 'next':'COMMIT_SHA'}
for label,sha in versions.items():
 url=prefix+sha+'/railway-diagnostic/risk-worker.mjs'
 with urllib.request.urlopen(url,timeout=25) as r:data=r.read()
 if len(data)<21000 or len(data)>45000:raise RuntimeError('UNEXPECTED_SOURCE_SIZE')
 (w/(label+'.mjs')).write_bytes(data)
url=prefix+versions['next']+'/railway-diagnostic/risk-sell-retry.mjs'
with urllib.request.urlopen(url,timeout=25) as r:data=r.read()
assert 600<len(data)<10000
(w/'new-helper.mjs').write_bytes(data)
old=(w/'base.mjs').read_text().splitlines(keepends=True)
new=(w/'next.mjs').read_text().splitlines(keepends=True)
patch=''.join(difflib.unified_diff(old,new,fromfile='a/risk-worker.mjs',tofile='b/risk-worker.mjs',n=3))
assert 'reconcileUnknownSell' in patch and 'scheduleKnownFailure' in patch
(w/'change.patch').write_text(patch)
print('RISKRETRY_CANDIDATE_DOWNLOADED_AND_DIFFED=true')
PY
cp -p "$file" "$W/live.mjs"
patch --batch --fuzz=0 --dry-run "$W/live.mjs" "$W/change.patch"
patch --batch --fuzz=0 "$W/live.mjs" "$W/change.patch"
"$node" --check "$W/live.mjs"
"$node" --check "$W/new-helper.mjs"
# Must deploy worker and its new import in the same transaction.
python3 - <<'PY'
import os
from pathlib import Path
w=Path(os.environ['W'])
s=(w/'live.mjs').read_text()
p=(w/'new-helper.mjs').read_text()
checks=[
 "import {reconcileExactUnknownOrder} from './risk-sell-retry.mjs';",
 "const UNKNOWN_RECONCILE_MS = 10000",
 "risk_retry_scheduled",
 "risk_unknown_reconcile_pending",
 "statusUnknown: true",
 "risk_unknown_reconciled_rejected",
 "const POLL_MS = Math.max(300",
 "currentSellAmount <= targets.slTarget",
 "currentSellAmount >= targets.tpTarget",
 "place-order-bundle"]
assert all(k in s for k in checks),'CANDIDATE_MISSING_SAFETY_INVARIANT'
assert 'REJECTED_NO_FILL_CAN_REEVALUATE' in p
assert 'REJECTED_NO_FILL_CAN_REEVALUATE' in s
print('RISKRETRY_NODE_AND_SAFETY_INVARIANTS_OK=true')
PY
# Stop if an ambiguous prior SELL or currently open/being-quoted position exists.
# Risk executor stores unknown-order protection in memory: never restart while
# a potential sell is in flight or an unresolved status could be lost.
python3 - <<'PY'
import json,urllib.request,subprocess,time,os
def get(route):
 with urllib.request.urlopen('http://127.0.0.1:13001'+route,timeout=8) as r:return json.load(r)
c=get('/api/risk-control');t=get('/api/status')
e=c.get('execution') or {}
assert c.get('ok') is True and c.get('persistenceHealthy') is True
assert e.get('workerRunning') is True and e.get('configApplied') is True
pending=t.get('pendingAction') or {}
assert pending.get('state') not in ('QUOTING','SUBMITTING','SUBMISSION_UNKNOWN')
config={k:c.get(k) for k in ('takeProfitEnabled','takeProfitPercent','stopLossEnabled','stopLossPercent')}
open(os.environ['W']+'/before.json','w').write(json.dumps(config))
danger={'risk_check','risk_triggered','risk_sell_submitted',
 'risk_sell_unknown','risk_sell_failed','risk_sell_exception',
 'risk_sell_quote_failed','risk_unknown_reconcile_pending',
 'risk_unknown_reconcile_error'}
# Abort when an UNKNOWN order occurred in last 10min. It cannot safely lose the
# existing in-memory status guard on restart.
past=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
 '--since','10 minutes ago','--no-pager','-o','cat','-n','2000'],
 capture_output=True,text=True,timeout=10).stdout
for line in past.splitlines():
 try:e=json.loads(line).get('event')
 except:continue
 if e in ('risk_sell_unknown','risk_unknown_reconcile_pending'):
  raise RuntimeError('UNKNOWN_SELL_STILL_NEEDS_RECONCILIATION_ABORT_DEPLOY')
# Need a 25sec quiet period, so no position being monitored or SELL outstanding.
for attempt in range(150):
 logs=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
  '--since','25 seconds ago','--no-pager','-o','cat','-n','1200'],
  capture_output=True,text=True,timeout=9).stdout
 last=[json.loads(z).get('event') for z in logs.splitlines() if z.lstrip().startswith('{')]
 if not any(k in danger for k in last):
  c2=get('/api/risk-control')
  assert all(c2.get(k)==v for k,v in config.items()),'USER_CHANGED_RISK_SETTING_ABORT'
  t2=get('/api/status')
  assert (t2.get('pendingAction') or {}).get('state') not in ('QUOTING','SUBMITTING','SUBMISSION_UNKNOWN')
  print('RISKRETRY_SAFE_QUIET_25S_CONFIRMED=true')
  break
 time.sleep(1)
else:raise RuntimeError('NO_SAFE_DEPLOY_WINDOW_KEEP_OLD_EXECUTOR')
print('RISKRETRY_USER_CONFIG_UNCHANGED=true')
PY
BACKUP=/var/lib/zl-prediction/archive/source-backups/risk-safe-retry-COMMIT_SHA
test ! -e "$BACKUP"
mkdir -p "$BACKUP"
cp -p "$file" "$BACKUP/old-worker.mjs"
if test -f "$helper";then cp -p "$helper" "$BACKUP/old-helper.mjs";fi
rollback(){
 echo 'RISKRETRY_ROLLBACK_ATTEMPTED=true'
 cp -p "$BACKUP/old-worker.mjs" "$file" || true
 if test -f "$BACKUP/old-helper.mjs";then cp -p "$BACKUP/old-helper.mjs" "$helper";else rm -f "$helper";fi
 systemctl restart "$unit" || true
}
trap rollback ERR
# Rollback applies even if module syntax or health verification fails.
chown --reference="$file" "$W/live.mjs" "$W/new-helper.mjs"
chmod --reference="$file" "$W/live.mjs" "$W/new-helper.mjs"
cp -p "$W/new-helper.mjs" "$helper"
cp -p "$W/live.mjs" "$file"
systemctl restart "$unit"
python3 - <<'PY'
import json,urllib.request,subprocess,time,os
def get(route):
 with urllib.request.urlopen('http://127.0.0.1:13001'+route,timeout=8) as r:return json.load(r)
before=json.load(open(os.environ['W']+'/before.json'))
for i in range(45):
 try:
  c=get('/api/risk-control');e=c.get('execution') or {}
  if e.get('workerRunning') is True and e.get('configApplied') is True and c.get('persistenceHealthy') is True:break
 except Exception:pass
 time.sleep(1)
else:raise RuntimeError('RISK_WORKER_NOT_HEALTHY_ROLLBACK')
assert all(c.get(k)==v for k,v in before.items()),'RISK_SETTINGS_DRIFT'
# Child status can be published by the runner before the child has logged its
# risk_worker_started event. Wait for the exact NEW worker banner; never accept
# an older 300ms worker as proof of deploying the retry implementation.
for wait in range(45):
 out=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
  '--since','3 minutes ago','--no-pager','-o','cat','-n','350'],
  capture_output=True,text=True,timeout=10).stdout
 started=[]
 for line in out.splitlines():
  try:
   j=json.loads(line)
   if j.get('event')=='risk_worker_started':started.append(j)
  except:continue
 if started and started[-1].get('pollMs')==300 and started[-1].get('unknownSellPolicy')=='VERIFY_EXCHANGE_HISTORY_OR_BLOCK':
  break
 time.sleep(0.5)
else:
 print('RISKRETRY_WORKER_BANNERS_OBSERVED',[
  {k:v.get(k) for k in ('pollMs','retryMs','unknownSellPolicy')} for v in started[-3:]])
 raise RuntimeError('NEW_RISK_RETRY_WORKER_BANNER_NOT_VISIBLE_ROLLBACK')
assert isinstance(started[-1].get('retryMs'),int) and 1000<=started[-1]['retryMs']<=10000
for unit in ('zl-prediction-risk-exits.service','zl-prediction-trade.service',
 'zl-prediction-v3.service','zl-prediction-deepseek5.service',
 'zl-futures-bot-paper.service'):
 assert subprocess.run(['systemctl','is-active','--quiet',unit]).returncode==0,unit
print('RISKRETRY_PRODUCTION_RETRIES_ENABLED=true')
print('RISKRETRY_TPSL_THRESHOLD_SETTINGS_UNCHANGED=true')
print('RISKRETRY_FAST_RETRY_MS',started[-1]['retryMs'])
print('RISKRETRY_UNKNOWN_ORDER_EXCHANGE_RECONCILIATION=true')
print('RISKRETRY_OTHER_TRADING_SERVICES_UNCHANGED=true')
print('RISKRETRY_RELEASE_SUCCESS=true')
PY
echo "RISKRETRY_BACKUP=$BACKUP"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 i=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
 name='zl-risk-safe-retry-quiet-window-deploy',type='RunShellScript',
 working_user='root',command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=250)).body.invoke_id
 for _ in range(145):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=i)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('RISKRETRY_DEPLOY_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(o[-15000:])
   return 0 if int(r.exit_code)==0 else 5
 print('RISKRETRY_DEPLOY_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

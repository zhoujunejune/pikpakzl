#!/usr/bin/env python3
"""Guarded Alibaba production release of confirmed-order TP/SL recovery.
No orders submitted by deploy. Atomic durable pending-order fence.
"""
import os,re,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/risk-sell-postsubmit-recovery-20261023'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
UNIT=zl-prediction-risk-exits.service
ROOT=/opt/zl-prediction-live/src/railway-diagnostic
WORKER="$ROOT/risk-worker.mjs"
HELPER="$ROOT/risk-sell-finality.mjs"
NODE=/opt/zl-prediction-node/bin/node
STATEDIR=/var/lib/zl-prediction/risk-sell-recovery
STATE="$STATEDIR/pending-v1.json"
test "$(id -u)" -eq 0 && test -x "$NODE" && test -f "$WORKER"
for unit in zl-prediction-risk-exits zl-prediction-trade zl-prediction-v3 zl-prediction-deepseek5 zl-futures-bot-paper;do
 test "$(systemctl is-active "$unit")" = active || { echo "POSTSELL_SERVICE_NOT_ACTIVE=$unit";exit 3; }
done
W=$(mktemp -d /tmp/zl-finality-XXXXXXXX)
trap 'rm -rf "$W"' EXIT
export W
# Download immutable public GitHub source commits; runtime cloud keys stay on host.
python3 - <<'PY'
from pathlib import Path
import os,urllib.request
w=Path(os.environ['W'])
root='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'
base='1a867c648579a2de1be87bd7930639b917aae589'
next='COMMIT_SHA'
for name,url in [
 ('base.mjs',root+base+'/railway-diagnostic/risk-worker.mjs'),
 ('next.mjs',root+next+'/railway-diagnostic/risk-worker.mjs'),
 ('finality.mjs',root+next+'/railway-diagnostic/risk-sell-finality.mjs')]:
 with urllib.request.urlopen(url,timeout=25) as r:data=r.read()
 assert 700<(len(data))<55000
 (w/name).write_bytes(data)
live=Path('/opt/zl-prediction-live/src/railway-diagnostic/risk-worker.mjs').read_text()
baseline=(w/'base.mjs').read_text()
change="const WORKER_HEALTH_FILE = '/tmp/risk-worker-health.json';"
override="const WORKER_HEALTH_FILE = process.env.RISK_WORKER_HEALTH_FILE || '/tmp/risk-worker-health.json';"
assert baseline.count(change)==1
# Reject any unexplained production drift; preserve the pre-existing health override.
assert live==baseline or live==baseline.replace(change,override),'UNEXPECTED_LIVE_RISK_WORKER_SOURCE_DRIFT'
nextCode=(w/'next.mjs').read_text()
if live!=baseline:
 assert nextCode.count(change)==1
 nextCode=nextCode.replace(change,override)
(w/'staged-worker.mjs').write_text(nextCode)
assert "acceptedSellPolicy:'RECHECK_BINANCE_ORDER_ID_TERMINAL_STATUS_AND_RETRY_ONLY_ZERO_FILL'" in nextCode
assert 'function persistPendingSellState(){' in nextCode
assert 'async function reconcileSubmittedSell(' in nextCode
assert "if(state?.submitted){" in nextCode
assert 'const POLL_MS = Math.max(300' in nextCode
print('POSTSELL_CANDIDATE_MATCHES_LIVE_BASELINE=true')
print('POSTSELL_ONLY_EXPECTED_FEATURES_ADDED=true')
PY
"$NODE" --check "$W/staged-worker.mjs"
"$NODE" --check "$W/finality.mjs"
# Stage dependencies together so import resolution never breaks across restart.
test ! -e "$HELPER"
python3 - <<'PY'
import pathlib,json,urllib.request,os,subprocess
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=8) as r:return json.load(r)
c=get('/api/risk-control')
e=c.get('execution') or {}
assert c.get('ok') is True and c.get('persistenceHealthy') is True
assert e.get('workerRunning') is True and e.get('configApplied') is True
config={k:c.get(k) for k in ('takeProfitEnabled','takeProfitPercent',
 'stopLossEnabled','stopLossPercent')}
pathlib.Path(os.environ['W']+'/config.json').write_text(json.dumps(config))
print('POSTSELL_OLD_WORKER_HEALTHY_AND_CONFIG_SAVED=true')
PY
# Wait for a QUIET position window. Never lose the old worker's in-memory
# unknown/pending SELL record, and don't interrupt quote/submission processing.
python3 - <<'PY'
import json,time,subprocess,urllib.request
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=8) as r:return json.load(r)
danger={'risk_check','risk_triggered','risk_sell_submitted','risk_sell_failed',
 'risk_sell_unknown','risk_sell_exception','risk_sell_quote_failed',
 'risk_unknown_reconcile_pending','risk_unknown_reconcile_error',
 'risk_retry_scheduled','risk_sell_finality_pending'}
historical=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
 '--since','10 minutes ago','-o','cat','--no-pager','-n','5000'],
 capture_output=True,text=True,timeout=12).stdout
for line in historical.splitlines():
 try:
  ev=json.loads(line).get('event')
  assert ev not in ('risk_sell_unknown','risk_unknown_reconcile_pending'), 'UNKNOWN_OLD_ORDER_REFUSE_RESTART'
 except ValueError:continue
saved=get('/api/risk-control')
config={k:saved.get(k) for k in ('takeProfitEnabled','takeProfitPercent','stopLossEnabled','stopLossPercent')}
for attempt in range(145):
 logs=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
  '--since','30 seconds ago','--no-pager','-o','cat','-n','1500'],
  capture_output=True,text=True,timeout=9).stdout
 events=[]
 for line in logs.splitlines():
  try: events.append(json.loads(line).get('event'))
  except:continue
 t=get('/api/status')
 pending=(t.get('pendingAction') or {}).get('state')
 if not any(x in danger for x in events) and pending not in ('QUOTING','SUBMITTING','SUBMISSION_UNKNOWN'):
  c=get('/api/risk-control')
  assert all(c.get(k)==v for k,v in config.items()),'TP_SL_CONFIG_CHANGED_ABORT'
  assert (c.get('execution') or {}).get('workerRunning') is True
  print('POSTSELL_SAFE_30S_IDLE_WINDOW=true')
  break
 time.sleep(1)
else:raise RuntimeError('POSTSELL_NO_QUIET_WINDOW_NO_PRODUCTION_CHANGE')
PY
# Create a new dedicated root-/service-owned persistent folder after the
# quiet-window check; the file holds only pending order IDs and internal flags.
test ! -e "$STATEDIR"
svcUser="$(systemctl show "$UNIT" --property=User --value)"
if [ -z "$svcUser" ];then svcUser=root;fi
svcGroup="$(systemctl show "$UNIT" --property=Group --value)"
if [ -z "$svcGroup" ];then svcGroup="$(id -gn "$svcUser")";fi
install -d -m 700 -o "$svcUser" -g "$svcGroup" "$STATEDIR"
python3 - "$STATE" <<'PY'
from pathlib import Path
import sys,json
s=Path(sys.argv[1])
with s.open('x') as f:f.write(json.dumps({'schema':1,'at':0,'outstanding':[]}))
s.chmod(0o600)
PY
chown "$svcUser:$svcGroup" "$STATE"
# Test folder is writable by the real unit service user before touching code.
if [ "$svcUser" = root ];then
 touch "$STATEDIR/write-test" && rm "$STATEDIR/write-test"
else
 runuser -u "$svcUser" -- sh -c 'touch "$1" && rm "$1"' sh "$STATEDIR/write-test"
fi
BACKUP=/var/lib/zl-prediction/archive/source-backups/risk-post-submit-COMMIT_SHA
test ! -e "$BACKUP"
mkdir -p "$BACKUP"
cp -p "$WORKER" "$BACKUP/old-risk-worker.mjs"
rollback(){
 echo 'POSTSELL_ROLLBACK_ATTEMPTED=true'
 # Never roll back to an old memory-only worker if the NEW worker already sent
 # a SELL: doing so could erase its durable duplicate-submission fence.
 if python3 - "$STATE" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1])
v=json.loads(p.read_text())
raise SystemExit(0 if not v.get('outstanding') else 1)
PY
 then
  cp -p "$BACKUP/old-risk-worker.mjs" "$WORKER" || true
  rm -f "$HELPER" || true
  systemctl restart "$UNIT" || true
  echo 'POSTSELL_OLD_VERSION_RESTORED=true'
 else
  echo 'POSTSELL_ROLLBACK_BLOCKED_PENDING_REAL_ORDER=true'
 fi
}
trap rollback ERR
chown --reference="$WORKER" "$W/staged-worker.mjs" "$W/finality.mjs"
chmod --reference="$WORKER" "$W/staged-worker.mjs" "$W/finality.mjs"
cp -p "$W/finality.mjs" "$HELPER"
cp -p "$W/staged-worker.mjs" "$WORKER"
systemctl restart "$UNIT"
python3 - <<'PY'
import json,urllib.request,subprocess,time,os,pathlib
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=8) as r:return json.load(r)
original=json.loads(pathlib.Path(os.environ['W']+'/config.json').read_text())
for i in range(50):
 try:
  c=get('/api/risk-control');e=c.get('execution') or {}
  rows=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
   '--since','4 minutes ago','-o','cat','--no-pager','-n','500'],
   capture_output=True,text=True,timeout=8).stdout
  started=[]
  for line in rows.splitlines():
   try:
    x=json.loads(line)
    if x.get('event')=='risk_worker_started':started.append(x)
   except:continue
  if (e.get('workerRunning') is True and e.get('configApplied') is True and
      c.get('persistenceHealthy') is True and started and
      started[-1].get('acceptedSellPolicy')=='RECHECK_BINANCE_ORDER_ID_TERMINAL_STATUS_AND_RETRY_ONLY_ZERO_FILL'
      and started[-1].get('pendingSellRecovery')=='ATOMIC_LOCAL_JOURNAL_BEFORE_POST'):
   break
 except Exception:pass
 time.sleep(1)
else:raise RuntimeError('POSTSELL_NEW_WORKER_NOT_CONFIRMED')
assert all(c.get(k)==v for k,v in original.items()),'USER_RISK_CONTROLS_CHANGED'
assert started[-1].get('pollMs')==300
assert 1000<=started[-1].get('retryMs',0)<=10000
states=json.loads(pathlib.Path('/var/lib/zl-prediction/risk-sell-recovery/pending-v1.json').read_text())
assert states.get('schema')==1 and isinstance(states.get('outstanding'),list)
for unit in ('zl-prediction-risk-exits.service','zl-prediction-trade.service',
 'zl-prediction-v3.service','zl-prediction-deepseek5.service',
 'zl-futures-bot-paper.service'):
 assert subprocess.run(['systemctl','is-active','--quiet',unit]).returncode==0,unit
print('POSTSELL_LIVE_FINAL_ORDER_RECONCILIATION=true')
print('POSTSELL_LIVE_UNFILLED_RETRY_ENABLED=true')
print('POSTSELL_LIVE_DURABLE_PENDING_FENCE=true')
print('POSTSELL_LIVE_RISK_THRESHOLDS_UNTOUCHED=true')
print('POSTSELL_LIVE_300MS_POLL_PRESERVED=true')
print('POSTSELL_RELEASE_SUCCESS=true')
PY
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[0-9a-f]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id=INSTANCE,name='zl-tpsl-accepted-sell-confirmation-safe-deploy',
  type='RunShellScript',working_user='root',
  command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=280)).body.invoke_id
 for _ in range(155):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('POSTSELL_DEPLOY_RESULT',r.invocation_status,'EXIT',r.exit_code)
   print(o[-14500:])
   return 0 if int(r.exit_code)==0 else 5
 print('POSTSELL_DEPLOY_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

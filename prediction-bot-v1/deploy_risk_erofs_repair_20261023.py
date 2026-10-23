#!/usr/bin/env python3
"""Safe production repair: allow dedicated SELL journal through systemd strict sandbox.
No orders or trades initiated. No TP/SL percentage or follow mode changes.
"""
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/risk-sell-journal-erofs-20261023'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
UNIT=zl-prediction-risk-exits.service
WORKER=/opt/zl-prediction-live/src/railway-diagnostic/risk-worker.mjs
NODE=/opt/zl-prediction-node/bin/node
DROP_DIR=/etc/systemd/system/zl-prediction-risk-exits.service.d
DROP="$DROP_DIR/45-risk-sell-recovery-write.conf"
JOURNAL=/var/lib/zl-prediction/risk-sell-recovery/pending-v1.json
test "$(id -u)" = 0
test -x "$NODE" && test -f "$WORKER" && test -f "$JOURNAL"
test "$(systemctl is-active "$UNIT")" = active
test "$(systemctl show "$UNIT" --property=ProtectSystem --value)" = strict
existing="$(systemctl show "$UNIT" --property=ReadWritePaths --value)"
test "$existing" = /var/lib/zl-prediction/rounds
test ! -e "$DROP"
WORK=$(mktemp -d /tmp/zl-risk-erofs-XXXXXXXX)
trap 'rm -rf "$WORK"' EXIT
export WORK
python3 - <<'PY'
from pathlib import Path
import urllib.request,os,json
base='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'
sha='COMMIT_SHA'
before='aa3eae5c8115f84ba6c3d191e344e047c30cc54c'
w=Path(os.environ['WORK'])
def read(commit):
 u=f'{base}{commit}/railway-diagnostic/risk-worker.mjs'
 with urllib.request.urlopen(u,timeout=15) as f:return f.read().decode()
now=read(sha)
prev=read(before)
live=Path('/opt/zl-prediction-live/src/railway-diagnostic/risk-worker.mjs').read_text()
healthDefault="const WORKER_HEALTH_FILE = '/tmp/risk-worker-health.json';"
healthOverride="const WORKER_HEALTH_FILE = process.env.RISK_WORKER_HEALTH_FILE || '/tmp/risk-worker-health.json';"
assert prev.count(healthDefault)==1 and now.count(healthDefault)==1
if live==prev.replace(healthDefault,healthOverride):
 now=now.replace(healthDefault,healthOverride)
 print('EROFS_EXISTING_HEALTH_FILE_OVERRIDE_PRESERVED=true')
else:
 assert live==prev,'STOP_UNEXPECTED_LIVE_TPSL_SOURCE_DRIFT'
assert 'risk_sell_not_submitted_journal_unavailable' in now
assert "log('risk_sell_journal_ready'" in now
assert "const POLL_MS = Math.max(300" in now
assert 'persistPendingSellState(); // must succeed BEFORE sending a real SELL' in now
(w/'next.mjs').write_text(now)
state=json.loads(Path('/var/lib/zl-prediction/risk-sell-recovery/pending-v1.json').read_text())
assert state.get('schema')==1 and not state.get('outstanding'),'PENDING_UNKNOWN_ORDER_DO_NOT_RESTART'
print('EROFS_EXISTING_JOURNAL_EMPTY=true')
print('EROFS_LIVE_BASELINE_MATCHES=true')
PY
"$NODE" --check "$WORK/next.mjs"
python3 - <<'PY'
import urllib.request,json,subprocess
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=7) as r:return json.load(r)
c=get('/api/risk-control')
t=get('/api/status')
e=c.get('execution') or {}
assert c.get('persistenceHealthy') is True and e.get('workerRunning') is True
assert c.get('takeProfitEnabled') is True and c.get('stopLossEnabled') is True
assert t.get('enabled') is False,'FOLLOW_ENABLED_DO_NOT_DISRUPT_REAL_POSITION'
out=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
 '--since','90 seconds ago','-o','cat','--no-pager','-n','800'],
 capture_output=True,text=True,timeout=7).stdout
for line in out.splitlines():
 try:
  v=json.loads(line);ev=v.get('event')
 except Exception:continue
 assert ev not in ('risk_triggered','risk_sell_submitted','risk_sell_failed',
  'risk_sell_unknown','risk_sell_exception',
  'risk_unknown_reconcile_pending','risk_sell_finality_pending'),'CURRENT_SELL_ACTIVITY_DO_NOT_RESTART'
print('EROFS_FOLLOW_OFF_AND_QUIET_TPSL_WINDOW=true')
PY
BACKUP=/var/lib/zl-prediction/archive/source-backups/risk-erofs-COMMIT_SHA
test ! -e "$BACKUP"
mkdir -p "$BACKUP" "$DROP_DIR"
cp -p "$WORKER" "$BACKUP/old-worker.mjs"
cat >"$WORK/drop.conf" <<'EOF'
[Service]
ReadWritePaths=/var/lib/zl-prediction/rounds /var/lib/zl-prediction/risk-sell-recovery
EOF
rollback(){
 echo 'EROFS_ROLLBACK_STARTED=true'
 if python3 - "$JOURNAL" <<'PY'
import json,sys
from pathlib import Path
v=json.loads(Path(sys.argv[1]).read_text())
raise SystemExit(0 if not v.get('outstanding') else 1)
PY
 then
  cp -p "$BACKUP/old-worker.mjs" "$WORKER" || true
  rm -f "$DROP" || true
  systemctl daemon-reload || true
  systemctl restart "$UNIT" || true
  echo 'EROFS_ROLLBACK_OLD_WORKER_RESTORED=true'
 else
  echo 'EROFS_ROLLBACK_BLOCKED_DURABLE_PENDING_SELL_NOT_SAFE=true'
 fi
}
trap rollback ERR
chown --reference="$WORKER" "$WORK/next.mjs"
chmod --reference="$WORKER" "$WORK/next.mjs"
cp -p "$WORK/drop.conf" "$DROP"
chmod 644 "$DROP"
cp -p "$WORK/next.mjs" "$WORKER"
systemctl daemon-reload
readwrite="$(systemctl show "$UNIT" --property=ReadWritePaths --value)"
case "$readwrite" in
 *"/var/lib/zl-prediction/rounds"*"/var/lib/zl-prediction/risk-sell-recovery"*) ;;
 *) echo "EROFS_SANDBOX_PATH_MISSING";exit 11;;
esac
systemctl restart "$UNIT"
python3 - <<'PY'
import urllib.request,json,subprocess,time,os
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=7) as r:return json.load(r)
for i in range(35):
 try:
  logs=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
   '--since','90 seconds ago','-o','cat','--no-pager','-n','700'],
   capture_output=True,text=True,timeout=8).stdout
  events=[]
  for line in logs.splitlines():
   try:events.append(json.loads(line))
   except Exception:pass
  started=[x for x in events if x.get('event')=='risk_worker_started']
  ready=[x for x in events if x.get('event')=='risk_sell_journal_ready']
  c=get('/api/risk-control');e=c.get('execution') or {}
  if started and ready and ready[-1].get('writable') is True and e.get('workerRunning') is True and e.get('configApplied') is True and c.get('persistenceHealthy') is True:
   break
 except Exception:pass
 time.sleep(1)
else:raise RuntimeError('NEW_WORKER_NOT_WRITABLE_IN_SANDBOX_AUTOROLLBACK')
assert started[-1]['pollMs']==300
assert c.get('takeProfitEnabled') is True and c.get('stopLossEnabled') is True
assert started[-1].get('acceptedSellPolicy')=='RECHECK_BINANCE_ORDER_ID_TERMINAL_STATUS_AND_RETRY_ONLY_ZERO_FILL'
t=get('/api/status')
assert t.get('enabled') is False
for unit in ('zl-prediction-risk-exits.service','zl-prediction-trade.service',
 'zl-prediction-v3.service','zl-prediction-deepseek5.service',
 'zl-futures-bot-paper.service'):
 assert subprocess.run(['systemctl','is-active','--quiet',unit]).returncode==0,unit
print('EROFS_JOURNAL_WRITABLE_INSIDE_REAL_RISK_PROCESS=true')
print('EROFS_PRE_POST_FAILURE_RECOVERABLE=true')
print('EROFS_300MS_TP_SL_POLL_PRESERVED=true')
print('EROFS_TP_SL_CONFIG_ENABLED_AND_INTACT=true')
print('EROFS_FOLLOW_OFF_UNCHANGED=true')
print('EROFS_RISK_SERVICE_HEALTHY=true')
print('EROFS_REPAIR_PRODUCTION_SUCCESS=true')
PY
trap - ERR
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
 instance_id=INSTANCE,name='zl-risk-erofs-readwrite-sandbox-guarded-repair',
 type='RunShellScript',working_user='root',
 command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=210)).body.invoke_id
 for _ in range(116):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('EROFS_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(o[-13500:])
   return 0 if int(r.exit_code)==0 else 5
 print('EROFS_REPAIR_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

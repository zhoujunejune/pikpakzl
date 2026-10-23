#!/usr/bin/env python3
"""Safely release adaptive risk scan ONLY on empty Binance Prediction positions.
Does not change user trade switches, stop percentages, quote logic or futures.
"""
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/risk-adaptive-fast-confirm-20261023'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
UNIT=zl-prediction-risk-exits.service
WORKER=/opt/zl-prediction-live/src/railway-diagnostic/risk-worker.mjs
NODE=/opt/zl-prediction-node/bin/node
STATE=/var/lib/zl-prediction/risk-sell-recovery/pending-v1.json
test "$(id -u)" -eq 0 && test -x "$NODE" && test -f "$WORKER" && test -f "$STATE"
test "$(systemctl is-active "$UNIT")" = active
W=$(mktemp -d /tmp/zl-risk-adaptive-XXXXXXXX)
trap 'rm -rf "$W"' EXIT
export W
python3 - <<'PY'
import urllib.request,pathlib,os,json
root='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'
old='99358b7e91509fd9ee1b22a99d886fd938320845'
new='COMMIT_SHA'
w=pathlib.Path(os.environ['W'])
def read(commit):
 with urllib.request.urlopen(root+commit+'/railway-diagnostic/risk-worker.mjs',timeout=18) as r:
  return r.read().decode()
baseline=read(old);candidate=read(new)
live=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic/risk-worker.mjs').read_text()
anchor="const WORKER_HEALTH_FILE = '/tmp/risk-worker-health.json';"
override="const WORKER_HEALTH_FILE = process.env.RISK_WORKER_HEALTH_FILE || '/tmp/risk-worker-health.json';"
assert baseline.count(anchor)==1 and candidate.count(anchor)==1
if live==baseline.replace(anchor,override):
 candidate=candidate.replace(anchor,override)
elif live!=baseline:raise RuntimeError('LIVE_RISK_SOURCE_DRIFT_DO_NOT_DEPLOY')
(w/'candidate.mjs').write_text(candidate)
for token in ("const POLL_MS = Math.max(300,","const NEAR_TARGET_FAST_POLL_MS = 200;",
 "const SUBMITTED_RECONCILE_MS = 2500;","risk_sell_journal_ready",
 "persistPendingSellState(); // must succeed BEFORE sending a real SELL",
 "if (state?.statusUnknown)","if(state?.submitted){",
 "risk_sell_final_failed_retry_scheduled","risk_sell_not_submitted_journal_unavailable"):
 assert token in candidate,token
print('ADAPTIVE_RELEASE_EXACT_LIVE_BASELINE_CONFIRMED=true')
PY
"$NODE" --check "$W/candidate.mjs"
# Probe the SAME live Binance account with wallet credentials held only in the
# local worker process; print counts, NEVER credentials/addresses/token IDs.
# No quote and no order APIs are called by this deployment.
python3 - <<'PY'
import os,subprocess,pathlib,time,json,urllib.request,urllib.parse,hashlib,hmac,datetime
from zoneinfo import ZoneInfo
w=pathlib.Path(os.environ['W'])
unit='zl-prediction-risk-exits.service'
m=subprocess.run(['systemctl','show',unit,'-p','MainPID','--value'],
 capture_output=True,text=True,timeout=5).stdout.strip()
parent=int(m)
def worker_pid():
 p=subprocess.run(['pgrep','-P',str(parent)],capture_output=True,text=True,timeout=6)
 for raw in p.stdout.split():
  try:
   pid=int(raw)
   cmd=(pathlib.Path('/proc')/str(pid)/'cmdline').read_bytes().decode(errors='replace')
   if 'risk-worker.mjs' in cmd:return pid
  except:pass
 raise RuntimeError('ACTIVE_WORKER_PID_NOT_RESOLVED')
pid=worker_pid()
env={}
for ent in (pathlib.Path('/proc')/str(pid)/'environ').read_bytes().split(b'\0'):
 if b'=' in ent:
  k,v=ent.split(b'=',1)
  if k in (b'BINANCE_PREDICTION_API_KEY',b'BINANCE_PREDICTION_API_SECRET',
           b'BINANCE_PREDICTION_WALLET_ADDRESS'):env[k.decode()]=v.decode()
key=env.get('BINANCE_PREDICTION_API_KEY')
secret=env.get('BINANCE_PREDICTION_API_SECRET')
assert key and secret,'READ_ONLY_POSITION_QUERY_CREDENTIALS_MISSING'
def get(p,params={}):
 q=urllib.parse.urlencode({**params,'timestamp':int(time.time()*1000),'recvWindow':5000})
 signature=hmac.new(secret.encode(),q.encode(),hashlib.sha256).hexdigest()
 req=urllib.request.Request('https://api.binance.com'+p+'?'+q+'&signature='+signature,
  headers={'X-MBX-APIKEY':key,'Accept':'application/json'})
 with urllib.request.urlopen(req,timeout=8) as r:return json.load(r)
wallet=env.get('BINANCE_PREDICTION_WALLET_ADDRESS')
if not wallet:
 wallets=get('/sapi/v1/w3w/wallet/prediction/wallet/list').get('wallets')
 assert isinstance(wallets,list) and wallets,'NO_WALLET_OR_API_UNAVAILABLE'
 wallet=wallets[0].get('walletAddress')
assert wallet
def status():
 with urllib.request.urlopen('http://127.0.0.1:13001/api/risk-control',timeout=6) as r:c=json.load(r)
 with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=6) as r:t=json.load(r)
 return c,t
c,t=status()
cfg={k:c.get(k) for k in ('takeProfitEnabled','takeProfitPercent',
 'stopLossEnabled','stopLossPercent')}
assert c.get('persistenceHealthy') is True and (c.get('execution') or {}).get('workerRunning') is True
assert (c.get('execution') or {}).get('configApplied') is True
assert cfg['takeProfitEnabled'] and cfg['stopLossEnabled']
(w/'settings.json').write_text(json.dumps({'controls':cfg,'followEnabled':t.get('enabled')}))
def no_pending():
 v=json.loads(pathlib.Path('/var/lib/zl-prediction/risk-sell-recovery/pending-v1.json').read_text())
 return v.get('schema')==1 and not v.get('outstanding')
def recent_sell():
 r=subprocess.run(['journalctl','-u',unit,'--since','20 seconds ago','-o','cat',
  '--no-pager','-n','900'],capture_output=True,text=True,timeout=9).stdout
 danger={'risk_triggered','risk_sell_submitted','risk_sell_unknown',
  'risk_sell_failed','risk_sell_exception','risk_sell_final_failed_retry_scheduled',
  'risk_sell_finality_pending','risk_unknown_reconcile_pending','risk_retry_scheduled'}
 for line in r.splitlines():
  try:
   if json.loads(line).get('event') in danger:return True
  except:pass
 return False
def empty_twice():
 for n in range(2):
  positions=get('/sapi/v1/w3w/wallet/prediction/position/list',
    {'walletAddress':wallet,'tab':'ONGOING','offset':0,'limit':100}).get('positions')
  if not isinstance(positions,list):return False
  if positions:return False
  if n==0:time.sleep(1.0)
 return True
# The user controls follow mode, not this deploy. With follow ON, avoid
# the beginning/end of rounds, when a new signal could open a position.
# An ongoing position is a hard BLOCK even with follow OFF.
found=False
for i in range(140):
 if not no_pending():raise RuntimeError('PENDING_UNSETTLED_SELL_DO_NOT_RESTART')
 now=int(time.time()*1000);phase=now%300000
 if 100000<phase<230000 and not recent_sell():
  if empty_twice():
   c,t=status()
   saved=json.loads((w/'settings.json').read_text())
   if (all(c.get(k)==v for k,v in cfg.items())
       and t.get('enabled')==saved['followEnabled']
       and no_pending() and not recent_sell()):
    found=True
    break
 time.sleep(1)
if not found:raise RuntimeError('NO_VERIFIED_EMPTY_POSITION_WINDOW_DEPLOY_ABORTED')
print('ADAPTIVE_RELEASE_VERIFIED_EMPTY_BINANCE_POSITIONS=true')
print('ADAPTIVE_RELEASE_NO_PENDING_SELL_OR_RECENT_SELL=true')
print('ADAPTIVE_RELEASE_TP_SL_AND_FOLLOW_SETTINGS_UNCHANGED=true')
PY
BACKUP=/var/lib/zl-prediction/archive/source-backups/risk-adaptive-COMMIT_SHA
test ! -e "$BACKUP"
mkdir -p "$BACKUP"
cp -p "$WORKER" "$BACKUP/old-risk-worker.mjs"
rollback(){
 echo 'ADAPTIVE_RELEASE_ROLLBACK_ATTEMPTED=true'
 if python3 - "$STATE" <<'PY'
import json,sys
from pathlib import Path
j=json.loads(Path(sys.argv[1]).read_text())
raise SystemExit(0 if j.get('schema')==1 and not j.get('outstanding') else 1)
PY
 then
  cp -p "$BACKUP/old-risk-worker.mjs" "$WORKER"
  systemctl restart "$UNIT" || true
  echo 'ADAPTIVE_RELEASE_ROLLBACK_OK=true'
 else
  echo 'ADAPTIVE_RELEASE_ROLLBACK_NOT_SAFE_PENDING_SELL=true'
 fi
}
trap rollback ERR
chown --reference="$WORKER" "$W/candidate.mjs"
chmod --reference="$WORKER" "$W/candidate.mjs"
cp -p "$W/candidate.mjs" "$WORKER"
systemctl restart "$UNIT"
python3 - <<'PY'
import json,urllib.request,time,subprocess,pathlib,os
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=7) as r:return json.load(r)
original=json.loads(pathlib.Path(os.environ['W']+'/settings.json').read_text())
for i in range(55):
 try:
  logs=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
   '--since','3 minutes ago','-o','cat','--no-pager','-n','950'],
   capture_output=True,text=True,timeout=8).stdout
  started=[];ready=[]
  for line in logs.splitlines():
   try:
    v=json.loads(line)
    if v.get('event')=='risk_worker_started':started.append(v)
    if v.get('event')=='risk_sell_journal_ready':ready.append(v)
   except:pass
  c=get('/api/risk-control');e=c.get('execution') or {}
  if (started and ready and started[-1].get('fastPollMs')==200 and
    started[-1].get('submittedCheckMs')==2500 and
    ready[-1].get('writable') is True and
    e.get('workerRunning') is True and e.get('configApplied') is True and
    c.get('persistenceHealthy') is True):break
 except Exception:pass
 time.sleep(.5)
else:raise RuntimeError('NEW_FAST_WORKER_OR_JOURNAL_HEALTH_NOT_READY_ROLLBACK')
assert started[-1].get('pollMs')==300
assert all(c.get(k)==v for k,v in original['controls'].items()),'USER_RISK_CONFIG_CHANGED'
t=get('/api/status')
assert t.get('enabled')==original['followEnabled'],'USER_FOLLOW_SWITCH_CHANGED'
j=json.loads(pathlib.Path('/var/lib/zl-prediction/risk-sell-recovery/pending-v1.json').read_text())
assert j.get('schema')==1 and isinstance(j.get('outstanding'),list)
for unit in ('zl-prediction-risk-exits.service','zl-prediction-trade.service',
 'zl-prediction-v3.service','zl-prediction-deepseek5.service',
 'zl-futures-bot-paper.service'):
 assert subprocess.run(['systemctl','is-active','--quiet',unit]).returncode==0,unit
print('ADAPTIVE_RELEASE_LIVE_200MS_NEAR_TARGET_CONFIRMED=true')
print('ADAPTIVE_RELEASE_300MS_WATCHDOG_CONFIRMED=true')
print('ADAPTIVE_RELEASE_2500MS_ORDER_STATUS_CONFIRMED=true')
print('ADAPTIVE_RELEASE_DURABLE_SELL_JOURNAL_WRITABLE=true')
print('ADAPTIVE_RELEASE_USER_CONTROLS_FOLLOW_UNCHANGED=true')
print('ADAPTIVE_RELEASE_SUCCESS=true')
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
  instance_id=INSTANCE,name='zl-risk-adaptive-200ms-safe-release',
  type='RunShellScript',working_user='root',
  command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=265)).body.invoke_id
 for _ in range(145):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(r.output or '').decode(errors='replace')
   except Exception:out=str(r.output)
   print('ADAPTIVE_RELEASE_CLOUD',r.invocation_status,'exit',r.exit_code)
   print(out[-15000:])
   return 0 if int(r.exit_code)==0 else 5
 print('ADAPTIVE_RELEASE_UNCONFIRMED');return 6
if __name__=='__main__':raise SystemExit(main())

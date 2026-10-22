#!/usr/bin/env python3
"""Correct only Alibaba prediction TP/SL worker API EnvironmentFile.
Owner TP/SL switches and percent levels are retained. Existing key file is
the same one used by main prediction trade and is never copied/logged.
"""
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
BRANCH='fix/aliyun-risk-exits-api-env-20261022'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
unit=zl-prediction-risk-exits.service
keys=/var/lib/zl-exchange-api/prediction/binance.env
d=/etc/systemd/system/zl-prediction-risk-exits.service.d
riskdrop=$d/30-prediction-binance-api-manager.conf
reload_dir=/etc/systemd/system/zl-api-prediction-reload.service.d
reload_drop=$reload_dir/30-include-prediction-risk-exits.conf
test "$(systemctl is-active "$unit")" = active
test "$(systemctl is-active zl-prediction-trade.service)" = active
test "$(systemctl is-active zl-prediction-redis.service)" = active
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
test "$(systemctl is-active zl-futures-bot-paper.service)" = active
test -s "$keys"
test ! -e "$riskdrop"
test ! -e "$reload_drop"
python3 - <<'PY'
from pathlib import Path
import json,urllib.request,subprocess
p=Path('/var/lib/zl-exchange-api/prediction/binance.env')
cfg={}
for line in p.read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1)
  if k in ('BINANCE_PREDICTION_API_KEY','BINANCE_PREDICTION_API_SECRET'):
   cfg[k]=bool(v.strip())
assert cfg.get('BINANCE_PREDICTION_API_KEY') and cfg.get('BINANCE_PREDICTION_API_SECRET')
assert p.stat().st_mode&0o777==0o600,'CREDENTIALS_FILE_MUST_BE_PRIVATE'
for port,url in ((13001,'/api/risk-control'),(13029,'/api/status'),(13001,'/api/status')):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,url),timeout=7) as r:
  s=json.load(r)
  if url=='/api/risk-control':
   assert s.get('persistenceHealthy') is True and s.get('source')=='redis'
   assert s.get('takeProfitEnabled') is True or s.get('stopLossEnabled') is True
   print('RISK_REPAIR_OWNER_TP_SL_ACTIVE_AND_PERSISTED=true')
  elif url=='/api/status' and port==13029:
   assert s.get('model')=='DEEPSEEK_5M_V1' and s.get('maxCallsPerRound')==1
  elif url=='/api/status' and port==13001:
   assert s.get('enabled') is False,'LIVE_FOLLOW_ON_ABORT_TO_AVOID_SERVICE_RESTART'
print('RISK_REPAIR_SOURCE_API_CONFIG_VALID=true')
unit_env=subprocess.check_output(['systemctl','show','zl-prediction-trade.service','-p','EnvironmentFiles','--value'],text=True)
assert '/var/lib/zl-exchange-api/prediction/binance.env' in unit_env,'UNEXPECTED_TRADE_CREDENTIAL_SOURCE'
risk_env=subprocess.check_output(['systemctl','show','zl-prediction-risk-exits.service','-p','EnvironmentFiles','--value'],text=True)
assert '/var/lib/zl-exchange-api/prediction/binance.env' not in risk_env,'RISK_CREDENTIAL_FILE_ALREADY_INSTALLED'
print('RISK_REPAIR_CONFIRMED_SINGLE_MISSING_ENV_BINDING=true')
PY
rollback(){
 echo 'RISK_REPAIR_ROLLBACK_TRIGGERED=true'
 rm -f "$riskdrop" "$reload_drop"
 systemctl daemon-reload || true
 systemctl restart "$unit" || true
}
trap rollback ERR
mkdir -p "$d" "$reload_dir"
cat > "$riskdrop" <<'EOF'
[Service]
EnvironmentFile=-/var/lib/zl-exchange-api/prediction/binance.env
EOF
chmod 0644 "$riskdrop"
# Existing API manager reloads trade/v2/v3 when the user changes saved keys.
# Ensure risk worker picks up API rotations too, without a second watcher.
cat > "$reload_drop" <<'EOF'
[Service]
ExecStart=
ExecStart=/bin/systemctl try-restart zl-prediction-v3.service zl-prediction-v2.service zl-prediction-trade.service zl-prediction-risk-exits.service
EOF
chmod 0644 "$reload_drop"
systemctl daemon-reload
systemctl restart "$unit"
for i in $(seq 1 22);do
 test "$(systemctl is-active "$unit")" = active || { sleep 2;continue; }
 sleep 2
 if python3 - <<'PY'
from pathlib import Path
import subprocess
unit='zl-prediction-risk-exits.service'
env=subprocess.check_output(['systemctl','show',unit,'-p','EnvironmentFiles','--value'],text=True)
assert '/var/lib/zl-exchange-api/prediction/binance.env' in env
pid=subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'],text=True).strip()
assert pid.isdigit() and int(pid)>0
child=Path('/proc/'+pid+'/task/'+pid+'/children').read_text().split()
assert child,'RISK_WORKER_NOT_RUNNING'
keys={}
for part in Path('/proc/'+child[0]+'/environ').read_bytes().split(b'\0'):
 if b'=' in part:
  k,v=part.split(b'=',1)
  if k in (b'BINANCE_PREDICTION_API_KEY',b'BINANCE_PREDICTION_API_SECRET'):
   keys[k]=bool(v)
assert keys.get(b'BINANCE_PREDICTION_API_KEY') and keys.get(b'BINANCE_PREDICTION_API_SECRET')
PY
 then break;fi
done
python3 - <<'PY'
from pathlib import Path
import json,subprocess,urllib.request
unit='zl-prediction-risk-exits.service'
env=subprocess.check_output(['systemctl','show',unit,'-p','EnvironmentFiles','--value'],text=True)
assert '/var/lib/zl-exchange-api/prediction/binance.env' in env
pid=subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'],text=True).strip()
children=Path('/proc/'+pid+'/task/'+pid+'/children').read_text().split()
assert children
secretflags={}
for x in Path('/proc/'+children[0]+'/environ').read_bytes().split(b'\0'):
 if b'=' in x:
  k,v=x.split(b'=',1)
  if k in (b'BINANCE_PREDICTION_API_KEY',b'BINANCE_PREDICTION_API_SECRET'):
   secretflags[k]=bool(v)
assert secretflags.get(b'BINANCE_PREDICTION_API_KEY') and secretflags.get(b'BINANCE_PREDICTION_API_SECRET')
with urllib.request.urlopen('http://127.0.0.1:13001/api/risk-control',timeout=6) as r:cfg=json.load(r)
assert cfg.get('execution',{}).get('enabled') is True
assert cfg.get('execution',{}).get('workerRunning') is True
assert cfg.get('execution',{}).get('configApplied') is True
with urllib.request.urlopen('http://127.0.0.1:13029/api/status',timeout=6) as r:ai=json.load(r)
assert ai.get('maxCallsPerRound')==1 and ai.get('learningDisabled') is True
assert ai.get('decisionWindowEndMs',0)-ai.get('round',0)==5000
print('RISK_REPAIR_WORKER_HAS_BINANCE_CREDENTIALS=true')
print('RISK_REPAIR_SETTINGS_AND_WORKER_APPLIED=true')
print('RISK_REPAIR_DEEPSEEK_5S_UNCHANGED=true')
for p in ('/var/lib/zl-prediction/rounds/risk-runtime-status.json',
          '/var/lib/zl-prediction/rounds/risk-worker-health.json'):
 f=Path(p)
 try:
  data=json.loads(f.read_text())
  print('RISK_REPAIR_STATUS_FILE',f.name,json.dumps({k:data.get(k) for k in (
   'enabled','workerRunning','configApplied','lastSuccessfulPositionsAt','positionsSeen',
   'quoteChecks','quoteErrors','lastError','lastErrorAt','lastTickStartedAt',
   'lastTickFinishedAt','lastSellEvent','lastSellEventAt') if k in data})[:1600])
 except Exception as e:print('RISK_REPAIR_STATUS_UNAVAILABLE',f.name,type(e).__name__)
# Only whitelist risk log event names and safe error/status fields; never IDs, creds, response bodies.
lines=subprocess.run(['journalctl','-u',unit,'--since','120 seconds ago','--no-pager','-o','cat','-n','700'],
 capture_output=True,text=True,timeout=15).stdout.splitlines()
seen={}
recent=[]
for line in lines:
 try:j=json.loads(line)
 except:continue
 e=j.get('event')
 if e not in {'risk_worker_started','risk_check','risk_wallet_error','risk_positions_error',
  'risk_invalid_position','risk_sell_quote_failed','risk_triggered','risk_sell_submitted',
  'risk_sell_failed','risk_sell_unknown','risk_tick_exception','risk_worker_stopping'}:continue
 seen[e]=seen.get(e,0)+1
 if e in {'risk_wallet_error','risk_positions_error','risk_invalid_position','risk_sell_quote_failed',
         'risk_sell_failed','risk_sell_unknown','risk_tick_exception','risk_worker_started'}:
  recent.append({k:j.get(k) for k in ('event','hasCredentials','scope','error','httpStatus','code') if k in j})
print('RISK_REPAIR_EXECUTION_EVENT_COUNTS',json.dumps(seen,ensure_ascii=False))
print('RISK_REPAIR_RECENT_EXECUTION_DETAILS',json.dumps(recent[-7:],ensure_ascii=False)[:2000])
PY
test "$(systemctl is-active zl-prediction-trade.service)" = active
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
test "$(systemctl is-active zl-futures-bot-paper.service)" = active
echo 'RISK_REPAIR_PRODUCTION_CREDENTIAL_BRIDGE_INSTALLED=true'
echo 'RISK_REPAIR_FUTURE_KEY_ROTATION_RESTARTS_RISK_SERVICE=true'
trap - ERR
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
  print('RISK_REPAIR_INVALID_GITHUB_REF');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',
 endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
 name='zl-fix-risk-worker-saved-api-credentials',type='RunShellScript',working_user='root',
 command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=220)).body.invoke_id
 for _ in range(115):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
    instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:s=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:s=str(r.output)
   print('RISK_REPAIR_PRODUCTION_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(s[-13000:])
   return 0 if int(r.exit_code)==0 else 5
 print('RISK_REPAIR_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

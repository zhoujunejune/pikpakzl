#!/usr/bin/env python3
"""Read-only live Alibaba prediction TP SL execution chain audit."""
import os,re,base64,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
import json,urllib.request,urllib.error,subprocess,datetime,hashlib,re
def get(port,route):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,route),timeout=5) as r:
   d=json.load(r)
   print('RISK_AUDIT_API',port,route,'HTTP',r.status,
    json.dumps({k:d.get(k) for k in ('ok','takeProfitEnabled','takeProfitPercent','stopLossEnabled',
     'stopLossPercent','source','persistenceReady','persistenceHealthy','persistenceRestored',
     'updatedAt','execution','error') if k in d},ensure_ascii=False)[:2500])
 except urllib.error.HTTPError as e:print('RISK_AUDIT_API',port,route,'HTTP',e.code)
 except Exception as e:print('RISK_AUDIT_API',port,route,'ERROR',type(e).__name__)
for p in (13001,13005):
 for route in ('/api/risk-control','/api/take-profit-control'):
  get(p,route)
units=subprocess.run(['systemctl','list-units','--all','--type=service','--no-legend','--plain'],capture_output=True,text=True).stdout.splitlines()
for line in units:
 if any(s in line.lower() for s in ('risk','prediction','redis')):
  print('RISK_AUDIT_UNIT',line[:210])
for u in ('zl-prediction-risk-exits.service','zl-prediction-risk.service','zl-prediction-risk-runner.service','zl-prediction-risk-monitor.service','zl-prediction-trade.service','zl-prediction-redis.service'):
 cmd=subprocess.run(['systemctl','show',u,'-p','LoadState','-p','ActiveState','-p','MainPID','-p','NRestarts','--no-pager'],capture_output=True,text=True)
 print('RISK_AUDIT_SYSTEMD',u,cmd.stdout.replace('\n',' ').strip()[:330])
riskpid=subprocess.run(['systemctl','show','zl-prediction-risk-exits.service','-p','MainPID','--value'],capture_output=True,text=True).stdout.strip()
if riskpid and riskpid!='0':
 try:
  print('RISK_AUDIT_RUNTIME_PID',riskpid)
  # Read only environment key names and presence, NEVER secret values.
  try:
   raw=Path('/proc/'+riskpid+'/environ').read_bytes().split(b'\0')
   keynames={entry.split(b'=',1)[0].decode('utf8','replace') for entry in raw if b'=' in entry}
   print('RISK_AUDIT_MAIN_KEY_PRESENCE',{'apiKey':('BINANCE_PREDICTION_API_KEY' in keynames),
    'apiSecret':('BINANCE_PREDICTION_API_SECRET' in keynames),
    'walletId':('BINANCE_PREDICTION_WALLET_ID' in keynames)})
  except Exception as e:print('RISK_AUDIT_MAIN_KEY_ERROR',type(e).__name__)
  childfile=Path('/proc/'+riskpid+'/task/'+riskpid+'/children')
  if childfile.is_file():
   for childpid in childfile.read_text().split()[:4]:
    try:
     raw=Path('/proc/'+childpid+'/environ').read_bytes().split(b'\0')
     entries={pair.split(b'=',1)[0].decode('utf8','replace'):len(pair.split(b'=',1)[1])>0
       for pair in raw if b'=' in pair}
     print('RISK_AUDIT_WORKER_KEY_PRESENCE',{'apiKeySet':entries.get('BINANCE_PREDICTION_API_KEY',False),
      'apiSecretSet':entries.get('BINANCE_PREDICTION_API_SECRET',False),
      'walletAddressSet':entries.get('BINANCE_PREDICTION_WALLET_ADDRESS',False),
      'walletIdSet':entries.get('BINANCE_PREDICTION_WALLET_ID',False),
      'tpEnabledSettingPresent':entries.get('AUTO_TAKE_PROFIT_ENABLED',False),
      'slEnabledSettingPresent':entries.get('AUTO_STOP_LOSS_ENABLED',False)})
    except Exception as e:print('RISK_AUDIT_WORKER_KEY_ERROR',type(e).__name__)
  for key in ('PrivateTmp','ExecStart'):
   value=subprocess.run(['systemctl','show','zl-prediction-risk-exits.service','-p',key,'--value'],capture_output=True,text=True).stdout.strip()
   if key=='ExecStart':
    print('RISK_AUDIT_EXEC_FILES',[Path(x).name for x in value.split() if x.endswith(('.mjs','.js'))][:7])
   else:print('RISK_AUDIT_SYSTEMD_PROPERTY',key,value)
  for n in ('risk-control.json','risk-runtime-status.json','risk-worker-health.json'):
   p=Path('/proc/'+riskpid+'/root/tmp/'+n)
   try:
    j=json.loads(p.read_text())
    allow=('at','enabled','workerRunning','configApplied','lastWorkerStartedAt','configurationSource',
     'configUpdatedAt','persistenceHealthy','persistedConfigFound','persistenceError','transitioning',
     'lastTickStartedAt','lastTickFinishedAt','lastSuccessfulPositionsAt','positionsSeen','quoteChecks','quoteErrors',
     'lastErrorAt','lastError','lastSellEventAt','lastSellEvent','lastQuoteAt','lastQuoteAmount')
    print('RISK_AUDIT_SERVICE_PRIVATE_TMP',n,json.dumps({k:j.get(k) for k in allow if k in j},ensure_ascii=False)[:1400])
   except Exception as e:print('RISK_AUDIT_SERVICE_PRIVATE_TMP',n,type(e).__name__)
 except Exception as e:print('RISK_AUDIT_PRIVATE_TMP_ERROR',type(e).__name__)
f=Path('/var/lib/zl-exchange-api/prediction/binance.env')
if f.exists():
 info=f.stat()
 keys={}
 for line in f.read_text().splitlines():
  if '=' in line:
   k,v=line.split('=',1)
   if k in ('BINANCE_PREDICTION_API_KEY','BINANCE_PREDICTION_API_SECRET',
            'BINANCE_PREDICTION_WALLET_ADDRESS','BINANCE_PREDICTION_WALLET_ID'):
    keys[k]=bool(v.strip())
 print('RISK_AUDIT_MANAGER_CREDENTIAL_FILE',{'exists':True,'mode':oct(info.st_mode&0o777),
   'ownerUid':info.st_uid,'sizeBytes':info.st_size,'fieldNonempty':keys})
else:print('RISK_AUDIT_MANAGER_CREDENTIAL_FILE',{'exists':False})
for unit in ('zl-prediction-trade.service','zl-prediction-risk-exits.service'):
 cmd=subprocess.run(['systemctl','show',unit,'-p','EnvironmentFiles','--value'],capture_output=True,text=True)
 print('RISK_AUDIT_EFFECTIVE_ENV_FILES',unit,cmd.stdout.replace('\n',' ').strip()[:600])
for p in ('/tmp/risk-control.json','/tmp/risk-runtime-status.json','/tmp/risk-worker-health.json'):
 f=Path(p)
 if not f.is_file():print('RISK_AUDIT_FILE',p,'NOT_FOUND');continue
 try:
  j=json.loads(f.read_text())
  allowed=('at','enabled','workerRunning','configApplied','lastWorkerStartedAt','configurationSource',
    'configUpdatedAt','persistenceHealthy','persistedConfigFound','persistenceError','transitioning',
    'takeProfitEnabled','takeProfitPercent','stopLossEnabled','stopLossPercent','lastTickStartedAt',
    'lastTickFinishedAt','lastSuccessfulPositionsAt','positionsSeen','quoteChecks','quoteErrors',
    'lastErrorAt','lastError','lastSellEventAt','lastSellEvent','lastQuoteAt','lastQuoteAmount')
  print('RISK_AUDIT_FILE',p,json.dumps({k:j.get(k) for k in allowed if k in j},ensure_ascii=False)[:1600])
 except Exception as e:print('RISK_AUDIT_FILE',p,'PARSE_FAILURE',type(e).__name__)
for p in ('/opt/zl-prediction-live/src/railway-diagnostic/risk-runner.mjs',
 '/opt/zl-prediction-live/src/railway-diagnostic/risk-worker.mjs',
 '/opt/zl-prediction-live/src/railway-diagnostic/control-shell.mjs',
 '/opt/zl-prediction-live/src/railway-diagnostic/risk-config-storage.mjs'):
 f=Path(p);print('RISK_AUDIT_SOURCE',p,'exists',f.exists(),
  'sha256',hashlib.sha256(f.read_bytes()).hexdigest() if f.exists() else None)
for unit in ('zl-prediction-risk-exits.service','zl-prediction-risk.service','zl-prediction-risk-runner.service','zl-prediction-risk-monitor.service','zl-prediction-trade.service'):
 cmd=subprocess.run(['journalctl','-u',unit,'--since','8 hours ago','--no-pager','-o','cat','--output-fields=MESSAGE','-n','4000'],capture_output=True,text=True,timeout=15)
 counts={};recent=[]
 allowed={'risk_worker_started','risk_runtime_controller_started','risk_runtime_worker_started','risk_runtime_worker_exited',
 'risk_config_redis_sync_failed','risk_positions_error','risk_wallet_error','risk_invalid_position',
 'risk_sell_quote_failed','risk_sell_failed','risk_sell_unknown','risk_sell_submitted','risk_triggered',
 'risk_tick_exception','risk_check','risk_control_updated','risk_persistence_restore_failed',
 'risk_worker_stopping','risk_sell_exception','risk_health_write_failed'}
 for line in cmd.stdout.splitlines():
  try:j=json.loads(line)
  except:continue
  event=j.get('event')
  if event in allowed:
   counts[event]=counts.get(event,0)+1
   if event not in ('risk_check',):
    recent.append({k:j.get(k) for k in ('event','at','error','httpStatus','code','reason',
      'hasTotalCost','hasShares','hasToWin','hasCredentials','scope','takeProfitEnabled','stopLossEnabled','pollMs') if k in j})
 print('RISK_AUDIT_EVENT_COUNTS',unit,json.dumps(counts,ensure_ascii=False))
 print('RISK_AUDIT_RECENT_EXCEPT_CHECKS',unit,json.dumps(recent[-15:],ensure_ascii=False)[:3700])
PY
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='audit/prediction-risk-live-20261022' or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,name='zl-prediction-risk-live-readonly-audit',type='RunShellScript',working_user='root',command_content=REMOTE,timeout=150)).body.invoke_id
 for _ in range(80):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:s=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:s=str(r.output)
   print('RISK_AUDIT_RUN',r.invocation_status,'EXIT',r.exit_code)
   print(s[-18000:])
   return 0 if int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':sys.exit(main())

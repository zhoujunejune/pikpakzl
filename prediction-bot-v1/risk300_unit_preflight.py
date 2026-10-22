#!/usr/bin/env python3
"""Read-only production TP/SL unit and live position safety preflight.
Never disclose credentials, wallet addresses, position/order/token IDs.
"""
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/risk-exit-300ms-20261023'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import subprocess,urllib.request,json,os,pathlib,re,datetime
from zoneinfo import ZoneInfo
T=ZoneInfo('Asia/Singapore')
def get(u):
 with urllib.request.urlopen(u,timeout=7) as r:return json.load(r)
print('RISK300_AT',datetime.datetime.now(T).isoformat())
status=get('http://127.0.0.1:13001/api/risk-control')
trade=get('http://127.0.0.1:13001/api/status')
print('RISK300_CONTROL',json.dumps({k:status.get(k) for k in ('ok','takeProfitEnabled','takeProfitPercent','stopLossEnabled','stopLossPercent','persistenceHealthy')},ensure_ascii=False))
print('RISK300_EXECUTION',json.dumps({k:(status.get('execution') or {}).get(k) for k in ('ready','enabled','workerRunning','configApplied','persistenceHealthy')},ensure_ascii=False))
print('RISK300_FOLLOW_ENABLED',trade.get('enabled'))
unit='zl-prediction-risk-exits.service'
for prop in ['MainPID','ControlGroup','FragmentPath','DropInPaths','EnvironmentFiles','Environment']:
 r=subprocess.run(['systemctl','show',unit,'-p',prop,'--value'],capture_output=True,text=True,timeout=6)
 v=r.stdout.strip()
 if prop in ('Environment','EnvironmentFiles'):
  # redact all environment values, show only names of NON-secret matching speed settings
  matches=re.findall(r'(?:AUTO_RISK_POLL_MS|AUTO_TAKE_PROFIT_POLL_MS)=[^\s]+',v)
  print('RISK300_UNIT_'+prop.upper(),[x.split('=')[0] for x in matches])
 else: print('RISK300_UNIT_'+prop.upper(),v[:240])
print('RISK300_UNIT_STATUS',subprocess.run(['systemctl','is-active',unit],capture_output=True,text=True).stdout.strip())
p=subprocess.run(['pgrep','-f','^.*node .*risk-worker.mjs'],capture_output=True,text=True)
pids=[]
for part in p.stdout.split():
 try:pids.append(int(part))
 except:pass
print('RISK300_WORKER_COUNT',len(pids))
for pid in pids[:3]:
 base=pathlib.Path('/proc')/str(pid)
 try:
  env=base.joinpath('environ').read_bytes().split(b'\0')
  visible={}
  for z in env:
   if z.startswith((b'AUTO_RISK_POLL_MS=',b'AUTO_TAKE_PROFIT_POLL_MS=',b'AUTO_RISK_RETRY_MS=')):
    k,v=z.split(b'=',1);visible[k.decode()]=v.decode(errors='replace')[:30]
  print('RISK300_WORKER_POLL_ENV',visible)
  candidates=[
   base/'root/tmp/risk-worker-health.json',
   base/'cwd/risk-worker-health.json',
   pathlib.Path('/tmp/risk-worker-health.json')
  ]
  for f in candidates:
   if f.exists():
    info=json.loads(f.read_text())
    fields=('at','lastTickStartedAt','lastTickFinishedAt','lastSuccessfulPositionsAt',
     'positionsSeen','quoteChecks','quoteErrors','lastQuoteAt','lastSellEventAt',
     'lastSellEvent','lastErrorAt','lastError')
    print('RISK300_HEALTH',json.dumps({k:info.get(k) for k in fields if k in info},ensure_ascii=False))
    break
  else: print('RISK300_HEALTH_FILE_NOT_VISIBLE_IN_HOST_NAMESPACE=true')
 except Exception as e:print('RISK300_WORKER_EXAMINATION_ERROR',type(e).__name__)
print('RISK300_PREFLIGHT_DONE=true')
PY
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  name='zl-risk300-unit-readonly-preflight',type='RunShellScript',working_user='root',command_content=REMOTE,timeout=90)).body.invoke_id
 for _ in range(50):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('RISK300_PREFLIGHT_RESULT',r.invocation_status,'EXIT',r.exit_code)
   print(o[-11000:])
   return 0 if int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':sys.exit(main())

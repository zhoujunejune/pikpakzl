#!/usr/bin/env python3
"""Read-only audit of exact production source before installing GUARDIAN switch."""
import os,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
from pathlib import Path
import hashlib,json,urllib.request,subprocess
base=Path('/opt/zl-prediction-live/src/railway-diagnostic')
files={
 'control-shell.mjs':'c457126430cccbad42645c353ffccec69254184f',
 'risk-config-storage.mjs':'d6b25b7dafbd1f31809fade988f607024be1d889',
 'risk-runner.mjs':'58c50eb5ebbf9843282409af8c81fdc271179eaf',
 'guardian-main-dashboard.mjs':'1c6a2998710a13fb707e3bbccfb0f130d15530fe'
}
for name,baseline in files.items():
 p=base/name
 if not p.is_file():print('TOGGLE_AUDIT_FILE',name,'MISSING');continue
 content=p.read_bytes()
 blob=hashlib.sha1(b'blob '+str(len(content)).encode()+b'\0'+content).hexdigest()
 t=content.decode('utf8','replace')
 keys={
 'control-shell.mjs':['function readRiskConfig()','function writeRiskConfig(next)','function validPercent(n)','if (req.method === \'GET\' && url.pathname === \'/api/risk-control\')','if (req.method === \'POST\' && url.pathname === \'/api/risk-control\')','guardianRiskToggleStatus'],
 'risk-config-storage.mjs':['export function validatedRiskConfig(value)','export async function persistRiskConfig(next)','guardianDynamicEnabled'],
 'risk-runner.mjs':['const GUARDIAN_DYNAMIC_EXIT_ENABLED=','function defaultConfig()','function readConfig()','function configKey(cfg)','function writeStatus()','function startWorker(cfg)','function reconcile()','guardianOpenExposure'],
 'guardian-main-dashboard.mjs':['id="zlGuardianMain"','id="zlGDynamicTP"','id="zlGRiskToggleButton"','window.zlGuardianToggleRisk']
 }[name]
 print('TOGGLE_AUDIT_FILE',name,'baselineIdentical',blob==baseline,'bytes',len(content),'markers',[(k,t.count(k)) for k in keys])
for unit in ['zl-prediction-trade','zl-prediction-risk-exits','zl-prediction-guardian-analysis']:
 print('TOGGLE_AUDIT_UNIT',unit,subprocess.run(['systemctl','is-active',unit],text=True,capture_output=True).stdout.strip())
for port,route in [(13001,'/api/status'),(13001,'/api/risk-control'),(13049,'/api/status')]:
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,route),timeout=7) as r:d=json.load(r)
  if route=='/api/status' and port==13001:
   print('TOGGLE_AUDIT_TRADE',{'enabled':d.get('enabled'),'pendingAction':bool(d.get('pendingAction')),'model':d.get('orderSignalModel')})
  elif route=='/api/risk-control':
   print('TOGGLE_AUDIT_RISK',{'ok':d.get('ok'),'persistenceHealthy':d.get('persistenceHealthy'),'stopLossEnabled':d.get('stopLossEnabled'),'takeProfitEnabled':d.get('takeProfitEnabled')})
  else:print('TOGGLE_AUDIT_GUARDIAN',{'model':d.get('model'),'exitExecutionEnabled':d.get('exitExecutionEnabled'),'eligible':(d.get('automaticTradeEligibility') or {}).get('eligible')})
 except Exception as e:print('TOGGLE_AUDIT_HTTP_ERROR',port,route,type(e).__name__)
for name,needles in {
 'control-shell.mjs':['function defaultRiskConfig()','function readRiskConfig()','async function writeRiskConfig(next)','  if (req.method === \'POST\' && url.pathname === \'/api/risk-control\')','function validPercent(n)'],
 'risk-config-storage.mjs':['export function validatedRiskConfig(value)'],
 'risk-runner.mjs':['const CONTROL_FILE','function defaultConfig()','function readConfig()','function configKey(cfg)','function writeStatus()','function startWorker(cfg)','function reconcile()']
}.items():
 p=base/name
 if not p.is_file():continue
 t=p.read_text()
 for needle in needles:
  i=t.find(needle)
  if i<0:continue
  print('TOGGLE_AUDIT_SNIPPET',name,needle.replace(' ','_')[:50],repr(t[i:i+1050]))
for name,n in [('control-shell.mjs',4400),('risk-runner.mjs',500),('risk-config-storage.mjs',1700)]:
 p=base/name
 if p.is_file():print('TOGGLE_AUDIT_TOP',name,repr(p.read_text()[:n]))
print('TOGGLE_AUDIT_COMPLETE=true')
PY
"""
def main():
 client=Client(api.Config(
  access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 inv=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  name='guardian-dynamic-ui-readonly-audit',type='RunShellScript',
  command_content=SCRIPT,working_user='root',timeout=90)).body.invoke_id
 for _ in range(52):
  time.sleep(2)
  d=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   invoke_id=inv)).body.invocation_result
  if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(d.output or '')
   print('TOGGLE_AUDIT_REMOTE',d.invocation_status,'EXIT',d.exit_code);print(o[-12000:])
   return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'TOGGLE_AUDIT_COMPLETE=true' in o else 4
 return 5
if __name__=='__main__':sys.exit(main())

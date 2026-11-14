#!/usr/bin/env python3
"""Add the existing DeepSeek 5m service to the authenticated Alibaba prediction site.
No trading logic or key material is touched. Existing Caddy host and auth stay in place.
"""
import base64,os,re,time,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r'''#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" = 0
test "$(systemctl is-active zl-prediction-deepseek5)" = active
test "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:13029/api/status)" = 200
python3 - <<'PY'
from pathlib import Path
import json,urllib.request,subprocess,datetime,shutil
base='http://127.0.0.1:13029'
with urllib.request.urlopen(base+'/api/status',timeout=7) as response:
 status=json.load(response)
assert status.get('model')=='DEEPSEEK_5M_V1'
assert status.get('configured') is True
assert status.get('realOrderEnabled') is False
assert status.get('tradeIntegration') is False
p=Path('/etc/caddy/Caddyfile')
original=p.read_text()
host='prediction.47-237-188-69.sslip.io {'
assert original.count('\n'+host)==1
start=original.index('\n'+host)+1
end=original.index('\n}\n',start)
block=original[start:end]
assert 'basic_auth {' in block
marker='  handle_path /llm/* {\n    reverse_proxy 127.0.0.1:13018\n  }\n'
new='  handle_path /deepseek/* {\n    reverse_proxy 127.0.0.1:13029\n  }\n'
if new not in block:
 assert 'handle_path /deepseek/' not in block
 assert block.count(marker)==1
 stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
 save=Path('/var/lib/zl-prediction/archive/source-backups')/('deepseek5-caddy-'+stamp+'.bak')
 shutil.copy2(p,save)
 changed=block.replace(marker,marker+new,1)
 p.write_text(original[:start]+changed+original[end:])
 if subprocess.run(['caddy','validate','--config',str(p)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0:
  shutil.copy2(save,p)
  raise RuntimeError('CADDY_VALIDATE_FAILED_RESTORED')
 if subprocess.run(['systemctl','reload','caddy'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0:
  shutil.copy2(save,p)
  subprocess.run(['systemctl','reload','caddy'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  raise RuntimeError('CADDY_RELOAD_FAILED_RESTORED')
 print('DEEPSEEK_PROTECTED_PAGE_ROUTE_ADDED=true')
else:
 print('DEEPSEEK_PROTECTED_PAGE_ROUTE_ALREADY_EXISTS=true')
PY
site=prediction.47-237-188-69.sslip.io
code=$(curl -ks -o /dev/null -w '%{http_code}' --resolve "$site:443:127.0.0.1" "https://$site/deepseek/")
test "$code" = 401
echo 'DEEPSEEK_PROTECTED_PAGE_UNAUTHENTICATED_HTTP=401'
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:13029/)
test "$code" = 200
echo 'DEEPSEEK_LOCAL_PAGE_HTTP=200'
test "$(systemctl is-active zl-prediction-trade)" = active
test "$(systemctl is-active zl-futures-bot-paper)" = active
echo 'DEEPSEEK_PUBLIC_ROUTE_PRODUCTION_TRADE_PRESERVED=true'
'''
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch(r'[a-f0-9]{40}',sha):
  print('WRONG_DEPLOY_BRANCH');return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
     access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
     endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 call=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
    name='zl-deepseek-protected-ui-route-no-orders',type='RunShellScript',
    command_content=SCRIPT,working_user='root',timeout=115)).body.invoke_id
 for _ in range(40):
  time.sleep(3)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
    instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=call)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   s=r.output or ''
   try:s=base64.b64decode(s,validate=True).decode('utf-8','replace')
   except Exception:pass
   print('DEEPSEEK_PUBLIC_REMOTE_STATUS',str(r.invocation_status),'EXIT',r.exit_code)
   print(s[-4500:])
   return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':sys.exit(main())

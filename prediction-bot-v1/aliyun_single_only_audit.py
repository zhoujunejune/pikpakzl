#!/usr/bin/env python3
"""Read-only Alibaba SWAS inventory for retiring all bots except five-minute single prediction."""
import os,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REGION='ap-southeast-1'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
echo AUDIT_BEGIN_UTC=$(date -u +%FT%TZ)
echo AUDIT_SERVICE_BEGIN
systemctl list-units --all --no-pager --plain --no-legend 'zl-*' | awk '{print $1,$3,$4}' | head -100
echo AUDIT_SERVICE_END
echo AUDIT_ENABLED_BEGIN
systemctl list-unit-files --no-pager --plain --no-legend 'zl-*' | awk '{print $1,$2}' | head -100
echo AUDIT_ENABLED_END
echo AUDIT_PORT_BEGIN
ss -ltnp | grep -E ':(10000|11000|130[0-9][0-9])[[:space:]]' | sed -E 's/users:.*$//g' || true
echo AUDIT_PORT_END
python3 - <<'PY'
import json,urllib.request,urllib.error
pairs=[(13001,'/api/status'),(13001,'/api/dual5-status'),(13048,'/api/status'),(13020,'/api/status'),(10000,'/status'),(13002,'/healthz'),(13003,'/healthz'),(13004,'/healthz'),(13005,'/healthz')]
for port,path in pairs:
 try:
  with urllib.request.urlopen('http://127.0.0.1:%s%s'%(port,path),timeout=5) as r:
   obj=json.loads(r.read(300000))
  allow=('ok','enabled','active','mode','model','liveTradingEnabled','pendingOrderUncertain','positions','openOrders','openOrderCount','pendingOrders','pendingOrderCount','followEnabled','tradeExecutionEnabled','executionAvailable','health','status','engineStatus')
  out={k:obj.get(k) for k in allow if k in obj}
  for k in ('positions','openOrders','pendingOrders'):
   if k in out:out[k]='count:'+str(len(out[k])) if isinstance(out[k],(list,dict)) else str(type(out[k]).__name__)
  print('AUDIT_API',port,path,json.dumps(out,ensure_ascii=False)[:1000])
 except Exception as ex:print('AUDIT_API',port,path,type(ex).__name__)
PY
echo AUDIT_CADDY_BEGIN
python3 - <<'PY'
from pathlib import Path
p=Path('/etc/caddy/Caddyfile')
print('present',p.is_file())
if p.is_file():
 s=p.read_text()
 for i,line in enumerate(s.splitlines(),1):
  t=line.strip()
  if any(w in t for w in ('sslip.io','handle','redir','reverse_proxy','route ','rewrite','uri ')):
   print('CADDY_LINE',i,t[:180])
PY
echo AUDIT_CADDY_END
echo AUDIT_CONFIG_FILES_BEGIN
for d in /etc/systemd/system /opt;do
 find "$d" -maxdepth 1 \( -name 'zl-*' -o -name 'zl*' \) -printf '%f\n' 2>/dev/null | head -100
done
echo AUDIT_CONFIG_FILES_END
echo AUDIT_SUCCESS=true
"""
def main():
 key=os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID')
 secret=os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET')
 if not key or not secret:
  print('AUDIT_AUTH_MISSING');return 2
 c=Client(api.Config(access_key_id=key,access_key_secret=secret,region_id=REGION,endpoint='swas.ap-southeast-1.aliyuncs.com'))
 try:
  r=c.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name='zl-single-only-audit',type='RunShellScript',command_content=SCRIPT,working_user='root',timeout=180))
  for _ in range(75):
   time.sleep(2)
   x=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=r.body.invoke_id)).body.invocation_result
   if not x or str(x.invocation_status) not in ('Success','Failed','Aborted','ExecutionTimeout','ClientNotRunning'):continue
   try:o=base64.b64decode(x.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(x.output or '')
   print('AUDIT_REMOTE_STATUS',x.invocation_status,'EXIT',x.exit_code)
   print(o[-25000:])
   return 0 if str(x.invocation_status)=='Success' and int(x.exit_code)==0 else 3
  print('AUDIT_REMOTE_TIMEOUT');return 4
 except Exception as ex:
  print('AUDIT_REMOTE_ERROR',type(ex).__name__,str(ex)[:300]);return 5
if __name__=='__main__':sys.exit(main())

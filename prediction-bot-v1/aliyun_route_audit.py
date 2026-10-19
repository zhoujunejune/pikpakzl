#!/usr/bin/env python3
"""Read-only route and request-URL diagnostic for prediction navigation."""
import os,base64,time,re,sys
REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
echo "ROUTE_AUDIT_TIME_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - <<'PY'
from pathlib import Path
import re
p=Path('/etc/caddy/Caddyfile')
src=p.read_text()
lines=src.splitlines()
for i,line in enumerate(lines):
 st=line.strip()
 if any(x in st for x in ('47-237-188-69.sslip.io','handle','redir','reverse_proxy','uri ', 'rewrite','route ', 'respond ','header_up')):
  if 'header_up' in st and 'Authorization' not in st and 'X-ZL-Verified-Login' not in st: continue
  if len(st)>150: st=st[:150]
  print('ROUTE_CADDY_LINE',i+1,st)
print('ROUTE_CADDY_SYNTAX',__import__('subprocess').run(['caddy','validate','--config',str(p)],stdout=__import__('subprocess').DEVNULL,stderr=__import__('subprocess').DEVNULL).returncode)
p=Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
a=p.read_text().splitlines()
for i,line in enumerate(a):
 if 'ZL_INVALID_REQUEST_URL_400_GUARD' in line:
  for j in range(max(0,i-3),min(len(a),i+17)):
   st=a[j].strip()
   # keep only structural safely classified descriptions; never expose credentials
   if 'new URL(req.url' in st:
    m=re.search(r'new URL\(req\.url,\s*(.*)\);',st)
    base=m.group(1) if m else ''
    print('ROUTE_URL_BASE_EXPR_TYPE', 'literal_localhost' if base in ("'http://localhost'","'http://127.0.0.1'") else "other")
    print('ROUTE_URL_BASE_LENGTH',len(base))
    print('ROUTE_URL_BASE_VALID', str(base.startswith(("'http://","\"http://")) and base.endswith(("'","\""))))
   else: print('ROUTE_PANEL_HANDLER',j+1,st[:135])
  break
else: print('ROUTE_PANEL_GUARD_ABSENT')
PY
for port in 10000 11000 13001;do
  for path in / /prediction/ /api/status /healthz;do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port$path" || true)
    echo "ROUTE_LOCAL_HTTP port=$port path=$path code=$code"
  done
done
for host in 47-237-188-69.sslip.io prediction.47-237-188-69.sslip.io;do
  for path in / /prediction/ /prediction/healthz /dashboard/ /api/status;do
    code=$(curl -sk --resolve "$host:443:127.0.0.1" -o /dev/null -w '%{http_code}' --max-time 5 "https://$host$path" || true)
    echo "ROUTE_HTTPS_UNAUTH host=$host path=$path code=$code"
  done
done
echo "ROUTE_SERVICE_11000=$(systemctl is-active zl-prediction-readonly.service || true)"
echo "ROUTE_SERVICE_13001=$(systemctl is-active zl-prediction-trade.service || true)"
echo "ROUTE_AUDIT_COMPLETE=true"
"""
def main():
 from alibabacloud_swas_open20200601.client import Client
 from alibabacloud_swas_open20200601 import models as sw
 from alibabacloud_tea_openapi import models as api
 k=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID");v=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
 if not k or not v: print("ROUTE_AUTH_MISSING");return 2
 cl=Client(api.Config(access_key_id=k,access_key_secret=v,region_id=REGION,endpoint="swas.ap-southeast-1.aliyuncs.com"))
 try:
  r=cl.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name="zl-prediction-route-audit",type="RunShellScript",command_content=SCRIPT,working_user="root",timeout=110))
  invoke=r.body.invoke_id
  for _ in range(32):
   time.sleep(3)
   d=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=invoke)).body.invocation_result
   if not d:continue
   status=str(d.invocation_status)
   if status in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
    raw=d.output or ""
    try:raw=base64.b64decode(raw,validate=True).decode("utf-8","replace")
    except Exception:pass
    print("ROUTE_CLOUD_STATUS",status,d.exit_code)
    print(raw[-19000:])
    return 0 if status=="Success" and int(d.exit_code)==0 else 4
 except Exception as e: print("ROUTE_CLOUD_ERR",type(e).__name__);return 5
 print("ROUTE_NO_RESPONSE");return 6
if __name__=="__main__":sys.exit(main())

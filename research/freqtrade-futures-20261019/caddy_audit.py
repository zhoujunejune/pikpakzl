#!/usr/bin/env python3
"""READ ONLY Caddy structure and free path probes. Never print secrets."""
import base64,os,re,sys,time
REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
SCRIPT=r'''#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import pathlib,re,urllib.request
p=pathlib.Path('/etc/caddy/Caddyfile')
s=p.read_text()
first=s.split('prediction.47-237-188-69.sslip.io {',1)[0]
for no,line in enumerate(first.splitlines(),1):
 if any(word in line for word in ('47-237-188-69.sslip.io','handle','reverse_proxy','file_server','root *','redir','route','basicauth','basic_auth','/research/')):
  line=line.strip()
  if re.search('password|secret|token|hash',line,re.I):line='REDACTED'
  print('AUDIT_CADDY_LINE',no,line[:170])
print('AUDIT_RESEARCH_PATH_PRESENT', '/research/' in first)
print('AUDIT_RESEARCH_DISK_EXISTS',pathlib.Path('/srv/zl-research/freqtrade/index.html').exists())
for path in ('/status','/research/'):
 try:
  with urllib.request.urlopen('http://127.0.0.1:10000'+path,timeout=2) as r:
   print('AUDIT_FUTURES_LOCAL',path,r.status)
 except Exception as exc:print('AUDIT_FUTURES_LOCAL',path,type(exc).__name__)
PY
'''
def main():
 from alibabacloud_swas_open20200601.client import Client
 from alibabacloud_swas_open20200601 import models as sw
 from alibabacloud_tea_openapi import models as api
 k=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID");v=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
 if not k or not v:print("AUDIT_MISSING_ACCESS");return 2
 cl=Client(api.Config(access_key_id=k,access_key_secret=v,endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
 try:
  inv=cl.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name="zl-research-only-caddy-read",type="RunShellScript",command_content=SCRIPT,working_user="root",timeout=75)).body.invoke_id
  for _ in range(24):
   time.sleep(3)
   obj=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
   if not obj:continue
   if str(obj.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
    raw=obj.output or ""
    try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
    except Exception:pass
    print('AUDIT_CLOUD_STATE',obj.invocation_status,'EXIT',obj.exit_code)
    print(raw[-4500:])
    return 0 if str(obj.invocation_status)=="Success" and int(obj.exit_code)==0 else 4
 except Exception as exc:print("AUDIT_ERROR_CLASS",type(exc).__name__);return 5
 return 6
if __name__=="__main__":sys.exit(main())

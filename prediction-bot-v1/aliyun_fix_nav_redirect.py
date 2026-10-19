#!/usr/bin/env python3
"""Patch only the misconfigured prediction cross-host Caddy redirect."""
import base64,os,sys,time
REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
SCRIPT=r'''#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
from pathlib import Path
from datetime import datetime,timezone
import shutil,subprocess,re
p=Path('/etc/caddy/Caddyfile')
src=p.read_text()
main='47-237-188-69.sslip.io {'
pred='prediction.47-237-188-69.sslip.io {'
assert src.startswith(main) and src.count('\n'+pred)==1, 'unexpected Caddy hosts'
first=src[:src.index(pred)]
old='redir https://prediction.47-237-188-69.sslip.io/{path} 302'
new='redir https://prediction.47-237-188-69.sslip.io{uri} 302'
assert first.count('handle_path /prediction/* {')==1,'prediction handle_path missing'
if old not in first:
 assert new in first,'Caddy redirect does not match expected old/new configuration'
 print('PRED_NAV_ALREADY_FIXED=true')
else:
 assert first.count(old)==1, 'unsafe multiple redirects'
 stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
 backup=Path('/var/lib/zl-prediction/archive/source-backups')/('caddy-nav-'+stamp+'.bak')
 backup.parent.mkdir(parents=True,exist_ok=True)
 shutil.copy2(p,backup)
 current=src.replace(old,new,1)
 p.write_text(current)
 valid=subprocess.run(['caddy','validate','--config',str(p)],capture_output=True,text=True,timeout=15)
 if valid.returncode!=0:
  shutil.copy2(backup,p)
  raise RuntimeError('Caddy syntax validation failed; restored original')
 reload=subprocess.run(['systemctl','reload','caddy'],capture_output=True,text=True,timeout=15)
 if reload.returncode!=0:
  shutil.copy2(backup,p)
  subprocess.run(['systemctl','reload','caddy'],timeout=15)
  raise RuntimeError('Caddy reload failed; restored original')
 print('PRED_NAV_CHANGED=true')
 print('PRED_NAV_BACKUP='+str(backup))
print('PRED_NAV_REDIR_TARGET=https://prediction.47-237-188-69.sslip.io{uri}')
PY
echo "PRED_NAV_CADDY=$(systemctl is-active caddy)"
echo "PRED_NAV_PRED_TRADE=$(systemctl is-active zl-prediction-trade)"
echo "PRED_NAV_FUTURES=$(systemctl is-active zl-futures-bot-paper)"
echo "PRED_NAV_V2=$(systemctl is-active zl-prediction-v2)"
echo "PRED_NAV_V3=$(systemctl is-active zl-prediction-v3)"
echo "PRED_NAV_DONE=true"
'''
def main():
 from alibabacloud_swas_open20200601.client import Client
 from alibabacloud_swas_open20200601 import models as sw
 from alibabacloud_tea_openapi import models as api
 k=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID");v=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
 if not k or not v:print("PRED_NAV_NO_AUTH");return 2
 cl=Client(api.Config(access_key_id=k,access_key_secret=v,endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
 try:
  inv=cl.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name="zl-caddy-nav-double-slash-fix",type="RunShellScript",command_content=SCRIPT,working_user="root",timeout=90)).body.invoke_id
  for _ in range(32):
   time.sleep(3)
   obj=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
   if not obj:continue
   state=str(obj.invocation_status)
   if state in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
    raw=obj.output or ""
    try:raw=base64.b64decode(raw,validate=True).decode("utf8","replace")
    except Exception:pass
    print("PRED_NAV_CLOUD_STATUS",state,"EXIT",obj.exit_code)
    print(raw[-6000:])
    return 0 if state=="Success" and int(obj.exit_code)==0 else 4
 except Exception as e:print("PRED_NAV_CLOUD_ERROR",type(e).__name__);return 5
 print("PRED_NAV_NO_RESPONSE");return 6
if __name__=="__main__":sys.exit(main())
,src))==1 and len(re.findall(r'(?m)^'+re.escape(pred)+r'
first=src[:src.index(pred)]
old='redir https://prediction.47-237-188-69.sslip.io/{path} 302'
new='redir https://prediction.47-237-188-69.sslip.io{uri} 302'
assert first.count('handle_path /prediction/* {')==1,'prediction handle_path missing'
if old not in first:
 assert new in first,'Caddy redirect does not match expected old/new configuration'
 print('PRED_NAV_ALREADY_FIXED=true')
else:
 assert first.count(old)==1, 'unsafe multiple redirects'
 stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
 backup=Path('/var/lib/zl-prediction/archive/source-backups')/('caddy-nav-'+stamp+'.bak')
 backup.parent.mkdir(parents=True,exist_ok=True)
 shutil.copy2(p,backup)
 current=src.replace(old,new,1)
 p.write_text(current)
 valid=subprocess.run(['caddy','validate','--config',str(p)],capture_output=True,text=True,timeout=15)
 if valid.returncode!=0:
  shutil.copy2(backup,p)
  raise RuntimeError('Caddy syntax validation failed; restored original')
 reload=subprocess.run(['systemctl','reload','caddy'],capture_output=True,text=True,timeout=15)
 if reload.returncode!=0:
  shutil.copy2(backup,p)
  subprocess.run(['systemctl','reload','caddy'],timeout=15)
  raise RuntimeError('Caddy reload failed; restored original')
 print('PRED_NAV_CHANGED=true')
 print('PRED_NAV_BACKUP='+str(backup))
print('PRED_NAV_REDIR_TARGET=https://prediction.47-237-188-69.sslip.io{uri}')
PY
echo "PRED_NAV_CADDY=$(systemctl is-active caddy)"
echo "PRED_NAV_PRED_TRADE=$(systemctl is-active zl-prediction-trade)"
echo "PRED_NAV_FUTURES=$(systemctl is-active zl-futures-bot-paper)"
echo "PRED_NAV_V2=$(systemctl is-active zl-prediction-v2)"
echo "PRED_NAV_V3=$(systemctl is-active zl-prediction-v3)"
echo "PRED_NAV_DONE=true"
'''
def main():
 from alibabacloud_swas_open20200601.client import Client
 from alibabacloud_swas_open20200601 import models as sw
 from alibabacloud_tea_openapi import models as api
 k=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID");v=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
 if not k or not v:print("PRED_NAV_NO_AUTH");return 2
 cl=Client(api.Config(access_key_id=k,access_key_secret=v,endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
 try:
  inv=cl.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name="zl-caddy-nav-double-slash-fix",type="RunShellScript",command_content=SCRIPT,working_user="root",timeout=90)).body.invoke_id
  for _ in range(32):
   time.sleep(3)
   obj=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
   if not obj:continue
   state=str(obj.invocation_status)
   if state in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
    raw=obj.output or ""
    try:raw=base64.b64decode(raw,validate=True).decode("utf8","replace")
    except Exception:pass
    print("PRED_NAV_CLOUD_STATUS",state,"EXIT",obj.exit_code)
    print(raw[-6000:])
    return 0 if state=="Success" and int(obj.exit_code)==0 else 4
 except Exception as e:print("PRED_NAV_CLOUD_ERROR",type(e).__name__);return 5
 print("PRED_NAV_NO_RESPONSE");return 6
if __name__=="__main__":sys.exit(main())
,src))==1, 'unexpected Caddy hosts'
first=src[:src.index(pred)]
old='redir https://prediction.47-237-188-69.sslip.io/{path} 302'
new='redir https://prediction.47-237-188-69.sslip.io{uri} 302'
assert first.count('handle_path /prediction/* {')==1,'prediction handle_path missing'
if old not in first:
 assert new in first,'Caddy redirect does not match expected old/new configuration'
 print('PRED_NAV_ALREADY_FIXED=true')
else:
 assert first.count(old)==1, 'unsafe multiple redirects'
 stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
 backup=Path('/var/lib/zl-prediction/archive/source-backups')/('caddy-nav-'+stamp+'.bak')
 backup.parent.mkdir(parents=True,exist_ok=True)
 shutil.copy2(p,backup)
 current=src.replace(old,new,1)
 p.write_text(current)
 valid=subprocess.run(['caddy','validate','--config',str(p)],capture_output=True,text=True,timeout=15)
 if valid.returncode!=0:
  shutil.copy2(backup,p)
  raise RuntimeError('Caddy syntax validation failed; restored original')
 reload=subprocess.run(['systemctl','reload','caddy'],capture_output=True,text=True,timeout=15)
 if reload.returncode!=0:
  shutil.copy2(backup,p)
  subprocess.run(['systemctl','reload','caddy'],timeout=15)
  raise RuntimeError('Caddy reload failed; restored original')
 print('PRED_NAV_CHANGED=true')
 print('PRED_NAV_BACKUP='+str(backup))
print('PRED_NAV_REDIR_TARGET=https://prediction.47-237-188-69.sslip.io{uri}')
PY
echo "PRED_NAV_CADDY=$(systemctl is-active caddy)"
echo "PRED_NAV_PRED_TRADE=$(systemctl is-active zl-prediction-trade)"
echo "PRED_NAV_FUTURES=$(systemctl is-active zl-futures-bot-paper)"
echo "PRED_NAV_V2=$(systemctl is-active zl-prediction-v2)"
echo "PRED_NAV_V3=$(systemctl is-active zl-prediction-v3)"
echo "PRED_NAV_DONE=true"
'''
def main():
 from alibabacloud_swas_open20200601.client import Client
 from alibabacloud_swas_open20200601 import models as sw
 from alibabacloud_tea_openapi import models as api
 k=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID");v=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
 if not k or not v:print("PRED_NAV_NO_AUTH");return 2
 cl=Client(api.Config(access_key_id=k,access_key_secret=v,endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
 try:
  inv=cl.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name="zl-caddy-nav-double-slash-fix",type="RunShellScript",command_content=SCRIPT,working_user="root",timeout=90)).body.invoke_id
  for _ in range(32):
   time.sleep(3)
   obj=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
   if not obj:continue
   state=str(obj.invocation_status)
   if state in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
    raw=obj.output or ""
    try:raw=base64.b64decode(raw,validate=True).decode("utf8","replace")
    except Exception:pass
    print("PRED_NAV_CLOUD_STATUS",state,"EXIT",obj.exit_code)
    print(raw[-6000:])
    return 0 if state=="Success" and int(obj.exit_code)==0 else 4
 except Exception as e:print("PRED_NAV_CLOUD_ERROR",type(e).__name__);return 5
 print("PRED_NAV_NO_RESPONSE");return 6
if __name__=="__main__":sys.exit(main())

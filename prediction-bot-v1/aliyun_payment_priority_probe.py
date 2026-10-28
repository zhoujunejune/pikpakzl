#!/usr/bin/env python3
"""Read-only SWAS prediction wallet-route deployment preflight."""
import os,base64,sys,time,json
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as o
REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
SH=r'''#!/bin/bash
set -u
echo PROBE_START
for svc in zl-prediction-trade zl-prediction-v2 zl-prediction-v3;do
 echo "SERVICE:$svc:$(systemctl is-active "$svc" 2>/dev/null || true)"
done
ROOT=/opt/zl-prediction-live/src
if [ -d "$ROOT/.git" ];then
 echo "REPO_PRESENT:yes"
 git -C "$ROOT" rev-parse --short HEAD 2>/dev/null | sed 's/^/SERVER_SHA:/'
else echo "REPO_PRESENT:no";fi
for file in railway-diagnostic/index.mjs railway-diagnostic/wrapper.mjs railway-diagnostic/payment-source-priority.mjs;do
 if [ -f "$ROOT/$file" ];then
   echo "FILE:$file:present"
   sha256sum "$ROOT/$file" | cut -d' ' -f1 | sed 's/^/CONTENT_SHA256:/'
   git hash-object "$ROOT/$file" | sed 's/^/GIT_BLOB_SHA:/'
 else echo "FILE:$file:missing";fi
done
python3 - <<'PY'
import json,urllib.request
for p in (13005,13004,13001):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d/api/status'%p,timeout=2) as response:
   d=json.load(response)
  print('PREDICTION_CONTROL_STATUS',json.dumps({'port':p,'ok':d.get('ok'),'enabled':d.get('enabled'),'pendingState':(d.get('pendingAction') or {}).get('state'),'lastOrderState':(d.get('lastOrder') or {}).get('state'),'autoConfirmEnabled':d.get('autoConfirmEnabled')},separators=(',',':')))
  break
 except Exception as e:print('PREDICTION_PORT_UNAVAILABLE',p,type(e).__name__)
PY
for p in 13005 13004 13001;do
 echo "HEALTHZ_PORT:$p:$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:$p/healthz || true)"
done
echo "TRADE_SERVICE_RECENT_FAILURES_BEGIN"
journalctl -u zl-prediction-trade --since '18 minutes ago' --no-pager -o cat 2>/dev/null | python3 -c 'import re,sys
rows=[]
for line in sys.stdin:
 if re.search(r"Error|ERR_|Cannot find|failed|exit|missing|SyntaxError|MODULE_NOT_FOUND|EACCES|address already|ECONNREFUSED",line,re.I):
  line=re.sub(r"(?i)(key|token|password|secret)[=:]\\s*\\S+",r"\\1=[REDACTED]",line.strip()[:210])
  rows.append(line)
print("\\n".join(rows[-17:]))' || true
echo "TRADE_SERVICE_RECENT_FAILURES_END"
echo PROBE_END
'''
def main():
 if not os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID") or not os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET"):
  print("ALICLOUD_CREDENTIALS_UNAVAILABLE");return 2
 c=Client(o.Config(access_key_id=os.environ["ALIBABA_CLOUD_ACCESS_KEY_ID"],access_key_secret=os.environ["ALIBABA_CLOUD_ACCESS_KEY_SECRET"],endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
 try:
  r=c.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name="zl-payment-priority-readonly-probe",type="RunShellScript",command_content=SH,working_user="root",timeout=70))
  if not r.body.invoke_id:print("NO_INVOKE_ID");return 3
  for _ in range(35):
   time.sleep(2)
   x=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=r.body.invoke_id)).body.invocation_result
   if x and str(x.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout","ClientNotRunning"):
    output=x.output or ""
    try:output=base64.b64decode(output,validate=True).decode("utf8","replace")
    except Exception:pass
    print("PROBE_STATUS",x.invocation_status,"EXIT",x.exit_code)
    print(output[-6000:])
    return 0 if str(x.invocation_status)=="Success" and int(x.exit_code)==0 else 4
  print("PROBE_PENDING");return 5
 except Exception as e:print("PROBE_ERROR",type(e).__name__,str(getattr(e,'code','unknown'))[:80]);return 6
if __name__=="__main__":sys.exit(main())

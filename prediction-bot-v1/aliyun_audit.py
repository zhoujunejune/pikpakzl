#!/usr/bin/env python3
"""Read-only Alibaba SWAS capacity and prediction secret presence audit."""
import base64,os,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as s
from alibabacloud_tea_openapi import models as o
REGION="ap-southeast-1"; INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
def main():
    key=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID");secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
    if not key or not secret: print("MISSING_ALIBABA_SECRETS");return 2
    client=Client(o.Config(access_key_id=key, access_key_secret=secret,
        region_id=REGION,endpoint="swas.ap-southeast-1.aliyuncs.com"))
    cmd=r"""#!/bin/bash
set -Eeuo pipefail
echo "PRED_AUDIT_OS=$(uname -s)-$(uname -m)"
echo "PRED_AUDIT_CPU=$(nproc)"
echo "PRED_AUDIT_DISK=$(df -Pk /opt | awk 'NR==2{printf "%sMiB",int($4/1024)}')"
echo "PRED_AUDIT_MEMORY=$(free -m | awk '/Mem:/{print $7 "MiB-available"}')"
for c in node npm python3 docker redis-server redis-cli git caddy; do
 if command -v "$c" >/dev/null;then echo "PRED_AUDIT_CMD_$c=yes";else echo "PRED_AUDIT_CMD_$c=no";fi
done
for name in zl-futures-bot-paper zl-prediction-readonly zl-prediction-v2 zl-prediction-v3 zl-prediction-trade zl-prediction-redis; do
 echo "PRED_AUDIT_SERVICE_$name=$(systemctl is-active "$name" || true)"
done
for dir in /opt/zl-prediction-live /opt/zl-prediction-monitor /var/lib/zl-prediction;do
 test -e "$dir" && echo "PRED_AUDIT_PATH_$dir=exists" || echo "PRED_AUDIT_PATH_$dir=absent"
done
for f in /etc/zl-prediction/panel.env /etc/zl-prediction/trading.env /etc/zl-prediction/collector.env; do
 if test -e "$f";then
  echo "PRED_AUDIT_SECRET_FILE_$f=present"
  grep -E '^[A-Za-z_][A-Za-z_0-9]*=' "$f" |cut -d = -f 1| grep -E 'BINANCE|CONTROL_PIN|WALLET|Z3|SIGNAL' |head -30 |sed 's/^/PRED_AUDIT_KEY_NAME=/' || true
 else echo "PRED_AUDIT_SECRET_FILE_$f=absent"; fi
done
"""
    res=client.run_command(s.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
            name="zl-prediction-capacity-readonly",type="RunShellScript",
            command_content=cmd,working_user="root",timeout=60))
    invoke=res.body.invoke_id
    for _ in range(25):
        time.sleep(2)
        y=client.describe_invocation_result(s.DescribeInvocationResultRequest(
            region_id=REGION,instance_id=INSTANCE,invoke_id=invoke)).body.invocation_result
        if not y:continue
        if str(y.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
            raw=y.output or ""
            try: raw=base64.b64decode(raw,validate=True).decode("utf-8","replace")
            except:pass
            print("PRED_AUDIT_EXIT",y.exit_code)
            print("PRED_AUDIT_OUTPUT\n"+raw[-5000:])
            return 0 if str(y.invocation_status)=="Success" and int(y.exit_code)==0 else 3
    return 4
if __name__=="__main__":sys.exit(main())

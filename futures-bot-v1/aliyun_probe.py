#!/usr/bin/env python3
"""One safe SWAS OS probe via Alibaba Cloud Assistant, no installs or trading."""
import os
import sys
import time
import base64

REGION="ap-southeast-1"
INSTANCE_ID="b67374069bb3457ba6a3a2ede9305d3f"
COMMAND="""#!/bin/bash
set -eu
echo "PROBE_BEGIN"
uname -s -m
if [ -f /etc/os-release ]; then
  . /etc/os-release
  echo "OS_ID=$ID"
  echo "OS_VERSION=$VERSION_ID"
fi
python3 --version || true
git --version || true
df -h / | tail -n 1
id -u
echo "PROBE_END"
echo "SERVICE_CHECK_BEGIN"
systemctl is-active zl-futures-bot-paper.service || true
systemctl is-enabled zl-futures-bot-paper.service || true
curl -fsS --max-time 5 http://127.0.0.1:10000/status || true
echo
echo "SERVICE_RECENT_EVENTS"
journalctl -u zl-futures-bot-paper.service --since "20 minutes ago" --no-pager -o cat 2>/dev/null | grep -E 'worker_failed|cycle_error|exchange_|render_paper_http_ready|started|paper_open|paper_closed' | tail -n 12 || true
echo "SERVICE_CHECK_END"
"""

def main():
    kid=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
    secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
    if not kid or not secret:
        print("FAILED: secrets missing")
        return 3
    from alibabacloud_swas_open20200601.client import Client
    from alibabacloud_swas_open20200601 import models as models
    from alibabacloud_tea_openapi import models as om
    client=Client(om.Config(access_key_id=kid,access_key_secret=secret,
                            endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
    try:
        req=models.RunCommandRequest(
            region_id=REGION,instance_id=INSTANCE_ID,
            name="zl-futures-readonly-preflight",
            type="RunShellScript",command_content=COMMAND,timeout=90)
        result=client.run_command(req)
        invoke_id=result.body.invoke_id
        if not invoke_id:
            print("FAILED: missing invocation ID")
            return 4
        print("PROBE: cloud command accepted")
        for _ in range(24):
            time.sleep(5)
            rs=client.describe_invocation_result(models.DescribeInvocationResultRequest(
                region_id=REGION,instance_id=INSTANCE_ID,invoke_id=invoke_id))
            inv=rs.body.invocation_result
            if inv is None:
                continue
            state=str(inv.invocation_status)
            if state in ("Success","Failed","Aborted","Invalid","ExecutionTimeout",
                         "ClientNotRunning","InstanceNotRunning","CommandNotApplicable"):
                print("PROBE_STATUS:",state)
                print("PROBE_EXIT:",inv.exit_code)
                out=inv.output or ""
                try:
                    out=base64.b64decode(out,validate=True).decode("utf-8","replace")
                except Exception:
                    pass
                print("PROBE_OUTPUT:",out[-4400:])
                return 0 if state=="Success" and int(inv.exit_code)==0 else 6
        print("FAILED: command status was not final")
        return 7
    except Exception as e:
        print("PROBE_API_ERROR_TYPE:",type(e).__name__)
        print("PROBE_API_ERROR_CODE:",str(getattr(e,"code","unknown"))[:64])
        return 8

if __name__=="__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Invoke Alibaba SWAS Cloud Assistant to patch only the live order deadline."""
import base64
import os
import re
import sys
import time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as om

REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"

def main():
    sha=os.environ.get("GITHUB_SHA","")
    if os.environ.get("GITHUB_REF_NAME")!="feature/zl-futures-bot-v1" or not re.fullmatch(r"[a-f0-9]{40}",sha):
        print("SELECTIVE30_INVALID_BRANCH_OR_SHA");return 2
    key=os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID")
    secret=os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
    if not key or not secret:
        print("SELECTIVE30_DEPLOY_MISSING_SECRETS");return 3
    c=Client(om.Config(access_key_id=key,access_key_secret=secret,region_id=REGION,endpoint="swas.ap-southeast-1.aliyuncs.com"))
    command=r"""#!/bin/bash
set -Eeuo pipefail
f=$(mktemp /tmp/zl-selective30-trade.XXXXXXXX.py)
trap 'rm -f "$f"' EXIT
curl -fsSL --retry 3 --max-time 35 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/DEPLOY_SHA/prediction-bot-v1/aliyun_selective30_trade_deadline_patch.py" -o "$f"
python3 -m py_compile "$f"
python3 "$f"
""".replace("DEPLOY_SHA",sha)
    try:
        job=c.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name="zl-selective30-live-order-window-fix",type="RunShellScript",command_content=command,working_user="root",timeout=390))
        for _ in range(115):
            time.sleep(3)
            r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=job.body.invoke_id)).body.invocation_result
            if not r:continue
            status=str(r.invocation_status)
            if status in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
                raw=r.output or ""
                try:raw=base64.b64decode(raw,validate=True).decode("utf-8","replace")
                except Exception:pass
                print("SELECTIVE30_TRADE_CLOUD_STATUS",status)
                print("SELECTIVE30_TRADE_CLOUD_EXIT",r.exit_code)
                print(raw[-6500:])
                return 0 if status=="Success" and int(r.exit_code)==0 else 5
        print("SELECTIVE30_TRADE_CLOUD_TIMEOUT");return 6
    except Exception as e:
        print("SELECTIVE30_TRADE_CLOUD_EXCEPTION",type(e).__name__)
        return 7
if __name__=="__main__":sys.exit(main())

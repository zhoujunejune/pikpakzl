#!/usr/bin/env python3
"""Deploy 30s qualified two-source patch through already-authorized Aliyun SWAS Cloud Assistant."""
import base64
import os
import re
import sys
import time

from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as om

REGION = "ap-southeast-1"
INSTANCE = "b67374069bb3457ba6a3a2ede9305d3f"

def main():
    sha = os.getenv("GITHUB_SHA", "")
    if os.getenv("GITHUB_REF_NAME") != "feature/zl-futures-bot-v1" or not re.fullmatch(r"[a-f0-9]{40}", sha):
        print("SELECTIVE30_INVALID_DEPLOY_SOURCE")
        return 2
    key = os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID")
    secret = os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
    if not key or not secret:
        print("SELECTIVE30_DEPLOY_SECRETS_MISSING")
        return 3
    client = Client(om.Config(access_key_id=key, access_key_secret=secret,
                              region_id=REGION, endpoint="swas.ap-southeast-1.aliyuncs.com"))
    command = r"""#!/bin/bash
set -Eeuo pipefail
f=$(mktemp /tmp/zl-selective30.XXXXXXXX.py)
trap 'rm -f "$f"' EXIT
curl -fsSL --retry 3 --max-time 35 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/DEPLOY_SHA/prediction-bot-v1/aliyun_selective30_patch.py" -o "$f"
python3 -m py_compile "$f"
python3 "$f"
""".replace("DEPLOY_SHA", sha)
    try:
        job = client.run_command(sw.RunCommandRequest(
            region_id=REGION, instance_id=INSTANCE,
            name="zl-prediction-v2-qualified-two-source-30s",
            type="RunShellScript", command_content=command,
            working_user="root", timeout=420))
        for _ in range(130):
            time.sleep(3)
            r = client.describe_invocation_result(sw.DescribeInvocationResultRequest(
                region_id=REGION, instance_id=INSTANCE,
                invoke_id=job.body.invoke_id)).body.invocation_result
            if not r:
                continue
            status = str(r.invocation_status)
            if status in ("Success", "Failed", "Aborted", "ExecutionTimeout", "ExitCodeNonzero"):
                out = r.output or ""
                try:
                    out = base64.b64decode(out, validate=True).decode("utf-8", "replace")
                except Exception:
                    pass
                print("SELECTIVE30_DEPLOY_STATUS", status)
                print("SELECTIVE30_DEPLOY_EXIT", r.exit_code)
                print("SELECTIVE30_DEPLOY_OUTPUT", out[-9000:])
                return 0 if status == "Success" and int(r.exit_code) == 0 else 5
        print("SELECTIVE30_DEPLOY_TIMEOUT")
        return 6
    except Exception as e:
        print("SELECTIVE30_DEPLOY_EXCEPTION", type(e).__name__)
        return 7

if __name__ == "__main__":
    sys.exit(main())

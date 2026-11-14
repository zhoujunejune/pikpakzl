#!/usr/bin/env python3
"""Deploy ONLY separate read-only market shadow; uses authorized Alibaba SWAS GitHub secret."""
import base64
import os
import re
import sys
import time

REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
BRANCH="feature/zl-futures-bot-v1"
REPORT_SHA="13b00d72a3307d3f02d9768386b165b3454060aa"

def main():
    sha=os.getenv("GITHUB_SHA","")
    if os.getenv("GITHUB_REF_NAME")!=BRANCH or not re.fullmatch(r"[0-9a-f]{40}",sha):
        print("SHADOW_INVALID_DEPLOY_REF");return 2
    key=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
    secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
    if not key or not secret:
        print("SHADOW_ALIBABA_ACCESS_MISSING");return 3
    from alibabacloud_swas_open20200601.client import Client
    from alibabacloud_swas_open20200601 import models as m
    from alibabacloud_tea_openapi import models as a
    client=Client(a.Config(access_key_id=key,access_key_secret=secret,
       region_id=REGION,endpoint="swas.ap-southeast-1.aliyuncs.com"))
    command=f"""#!/bin/bash
set -Eeuo pipefail
f=$(mktemp)
trap 'rm -f "$f"' EXIT
curl -fsSL --retry 3 --max-time 25 https://raw.githubusercontent.com/zhoujunejune/pikpakzl/{sha}/futures-research-panel/install_live_shadow.sh -o "$f"
export APP_SHA={sha}
export REPORT_SHA={REPORT_SHA}
bash "$f"
"""
    try:
        r=client.run_command(m.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
          name="zl-sandbox-futures-live-readonly-market",type="RunShellScript",
          command_content=command,working_user="root",timeout=170))
        invocation=r.body.invoke_id
        if not invocation:
            print("SHADOW_INVOKE_ID_MISSING");return 4
        for _ in range(45):
            time.sleep(3)
            rr=client.describe_invocation_result(m.DescribeInvocationResultRequest(
               region_id=REGION,instance_id=INSTANCE,invoke_id=invocation)).body.invocation_result
            if rr is None:continue
            status=str(rr.invocation_status)
            if status in ("Success","Failed","Aborted","Invalid","ExecutionTimeout","ExitCodeNonzero",
                         "InstanceNotRunning","ClientNotRunning"):
                raw=rr.output or ""
                try:raw=base64.b64decode(raw,validate=True).decode("utf8","replace")
                except Exception:pass
                print("SHADOW_INSTALL_STATUS",status,"EXIT",rr.exit_code)
                print("SHADOW_INSTALL_TAIL",raw[-5000:])
                return 0 if status=="Success" and int(rr.exit_code)==0 else 5
        print("SHADOW_INSTALL_UNCONFIRMED_TIMEOUT");return 6
    except Exception as exc:
        print("SHADOW_INSTALL_ERROR_CLASS",type(exc).__name__)
        print("SHADOW_INSTALL_CLOUD_CODE",str(getattr(exc,"code","unknown"))[:80])
        return 7
if __name__=="__main__":
    sys.exit(main())

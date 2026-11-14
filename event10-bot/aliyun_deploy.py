#!/usr/bin/env python3
"""Deploy EVENT10 via the repository's existing authorized Alibaba SWAS secrets."""
import base64
import os
import re
import sys
import time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
BRANCH="feature/event10-deepseek-signal"

def main():
    sha=os.getenv("GITHUB_SHA","")
    if os.getenv("GITHUB_REF_NAME")!=BRANCH or not re.fullmatch("[0-9a-f]{40}",sha):
        print("EVENT10_INVALID_DEPLOY_REF")
        return 2
    ak=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
    sk=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
    if not ak or not sk:
        print("EVENT10_DEPLOY_CREDS_NOT_AVAILABLE")
        return 3
    cli=Client(api.Config(access_key_id=ak,access_key_secret=sk,
                          region_id=REGION,endpoint="swas.ap-southeast-1.aliyuncs.com"))
    script=f"""#!/bin/bash
set -Eeuo pipefail
tmp=$(mktemp -d /tmp/zl-event10-launch.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT
for filename in install_aliyun.sh install_routes.sh;do
 curl -fsSL --retry 3 --max-time 30 \
   https://raw.githubusercontent.com/zhoujunejune/pikpakzl/{sha}/event10-bot/$filename -o "$tmp/$filename"
done
export APP_SHA={sha}
bash "$tmp/install_aliyun.sh"
bash "$tmp/install_routes.sh"
echo EVENT10_COMPLETE_SHA={sha}
"""
    try:
        result=cli.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
             name="zl-event10-10m-readonly-install",type="RunShellScript",
             command_content=script,working_user="root",timeout=260))
        invocation=result.body.invoke_id
        if not invocation:
            print("EVENT10_NO_INVOCATION_ID")
            return 4
        for _ in range(92):
            time.sleep(3)
            res=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(
                  region_id=REGION,instance_id=INSTANCE,invoke_id=invocation)).body.invocation_result
            if not res:
                continue
            st=str(res.invocation_status)
            if st in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero",
                      "ClientNotRunning","InstanceNotRunning"):
                raw=res.output or ""
                try:raw=base64.b64decode(raw,validate=True).decode("utf-8","replace")
                except Exception:pass
                print("EVENT10_INVOCATION_STATUS="+st)
                print("EVENT10_EXIT_CODE="+str(res.exit_code))
                print("EVENT10_OUTPUT_TAIL="+raw[-4500:])
                return 0 if st=="Success" and int(res.exit_code)==0 and "EVENT10_ROUTES_DEPLOYED=true" in raw else 5
        print("EVENT10_COMMAND_TIMED_OUT_UNCONFIRMED")
        return 6
    except Exception as exc:
        print("EVENT10_DEPLOY_EXCEPTION="+type(exc).__name__)
        print("EVENT10_DEPLOY_ERROR_CODE="+str(getattr(exc,"code","unknown"))[:100])
        return 7
if __name__=="__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Install *only* read-only dynamically generated HTML nav on existing Alibaba SWAS.

Uses the existing GitHub encrypted Alibaba deployment secrets. Never imports,
edits, restarts or controls any trading logic or model settings.
"""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as m
from alibabacloud_tea_openapi import models as a

REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
BRANCH="feature/zl-futures-bot-v1"

def main():
    sha=os.getenv("GITHUB_SHA","")
    if os.getenv("GITHUB_REF_NAME")!=BRANCH or not re.fullmatch("[0-9a-f]{40}",sha):
        print("NAV_INVALID_GITHUB_REF")
        return 2
    key=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
    secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
    if not key or not secret:
        print("NAV_CLOUD_CREDENTIALS_NOT_CONFIGURED")
        return 3
    client=Client(a.Config(access_key_id=key,access_key_secret=secret,
        region_id=REGION,endpoint="swas.ap-southeast-1.aliyuncs.com"))
    cmd=f"""#!/bin/bash
set -Eeuo pipefail
s=$(mktemp)
trap 'rm -f "$s"' EXIT
curl -fsSL --retry 3 --max-time 25 \
https://raw.githubusercontent.com/zhoujunejune/pikpakzl/{sha}/futures-research-panel/install_nav_bridge.sh -o "$s"
export APP_SHA={sha}
bash "$s"
"""
    try:
        r=client.run_command(m.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
            name="zl-three-menu-read-only-ui-only",type="RunShellScript",
            command_content=cmd,working_user="root",timeout=170))
        inv=r.body.invoke_id
        if not inv:
            print("NAV_NO_INVOCATION_ID")
            return 4
        for _ in range(50):
            time.sleep(3)
            result=client.describe_invocation_result(m.DescribeInvocationResultRequest(
                region_id=REGION,instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
            if not result:continue
            st=str(result.invocation_status)
            if st in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero",
                      "ClientNotRunning","InstanceNotRunning"):
                raw=result.output or ""
                try:raw=base64.b64decode(raw,validate=True).decode("utf8","replace")
                except Exception:pass
                print("NAV_DEPLOY_STATUS",st,"EXIT",result.exit_code)
                print("NAV_DEPLOY_TAIL",raw[-4000:])
                return 0 if st=="Success" and int(result.exit_code)==0 else 5
        print("NAV_DEPLOY_TIMEOUT_UNCONFIRMED")
        return 6
    except Exception as exc:
        print("NAV_DEPLOY_ERROR_CLASS",type(exc).__name__)
        print("NAV_DEPLOY_CLOUD_CODE",str(getattr(exc,"code","unknown"))[:80])
        return 7
if __name__=="__main__":
    sys.exit(main())

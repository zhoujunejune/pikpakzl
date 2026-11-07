#!/usr/bin/env python3
"""Install static historical simulation dashboard without touching trading binaries."""
import base64,os,re,sys,time
REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
PANEL_BRANCH="feature/zl-futures-bot-v1"
# Validated public research snapshot, NO API keys, no real orders.
REPORT_SHA="13b00d72a3307d3f02d9768386b165b3454060aa"
def main():
    sha=os.getenv("GITHUB_SHA","")
    if os.getenv("GITHUB_REF_NAME")!=PANEL_BRANCH or not re.fullmatch("[a-f0-9]{40}",sha):
        print("RESEARCH_DEPLOY_INVALID_BRANCH_OR_SHA");return 2
    kid=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
    sec=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
    if not kid or not sec:
        print("RESEARCH_DEPLOY_NO_ALIBABA_PERMISSION");return 3
    from alibabacloud_swas_open20200601.client import Client
    from alibabacloud_swas_open20200601 import models as sw
    from alibabacloud_tea_openapi import models as api
    client=Client(api.Config(access_key_id=kid,access_key_secret=sec,
        region_id=REGION,endpoint="swas.ap-southeast-1.aliyuncs.com"))
    cmd=f"""#!/bin/bash
set -Eeuo pipefail
TEMP=$(mktemp)
trap 'rm -f "$TEMP"' EXIT
curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/zhoujunejune/pikpakzl/{sha}/futures-research-panel/install_aliyun.sh -o "$TEMP"
export PANEL_SHA={sha}
export REPORT_SHA={REPORT_SHA}
bash "$TEMP"
"""
    try:
        r=client.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
          name="zl-static-research-readonly-panel",type="RunShellScript",
          command_content=cmd,working_user="root",timeout=160))
        iv=r.body.invoke_id
        if not iv:print("RESEARCH_DEPLOY_NOT_ACCEPTED");return 4
        for _ in range(44):
            time.sleep(3)
            rr=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
                region_id=REGION,instance_id=INSTANCE,invoke_id=iv)).body.invocation_result
            if rr is None:continue
            state=str(rr.invocation_status)
            if state in ("Success","Failed","Aborted","ExecutionTimeout",
                         "InstanceNotRunning","ClientNotRunning","ExitCodeNonzero"):
                data=rr.output or ""
                try:data=base64.b64decode(data,validate=True).decode("utf8","replace")
                except Exception:pass
                print("RESEARCH_DEPLOY_STATUS",state,"EXIT",rr.exit_code)
                print("RESEARCH_DEPLOY_LOG_TAIL",data[-5000:])
                return 0 if state=="Success" and int(rr.exit_code)==0 else 5
        print("RESEARCH_DEPLOY_UNCONFIRMED");return 6
    except Exception as e:
        print("RESEARCH_DEPLOY_ERROR_CLASS",type(e).__name__)
        print("RESEARCH_DEPLOY_API_CODE",str(getattr(e,"code","unknown"))[:80])
        return 7
if __name__=="__main__":sys.exit(main())

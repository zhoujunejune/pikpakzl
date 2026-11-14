#!/usr/bin/env python3
"""Deploy the shared exchange API UI via Alibaba SWAS Cloud Assistant."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as om
SHA=os.getenv("GITHUB_SHA","")
REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
PREDICTION_SHA="ae1fba706d30a913f9f07d88c2f4d0ea8872b8ff"
def main():
    if os.getenv("GITHUB_REF_NAME")!="feature/zl-futures-bot-v1" or not re.fullmatch("[a-f0-9]{40}",SHA):
        print("API_MANAGER_INVALID_BRANCH");return 2
    k=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
    v=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
    if not k or not v:print("API_MANAGER_ALI_CREDENTIALS_UNAVAILABLE");return 3
    cl=Client(om.Config(access_key_id=k,access_key_secret=v,
        region_id=REGION,endpoint="swas.ap-southeast-1.aliyuncs.com"))
    cmd="""#!/bin/bash
set -Eeuo pipefail
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsSL --retry 3 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/MANAGER_REV/exchange-api-manager/install_aliyun.sh" -o "$TMP"
bash -n "$TMP"
export MANAGER_SHA=MANAGER_REV
export PREDICTION_SHA=PREDICTION_REV
bash "$TMP"
""".replace("MANAGER_REV",SHA).replace("PREDICTION_REV",PREDICTION_SHA)
    try:
        inv=cl.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
          name="zl-exchange-apis-shared-console",type="RunShellScript",
          command_content=cmd,working_user="root",timeout=800))
        if not inv.body.invoke_id:return 4
        for _ in range(150):
            time.sleep(4)
            resp=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(
               region_id=REGION,instance_id=INSTANCE,invoke_id=inv.body.invoke_id)).body.invocation_result
            if not resp:continue
            if str(resp.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
                raw=resp.output or ""
                try:raw=base64.b64decode(raw,validate=True).decode("utf-8","replace")
                except:pass
                print("API_MANAGER_DEPLOY_STATUS",resp.invocation_status)
                print("API_MANAGER_DEPLOY_EXIT",resp.exit_code)
                print("API_MANAGER_DEPLOY_LOG",raw[-2600:])
                return 0 if str(resp.invocation_status)=="Success" and int(resp.exit_code)==0 else 5
        print("API_MANAGER_DEPLOY_NO_RESULT");return 6
    except Exception as e:
        print("API_MANAGER_DEPLOY_ERROR",type(e).__name__);return 7
if __name__=="__main__":sys.exit(main())

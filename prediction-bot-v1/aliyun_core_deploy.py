#!/usr/bin/env python3
"""Install source from existing migration branch as dedicated on-host services.

No exchange credentials, no order writes, no change to the futures backend.
"""
import os, re, sys, time, base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as openapi

REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
BRANCH="feature/zl-futures-bot-v1"

def main():
    sha=os.getenv("GITHUB_SHA","")
    if os.getenv("GITHUB_REF_NAME")!=BRANCH or not re.fullmatch("[a-f0-9]{40}",sha):
        print("CORE_DEPLOY_BLOCKED: wrong branch or revision")
        return 2
    key=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
    secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
    if not key or not secret:
        print("CORE_DEPLOY_BLOCKED: no AliCloud config")
        return 3
    client=Client(openapi.Config(access_key_id=key,access_key_secret=secret,
        region_id=REGION,endpoint="swas.ap-southeast-1.aliyuncs.com"))
    command='''#!/bin/bash
set -Eeuo pipefail
FILE=$(mktemp)
trap 'rm -f "$FILE"' EXIT
curl --fail --silent --show-error --location --retry 3 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/install_original_core.sh" --output "$FILE"
test -s "$FILE"
bash -n "$FILE"
bash "$FILE"
'''.replace("COMMIT_SHA",sha)
    try:
        check=client.list_instances(sw.ListInstancesRequest(region_id=REGION,page_size=100))
        target=[x for x in check.body.instances or [] if getattr(x,"instance_id","")==INSTANCE]
        if len(target)!=1 or target[0].status!="Running":
            print("CORE_DEPLOY_BLOCKED: instance missing")
            return 4
        invoked=client.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
            name="zl-prediction-original-core-stage",type="RunShellScript",
            command_content=command,working_user="root",timeout=1000))
        if not invoked.body.invoke_id:
            return 5
        for _ in range(185):
            time.sleep(5)
            s=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
                region_id=REGION,instance_id=INSTANCE,invoke_id=invoked.body.invoke_id)).body.invocation_result
            if not s: continue
            if str(s.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout",
                    "ClientNotRunning","ExitCodeNonzero"):
                raw=s.output or ""
                try: raw=base64.b64decode(raw,validate=True).decode("utf8","replace")
                except Exception:pass
                print("CORE_DEPLOY_STATUS",s.invocation_status)
                print("CORE_DEPLOY_EXIT",s.exit_code)
                # The installer never prints secret values.
                print("CORE_DEPLOY_OUTPUT_TAIL",raw[-3500:])
                return 0 if str(s.invocation_status)=="Success" and int(s.exit_code)==0 else 6
        print("CORE_DEPLOY_NO_FINAL_RESULT")
        return 7
    except Exception as error:
        print("CORE_DEPLOY_API_ERROR",type(error).__name__)
        return 8
if __name__=="__main__":sys.exit(main())

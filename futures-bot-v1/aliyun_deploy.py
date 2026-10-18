#!/usr/bin/env python3
"""Deploy paper-only futures bot through Alibaba SWAS RunCommand.
Uses hardcoded target and audited command template; GH secrets never leave the
runner. Source is checked out at this workflow run's immutable commit SHA.
"""
import base64
import os
import re
import sys
import time

REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
REPO="https://github.com/zhoujunejune/pikpakzl.git"
BRANCH="feature/zl-futures-bot-v1"

def main():
    sha=os.getenv("GITHUB_SHA","").lower()
    if not re.fullmatch(r"[a-f0-9]{40}",sha):
        print("DEPLOY_ERROR: invalid commit SHA")
        return 10
    if os.getenv("GITHUB_REF_NAME")!=BRANCH:
        print("DEPLOY_ERROR: unexpected branch")
        return 11
    key=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
    secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
    if not key or not secret:
        print("DEPLOY_ERROR: GitHub secrets missing")
        return 12
    from alibabacloud_swas_open20200601.client import Client
    from alibabacloud_swas_open20200601 import models as m
    from alibabacloud_tea_openapi import models as om
    client=Client(om.Config(access_key_id=key,access_key_secret=secret,
        endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
    # Never take an instance ID or executable shell command from untrusted input.
    cmd=f"""#!/bin/bash
set -Eeuo pipefail
ROOT=/opt/zl-futures-bot
mkdir -p "$ROOT"
if [ -d "$ROOT/src/.git" ]; then
  git -C "$ROOT/src" fetch --depth=1 origin {BRANCH}
else
  git clone --depth 1 --branch {BRANCH} {REPO} "$ROOT/src"
fi
git -C "$ROOT/src" checkout --force --detach {sha}
test "$(git -C "$ROOT/src" rev-parse HEAD)" = "{sha}"
cd "$ROOT/src"
bash futures-bot-v1/install_aliyun.sh
"""
    try:
        print("DEPLOY_TARGET_ID:",INSTANCE)
        print("DEPLOY_COMMIT:",sha)
        print("DEPLOY_MODE: paper only; no Binance credentials")
        r=client.run_command(m.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
            name="zl-futures-v1-paper-install",type="RunShellScript",
            command_content=cmd,working_user="root",timeout=1000))
        invoke_id=r.body.invoke_id
        if not invoke_id:
            print("DEPLOY_ERROR: no invocation ID")
            return 13
        print("DEPLOY: Cloud Assistant accepted installation")
        for attempt in range(160):
            time.sleep(5)
            result=client.describe_invocation_result(m.DescribeInvocationResultRequest(
                region_id=REGION,instance_id=INSTANCE,invoke_id=invoke_id))
            inv=result.body.invocation_result
            if not inv:
                continue
            status=str(inv.invocation_status)
            if status in ("Success","Failed","Aborted","Invalid","ExecutionTimeout","ClientNotRunning",
                           "InstanceNotRunning","CommandNotApplicable","ExitCodeNonzero"):
                raw=inv.output or ""
                # SWAS SDK sometimes returns base64 text, despite docs describing plaintext.
                try:
                    if re.fullmatch(r"[A-Za-z0-9+/=\s]+",raw) and len(raw.strip())%4==0:
                        decoded=base64.b64decode(raw,validate=True).decode("utf-8","replace")
                        raw=decoded
                except Exception:
                    pass
                print("DEPLOY_STATUS:",status)
                print("DEPLOY_EXIT_CODE:",inv.exit_code)
                # Only static installer messages; no credentials are used on VM.
                print("DEPLOY_LOG_TAIL:",raw[-4500:])
                return 0 if status=="Success" and int(inv.exit_code)==0 else 14
        print("DEPLOY_NOT_CONFIRMED: exceeded poll window; check Cloud Assistant results")
        return 15
    except Exception as e:
        # Never print opaque error messages containing request bodies or authorization.
        print("DEPLOY_API_ERROR_TYPE:",type(e).__name__)
        print("DEPLOY_API_ERROR_CODE:",str(getattr(e,"code","unknown"))[:70])
        return 16

if __name__=="__main__":
    sys.exit(main())

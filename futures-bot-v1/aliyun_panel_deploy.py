#!/usr/bin/env python3
"""Free HTTPS phone console deploy. GitHub secret password hashed on runner."""
import base64
import ipaddress
import os
import re
import shlex
import socket
import sys
import time

REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
BRANCH="feature/zl-futures-bot-v1"

def main():
    pwd=os.getenv("ZL_PANEL_PASSWORD","")
    if len(pwd)<16 or len(pwd)>128 or any(x in pwd for x in "\r\n\x00"):
        print("PANEL_ERROR: provide unique 16-128 character ZL_PANEL_PASSWORD GitHub Actions secret")
        return 2
    key=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
    secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
    if not key or not secret:
        print("PANEL_ERROR: missing Alibaba credentials")
        return 3
    sha=os.getenv("GITHUB_SHA","")
    if os.getenv("GITHUB_REF_NAME")!=BRANCH or not re.fullmatch(r"[a-f0-9]{40}",sha):
        print("PANEL_ERROR: wrong branch/ref")
        return 4
    import bcrypt
    from alibabacloud_swas_open20200601.client import Client
    from alibabacloud_swas_open20200601 import models as m
    from alibabacloud_tea_openapi import models as om
    client=Client(om.Config(access_key_id=key,access_key_secret=secret,
        endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
    try:
        info=client.list_instances(m.ListInstancesRequest(region_id=REGION,page_size=100))
        matches=[x for x in info.body.instances or [] if getattr(x,"instance_id","")==INSTANCE]
        if len(matches)!=1 or matches[0].status!="Running":
            print("PANEL_ERROR: target not uniquely identified/running")
            return 5
        address=getattr(matches[0],"public_ip_address","")
        ip=ipaddress.ip_address(address)
        if ip.version!=4 or not ip.is_global:
            print("PANEL_ERROR: no valid public IPv4")
            return 6
        domain=str(ip).replace(".","-")+".sslip.io"
        if socket.gethostbyname(domain)!=str(ip):
            print("PANEL_ERROR: HTTPS hostname DNS does not point to instance")
            return 7
        pwd_hash=bcrypt.hashpw(pwd.encode("utf-8"),bcrypt.gensalt(rounds=12)).decode("ascii")
        # Cloud Assistant command contains a salted bcrypt hash, never plaintext password.
        cmd=f"""#!/bin/bash
set -Eeuo pipefail
ROOT=/opt/zl-futures-bot
git -C "$ROOT/src" fetch --depth=1 origin {BRANCH}
git -C "$ROOT/src" checkout --force --detach {sha}
test "$(git -C "$ROOT/src" rev-parse HEAD)" = "{sha}"
cd "$ROOT/src"
export PANEL_DOMAIN={shlex.quote(domain)}
export PANEL_EXPECTED_IP={shlex.quote(str(ip))}
export PANEL_BCRYPT_HASH={shlex.quote(pwd_hash)}
bash futures-bot-v1/install_public_panel.sh
unset PANEL_BCRYPT_HASH
"""
        print("PANEL_HOST:",domain)
        print("PANEL_MODE: password-protected HTTPS, paper only")
        r=client.run_command(m.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
           name="zl-futures-https-panel-install",type="RunShellScript",
           command_content=cmd,working_user="root",timeout=1000))
        invoke=r.body.invoke_id
        if not invoke:
            print("PANEL_ERROR: missing invocation")
            return 8
        for _ in range(150):
            time.sleep(5)
            res=client.describe_invocation_result(m.DescribeInvocationResultRequest(
                region_id=REGION,instance_id=INSTANCE,invoke_id=invoke))
            result=res.body.invocation_result
            if not result:continue
            if str(result.invocation_status) in ("Success","Failed","Aborted","Invalid","ExecutionTimeout","ClientNotRunning","InstanceNotRunning","CommandNotApplicable","ExitCodeNonzero"):
                raw=result.output or ""
                try:raw=base64.b64decode(raw,validate=True).decode("utf-8","replace")
                except Exception:pass
                raw=raw.replace(pwd_hash,"[HASH_REDACTED]")
                print("PANEL_EXECUTION:",result.invocation_status)
                print("PANEL_EXIT:",result.exit_code)
                print("PANEL_LOG_TAIL:",raw[-1500:])
                return 0 if str(result.invocation_status)=="Success" and int(result.exit_code)==0 else 9
        print("PANEL_ERROR: timed out waiting for result")
        return 10
    except Exception as exc:
        print("PANEL_ERROR_TYPE:",type(exc).__name__)
        print("PANEL_API_ERROR_CODE:",str(getattr(exc,"code","unknown"))[:80])
        return 11

if __name__=="__main__":
    sys.exit(main())

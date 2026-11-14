#!/usr/bin/env python3
"""Cloud Assistant installer for live 30s current-round feature repair."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as om

def main():
 sha=os.environ.get("GITHUB_SHA","")
 if os.environ.get("GITHUB_REF_NAME")!="feature/zl-futures-bot-v1" or not re.fullmatch("[0-9a-f]{40}",sha):
  print("CURRENT_REPAIR_BAD_GITHUB_SOURCE");return 2
 key=os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID")
 secret=os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
 if not key or not secret:print("CURRENT_REPAIR_MISSING_AUTH");return 3
 cl=Client(om.Config(access_key_id=key,access_key_secret=secret,region_id="ap-southeast-1",endpoint="swas.ap-southeast-1.aliyuncs.com"))
 cmd=r"""#!/bin/bash
set -Eeuo pipefail
tmp=$(mktemp /tmp/zl-current30.XXXXXXXX.py)
trap 'rm -f "$tmp"' EXIT
curl -fsSL --retry 3 --max-time 35 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/DEPLOY_SHA/prediction-bot-v1/aliyun_selective30_current_round_repair.py" -o "$tmp"
python3 -m py_compile "$tmp"
python3 "$tmp"
""".replace("DEPLOY_SHA",sha)
 req=sw.RunCommandRequest(region_id="ap-southeast-1",instance_id="b67374069bb3457ba6a3a2ede9305d3f",name="zl-prediction-selective30-current-facts-fix",type="RunShellScript",command_content=cmd,working_user="root",timeout=420)
 try:
  run=cl.run_command(req)
  for _ in range(130):
   time.sleep(3)
   result=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id="ap-southeast-1",instance_id="b67374069bb3457ba6a3a2ede9305d3f",invoke_id=run.body.invoke_id)).body.invocation_result
   if result and str(result.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
    raw=result.output or ""
    try:raw=base64.b64decode(raw,validate=True).decode("utf-8","replace")
    except Exception:pass
    print("CURRENT_REPAIR_CLOUD_RESULT",result.invocation_status,"EXIT",result.exit_code)
    print(raw[-11000:])
    return 0 if str(result.invocation_status)=="Success" and int(result.exit_code)==0 else 5
  print("CURRENT_REPAIR_TIMEOUT");return 6
 except Exception as e:
  print("CURRENT_REPAIR_CLOUD_EXCEPTION",type(e).__name__);return 7
if __name__=="__main__":sys.exit(main())

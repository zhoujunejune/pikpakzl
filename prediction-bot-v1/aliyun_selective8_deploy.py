#!/usr/bin/env python3
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as om
REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
PRED_MODEL_SHA="f295b1624c0af5a4ff1b7b31571d0ca4c7503a2b"
def main():
  repo_sha=os.getenv("GITHUB_SHA","")
  if os.getenv("GITHUB_REF_NAME")!="feature/zl-futures-bot-v1" or not re.fullmatch("[a-f0-9]{40}",repo_sha):
    print("PIN_V2_INVALID_SOURCE");return 2
  key=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID");secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
  if not key or not secret:print("PIN_V2_ALI_SECRETS_UNAVAILABLE");return 3
  cl=Client(om.Config(access_key_id=key,access_key_secret=secret,region_id=REGION,
    endpoint="swas.ap-southeast-1.aliyuncs.com"))
  script="""#!/bin/bash
set -Eeuo pipefail
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsSL --retry 3 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/INSTALL_SHA/prediction-bot-v1/aliyun_selective8_install.sh" -o "$TMP"
bash -n "$TMP"
export PRED_MODEL_SHA=PRED_SHA
bash "$TMP"
""".replace("INSTALL_SHA",repo_sha).replace("PRED_SHA",PRED_MODEL_SHA)
  try:
    result=cl.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
      name="zl-selective-v2-8sec-only-prod",type="RunShellScript",
      command_content=script,working_user="root",timeout=400))
    for _ in range(110):
      time.sleep(3)
      r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,
       instance_id=INSTANCE,invoke_id=result.body.invoke_id)).body.invocation_result
      if not r:continue
      status=str(r.invocation_status)
      if status in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
        raw=r.output or ""
        try:raw=base64.b64decode(raw,validate=True).decode("utf8","replace")
        except Exception:pass
        print("PIN_V2_DEPLOY_STATUS",status)
        print("PIN_V2_DEPLOY_EXIT",r.exit_code)
        print("PIN_V2_DEPLOY_LOG",raw[-6000:])
        return 0 if status=="Success" and int(r.exit_code)==0 else 5
    print("PIN_V2_DEPLOY_TIMEOUT");return 6
  except Exception as e:
    print("PIN_V2_DEPLOY_ERROR",type(e).__name__);return 7
if __name__=="__main__":sys.exit(main())

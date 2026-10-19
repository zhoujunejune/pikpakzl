#!/usr/bin/env python3
"""One-way Alibaba migration of separate prediction and official stats components."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REGION="ap-southeast-1"; INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
PRED_SHA="f624279f17126a4e41e9703a15adf604d9997ceb"
def main():
 sha=os.getenv("GITHUB_SHA","")
 if os.getenv("GITHUB_REF_NAME")!="feature/zl-futures-bot-v1" or not re.fullmatch("[a-f0-9]{40}",sha):return 2
 key=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID");secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
 if not key or not secret:return 3
 cl=Client(api.Config(access_key_id=key,access_key_secret=secret,region_id=REGION,endpoint="swas.ap-southeast-1.aliyuncs.com"))
 script="""#!/bin/bash
set -Eeuo pipefail
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsSL --retry 3 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/INSTALL_SHA/prediction-bot-v1/aliyun_singlehost_install.sh" -o "$TMP"
bash -n "$TMP"
export PRED_MIGRATION_SHA=PRED_SHA
bash "$TMP"
""".replace("INSTALL_SHA",sha).replace("PRED_SHA",PRED_SHA)
 try:
  invoked=cl.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name="zl-prediction-singlehost",
   type="RunShellScript",command_content=script,working_user="root",timeout=900))
  iid=invoked.body.invoke_id
  for _ in range(225):
   time.sleep(4)
   r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=iid)).body.invocation_result
   if not r:continue
   status=str(r.invocation_status)
   if status in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
    raw=r.output or ""
    try:raw=base64.b64decode(raw,validate=True).decode("utf-8","replace")
    except Exception:pass
    print("SINGLEHOST_DEPLOY_STATUS",status)
    print("SINGLEHOST_DEPLOY_EXIT",r.exit_code)
    print("SINGLEHOST_DEPLOY_LOG",raw[-5700:])
    return 0 if status=="Success" and int(r.exit_code)==0 else 5
  print("SINGLEHOST_TIMEOUT");return 6
 except Exception as e:
  print("SINGLEHOST_ERROR",type(e).__name__);return 7
if __name__=="__main__":sys.exit(main())

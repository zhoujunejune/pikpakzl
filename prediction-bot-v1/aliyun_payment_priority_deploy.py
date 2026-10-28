#!/usr/bin/env python3
"""Deploy only wallet-source changes to the disabled original Prediction trade service.

Use a contextual git patch against the live files, never overwrite whole
production source. Refuse to deploy if local changes conflict with the patch.
"""
import os,sys,subprocess,base64,gzip,time
from pathlib import Path
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as o

REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
BASE="80dae784aad3bca9f3c7b2c8bc34402fd2ec3ca5"
BRANCH="feature/zl-futures-bot-v1"

def main():
 sha=os.environ.get("GITHUB_SHA","")
 if os.environ.get("GITHUB_REF_NAME")!=BRANCH or len(sha)!=40 or any(x not in "0123456789abcdef" for x in sha):
  print("DEPLOY_BLOCKED_WRONG_BRANCH");return 2
 if not os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID") or not os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET"):
  print("DEPLOY_BLOCKED_NO_ALI_CREDENTIALS");return 3
 subprocess.run(["git","fetch","--no-tags","--depth=40","origin",BASE],check=True,stdout=subprocess.DEVNULL)
 files=["railway-diagnostic/index.mjs","railway-diagnostic/wrapper.mjs"]
 patch=subprocess.check_output(["git","diff","--no-ext-diff","--binary",BASE,sha,"--",*files])
 if not patch or b"payment-source-priority" not in patch:
  print("DEPLOY_BLOCKED_PATCH_INCOMPLETE");return 4
 helper=Path("railway-diagnostic/payment-source-priority.mjs").read_bytes()
 patch_b64=base64.b64encode(gzip.compress(patch)).decode()
 helper_b64=base64.b64encode(helper).decode()
 script=(
  "#!/bin/bash\n"
  "set -Eeuo pipefail\n"
  "ROOT=/opt/zl-prediction-live/src/railway-diagnostic\n"
  "test -d \"$ROOT\" && test -f \"$ROOT/index.mjs\" && test -f \"$ROOT/wrapper.mjs\"\n"
  "check_idle(){ python3 - <<'CHECK_IDLE'\n"
  "import json,urllib.request,sys\n"
  "try:\n"
  " r=urllib.request.urlopen('http://127.0.0.1:13005/api/status',timeout=4)\n"
  " d=json.load(r)\n"
  " if d.get('ok') is not True or d.get('enabled') is not False or d.get('pendingAction') is not None:\n"
  "  print('TRADE_ACTIVE_OR_PENDING_ABORTED');sys.exit(9)\n"
  " print('TRADE_IDLE_CONFIRMED')\n"
  "except Exception as e:\n"
  " print('TRADE_STATUS_UNAVAILABLE_ABORTED',type(e).__name__);sys.exit(10)\n"
  "CHECK_IDLE\n"
  "}\n"
  "check_idle\n"
  "TMP=$(mktemp -d /tmp/zl-wallet-priority.XXXXXXXX)\n"
  "changed=0\n"
  "success=0\n"
  "restore(){\n"
  " if [ \"$changed\" = 1 ] && [ \"$success\" = 0 ];then\n"
  "  cp -p \"$TMP/index.mjs\" \"$ROOT/index.mjs\"\n"
  "  cp -p \"$TMP/wrapper.mjs\" \"$ROOT/wrapper.mjs\"\n"
  "  if [ -f \"$TMP/payment-source-priority.mjs\" ];then cp -p \"$TMP/payment-source-priority.mjs\" \"$ROOT/payment-source-priority.mjs\";else rm -f \"$ROOT/payment-source-priority.mjs\";fi\n"
  "  echo PAYMENT_PATCH_ROLLED_BACK\n"
  "  if ! systemctl is-active --quiet zl-prediction-trade;then systemctl restart zl-prediction-trade || true;fi\n"
  " fi\n"
  " rm -rf \"$TMP\"\n"
  "}\n"
  "trap restore EXIT\n"
  "python3 - \"$TMP\" <<'DECODE'\n"
  "import sys,base64,gzip,pathlib\n"
  "dst=pathlib.Path(sys.argv[1])\n"
  "dst.joinpath('change.patch').write_bytes(gzip.decompress(base64.b64decode('"+patch_b64+"')))\n"
  "dst.joinpath('new-helper.mjs').write_bytes(base64.b64decode('"+helper_b64+"'))\n"
  "DECODE\n"
  "cd /opt/zl-prediction-live/src\n"
  "if ! git apply --check \"$TMP/change.patch\";then echo PATCH_CONTEXT_MISMATCH_NO_CHANGES;exit 11;fi\n"
  "cp -p \"$ROOT/index.mjs\" \"$TMP/index.mjs\"\n"
  "cp -p \"$ROOT/wrapper.mjs\" \"$TMP/wrapper.mjs\"\n"
  "if [ -e \"$ROOT/payment-source-priority.mjs\" ];then cp -p \"$ROOT/payment-source-priority.mjs\" \"$TMP/payment-source-priority.mjs\";fi\n"
  "changed=1\n"
  "git apply \"$TMP/change.patch\"\n"
  "install -m 640 \"$TMP/new-helper.mjs\" \"$ROOT/payment-source-priority.mjs\"\n"
  "chown --reference=\"$ROOT/index.mjs\" \"$ROOT/payment-source-priority.mjs\"\n"
  "NODE=/opt/zl-prediction-node/bin/node\n"
  "test -x \"$NODE\"\n"
  "\"$NODE\" --check \"$ROOT/index.mjs\"\n"
  "\"$NODE\" --check \"$ROOT/wrapper.mjs\"\n"
  "\"$NODE\" --check \"$ROOT/payment-source-priority.mjs\"\n"
  "grep -q 'prediction_wallet_insufficient_spot_fallback' \"$ROOT/wrapper.mjs\"\n"
  "grep -q 'return predictionWalletPayment()' \"$ROOT/index.mjs\"\n"
  "check_idle\n"
  "systemctl restart zl-prediction-trade\n"
  "for i in $(seq 1 15);do\n"
  " if systemctl is-active --quiet zl-prediction-trade && curl --silent --fail --max-time 3 http://127.0.0.1:13005/healthz >/dev/null && curl --silent --fail --max-time 3 http://127.0.0.1:13005/api/status >/dev/null;then break;fi\n"
  " sleep 1\n"
  "done\n"
  "systemctl is-active --quiet zl-prediction-trade\n"
  "curl --silent --fail --max-time 4 http://127.0.0.1:13005/healthz >/dev/null\n"
  "check_idle\n"
  "success=1\n"
  "echo PAYMENT_PATCH_DEPLOY_SUCCESS_MPC_THEN_SPOT\n"
 )
 client=Client(o.Config(access_key_id=os.environ["ALIBABA_CLOUD_ACCESS_KEY_ID"],access_key_secret=os.environ["ALIBABA_CLOUD_ACCESS_KEY_SECRET"],endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
 try:
  r=client.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name="zl-prediction-payment-priority-context-patch",type="RunShellScript",command_content=script,working_user="root",timeout=130))
  if not r.body.invoke_id:
   print("DEPLOY_NO_INVOKE_ID");return 5
  for _ in range(65):
   time.sleep(2)
   x=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=r.body.invoke_id)).body.invocation_result
   if x and str(x.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout","ClientNotRunning"):
    raw=x.output or ""
    try: raw=base64.b64decode(raw,validate=True).decode("utf8","replace")
    except Exception:pass
    # Never print secrets or full file contents.
    clean=[line[:180] for line in raw.splitlines() if any(k in line for k in ("TRADE_","PATCH_","PAYMENT_","error:","Error","fatal:"))]
    print("DEPLOY_STATUS",x.invocation_status,"EXIT",x.exit_code)
    print("\n".join(clean[-35:]))
    return 0 if str(x.invocation_status)=="Success" and int(x.exit_code)==0 and "PAYMENT_PATCH_DEPLOY_SUCCESS_MPC_THEN_SPOT" in raw else 6
  print("DEPLOY_RESULT_PENDING");return 7
 except Exception as e:
  print("DEPLOY_SDK_ERROR",type(e).__name__,str(getattr(e,"code","unknown"))[:80]);return 8
if __name__=="__main__":sys.exit(main())

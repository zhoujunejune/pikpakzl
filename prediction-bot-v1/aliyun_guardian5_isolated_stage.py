#!/usr/bin/env python3
"""Install GUARDIAN candidate in a separate inert directory on Alibaba; never touch production."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
NODE=/opt/zl-prediction-node/bin/node
BASE=/opt/zl-prediction-live/src/railway-diagnostic
ROOT=/opt/zl-guardian5-stage
REV=__TARGET_SHA__
CUT=$(printf '%s' "$REV" | cut -c1-12)
DEST="$ROOT/pr225-$CUT"
BEFORE_TRADE=$(systemctl show zl-prediction-trade -p MainPID --value)
BEFORE_RISK=$(systemctl show zl-prediction-risk-exits -p MainPID --value)
BEFORE_GUARDIAN=$(systemctl show zl-prediction-guardian-analysis -p MainPID --value)
test -x "$NODE" && test -d "$BASE"
mkdir -p -m 0750 "$ROOT"
STAGE=$(mktemp -d "$ROOT/.candidate.XXXXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/railway-diagnostic" "$STAGE/prediction-bot-v1"
for f in \
  railway-diagnostic/guardian-live-bridge.mjs \
  railway-diagnostic/guardian-dynamic-exit.mjs \
  railway-diagnostic/guardian-risk-integration.mjs \
  railway-diagnostic/guardian-live-bridge.test.mjs \
  railway-diagnostic/guardian-risk-integration.test.mjs \
  railway-diagnostic/guardian-live-risk-readiness.test.mjs \
  railway-diagnostic/risk-config-storage.mjs \
  railway-diagnostic/risk-runner.mjs \
  railway-diagnostic/risk-worker.mjs \
  railway-diagnostic/control-shell.mjs \
  railway-diagnostic/wrapper.mjs \
  railway-diagnostic/index.mjs \
  railway-diagnostic/guardian-main-dashboard.mjs \
  prediction-bot-v1/guardian5-live-bridge.mjs;do
  curl -fsSL --retry 2 --max-time 22 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$REV/$f" -o "$STAGE/$f"
  "$NODE" --check "$STAGE/$f"
done
(cd "$STAGE" && "$NODE" --test \
 railway-diagnostic/guardian-live-bridge.test.mjs \
 railway-diagnostic/guardian-risk-integration.test.mjs \
 railway-diagnostic/guardian-live-risk-readiness.test.mjs)
# No trade service started; all tests have local fixtures and temp files.
if test ! -d "$DEST";then
  mv "$STAGE" "$DEST"
  trap - EXIT
fi
python3 - "$DEST" "$REV" <<'PY'
import json,sys
from pathlib import Path
out=Path(sys.argv[1])/'manifest.json'
out.write_text(json.dumps({'revision':sys.argv[2],'mode':'INERT_STAGE_ONLY',
'orderSubmission':False,'productionReplaced':False,'servicesRestarted':False},
sort_keys=True,indent=2))
PY
chmod -R go-w "$DEST"
test "$BEFORE_TRADE" = "$(systemctl show zl-prediction-trade -p MainPID --value)"
test "$BEFORE_RISK" = "$(systemctl show zl-prediction-risk-exits -p MainPID --value)"
test "$BEFORE_GUARDIAN" = "$(systemctl show zl-prediction-guardian-analysis -p MainPID --value)"
for s in zl-prediction-trade zl-prediction-risk-exits zl-prediction-guardian-analysis;do
 systemctl is-active --quiet "$s"
done
echo "GUARDIAN5_ISOLATED_STAGE_SUCCESS=true"
echo "GUARDIAN5_STAGE_REVISION=$REV"
echo "GUARDIAN5_STAGE_PATH=$DEST"
echo "GUARDIAN5_PRODUCTION_UNCHANGED=true"
echo "GUARDIAN5_PRODUCTION_PIDS_UNCHANGED=true"
echo "GUARDIAN5_NO_REAL_ORDERS_SUBMITTED=true"
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME') not in ('fix/guardian5-live-execution-20261029','feature/zl-futures-bot-v1') or not re.fullmatch('[0-9a-f]{40}',sha):
  print('GUARDIAN_STAGE_BAD_REVISION');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 call=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
 instance_id='b67374069bb3457ba6a3a2ede9305d3f',type='RunShellScript',
 name='guardian5-inert-isolated-stage',command_content=SCRIPT.replace('__TARGET_SHA__',sha),
 working_user='root',timeout=180)).body.invoke_id
 for _ in range(90):
  time.sleep(2)
  d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=call)).body.invocation_result
  if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
   except Exception:out='OUTPUT_UNAVAILABLE'
   print('GUARDIAN5_STAGE_STATUS',d.invocation_status,d.exit_code)
   print(out[-10000:])
   return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'GUARDIAN5_ISOLATED_STAGE_SUCCESS=true' in out else 5
 print('GUARDIAN5_STAGE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

#!/usr/bin/env python3
"""Stage *inert* GUARDIAN adaptive-shadow files on existing Alibaba SWAS.
No trade controls, credentials, risk worker, service units, or live SELL behavior are changed.
"""
import os
import sys
import re
import time
import base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
SHA=__TARGET_SHA__
BASE=/opt/zl-prediction-live/src/railway-diagnostic
NODE=/opt/zl-prediction-node/bin/node
ROOT="$BASE/guardian-adaptive-shadow-v2"
RELEASE="$ROOT/releases/$SHA"
STAGE=$(mktemp -d /tmp/guardian-adaptive-XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
test -d "$BASE"
test -x "$NODE"
exec 9>/tmp/guardian-adaptive-shadow-stage.lock
flock -n 9
for f in guardian-adaptive-exit-v2.mjs guardian-adaptive-exit-v2.test.mjs guardian-adaptive-replay-v2.mjs;do
 curl -fsSL --retry 2 --max-time 25 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$SHA/railway-diagnostic/$f" \
  -o "$STAGE/$f"
 "$NODE" --check "$STAGE/$f"
done
"$NODE" --test "$STAGE/guardian-adaptive-exit-v2.test.mjs"
printf '[]' > "$STAGE/empty-evidence.json"
"$NODE" "$STAGE/guardian-adaptive-replay-v2.mjs" "$STAGE/empty-evidence.json" > "$STAGE/report.json"
python3 - "$STAGE/report.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d['ok'] and d['validPositions']==0
assert d['performanceValidated'] is False and d['netTradingProfit'] is None
print('GUARDIAN_ADAPTIVE_NO_FAKE_NET_PROFIT=true')
PY
before_trade=$(systemctl show zl-prediction-trade -p MainPID --value)
before_risk=$(systemctl show zl-prediction-risk-exits -p MainPID --value)
test "$before_trade" -gt 0
test "$before_risk" -gt 0
mkdir -p -m 0750 "$ROOT/releases"
test ! -L "$ROOT"
test ! -L "$ROOT/releases"
if test -d "$RELEASE";then
 for f in guardian-adaptive-exit-v2.mjs guardian-adaptive-exit-v2.test.mjs guardian-adaptive-replay-v2.mjs;do
  cmp "$RELEASE/$f" "$STAGE/$f"
 done
else
 tmpdir=$(mktemp -d "$ROOT/releases/.staging-XXXXXXXX")
 for f in guardian-adaptive-exit-v2.mjs guardian-adaptive-exit-v2.test.mjs guardian-adaptive-replay-v2.mjs;do
  install -m 0644 "$STAGE/$f" "$tmpdir/$f"
 done
 mv "$tmpdir" "$RELEASE"
fi
test "$(systemctl show zl-prediction-trade -p MainPID --value)" = "$before_trade"
test "$(systemctl show zl-prediction-risk-exits -p MainPID --value)" = "$before_risk"
python3 - <<'PY'
import pathlib,json
base=pathlib.Path('/var/lib/zl-prediction/guardian5')
registered=base/'guardian-live-orders.json'
if not registered.is_file():
 print('GUARDIAN_ADAPTIVE_REGISTERED_ORDER_EVIDENCE=NONE')
else:
 try:
  raw=json.loads(registered.read_text())
  rows=raw.get('entries',[])
  print('GUARDIAN_ADAPTIVE_REGISTERED_ORDER_COUNT',len(rows))
  print('GUARDIAN_ADAPTIVE_ACCEPTED_ORDER_COUNT',sum(r.get('status')=='SUBMITTED' for r in rows))
 except Exception:
  print('GUARDIAN_ADAPTIVE_REGISTERED_ORDER_EVIDENCE=UNREADABLE')
quote=base/'guardian-executable-sell-quotes.json'
print('GUARDIAN_ADAPTIVE_HISTORICAL_SELL_QUOTES',
 'FOUND' if quote.is_file() else 'NOT_COLLECTED')
PY
echo GUARDIAN_ADAPTIVE_V2_SHADOW_STAGED=true
echo GUARDIAN_ADAPTIVE_V2_LIVE_SELL_UNCHANGED=true
echo GUARDIAN_ADAPTIVE_V2_NO_SERVICE_RESTART=true
echo GUARDIAN_ADAPTIVE_V2_RELEASE="$RELEASE"
sha256sum "$RELEASE"/guardian-adaptive-*.mjs
"""

def main():
    sha=os.getenv('GITHUB_SHA','')
    if os.getenv('GITHUB_REF_NAME')!='feature/guardian-adaptive-v2-shadow' or not re.fullmatch(r'[0-9a-f]{40}',sha):
        print('GUARDIAN_ADAPTIVE_BAD_REVISION')
        return 2
    client=Client(api.Config(
        access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
        access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
        endpoint='swas.ap-southeast-1.aliyuncs.com',
        region_id='ap-southeast-1'))
    request=sw.RunCommandRequest(
        region_id='ap-southeast-1',
        instance_id='b67374069bb3457ba6a3a2ede9305d3f',
        name='guardian-adaptive-shadow-code-stage',
        type='RunShellScript',
        command_content=SCRIPT.replace('__TARGET_SHA__',sha),
        working_user='root',
        timeout=180)
    invocation=client.run_command(request).body.invoke_id
    for _ in range(95):
        time.sleep(2)
        result=client.describe_invocation_result(
            sw.DescribeInvocationResultRequest(
                region_id='ap-southeast-1',
                instance_id='b67374069bb3457ba6a3a2ede9305d3f',
                invoke_id=invocation)).body.invocation_result
        if result and str(result.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
            try:
                output=base64.b64decode(result.output or '',validate=True).decode('utf8','replace')
            except Exception:
                output=str(result.output or '')
            print('GUARDIAN_ADAPTIVE_REMOTE',result.invocation_status,'EXIT',result.exit_code)
            print(output[-13000:])
            return 0 if str(result.invocation_status)=='Success' and int(result.exit_code)==0 and 'GUARDIAN_ADAPTIVE_V2_SHADOW_STAGED=true' in output else 5
    print('GUARDIAN_ADAPTIVE_STAGE_TIMEOUT')
    return 6

if __name__=='__main__':
    sys.exit(main())

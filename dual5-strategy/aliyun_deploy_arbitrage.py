#!/usr/bin/env python3
"""Deploy independent dual5 arbitrage edge-gate to SWAS. Never touches fast5 or single prediction files."""
from pathlib import Path
import os,base64,gzip,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REGION='ap-southeast-1'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
PATCH=Path(__file__).with_name('patch_arbitrage.py')

def main():
    if not PATCH.is_file():
        print('MISSING_DUAL_PATCH');return 2
    if not os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID') or not os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET'):
        print('MISSING_ALI_CREDENTIALS');return 3
    encoded=base64.b64encode(gzip.compress(PATCH.read_bytes())).decode()
    script=r"""#!/bin/bash
set -Eeuo pipefail
ROOT=/opt/zl-prediction-dual5
TARGET="$ROOT/binance_dual5_pairs.mjs"
test -f "$TARGET"
systemctl is-active --quiet zl-prediction-dual5
pre_single_pid=$(systemctl show zl-prediction-fast5.service -p MainPID --value)
pre_original_pid=$(systemctl show zl-prediction-trade.service -p MainPID --value)
DUAL_PORT=$(python3 - <<'FIND_DUAL_PORT'
import json,urllib.request
for port in (13048,13046,13045,13044,13042,13021,13020,13005):
 try:
  with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/status',timeout=2) as r: d=json.load(r)
  if d.get('ok') is True and d.get('model')=='BINANCE_DUAL5_PAIR_V1':
   print(port)
   break
 except Exception: pass
FIND_DUAL_PORT
)
if ! [[ "$DUAL_PORT" =~ ^13[0-9]{3}$ ]];then echo DUAL_PORT_NOT_FOUND_ABORTED;exit 11;fi
export DUAL_PORT
python3 - <<'PRECHECK'
import urllib.request,json,os
with urllib.request.urlopen('http://127.0.0.1:'+os.environ['DUAL_PORT']+'/api/status',timeout=5) as r:
 d=json.load(r)
assert d.get('ok') is True and d.get('model')=='BINANCE_DUAL5_PAIR_V1', 'WRONG_DUAL_STATUS'
assert d.get('active') is False and d.get('mode')=='PRODUCTION_IDLE', 'DUAL_LIVE_ACTIVE_ABORT'
assert not any(v.get('status')=='ORDER_PENDING' for v in (d.get('legs') or {}).values()), 'UNKNOWN_PENDING_ORDER_ABORT'
print('DUAL_OWNER_OFF_AND_NO_PENDING_CONFIRMED')
print('DUAL_PORT',os.environ['DUAL_PORT'])
print('DUAL_EXISTING_PROTECTION_LOCK',bool(d.get('blocked')))
PRECHECK
mkdir -p -m 700 "$ROOT/backups"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$ROOT/backups/binance_dual5_pairs.mjs.before-arb-v2.$stamp"
cp -p "$TARGET" "$backup"
tmp=$(mktemp -d /tmp/zl-dual-arb-v2.XXXXXXXX)
changed=0
committed=0
cleanup(){
  if [ "$changed" = 1 ] && [ "$committed" = 0 ]; then
    cp -p "$backup" "$TARGET"
    systemctl restart zl-prediction-dual5 || true
    echo "DUAL_ONLY_ROLLBACK_APPLIED"
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
python3 - "$tmp" <<'DECODE'
import base64,gzip,pathlib,sys
pathlib.Path(sys.argv[1],'patch.py').write_bytes(gzip.decompress(base64.b64decode('REPLACEME_B64')))
DECODE
python3 "$tmp/patch.py" "$TARGET" --dry-run
NODE=/opt/zl-prediction-node/bin/node
if [ ! -x "$NODE" ];then NODE=$(command -v node);fi
"$NODE" --check "$TARGET"
changed=1
python3 "$tmp/patch.py" "$TARGET"
"$NODE" --check "$TARGET"
systemctl restart zl-prediction-dual5.service
for _ in $(seq 1 15); do
  if systemctl is-active --quiet zl-prediction-dual5 && curl -sf --max-time 3 http://127.0.0.1:$DUAL_PORT/healthz >/dev/null;then break;fi
  sleep 1
done
systemctl is-active --quiet zl-prediction-dual5
python3 - <<'VERIFY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:'+__import__('os').environ['DUAL_PORT']+'/api/status',timeout=5) as r:d=json.load(r)
assert d.get('ok') is True and d.get('model')=='BINANCE_DUAL5_PAIR_V1'
assert d.get('active') is False and d.get('mode')=='PRODUCTION_IDLE','DUAL_AUTO_ARM_UNEXPECTED'
assert not any(v.get('status')=='ORDER_PENDING' for v in (d.get('legs') or {}).values())
print('DUAL_ARB_V2_SERVICE_OK_IDLE',d.get('model'),d.get('mode'))
VERIFY
post_single_pid=$(systemctl show zl-prediction-fast5.service -p MainPID --value)
post_original_pid=$(systemctl show zl-prediction-trade.service -p MainPID --value)
if [ "$pre_single_pid" != "$post_single_pid" ] || [ "$pre_original_pid" != "$post_original_pid" ];then
  echo "SINGLE_SERVICE_PID_CHANGED_EXTERNALLY_CHECK";exit 23
fi
committed=1
echo 'DUAL_ARB_V2_DEPLOYED_SINGLE_UNTOUCHED_REAL_TRADING_OFF'
""".replace('REPLACEME_B64',encoded)
    client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
        access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
        endpoint='swas.ap-southeast-1.aliyuncs.com',region_id=REGION))
    try:
        run=client.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
            name='zl-dual-arbitrage-v2-deploy-only',type='RunShellScript',
            command_content=script,working_user='root',timeout=150))
        for _ in range(70):
            time.sleep(2)
            result=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
                region_id=REGION,instance_id=INSTANCE,invoke_id=run.body.invoke_id)).body.invocation_result
            if result and str(result.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ClientNotRunning'):
                try:out=base64.b64decode(result.output or '',validate=True).decode('utf8','replace')
                except:out='REMOTE_OUTPUT_UNAVAILABLE'
                safe=[x[:190] for x in out.splitlines() if any(k in x for k in ('DUAL_','PATCH_','SINGLE_','Traceback','Error','Failure','Failed','NO_'))]
                print('REMOTE_DEPLOY_RESULT',result.invocation_status,'EXIT',result.exit_code)
                print('\\n'.join(safe[-45:]))
                return 0 if str(result.invocation_status)=='Success' and int(result.exit_code)==0 and 'DUAL_ARB_V2_DEPLOYED_SINGLE_UNTOUCHED_REAL_TRADING_OFF' in out else 4
        print('REMOTE_DEPLOY_PENDING');return 5
    except Exception as e:
        print('DUAL_DEPLOY_SDK_ERROR',type(e).__name__,str(getattr(e,'code','unknown'))[:90]);return 6

if __name__=='__main__':
    sys.exit(main())

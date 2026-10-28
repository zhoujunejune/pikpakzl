#!/usr/bin/env python3
"""Stage guarded GUARDIAN signal/quote adapter on Alibaba. Never enable orders."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
BASE=/opt/zl-prediction-live/src/railway-diagnostic
NODE=/opt/zl-prediction-node/bin/node
SHA=__TARGET_SHA__
OLD=d616a726aea5d9e5f75c2a53db9647d63e617837
STAGE=$(mktemp -d /tmp/guardian-bridge-XXXXXX)
BACK=/var/backups/guardian-bridge-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 700 "$BACK"
restore() {
  echo GUARDIAN_BRIDGE_ROLLBACK_START=true
  for f in index.mjs wrapper.mjs guardian-live-bridge.mjs guardian-dynamic-exit.mjs guardian-risk-integration.mjs;do
    if test -f "$BACK/$f";then cp -p "$BACK/$f" "$BASE/$f";else
      if test -f "$BACK/$f.absent";then rm -f "$BASE/$f";fi
    fi
  done
  systemctl restart zl-prediction-trade >/dev/null 2>&1 || true
  echo GUARDIAN_BRIDGE_ROLLBACK_COMPLETE=true
}
trap 'rm -rf "$STAGE"' EXIT
test -x "$NODE"
systemctl is-active --quiet zl-prediction-trade
systemctl is-active --quiet zl-prediction-risk-exits
systemctl is-active --quiet zl-prediction-guardian-analysis
python3 - <<'PY'
import json,urllib.request
def api(port,path):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=8) as x:return json.load(x)
s=api(13001,'/api/status')
g=api(13049,'/api/status')
assert s.get('ok') is True and s.get('enabled') is False,'LIVE_FOLLOW_MUST_BE_OFF'
assert not s.get('pendingAction'),'PENDING_ORDER_MUST_BE_EMPTY'
assert s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1','GUARDIAN_MUST_BE_ONLY_SIGNAL'
assert g.get('ok') and g.get('model')=='ZL_GUARDIAN_5M_V1'
assert g.get('automaticTradeEligibility',{}).get('eligible') is False,'UNEXPECTED_TRADE_ELIGIBILITY'
print('GUARDIAN_GUARDED_BRIDGE_PREFLIGHT=true')
PY
for f in wrapper.mjs guardian-live-bridge.mjs guardian-dynamic-exit.mjs guardian-risk-integration.mjs;do
 curl -fsSL --retry 2 --max-time 25 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$SHA/railway-diagnostic/$f" \
  -o "$STAGE/$f"
 "$NODE" --check "$STAGE/$f"
done
curl -fsSL --retry 2 --max-time 25 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$OLD/railway-diagnostic/wrapper.mjs" \
 -o "$STAGE/wrapper.before"
if ! cmp -s "$BASE/wrapper.mjs" "$STAGE/wrapper.before";then
 echo GUARDIAN_BRIDGE_WRAPPER_DRIFT_ABORT=true;exit 31
fi
python3 - "$BASE/index.mjs" "$STAGE/index.mjs" <<'PY'
from pathlib import Path
import sys
src=Path(sys.argv[1]).read_text()
assert 'GUARDIAN_PRODUCTION_SINGLE_SOURCE_V1' in src,'CURRENT_GUARDIAN_BLOCK_MISSING'
assert 'GUARDIAN_LIVE_CONNECTOR_V1' not in src,'ALREADY_PATCHED_ABORT'
start=src.index('// GUARDIAN_PRODUCTION_SINGLE_SOURCE_V1')
end=src.index('  if(choice.model!==SELECTIVE8_MODEL)return null;',start)
new='''// GUARDIAN_LIVE_CONNECTOR_V1
  // Model evidence must pass official-feed and forward-performance gates.
  // The trade wrapper also requires a live risk heartbeat + current BUY quote.
  if(choice.model===GUARDIAN_ID){
    try{
      const response=await fetch('http://127.0.0.1:13049/api/status',{
        cache:'no-store',signal:AbortSignal.timeout(1800)});
      if(!response.ok)return null;
      const data=guardianOrderSignal(await response.json());
      if(!data.ok||data.executionEligible!==true)return null;
      return {...data,status:'LOCKED',model:SIGNAL_MODEL_NAME,
        rawDirection:data.direction,transport:'aliyun_guardian5_calibrated'};
    }catch(error){
      console.error(JSON.stringify({event:'guardian_live_connector_error',
        message:String(error?.message||error).slice(0,100)}));return null;
    }
  }
'''
src=src[:start]+new+src[end:]
anchor="import http from 'node:http';"
assert src.count(anchor)==1
src=src.replace(anchor,anchor+"\nimport {GUARDIAN_ID,guardianOrderSignal,guardianQuoteGate,guardianRegisterIntent,guardianMarkSubmitted} from './guardian-live-bridge.mjs';",1)
anchor="  if(choice.model===SELECTIVE8_MODEL&&signal.upstreamModel!==SELECTIVE8_MODEL)return;"
assert src.count(anchor)==1
src=src.replace(anchor,anchor+"\n  if(choice.model===GUARDIAN_ID&&(signal.upstreamModel!==GUARDIAN_ID||signal.executionEligible!==true))return;",1)
Path(sys.argv[2]).write_text(src)
print('GUARDIAN_TRADE_SOURCE_PATCH_READY=true')
PY
"$NODE" --check "$STAGE/index.mjs"
# No code replacement or service restart occurs until all preflight checks pass.
for f in index.mjs wrapper.mjs guardian-live-bridge.mjs guardian-dynamic-exit.mjs guardian-risk-integration.mjs;do
 if test -f "$BASE/$f";then cp -p "$BASE/$f" "$BACK/$f";else touch "$BACK/$f.absent";fi
done
trap restore ERR
for f in index.mjs wrapper.mjs guardian-live-bridge.mjs guardian-dynamic-exit.mjs guardian-risk-integration.mjs;do
 cp "$STAGE/$f" "$BASE/$f"
 chown "$(stat -c %u "$BACK/index.mjs")":"$(stat -c %g "$BACK/index.mjs")" "$BASE/$f"
 chmod 0644 "$BASE/$f"
done
"$NODE" --check "$BASE/index.mjs"
"$NODE" --check "$BASE/wrapper.mjs"
systemctl restart zl-prediction-trade
ready=no
for i in $(seq 1 18);do
 if curl -fsS --max-time 4 http://127.0.0.1:13001/api/status -o "$STAGE/status.json" 2>/dev/null;then
  if python3 - "$STAGE/status.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
assert s.get('ok') and s.get('enabled') is False
assert s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1'
assert not s.get('pendingAction') and s.get('orderSignal') is None
PY
  then ready=yes;break;fi
 fi
 sleep 2
done
test "$ready" = yes
systemctl is-active --quiet zl-prediction-trade
systemctl is-active --quiet zl-prediction-risk-exits
systemctl is-active --quiet zl-prediction-guardian-analysis
echo GUARDIAN_BRIDGE_STAGED_ON_ALIBABA=true
echo GUARDIAN_REAL_TRADING_DISABLED=true
echo GUARDIAN_DYNAMIC_EXIT_NOT_ENABLED=true
echo GUARDIAN_BRIDGE_BACKUP="$BACK"
trap - ERR
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch(r'[0-9a-f]{40}',sha):
  print('GUARDIAN_BAD_REVISION');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 call=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',type='RunShellScript',
  name='guardian-guarded-live-bridge-stage',command_content=SCRIPT.replace('__TARGET_SHA__',sha),
  working_user='root',timeout=200)).body.invoke_id
 for _ in range(98):
  time.sleep(2)
  d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=call)).body.invocation_result
  if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
   except Exception:out=str(d.output or '')
   print('GUARDIAN_BRIDGE_REMOTE',d.invocation_status,'EXIT',d.exit_code)
   print(out[-8500:])
   return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'GUARDIAN_BRIDGE_STAGED_ON_ALIBABA=true' in out else 5
 print('GUARDIAN_BRIDGE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

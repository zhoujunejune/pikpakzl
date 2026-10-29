#!/usr/bin/env python3
"""Guarded, no-trade Alibaba deployment of GUARDIAN 5M repair."""
import os,sys,re,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
REV=__REV__
BASE=1974056b08025a696b23d1e223a46df58081e374
ROOT=/opt/zl-prediction-live/src/railway-diagnostic
REG=/var/lib/zl-prediction/rounds/guardian5/guardian-live-orders.json
NODE=/opt/zl-prediction-node/bin/node
TMP=$(mktemp -d /tmp/g5repair-XXXXXXXX)
BACK=/var/backups/guardian-5m-repair-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 0700 "$BACK"
CHANGED=0; DONE=0
cleanup(){
 if test "$CHANGED" = 1 && test "$DONE" = 0;then
  for f in wrapper.mjs guardian-live-bridge.mjs guardian-risk-integration.mjs;do cp -p "$BACK/$f" "$ROOT/$f" || :;done
  systemctl restart zl-prediction-risk-exits || :
  systemctl restart zl-prediction-trade || :
  echo GUARDIAN_REPAIR_ROLLED_BACK=true
 fi
 rm -rf "$TMP"
}
trap cleanup EXIT
preflight(){
python3 - <<'PY'
import json,urllib.request,pathlib,subprocess
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=4) as r:s=json.load(r)
assert s.get('ok') is True and s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1','NOT_GUARDIAN'
assert s.get('enabled') is False,'FOLLOW_ON_ABORT'
assert s.get('orderSignalModelReady') is True and s.get('directionModeReady') is True,'MODEL_OR_DIRECTION_UNREADY'
for p in (s.get('pendingAction') or {},s.get('lastOrder') or {}):
 assert p.get('state') not in ('READY','QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN'),'UNRECONCILED_ORDER'
root=pathlib.Path('/var/lib/zl-prediction/rounds')
cfg=json.loads((root/'risk-control.json').read_text())
risk=json.loads((root/'risk-runtime-status.json').read_text())
health=json.loads((root/'risk-worker-health.json').read_text())
assert cfg.get('stopLossEnabled') is True,'FIXED_STOP_LOSS_OFF'
assert risk.get('workerRunning') is True and risk.get('configApplied') is True,'RISK_WORKER_UNREADY'
assert health.get('positionsSeen')==0,'OPEN_POSITION_ABORT'
for svc in ('zl-prediction-trade','zl-prediction-risk-exits'):
 p=subprocess.check_output(['systemctl','show','-p','MainPID','--value',svc],text=True).strip()
 if p.isdigit() and int(p)>0:
  for item in (pathlib.Path('/proc')/p/'environ').read_bytes().split(b'\0'):
   if item.startswith(b'GUARDIAN_REGISTRY_FILE='):
    assert item.split(b'=',1)[1].decode()=='/var/lib/zl-prediction/rounds/guardian5/guardian-live-orders.json','REGISTRY_ENV_CONFLICT'
print('GUARDIAN_REPAIR_PREFLIGHT_OK=true',flush=True)
PY
}
for svc in zl-prediction-trade zl-prediction-risk-exits zl-prediction-guardian-analysis;do systemctl is-active --quiet "$svc";done
preflight
for f in wrapper.mjs guardian-live-bridge.mjs guardian-risk-integration.mjs;do
 cp -p "$ROOT/$f" "$BACK/$f"
done
echo GUARDIAN_REPAIR_BACKUP="$BACK"
curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$BASE/railway-diagnostic/wrapper.mjs" -o "$TMP/old.mjs"
curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$REV/railway-diagnostic/wrapper.mjs" -o "$TMP/new.mjs"
python3 - "$TMP/old.mjs" "$TMP/new.mjs" "$ROOT/wrapper.mjs" "$TMP/wrapper.mjs" <<'PY'
import difflib,pathlib,sys
old,new,live,out=map(pathlib.Path,sys.argv[1:])
a=old.read_text().splitlines(keepends=True)
b=new.read_text().splitlines(keepends=True)
live_text=live.read_text()
opcodes=[x for x in difflib.SequenceMatcher(None,a,b,autojunk=False).get_opcodes() if x[0]!='equal']
assert 3<=len(opcodes)<=10,'UNEXPECTED_GUARDIAN_CHANGE_COUNT'
print('GUARDIAN_SELECTIVE_CHANGE_COUNT',len(opcodes),flush=True)
for tag,i1,i2,j1,j2 in opcodes:
 old_part=''.join(a[i1:i2])
 new_part=''.join(b[j1:j2])
 left=''.join(a[max(0,i1-1):i1])
 right=''.join(a[i2:i2+1])
 candidates=[(left+old_part+right,left+new_part+right),(old_part,new_part)]
 applied=False
 for needle,replacement in candidates:
  if needle and live_text.count(needle)==1:
   live_text=live_text.replace(needle,replacement,1)
   applied=True
   break
 if not applied:
  print('GUARDIAN_PATCH_CONTEXT_MISMATCH',tag,i1,i2,
        'oldFirstLine',repr(old_part[:130]),'oldCount',live_text.count(old_part),
        'newCount',live_text.count(new_part),flush=True)
  if new_part and live_text.count(new_part)==1:
   print('GUARDIAN_HUNK_ALREADY_INSTALLED',i1,flush=True)
   continue
  raise AssertionError('LIVE_WRAPPER_CHANGE_REQUIRES_REVIEW')
assert 'guardian_prepost_retry_scheduled' in live_text,'RETRY_GUARD_LOST'
assert 'GUARDIAN_FIXED_STOP_LOSS_UNREADY' in live_text,'FIXED_SL_REPAIR_MISSING'
assert 'p.signalModelChoice!==GUARDIAN_ID' in live_text,'COOLDOWN_REPAIR_MISSING'
out.write_text(live_text)
print('GUARDIAN_SELECTIVE_PATCH_PASS=true',flush=True)
PY
for f in guardian-live-bridge.mjs guardian-risk-integration.mjs;do
 python3 - "$ROOT/$f" "$TMP/$f" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
old='/var/lib/zl-prediction/guardian5/guardian-live-orders.json'
new='/var/lib/zl-prediction/rounds/guardian5/guardian-live-orders.json'
print('GUARDIAN_REGISTRY_LIVE_SOURCE',sys.argv[1], 'old',s.count(old),'new',s.count(new),
      'registryLines',[x[:200] for x in s.splitlines() if 'REGISTRY' in x or 'guardian-live-orders.json' in x][:8],flush=True)
if s.count(old)+s.count(new)==0 and sys.argv[1].endswith('guardian-risk-integration.mjs'):
 legacy="const REGISTRY=path.join(GUARDIAN_STATE_DIR,'guardian-live-orders.json');"
 assert s.count(legacy)==1,'GUARDIAN_RISK_REGISTRY_ANCHOR_MISSING'
 s=s.replace(legacy,"const REGISTRY=process.env.GUARDIAN_REGISTRY_FILE || '"+new+"';")
else:
 assert s.count(old)+s.count(new)>=1,'REGISTRY_PATH_UNEXPECTED'
 s=s.replace(old,new)
assert new in s,'REGISTRY_PATCH_NOT_APPLIED'
Path(sys.argv[2]).write_text(s)
PY
done
for f in wrapper.mjs guardian-live-bridge.mjs guardian-risk-integration.mjs;do "$NODE" --check "$TMP/$f";done
install -d -o zl-pred -g zl-pred -m 0750 "$(dirname "$REG")"
OLD=/var/lib/zl-prediction/guardian5/guardian-live-orders.json
if test -f "$OLD";then
 if test -f "$REG";then cmp -s "$OLD" "$REG" || { echo REGISTRY_CONFLICT;exit 4; }
 else cp -p "$OLD" "$REG";chown zl-pred:zl-pred "$REG";fi
fi
systemd-run --quiet --wait --pipe --collect \
 -p User=zl-pred -p Group=zl-pred -p ProtectSystem=strict \
 -p ReadWritePaths=/var/lib/zl-prediction/rounds \
 /usr/bin/python3 -c '
import pathlib,os,sys
p=pathlib.Path(sys.argv[1]).parent/(".atomic-check-"+str(os.getpid()))
q=p.with_suffix(".renamed")
try:
 p.write_text("ok");p.rename(q);assert q.read_text()=="ok"
finally:p.unlink(missing_ok=True);q.unlink(missing_ok=True)
print("GUARDIAN_REGISTRY_SANDBOX_ATOMIC_WRITE_OK=true")
' "$REG"
preflight
for f in wrapper.mjs guardian-live-bridge.mjs guardian-risk-integration.mjs;do
 cp "$TMP/$f" "$ROOT/$f"
 chown --reference="$BACK/$f" "$ROOT/$f"
 chmod --reference="$BACK/$f" "$ROOT/$f"
done
CHANGED=1
systemctl restart zl-prediction-risk-exits
systemctl restart zl-prediction-trade
PASS=0
for i in $(seq 1 20);do
 if preflight >/dev/null 2>&1;then PASS=1;break;fi
 sleep 2
done
test "$PASS" = 1
for f in wrapper.mjs guardian-live-bridge.mjs guardian-risk-integration.mjs;do
 cmp -s "$TMP/$f" "$ROOT/$f"
 echo "GUARDIAN_REPAIR_FILE_SHA" "$f" "$(sha256sum "$ROOT/$f" | cut -d ' ' -f1)"
done
for svc in zl-prediction-trade zl-prediction-risk-exits zl-prediction-guardian-analysis;do systemctl is-active --quiet "$svc";done
preflight
# Use a private dummy registry file to validate the real Guardian write and
# confirmation functions inside a systemd sandbox. Never touch an actual order.
systemd-run --quiet --wait --pipe --collect \
 -p User=zl-pred -p Group=zl-pred -p ProtectSystem=strict \
 -p ReadWritePaths=/var/lib/zl-prediction/rounds \
 "$NODE" --input-type=module -e '
import fs from "node:fs";
import {guardianRegisterIntent,guardianMarkSubmitted} from "file:///opt/zl-prediction-live/src/railway-diagnostic/guardian-live-bridge.mjs";
const file="/var/lib/zl-prediction/rounds/guardian5/.smoke-"+process.pid+".json";
const round=Math.floor(Date.now()/300000)*300000;
try {
 guardianRegisterIntent({round,tokenId:"test-token-no-trade"},{file});
 const before=JSON.parse(fs.readFileSync(file,"utf8"));
 if(before.entries.length!==1 || before.entries[0].status!=="INTENT_PREPARED")throw Error("PREPARE_REGISTRY_FAILED");
 guardianMarkSubmitted({round,tokenId:"test-token-no-trade"},"test-order-no-trade",{file});
 const after=JSON.parse(fs.readFileSync(file,"utf8"));
 if(after.entries[0].status!=="SUBMITTED")throw Error("CONFIRM_REGISTRY_FAILED");
 console.log("GUARDIAN_REAL_MODULE_REGISTRY_SANDBOX_OK=true");
} finally {try{fs.unlinkSync(file)}catch{}}
'
DONE=1
echo GUARDIAN_REPAIR_PRODUCTION_DEPLOYED=true
echo GUARDIAN_REPAIR_COMMIT="$REV"
echo GUARDIAN_REPAIR_NO_LIVE_ORDER_POST=true
echo GUARDIAN_REPAIR_OWNER_REARM_REQUIRED=true
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch(r'[a-f0-9]{40}',sha):
  print('GUARDIAN_INVALID_REF');return 2
 if not (os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID') and os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET')):
  print('GUARDIAN_MISSING_ALIBABA_CREDENTIALS');return 3
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 try:
  ident=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='guardian-5m-safe-repair',type='RunShellScript',command_content=REMOTE.replace('__REV__',sha),working_user='root',timeout=170)).body.invoke_id
  for _ in range(100):
   time.sleep(2)
   d=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=ident)).body.invocation_result
   if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    try: out=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
    except Exception:out='OUTPUT_UNAVAILABLE'
    print('GUARDIAN_REPAIR_REMOTE',d.invocation_status,d.exit_code)
    print(out[-11500:])
    return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'GUARDIAN_REPAIR_PRODUCTION_DEPLOYED=true' in out else 5
  print('GUARDIAN_REPAIR_TIMEOUT');return 6
 except Exception as e:
  print('GUARDIAN_REPAIR_API_ERROR',type(e).__name__,getattr(e,'code',''));return 7
if __name__=='__main__':sys.exit(main())

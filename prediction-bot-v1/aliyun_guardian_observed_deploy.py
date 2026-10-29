#!/usr/bin/env python3
"""Deploy GUARDIAN saved-signal-lock fix to Alibaba SWAS, without submitting orders.
Production handoff resets owner-armed following after trade service restart.
"""
import base64
import os
import re
import sys
import time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REMOTE = r"""#!/bin/bash
set -Eeuo pipefail
REV=__REV__
ROOT=/opt/zl-prediction-live/src/railway-diagnostic
DEST="$ROOT/guardian-live-bridge.mjs"
NODE=/opt/zl-prediction-node/bin/node
WORK=$(mktemp -d /tmp/zl-guardian-observed-XXXXXXXX)
BACK=/var/backups/zl-guardian-observed-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 0700 "$BACK"
STAGED=0
COMPLETE=0
cleanup(){
 if [ "$STAGED" = 1 ] && [ "$COMPLETE" = 0 ];then
  echo GUARDIAN_OBSERVED_ROLLBACK_STARTED=true
  cp -p "$BACK/guardian-live-bridge.mjs" "$DEST"
  systemctl restart zl-prediction-trade || true
  echo GUARDIAN_OBSERVED_ROLLBACK_DONE=true
 fi
 rm -rf "$WORK"
}
trap cleanup EXIT
test -x "$NODE" && test -r "$DEST"
systemctl is-active --quiet zl-prediction-trade
systemctl is-active --quiet zl-prediction-risk-exits
systemctl is-active --quiet zl-prediction-guardian-analysis

preflight(){
python3 - <<'PY'
import json,sys,urllib.request,datetime,pathlib
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=5) as r:return json.load(r)
s=get('/api/status')
assert s.get('ok') is True,'STATUS_NOT_OK'
assert s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1','OTHER_MODEL_ACTIVE'
assert s.get('orderSignalModelReady') is True,'MODEL_SELECTION_NOT_READY'
assert s.get('guardianExecutionReady') is True and s.get('guardianRiskReady') is True,'EXECUTION_OR_RISK_NOT_READY'
assert s.get('directionModeReady') is True,'DIRECTION_MODES_NOT_READY'
m=(s.get('directionModes') or {}).get('FAST5_SPOT_MOMENTUM_V1') or {}
assert m.get('UP') in ('FORWARD','INVERSE') and m.get('DOWN') in ('FORWARD','INVERSE'),'FAST5_SOURCE_MODE_NOT_ENABLED'
p=s.get('pendingAction')
if isinstance(p,dict):
 now=int(datetime.datetime.now(datetime.timezone.utc).timestamp()*1000)
 ongoing=p.get('state') in ('READY','QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN')
 current=(p.get('round') is not None and int(p['round'])>=now//300000*300000-300000)
 assert not (ongoing and current),'ACTIVE_ORDER_PENDING'
order=s.get('lastOrder') or {}
assert order.get('state') not in ('SUBMISSION_UNKNOWN','SUBMITTED_PENDING_CONFIRMATION','SUBMITTING','QUOTING'),'ORDER_UNRESOLVED'
root=pathlib.Path('/var/lib/zl-prediction/rounds')
risk=json.loads((root/'risk-runtime-status.json').read_text())
health=json.loads((root/'risk-worker-health.json').read_text())
cfg=json.loads((root/'risk-control.json').read_text())
assert cfg.get('takeProfitEnabled') is True and cfg.get('stopLossEnabled') is True,'FIXED_EXITS_DISABLED'
assert risk.get('workerRunning') is True and risk.get('enabled') is True and risk.get('configApplied') is True,'RISK_WORKER_UNREADY'
assert risk.get('guardianDynamicExitEnabled') is False,'RISK_CONFIG_UNEXPECTED'
assert health.get('positionsSeen')==0,'OPEN_POSITIONS_ABORT'
def age(v):
 if isinstance(v,(int,float)):return datetime.datetime.now(datetime.timezone.utc).timestamp()-(v/1000 if v>1e11 else v)
 return (datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(str(v).replace('Z','+00:00'))).total_seconds()
assert 0<=age(risk.get('at'))<10,'RISK_STATUS_STALE'
assert 0<=age(health.get('lastSuccessfulPositionsAt'))<15,'POSITION_HEALTH_STALE'
print('GUARDIAN_OBSERVED_PREFLIGHT_OK=true')
print('GUARDIAN_OBSERVED_FOLLOW_BEFORE=',s.get('enabled'))
print('GUARDIAN_OBSERVED_AUTO_MODE=',s.get('mode'))
PY
}
preflight
cp -p "$DEST" "$BACK/guardian-live-bridge.mjs"
curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$REV/railway-diagnostic/guardian-live-bridge.mjs" -o "$WORK/repo-guardian-live-bridge.mjs"
python3 - "$DEST" "$WORK/repo-guardian-live-bridge.mjs" "$WORK/guardian-live-bridge.mjs" <<'PY'
from pathlib import Path
import sys
dest=Path(sys.argv[1]).read_text()
new=Path(sys.argv[2]).read_text()
start='export function guardianOrderSignal('
end='export function guardianQuoteGate('
assert dest.count(start)==new.count(start)==1,'ORDER_SIGNAL_MARKER_MISSING'
assert dest.count(end)==new.count(end)==1,'QUOTE_MARKER_MISSING'
assert dest.count('export const GUARDIAN_ID=')==1,'IDENTITY_MISMATCH'
oldstart=dest.index(start)
oldend=dest.index(end,oldstart)
newstart=new.index(start)
newend=new.index(end,newstart)
replacement=new[newstart:newend]
assert 'retainedObservation' in replacement and "latest.direction==='OBSERVED'" in replacement,'EXPECTED_FIX_MISSING'
assert 'now-status.observedAt>10000' in replacement,'FEED_FRESHNESS_CHECK_MISSING'
assert 'now>=round+FIVE_MIN' in replacement,'ROUND_EXPIRY_CHECK_MISSING'
assert 'GUARDIAN_SOURCE' in dest and 'FIVE_MIN' in dest,'ADAPTER_DEPENDENCY_MISSING'
out=dest[:oldstart]+replacement+dest[oldend:]
assert out[:oldstart]==dest[:oldstart] and out[out.index(end):]==dest[oldend:],'UNEXPECTED_CHANGE'
old_source="export const GUARDIAN_SOURCE='SELECTIVE_V2_FAST8_PRIMARY';"
new_source="export const GUARDIAN_SOURCE='FAST5_SPOT_MOMENTUM_V1';"
assert out.count(old_source)==1 and new.count(new_source)==1,'GUARDIAN_PRODUCTION_SOURCE_UNKNOWN'
out=out.replace(old_source,new_source,1)
assert out.count(new_source)==1,'GUARDIAN_SOURCE_FIX_FAILED'
Path(sys.argv[3]).write_text(out)
print('GUARDIAN_PRODUCTION_SOURCE_ALIGNED=true')
print('GUARDIAN_OBSERVED_MINIMAL_FUNCTION_PATCH_READY=true')
PY
"$NODE" --check "$WORK/guardian-live-bridge.mjs"
"$NODE" --input-type=module - "$WORK/guardian-live-bridge.mjs" <<'JS'
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const src=process.argv[2];
const {guardianOrderSignal,GUARDIAN_ID,GUARDIAN_SOURCE}=await import(pathToFileURL(src).href);
assert.equal(GUARDIAN_SOURCE,'FAST5_SPOT_MOMENTUM_V1','PRODUCTION_SOURCE_NOT_ALIGNED');
const now=Date.now(),round=Math.floor(now/300000)*300000;
const r={round,at:Math.max(round,now-1800),marketAt:now-600,status:'PREDICTED',predictedDirection:'DOWN'};
const root={ok:true,model:GUARDIAN_ID,readOnly:true,orders:false,configured:true,observedAt:now-100,
 records:[r],stats:{settled:0,validated:false}};
const a=guardianOrderSignal({...root,latest:{round,status:'SHADOW_OBSERVATION',direction:'DOWN'}},now);
const b=guardianOrderSignal({...root,latest:{round,direction:'OBSERVED'}},now);
assert(a.ok===true&&b.ok===true,'OBSERVED_SIGNAL_NOT_ACCEPTED');
assert(a.signalId===b.signalId&&b.direction==='DOWN','SIGNAL_ID_CHANGED');
assert.equal(a.source,'FAST5_SPOT_MOMENTUM_V1','GUARDIAN_ORDER_DIRECTION_MAPPING_UNKNOWN');
assert(guardianOrderSignal({...root,latest:{round,direction:'WAIT'}},now).ok===false);
assert(guardianOrderSignal({...root,observedAt:now-15000,latest:{round,direction:'OBSERVED'}},now).ok===false);
console.log('GUARDIAN_OBSERVED_REMOTE_REGRESSION_OK=true');
JS
# Recheck the trade engine and risk monitor immediately before stopping the service.
preflight
cp -p "$WORK/guardian-live-bridge.mjs" "$DEST"
chown --reference="$BACK/guardian-live-bridge.mjs" "$DEST"
chmod --reference="$BACK/guardian-live-bridge.mjs" "$DEST"
STAGED=1
systemctl restart zl-prediction-trade
HEALTHY=0
for n in $(seq 1 16);do
 if systemctl is-active --quiet zl-prediction-trade && curl -fsS --max-time 4 http://127.0.0.1:13001/api/status -o "$WORK/status.json" 2>/dev/null;then
  if python3 - "$WORK/status.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d.get('ok') is True
assert d.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1'
assert d.get('guardianExecutionReady') is True and d.get('guardianRiskReady') is True
assert d.get('enabled') is False,'RESTART_EXPECTED_OWNER_REARM'
assert not d.get('pendingAction')
print('GUARDIAN_OBSERVED_RUNTIME_VERIFIED=true')
print('GUARDIAN_OBSERVED_OWNER_MUST_REENABLE=true')
PY
  then HEALTHY=1;break;fi
 fi
 sleep 2
done
test "$HEALTHY" = 1
cmp -s "$DEST" "$WORK/guardian-live-bridge.mjs"
systemctl is-active --quiet zl-prediction-risk-exits
systemctl is-active --quiet zl-prediction-guardian-analysis
COMPLETE=1
echo GUARDIAN_OBSERVED_ALIYUN_DEPLOYED=true
echo GUARDIAN_OBSERVED_NO_REAL_ORDER_SUBMITTED=true
echo GUARDIAN_OBSERVED_BACKUP="$BACK"
"""

def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[a-f0-9]{40}',sha):
  print('GUARDIAN_OBSERVED_INVALID_REF');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
                      access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
                      endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 task=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='guardian-observed-signal-live-fix',
  type='RunShellScript',command_content=REMOTE.replace('__REV__',sha),
  working_user='root',timeout=175)).body.invoke_id
 for _ in range(82):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
    instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=task)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:msg=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:msg='OUTPUT_UNAVAILABLE'
   print('GUARDIAN_OBSERVED_REMOTE',r.invocation_status,r.exit_code)
   print(msg[-9500:])
   return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 and 'GUARDIAN_OBSERVED_ALIYUN_DEPLOYED=true' in msg else 5
 print('GUARDIAN_OBSERVED_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

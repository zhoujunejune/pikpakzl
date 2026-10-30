#!/usr/bin/env python3
"""Surgical, rollback-safe GUARDIAN early-entry production repair. No real orders."""
import os,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
NODE=/opt/zl-prediction-node/bin/node
G=/opt/zl-prediction-live/guardian5/guardian5-service.mjs
W=/opt/zl-prediction-live/src/railway-diagnostic/wrapper.mjs
STAGE=$(mktemp -d /tmp/guardian-early-XXXXXX)
BACK=/var/backups/guardian-early-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 0700 "$BACK"
CHANGED=0; OK=0
cleanup(){
 if test "$CHANGED" = 1 && test "$OK" = 0;then
  cp -p "$BACK/service" "$G" || :
  cp -p "$BACK/wrapper" "$W" || :
  systemctl restart zl-prediction-guardian-analysis || :
  systemctl restart zl-prediction-trade || :
  echo EARLY_ENTRY_ROLLED_BACK=true
 fi
 rm -rf "$STAGE"
}
trap cleanup EXIT
preflight(){
 python3 - <<'PY'
import json,urllib.request,pathlib,subprocess
def get(port):
 with urllib.request.urlopen('http://127.0.0.1:%d/api/status'%port,timeout=5) as r:return json.load(r)
s=get(13001);g=get(13049)
assert s.get('ok') is True and s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1'
assert s.get('enabled') is False,'FOLLOW_ENABLED_ABORT'
assert s.get('guardianRiskReady') is True and s.get('guardianExecutionReady') is True,'RISK_NOT_READY'
assert g.get('ok') is True and g.get('model')=='ZL_GUARDIAN_5M_V1','GUARDIAN_UNREADY'
for p in (s.get('pendingAction') or {},s.get('lastOrder') or {}):
 assert p.get('state') not in ('READY','QUOTING','SUBMITTING','SUBMISSION_UNKNOWN','SUBMITTED_PENDING_CONFIRMATION'),'OPEN_OR_UNKNOWN_ORDER'
root=pathlib.Path('/var/lib/zl-prediction/rounds')
risk=json.loads((root/'risk-runtime-status.json').read_text())
health=json.loads((root/'risk-worker-health.json').read_text())
cfg=json.loads((root/'risk-control.json').read_text())
assert cfg.get('stopLossEnabled') is True and risk.get('workerRunning') is True and risk.get('configApplied') is True
assert health.get('positionsSeen')==0,'OPEN_POSITION_ABORT'
print('EARLY_ENTRY_PREFLIGHT_PASS=true',flush=True)
PY
}
test -x "$NODE" && test -r "$G" && test -r "$W"
for s in zl-prediction-guardian-analysis zl-prediction-trade zl-prediction-risk-exits;do systemctl is-active --quiet "$s";done
preflight
cp -p "$G" "$BACK/service";cp -p "$W" "$BACK/wrapper"
python3 - "$G" "$W" "$STAGE/service.mjs" "$STAGE/wrapper.mjs" <<'PY'
import pathlib,sys
g,w,gs,ws=map(pathlib.Path,sys.argv[1:])
src=g.read_text();trade=w.read_text()
def replace(s,a,b,label):
 count=s.count(a)
 assert count==1,('SOURCE_DRIFT_'+label,count)
 return s.replace(a,b,1)
mark='// GUARDIAN_EARLY_ENTRY_V1_20261030'
if mark not in src:
 src=replace(src,'const MAX_CALLS=3;',
 'const MAX_CALLS=3;\n'+mark+'\nconst GUARDIAN_ENTRY_CUTOFF_MS=170000;\nconst GUARDIAN_AI_TIMEOUT_MS=19000;','config')
 src=replace(src,
  "  try{await pollOfficial(now)}catch(e){local.error='结算读取:'+String(e?.message||e).slice(0,90)}",
  "  void pollOfficial(now).catch(e=>{local.error='结算读取:'+String(e?.message||e).slice(0,90)});",'nonblocking_stats')
 src=replace(src,'max_tokens:1500,thinking:', 'max_tokens:600,thinking:','response_tokens')
 src=replace(src,'Math.min(43000,Math.max(2000,remaining-24000))',
  'Math.min(GUARDIAN_AI_TIMEOUT_MS,Math.max(2000,remaining-24000))','ai_timeout')
 src=replace(src,'local.aiCalls+=1;local.nextAnalysisAt=Date.now()+25000;',
  'local.aiCalls+=1;local.nextAnalysisAt=Date.now()+12000;','cadence')
 src=replace(src,'  const c=safeCandidate(f,Date.now());',
  """  if(Date.now()-r>=GUARDIAN_ENTRY_CUTOFF_MS){
   local.latest={direction:'WAIT',round:r,reason:'超过本轮2分50秒入场窗口，不追尾盘'};
   return;
  }
  const c=safeCandidate(f,Date.now());""",'pre_analysis_cutoff')
 src=replace(src,'  const result=await judge(c,f);',
  """  console.log(JSON.stringify({event:'guardian_ai_start',round:r,elapsedMs:Date.now()-r,attempt:local.aiCalls}));
  const result=await judge(c,f);
  console.log(JSON.stringify({event:'guardian_ai_finish',round:r,elapsedMs:Date.now()-r,modelLatencyMs:local.modelLatencyMs,decision:result.direction}));""",'ai_timing')
 src=replace(src,"  // Revalidate the market at execution time: never use a slow model's stale snapshot.",
  """  if(Date.now()-r>=GUARDIAN_ENTRY_CUTOFF_MS){
   local.latest={direction:'WAIT',round:r,reason:'DeepSeek回复超过前2分50秒入场窗口'};
   console.log(JSON.stringify({event:'guardian_late_signal_skipped',round:r,elapsedMs:Date.now()-r}));
   return;
  }
  // Revalidate the market at execution time: never use a slow model's stale snapshot.""",'after_ai_cutoff')
 src=replace(src,'  const row=recordDecision(c,result,Date.now());',
  """  if(Date.now()-r>=GUARDIAN_ENTRY_CUTOFF_MS){
   local.latest={direction:'WAIT',round:r,reason:'市场复核超过入场窗口'};
   return;
  }
  const row=recordDecision(c,result,Date.now());
  console.log(JSON.stringify({event:'guardian_early_signal_ready',round:r,elapsedMs:Date.now()-r}));""",'before_signal_cutoff')
else:
 assert src.count(mark)==1 and src.count('GUARDIAN_ENTRY_CUTOFF_MS')>=4,'PARTIAL_EARLY_PATCH'
old='const GUARDIAN_ORDER_DEADLINE_MS = 300000;'
new='const GUARDIAN_ORDER_DEADLINE_MS = 180000;'
if new not in trade:trade=replace(trade,old,new,'executor_deadline')
assert src.count(mark)==1 and 'guardian_early_signal_ready' in src
assert 'guardianFixedReadiness().ready' in trade and 'GUARDIAN_QUOTE_CAPACITY_V2_BEGIN' in trade
gs.write_text(src);ws.write_text(trade)
print('GUARDIAN_EARLY_PATCH_STAGE_OK=true',flush=True)
PY
"$NODE" --check "$STAGE/service.mjs"
"$NODE" --check "$STAGE/wrapper.mjs"
"$NODE" --input-type=module - "$STAGE/service.mjs" "$STAGE/wrapper.mjs" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const g=fs.readFileSync(process.argv[2],'utf8'),w=fs.readFileSync(process.argv[3],'utf8');
for(const s of ['GUARDIAN_ENTRY_CUTOFF_MS=170000','GUARDIAN_AI_TIMEOUT_MS=19000',
 'void pollOfficial(now).catch','guardian_late_signal_skipped','guardian_early_signal_ready',
 'if(check.direction!==c.direction||fresh.round!==r)','const row=recordDecision(c,result,Date.now());'])
 assert(g.includes(s),s);
assert(w.includes('GUARDIAN_ORDER_DEADLINE_MS = 180000'));
assert(w.includes('GUARDIAN_QUOTE_CAPACITY_V2_BEGIN'));
console.log('GUARDIAN_EARLY_INVARIANTS_PASS=true');
JS
preflight
if ! cmp -s "$G" "$STAGE/service.mjs" || ! cmp -s "$W" "$STAGE/wrapper.mjs";then
 cp "$STAGE/service.mjs" "$G";chown --reference="$BACK/service" "$G";chmod --reference="$BACK/service" "$G"
 cp "$STAGE/wrapper.mjs" "$W";chown --reference="$BACK/wrapper" "$W";chmod --reference="$BACK/wrapper" "$W"
 CHANGED=1
 systemctl restart zl-prediction-guardian-analysis
 systemctl restart zl-prediction-trade
fi
HEALTHY=0
for i in $(seq 1 24);do
 if preflight >/dev/null 2>&1;then HEALTHY=1;break;fi
 sleep 2
done
test "$HEALTHY" = 1
cmp -s "$G" "$STAGE/service.mjs";cmp -s "$W" "$STAGE/wrapper.mjs"
for s in zl-prediction-guardian-analysis zl-prediction-trade zl-prediction-risk-exits;do systemctl is-active --quiet "$s";done
OK=1
echo GUARDIAN_EARLY_ENTRY_DEPLOYED=true
echo GUARDIAN_EARLY_ENTRY_NO_REAL_ORDER=true
echo GUARDIAN_EARLY_ENTRY_OWNER_REARM_REQUIRED=true
echo GUARDIAN_EARLY_ENTRY_BACKUP="$BACK"
"""
def main():
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1':return 2
 if not os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID') or not os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET'):return 3
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 try:
  i=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
    instance_id='b67374069bb3457ba6a3a2ede9305d3f',
    name='guardian-early-timing-repair',type='RunShellScript',
    command_content=REMOTE,working_user='root',timeout=170)).body.invoke_id
  for _ in range(95):
   time.sleep(2)
   d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(
     region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
     invoke_id=i)).body.invocation_result
   if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    try:o=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
    except Exception:o='OUTPUT_UNAVAILABLE'
    print('EARLY_TIMING_REMOTE',d.invocation_status,d.exit_code)
    print(o[-12000:])
    return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'GUARDIAN_EARLY_ENTRY_DEPLOYED=true' in o else 5
  print('EARLY_TIMING_TIMEOUT');return 6
 except Exception as e:
  print('EARLY_TIMING_ERROR',type(e).__name__,str(getattr(e,'code',''))[:100]);return 7
if __name__=='__main__':sys.exit(main())

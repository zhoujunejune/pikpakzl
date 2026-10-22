#!/usr/bin/env python3
"""Safely speed the selected DeepSeek live signal polling only: 120ms first 12s.
No change to quote/order logic, no user switch toggles, no duplicate orders.
"""
import os,re,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/fast-feed-and-trigger-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
NODE=/opt/zl-prediction-node/bin/node
DIR=/opt/zl-prediction-live/src/railway-diagnostic
IDX=$DIR/index.mjs
WRAPPER=$DIR/wrapper.mjs
CHOICE=$DIR/production-signal-choice.mjs
test -x "$NODE" && test -f "$IDX" && test -f "$WRAPPER" && test -f "$CHOICE"
for unit in zl-prediction-trade zl-prediction-deepseek5 zl-prediction-v3 zl-prediction-risk-exits zl-deepseek-results-display-only zl-futures-bot-paper;do
 test "$(systemctl is-active "$unit")" = active || { echo "FASTTRADE_UNIT_UNAVAILABLE=$unit";exit 3; }
done
WORK=$(mktemp -d "$DIR/.fastpoll-test-XXXXXXXX")
trap 'rm -rf "$WORK"' EXIT
python3 - "$WORK" <<'PY'
import json,urllib.request,sys
from pathlib import Path
def get(p):
 with urllib.request.urlopen('http://127.0.0.1:13001'+p,timeout=8) as x:return json.load(x)
t=get('/api/status')
s=get('/api/order-signal-model')
assert t.get('enabled') is False,'OWNER_FOLLOW_ON_NO_RESTART'
assert (t.get('pendingAction') or {}).get('state') not in ('QUOTING','SUBMITTING','SUBMISSION_UNKNOWN')
assert s.get('model')=='DEEPSEEK_5M_V1','SELECTED_MODEL_CHANGED'
idx=Path('/opt/zl-prediction-live/src/railway-diagnostic/index.mjs').read_text()
choice=Path('/opt/zl-prediction-live/src/railway-diagnostic/production-signal-choice.mjs').read_text()
assert idx.count('setInterval(prepareWorker, 1200);')==1
assert idx.count('  prepareInFlight = true;\n  lastPrepareAttemptAt = Date.now();')==1
assert 'deepseek_fast_local_poll' not in idx
assert "SELECTIVE8_MODEL='DEEPSEEK_5M_V1'" in choice.replace(' ','')
Path(sys.argv[1]+'/state.json').write_text(json.dumps({'enabled':False,'selectedModel':s['model']}))
print('FASTTRADE_SELECTED_DEEPSEEK_AND_OWNER_OFF=true')
PY
cp -p "$IDX" "$WORK/index.mjs"
cp -p "$WRAPPER" "$WORK/wrapper.mjs"
python3 - "$WORK" <<'PY'
from pathlib import Path
import sys
w=Path(sys.argv[1]);p=w/'index.mjs';src=p.read_text()
needle='setInterval(prepareWorker, 1200);'
assert src.count(needle)==1
patch='''// Fast *local* DeepSeek signal pickup. No new Binance requests or submission path.
let fastLivePrepareCheckBusy=false;
setInterval(()=>{
  if(!enabled||!tradeAmountText||fastLivePrepareCheckBusy||prepareInFlight||
     !directionSettingsSnapshot().ready||
     modelSelectionSnapshot().model!==SELECTIVE8_MODEL||
     Date.now()%300000>=12000)return;
  fastLivePrepareCheckBusy=true;
  Promise.resolve(prepareWorker(null,'deepseek_fast_local_poll'))
    .catch(e=>console.error(JSON.stringify({event:'deepseek_fast_local_poll_failed',
      code:String(e?.code||e?.name||'UNKNOWN').slice(0,60)})))
    .finally(()=>{fastLivePrepareCheckBusy=false;});
},120);
'''
src=src.replace(needle,patch+needle)
needle='  prepareInFlight = true;\n  lastPrepareAttemptAt = Date.now();'
assert src.count(needle)==1
src=src.replace(needle,'''  // Prevent racing 1200ms and 120ms polls from preparing twice.
  if(prepareInFlight)return;
'''+needle)
p.write_text(src)
wr=w/'wrapper.mjs';wrSrc=wr.read_text()
needle='await import(generatedModuleUrl.href);'
assert wrSrc.count(needle)==1
wr.write_text(wrSrc.replace(needle,"console.log('FASTTRADE_GENERATED_MODULE_READY_FOR_SYNTAX_CHECK=true');"))
print('FASTTRADE_DEEPSEEK_LOCAL_POLL_PATCH_CREATED=true')
PY
"$NODE" --check "$WORK/index.mjs"
"$NODE" --check "$WORK/wrapper.mjs"
(cd "$WORK" && "$NODE" "$WORK/wrapper.mjs")
"$NODE" --check "$WORK/trade-control-fixed.mjs"
echo 'FASTTRADE_DYNAMIC_GENERATED_BACKEND_SYNTAX_OK=true'
python3 - <<'PY'
import time,urllib.request,json
for i in range(165):
 ms=int(time.time()*1000)%300000
 if 40000<=ms<=230000:
  with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=9) as x:t=json.load(x)
  assert t.get('enabled') is False,'OWNER_TURNED_FOLLOW_ON_ABORT'
  print('FASTTRADE_SAFE_RESTART_AFTER_ROUND_MS',ms);break
 time.sleep(1)
else:raise SystemExit('FASTTRADE_NO_SAFE_WINDOW')
PY
BACKUP=/var/lib/zl-prediction/archive/source-backups/fast-tradepoll-COMMIT_SHA
test ! -e "$BACKUP"
mkdir -p "$BACKUP"
cp -p "$IDX" "$BACKUP/old-index.mjs"
rollback(){
 echo 'FASTTRADE_ROLLBACK_TRIGGERED=true'
 cp -p "$BACKUP/old-index.mjs" "$IDX" || true
 systemctl restart zl-prediction-trade.service || true
}
trap rollback ERR
chown --reference="$IDX" "$WORK/index.mjs"
chmod --reference="$IDX" "$WORK/index.mjs"
cp -p "$WORK/index.mjs" "$IDX"
systemctl restart zl-prediction-trade.service
python3 - "$WORK/state.json" <<'PY'
import json,urllib.request,time,sys,subprocess
before=json.load(open(sys.argv[1]))
def get(port,p):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,p),timeout=9) as r:return json.load(r)
for i in range(35):
 try:
  t=get(13001,'/api/status')
  if t.get('ok') is True:break
 except Exception:pass
 time.sleep(1)
else:raise SystemExit('FASTTRADE_CONTROL_API_NOT_HEALTHY')
assert t.get('enabled') is before['enabled'] is False
assert get(13001,'/api/order-signal-model').get('model')==before['selectedModel']=='DEEPSEEK_5M_V1'
m=get(13029,'/api/status')
assert m.get('decisionRule')=='DEEPSEEK_100MS_THEN_CURRENT_ROUND_PRICE_FALLBACK'
for unit in ('zl-prediction-trade.service','zl-prediction-deepseek5.service',
 'zl-prediction-v3.service','zl-prediction-risk-exits.service',
 'zl-deepseek-results-display-only.service','zl-futures-bot-paper.service'):
 assert subprocess.run(['systemctl','is-active','--quiet',unit]).returncode==0,unit
print('FASTTRADE_120MS_SELECTED_AI_POLL_ACTIVE=true')
print('FASTTRADE_BASELINE_1200MS_POLL_UNCHANGED=true')
print('FASTTRADE_FOLLOW_AND_ORDER_SAFETY_PRESERVED=true')
print('FASTTRADE_PRODUCTION_SUCCESS=true')
PY
echo "FASTTRADE_BACKUP=$BACKUP"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[0-9a-f]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,name='zl-fast-deepseek-trade-poll-guarded',type='RunShellScript',working_user='root',command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=250)).body.invoke_id
 for _ in range(140):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('FASTTRADE_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(o[-9500:])
   return 0 if int(r.exit_code)==0 else 5
 print('FASTTRADE_RESULT_UNKNOWN');return 6
if __name__=='__main__':sys.exit(main())

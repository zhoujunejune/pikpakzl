#!/usr/bin/env python3
"""Safely switch only existing Alibaba prediction AI and prediction panel to 5s.
Never enable orders or alter exchange credentials/futures; preserve rollback archive.
"""
import os,re,time,sys,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='feat/deepseek-single5-no-learning-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
node=/opt/zl-prediction-node/bin/node
app=/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs
panel=/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs
test -x "$node" && test -f "$app" && test -f "$panel"
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
test "$(systemctl is-active zl-prediction-trade.service)" = active
systemctl show zl-prediction-deepseek5.service -p ExecStart --value | grep -q deepseek-adaptive15-production-adapter.mjs
python3 - <<'PY'
import json,urllib.request,hashlib,pathlib
def get(port,uri):
 with urllib.request.urlopen('http://127.0.0.1:%s%s'%(port,uri),timeout=7) as r:return json.load(r)
m=get(13029,'/api/status');t=get(13001,'/api/status');sel=get(13001,'/api/order-signal-model')
assert m.get('model')=='DEEPSEEK_5M_V1' and m.get('providerModel')=='deepseek-flash'
assert m.get('decisionWindowEndMs',0)-m.get('round',0)==25000
assert m.get('maxCallsPerRound')==6
assert t.get('enabled') is False,'FOLLOW_ACTIVE_DO_NOT_RESTART'
assert not (t.get('pendingAction') or {}).get('state') in (
 'QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN')
assert sel.get('model')=='DEEPSEEK_5M_V1','SELECTOR_CHANGED'
p=pathlib.Path('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs')
assert hashlib.sha256(p.read_bytes()).hexdigest()=='67709f6892267a4c8814f357e5644992998a6033f2e0c96edf6fa788f65ea6ff','LIVE_SOURCE_DRIFT_ABORT'
print('FAST5_PRECHECK_REAL_ALIYUN_25S6_FOLLOW_OFF=true')
PY
work=$(mktemp -d /tmp/zl-five-signal-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
base="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1"
curl -fsSL --retry 2 --max-time 30 "$base/deepseek-single5-production.mjs" -o "$work/model.mjs"
curl -fsSL --retry 2 --max-time 30 "$base/patch_fast5_panel.py" -o "$work/patch.py"
"$node" --check "$work/model.mjs"
python3 "$work/patch.py" "$panel" "$work/panel.mjs"
"$node" --check "$work/panel.mjs"
grep -q 'ONE_CALL_FIVE_SECONDS_NO_LEARNING' "$work/model.mjs"
! grep -q 'const statsCard = ' "$work/panel.mjs"
grep -q 'function injectStats(html) { return html; }' "$work/panel.mjs"
# Back up exact running sources before replacing them. No old order/audit records are erased.
back="/var/lib/zl-prediction/archive/source-backups/deepseek-single5-COMMIT_SHA"
mkdir -p "$back"
cp -p "$app" "$back/deepseek-adaptive15-production-adapter.mjs"
cp -p "$panel" "$back/panel-stats-shell.mjs"
rollback(){
 echo 'FAST5_ROLLBACK_TRIGGERED=true'
 cp -p "$back/deepseek-adaptive15-production-adapter.mjs" "$app"
 cp -p "$back/panel-stats-shell.mjs" "$panel"
 systemctl restart zl-prediction-deepseek5.service || true
 systemctl restart zl-prediction-trade.service || true
 for unit in zl-deepseek-shadow-online.service zl-deepseek-shadow15-online.service;do
  if test -f "$back/$unit.was-active";then systemctl enable --now "$unit" || true;fi
 done
}
trap rollback ERR
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=5) as r:t=json.load(r)
assert t.get('enabled') is False,'FOLLOW_CHANGED_ABORT'
assert (t.get('pendingAction') or {}).get('state') not in (
 'QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN')
PY
chown --reference="$app" "$work/model.mjs"
chmod --reference="$app" "$work/model.mjs"
chown --reference="$panel" "$work/panel.mjs"
chmod --reference="$panel" "$work/panel.mjs"
cp -p "$work/model.mjs" "$app"
cp -p "$work/panel.mjs" "$panel"
systemctl restart zl-prediction-deepseek5.service
systemctl restart zl-prediction-trade.service
for i in $(seq 1 20);do
 if curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$work/model.json" 2>/dev/null &&
    curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$work/trade.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$work/model.json" && test -s "$work/trade.json"
python3 - "$work/model.json" "$work/trade.json" <<'PY'
import sys,json,urllib.request
m=json.load(open(sys.argv[1]));t=json.load(open(sys.argv[2]))
assert m.get('ok') is True and m.get('model')=='DEEPSEEK_5M_V1'
assert m.get('configured') is True and m.get('providerModel')=='deepseek-flash'
assert m.get('decisionWindowEndMs',0)-m.get('round',0)==5000
assert m.get('maxCallsPerRound')==1 and m.get('preRoundMaxCalls')==0
assert m.get('learningDisabled') is True and m.get('trainingDisabled') is True
assert m.get('statisticsDisabled') is True
assert 'learning' not in m and 'strategyQuality' not in m
assert t.get('enabled') is False
with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=6) as r:sel=json.load(r)
assert sel.get('model')=='DEEPSEEK_5M_V1'
with urllib.request.urlopen('http://127.0.0.1:13001/',timeout=6) as r:page=r.read(300000).decode('utf8','replace')
assert 'id="roundStatsCard"' not in page
print('FAST5_PRODUCTION_AI_ACTIVE=true')
print('FAST5_ONE_CALL_DEADLINE_5000MS=true')
print('FAST5_NO_LEARNING_STATISTICS_IN_AI=true')
print('FAST5_STATS_CARD_REMOVED_FROM_PANEL=true')
print('FAST5_TRADE_FOLLOW_REMAINS_OFF=true')
PY
# Stop the two DeepSeek CPU learning shadows, not the market, order, official
# settlement, or unrelated futures services. Recovery state is kept in archive.
for unit in zl-deepseek-shadow-online.service zl-deepseek-shadow15-online.service;do
 if test "$(systemctl is-active "$unit" || true)" = active;then
  touch "$back/$unit.was-active"
  systemctl disable --now "$unit"
 fi
done
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
test "$(systemctl is-active zl-prediction-trade.service)" = active
test "$(systemctl is-active zl-futures-bot-paper.service)" = active
echo 'FAST5_CPU_LEARNING_SHADOWS_STOPPED=true'
echo 'FAST5_ORDER_AND_FUTURES_CODE_UNCHANGED=true'
echo "FAST5_ROLLBACK_BACKUP=$back"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
  print('FAST5_INVALID_GITHUB_REF');return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 id=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
  name='zl-live-deepseek-single5-no-learning-guarded',type='RunShellScript',
  working_user='root',command_content=REMOTE.replace('COMMIT_SHA',sha),
  timeout=180)).body.invoke_id
 for _ in range(105):
  time.sleep(2)
  x=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=id)).body.invocation_result
  if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(x.output or '',validate=True).decode('utf8','replace')
   except Exception:out=str(x.output)
   print('FAST5_PRODUCTION_RELEASE',x.invocation_status,'EXIT',x.exit_code)
   print(out[-11000:])
   return 0 if int(x.exit_code)==0 else 5
 print('FAST5_RELEASE_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

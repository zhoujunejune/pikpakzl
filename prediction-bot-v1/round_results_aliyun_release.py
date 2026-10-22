#!/usr/bin/env python3
"""Guarded, no-trade-change Alibaba rollout for read-only 5s official results."""
import os,re,time,sys,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='feat/deepseek5-round-results-panel-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
node=/opt/zl-prediction-node/bin/node
appdir=/opt/zl-prediction-live/deepseek5
app="$appdir/deepseek-adaptive15-production-adapter.mjs"
module="$appdir/round-results-only-journal.mjs"
panel=/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs
test -x "$node" && test -f "$app" && test -f "$panel"
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
test "$(systemctl is-active zl-prediction-trade.service)" = active
python3 - <<'PY'
import json,urllib.request,pathlib,hashlib
def get(port,endpoint):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,endpoint),timeout=6) as r:return json.load(r)
s=get(13029,'/api/status');t=get(13001,'/api/status')
sel=get(13001,'/api/order-signal-model')
assert s.get('model')=='DEEPSEEK_5M_V1' and s.get('providerModel')=='deepseek-flash'
assert s.get('configured') is True and s.get('maxCallsPerRound')==1
assert s.get('decisionWindowEndMs',0)-s.get('round',0)==5000
assert s.get('learningDisabled') is True and s.get('trainingDisabled') is True
assert t.get('enabled') is False,'FOLLOW_ACTIVE_DO_NOT_RESTART'
assert (t.get('pendingAction') or {}).get('state') not in (
 'QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN')
assert sel.get('model')=='DEEPSEEK_5M_V1'
app=pathlib.Path('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs')
assert hashlib.sha256(app.read_bytes()).hexdigest()=='ad3b362f052a98e2bdb3db3bd5323b878d04cc462f1b79c5f7352599c64c1ca0','UNEXPECTED_MODEL_CHANGE'
panel=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
assert 'function injectStats(html) { return html; }' in panel.read_text(),'UNEXPECTED_PANEL_CHANGE'
print('ROUND_RESULTS_LIVE_FAST5_PRECHECK=true')
PY
work=$(mktemp -d /tmp/zl-round-results-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
base="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1"
curl -fsSL --retry 2 --max-time 30 "$base/deepseek-single5-production.mjs" -o "$work/provider.mjs"
curl -fsSL --retry 2 --max-time 30 "$base/round-results-only-journal.mjs" -o "$work/round-results-only-journal.mjs"
curl -fsSL --retry 2 --max-time 30 "$base/patch_round_results_panel.py" -o "$work/patch.py"
"$node" --check "$work/provider.mjs"
"$node" --check "$work/round-results-only-journal.mjs"
python3 "$work/patch.py" "$panel" "$work/panel.mjs"
"$node" --check "$work/panel.mjs"
grep -q 'createRoundResultsJournal' "$work/provider.mjs"
grep -q 'roundResultsOnlyCard' "$work/panel.mjs"
grep -q "url.pathname === '/api/deepseek-round-results'" "$work/panel.mjs"
! grep -q 'const statsCard = ' "$work/panel.mjs"
archive="/var/lib/zl-prediction/archive/source-backups/deepseek5-round-results-COMMIT_SHA"
mkdir -p "$archive"
cp -p "$app" "$archive/deepseek-adaptive15-production-adapter.mjs"
cp -p "$panel" "$archive/panel-stats-shell.mjs"
if test -f "$module";then cp -p "$module" "$archive/round-results-only-journal.mjs";fi
rollback(){
 echo 'ROUND_RESULTS_ALIYUN_ROLLBACK=true'
 cp -p "$archive/deepseek-adaptive15-production-adapter.mjs" "$app"
 cp -p "$archive/panel-stats-shell.mjs" "$panel"
 if test -f "$archive/round-results-only-journal.mjs";then
  cp -p "$archive/round-results-only-journal.mjs" "$module"
 else rm -f "$module";fi
 systemctl restart zl-prediction-deepseek5.service || true
 systemctl restart zl-prediction-trade.service || true
}
trap rollback ERR
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=6) as r:t=json.load(r)
assert t.get('enabled') is False,'OWNER_RESUMED_FOLLOW_SKIP_DEPLOY'
assert (t.get('pendingAction') or {}).get('state') not in (
 'QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN')
PY
chown --reference="$app" "$work/provider.mjs" "$work/round-results-only-journal.mjs"
chmod --reference="$app" "$work/provider.mjs" "$work/round-results-only-journal.mjs"
chown --reference="$panel" "$work/panel.mjs"
chmod --reference="$panel" "$work/panel.mjs"
cp -p "$work/round-results-only-journal.mjs" "$module"
cp -p "$work/provider.mjs" "$app"
cp -p "$work/panel.mjs" "$panel"
systemctl restart zl-prediction-deepseek5.service
systemctl restart zl-prediction-trade.service
for i in $(seq 1 22);do
 if curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$work/model.json" 2>/dev/null &&
    curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$work/trade.json" 2>/dev/null &&
    curl -fsS --max-time 3 http://127.0.0.1:13029/api/round-results?limit=5 -o "$work/rounds.json" 2>/dev/null &&
    curl -fsS --max-time 3 http://127.0.0.1:13001/api/deepseek-round-results?limit=5 -o "$work/ui-api.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$work/model.json" && test -s "$work/trade.json"
test -s "$work/rounds.json" && test -s "$work/ui-api.json"
python3 - "$work/model.json" "$work/trade.json" "$work/rounds.json" "$work/ui-api.json" <<'PY'
import json,sys,urllib.request
m,t,a,b=[json.load(open(x)) for x in sys.argv[1:]]
assert m.get('ok') is True and m.get('model')=='DEEPSEEK_5M_V1'
assert m.get('decisionWindowEndMs',0)-m.get('round',0)==5000
assert m.get('maxCallsPerRound')==1 and m.get('configured') is True
assert m.get('learningDisabled') is True and m.get('trainingDisabled') is True
assert m.get('standaloneRoundResultsEnabled') is True
assert t.get('enabled') is False
for d in (a,b):
 assert d.get('ok') is True and d.get('schema')=='ROUND_RESULTS_DISPLAY_ONLY_V1'
 assert d.get('usedForAnalysis') is False and d.get('learningDisabled') is True
 assert isinstance(d.get('records'),list)
with urllib.request.urlopen('http://127.0.0.1:13001/',timeout=6) as r:html=r.read(400000).decode('utf8','replace')
assert 'id="roundResultsOnlyCard"' in html
assert '/api/deepseek-round-results' in html
assert 'id="roundStatsCard"' not in html
with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=5) as r:choice=json.load(r)
assert choice.get('model')=='DEEPSEEK_5M_V1'
print('ROUND_RESULTS_ALIYUN_DEPLOY_VERIFIED=true')
print('ROUND_RESULTS_FRONTEND_CARD_AND_API_OK=true')
print('ROUND_RESULTS_NEW_RECORD_COUNT',a['summary']['rounds'])
print('ROUND_RESULTS_NEW_OFFICIAL_SETTLED',a['summary']['settled'])
print('ROUND_RESULTS_5S_ONE_CALL_NO_LEARNING_UNCHANGED=true')
print('ROUND_RESULTS_USER_FOLLOW_REMAINS_OFF=true')
PY
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
test "$(systemctl is-active zl-prediction-trade.service)" = active
test "$(systemctl is-active zl-futures-bot-paper.service)" = active
test "$(systemctl is-active zl-deepseek-shadow15-online.service)" != active
echo 'ROUND_RESULTS_NO_SHADOW_TRAINING_OR_TRADE_CHANGE=true'
echo "ROUND_RESULTS_ROLLBACK_BACKUP=$archive"
trap - ERR
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[0-9a-f]{40}',sha):
  print('ROUND_RESULTS_BAD_DEPLOY_REF');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 id=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
  name='zl-5s-official-round-results-readonly-ui',type='RunShellScript',working_user='root',
  command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=180)).body.invoke_id
 for _ in range(105):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=id)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:s=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:s=str(r.output)
   print('ROUND_RESULTS_ALIYUN_RELEASE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(s[-11000:])
   return 0 if int(r.exit_code)==0 else 5
 print('ROUND_RESULTS_RELEASE_NOT_CONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

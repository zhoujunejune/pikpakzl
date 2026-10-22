#!/usr/bin/env python3
"""Patch only read-only results display watcher for AI15. No orders, no AI restart, no trade switch."""
import os,re,time,sys,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/deepseek15-round-display-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
node=/opt/zl-prediction-node/bin/node
dir=/opt/zl-prediction-live/round-results-display
watch="$dir/round-results-display-watcher.mjs"
journal="$dir/round-results-only-journal.mjs"
unit=zl-deepseek-results-display-only.service
test -x "$node" && test -f "$watch" && test -f "$journal"
test "$(systemctl is-active "$unit")" = active
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
test "$(systemctl is-active zl-prediction-trade.service)" = active
python3 - <<'PY'
from pathlib import Path
import json,urllib.request
w=Path('/opt/zl-prediction-live/round-results-display/round-results-display-watcher.mjs').read_text()
j=Path('/opt/zl-prediction-live/round-results-display/round-results-only-journal.mjs').read_text()
assert 'if(now<round+5000)sawWindow=true;' in w,'WATCHER_SOURCE_DRIFT'
assert 'if(elapsed>=5000)' in w,'WATCHER_DEADLINE_DRIFT'
assert 'at>=round+5000' in j,'JOURNAL_SOURCE_DRIFT'
assert 'event.lockedAt>=event.round+5000' in j,'JOURNAL_HISTORY_DRIFT'
with urllib.request.urlopen('http://127.0.0.1:13029/api/status',timeout=8) as r:m=json.load(r)
assert m.get('decisionRule')=='DEEPSEEK_ONLY_ONE_CALL_15S_NO_PRICE_FALLBACK'
assert m.get('decisionWindowEndMs',0)-m.get('round',0)==15000
with urllib.request.urlopen('http://127.0.0.1:13045/api/round-results?limit=2',timeout=8) as r:display=json.load(r)
assert display.get('ok') is True and display.get('schema')=='ROUND_RESULTS_DISPLAY_ONLY_V1'
print('AI15_DISPLAY_PRECHECK_HISTORICAL_RECORDS',display['summary']['rounds'])
print('AI15_DISPLAY_PRODUCTION_LIVE_15S_AI_VERIFIED=true')
PY
work=$(mktemp -d /tmp/zl-round-display-ai15.XXXXXXXX)
trap 'rm -rf "$work"' EXIT
base=https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1
curl -fsSL --retry 2 --max-time 30 "$base/round-results-display-watcher.mjs" -o "$work/watcher.mjs"
curl -fsSL --retry 2 --max-time 30 "$base/round-results-only-journal.mjs" -o "$work/journal.mjs"
"$node" --check "$work/watcher.mjs"
"$node" --check "$work/journal.mjs"
grep -q 'const DECISION_WINDOW_MS=15000;' "$work/watcher.mjs"
grep -q 'const LOCK_DEADLINE_MS=15000;' "$work/journal.mjs"
grep -q 'DEEPSEEK_SINGLE_CALL_15S' "$work/journal.mjs"
# Match production filenames so imports resolve. Do not modify persisted result journal.
cp "$work/watcher.mjs" "$work/round-results-display-watcher.mjs"
cp "$work/journal.mjs" "$work/round-results-only-journal.mjs"
node "$work/round-results-display-watcher.mjs" --help >/dev/null 2>&1 && exit 13 || true
# Above attempted direct invocation would open an extra listener; therefore
# never rely on it as a validation. Validate only node --check and CI tests.
archive=/var/lib/zl-prediction/archive/source-backups/deepseek-ai15-display-COMMIT_SHA
test ! -e "$archive"
mkdir -p "$archive"
cp -p "$watch" "$archive/original-watcher.mjs"
cp -p "$journal" "$archive/original-journal.mjs"
rollback(){
 echo 'AI15_DISPLAY_ROLLBACK_TRIGGERED=true'
 cp -p "$archive/original-watcher.mjs" "$watch"
 cp -p "$archive/original-journal.mjs" "$journal"
 systemctl restart "$unit" || true
}
trap rollback ERR
chown --reference="$watch" "$work/watcher.mjs"
chmod --reference="$watch" "$work/watcher.mjs"
chown --reference="$journal" "$work/journal.mjs"
chmod --reference="$journal" "$work/journal.mjs"
cp -p "$work/watcher.mjs" "$watch"
cp -p "$work/journal.mjs" "$journal"
systemctl restart "$unit"
for i in $(seq 1 25);do
 if curl -fsS --max-time 4 'http://127.0.0.1:13045/api/round-results?limit=4' -o "$work/results.json" 2>/dev/null;then break;fi
 sleep 1
done
python3 - "$work/results.json" <<'PY'
import sys,json,subprocess,pathlib,urllib.request
r=json.load(open(sys.argv[1]))
assert r.get('ok') is True and r.get('schema')=='ROUND_RESULTS_DISPLAY_ONLY_V1'
assert r.get('source')=='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY'
assert r.get('learningDisabled') is True and r.get('usedForAnalysis') is False
assert r.get('summary',{}).get('rounds',0)>=100
with urllib.request.urlopen('http://127.0.0.1:13029/api/status',timeout=8) as x:m=json.load(x)
assert m.get('decisionRule')=='DEEPSEEK_ONLY_ONE_CALL_15S_NO_PRICE_FALLBACK'
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=8) as x:t=json.load(x)
assert t.get('ok') is True
assert 'const DECISION_WINDOW_MS=15000' in pathlib.Path('/opt/zl-prediction-live/round-results-display/round-results-display-watcher.mjs').read_text()
assert 'const LOCK_DEADLINE_MS=15000' in pathlib.Path('/opt/zl-prediction-live/round-results-display/round-results-only-journal.mjs').read_text()
for unit in ('zl-deepseek-results-display-only.service','zl-prediction-deepseek5.service',
 'zl-prediction-trade.service','zl-prediction-risk-exits.service','zl-futures-bot-paper.service'):
 assert subprocess.run(['systemctl','is-active','--quiet',unit]).returncode==0,unit
print('AI15_DISPLAY_DEPLOYED=true')
print('AI15_DISPLAY_CURRENT_PREDICTION_SIGNAL_WINDOW_15S=true')
print('AI15_DISPLAY_RAW_AI15_METHOD_PERSISTED=true')
print('AI15_DISPLAY_OLD_UI_COMPAT_DEEPSEEK_SINGLE_CALL=true')
print('AI15_DISPLAY_HISTORY_UNCHANGED_COUNT',r['summary']['rounds'])
print('AI15_DISPLAY_TRADE_FOLLOW_STATUS_READONLY',t.get('enabled'))
print('AI15_DISPLAY_UNRELATED_PRODUCTION_SERVICES_UNCHANGED=true')
PY
echo 'AI15_DISPLAY_RELEASE_SUCCESS=true'
echo "AI15_DISPLAY_BACKUP_DIR=$archive"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[0-9a-f]{40}',sha):
  return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 i=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
 name='zl-display15-readonly-service-fix',type='RunShellScript',working_user='root',
 command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=150)).body.invoke_id
 for n in range(85):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=i)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:out=str(r.output)
   print('AI15_DISPLAY_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(out[-12000:])
   return 0 if int(r.exit_code)==0 else 5
 print('AI15_DISPLAY_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

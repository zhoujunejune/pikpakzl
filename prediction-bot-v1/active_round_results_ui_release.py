#!/usr/bin/env python3
"""Repair only the running Alibaba control-shell UI + read-only endpoint."""
import os,re,time,sys,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/deepseek5-results-public-visibility-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
node=/opt/zl-prediction-node/bin/node
live=/opt/zl-prediction-live/src/railway-diagnostic/control-shell.mjs
test -x "$node" && test -f "$live"
for u in zl-prediction-trade.service zl-prediction-deepseek5.service zl-futures-bot-paper.service;do
 test "$(systemctl is-active "$u")" = active
done
python3 - <<'PY'
import urllib.request,json
def get(p,route):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(p,route),timeout=5) as r:return json.load(r)
s=get(13029,'/api/status');t=get(13001,'/api/status');sel=get(13001,'/api/order-signal-model')
h=get(13029,'/api/round-results?limit=2')
assert s.get('model')=='DEEPSEEK_5M_V1'
assert s.get('maxCallsPerRound')==1 and s.get('decisionWindowEndMs',0)-s.get('round',0)==5000
assert s.get('learningDisabled') is True and s.get('standaloneRoundResultsEnabled') is True
assert h.get('ok') is True and h.get('schema')=='ROUND_RESULTS_DISPLAY_ONLY_V1'
assert t.get('enabled') is False,'FOLLOW_RUNNING_SKIP_RESTART'
assert sel.get('model')=='DEEPSEEK_5M_V1'
assert (t.get('pendingAction') or {}).get('state') not in ('QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN')
print('ACTIVE_RESULTS_FIX_MODEL_AND_FOLLOW_GUARDS_OK=true')
PY
python3 - <<'PY'
from pathlib import Path
p=Path('/opt/zl-prediction-live/src/railway-diagnostic/control-shell.mjs')
s=p.read_text()
assert 'function injectRiskControls(html)' in s
assert 'let inner = null;' in s
assert 'riskControlsAnchor' in s
assert "url.pathname === '/api/risk-control'" in s
assert 'roundResultsOnlyCard' not in s,'ALREADY_PATCHED_ABORT'
print('ACTIVE_RESULTS_FIX_CONTROL_SOURCE_CONFIRMED=true')
PY
work=$(mktemp -d /tmp/zl-results-actual-ui-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
base="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1"
curl -fsSL --retry 2 --max-time 30 "$base/patch_active_round_results_control.py" -o "$work/patch.py"
curl -fsSL --retry 2 --max-time 30 "$base/patch_round_results_panel.py" -o "$work/donor.py"
python3 "$work/patch.py" "$work/donor.py" "$live" "$work/control-shell.mjs"
"$node" --check "$work/control-shell.mjs"
backup="/var/lib/zl-prediction/archive/source-backups/deepseek-results-actual-web-COMMIT_SHA"
mkdir -p "$backup"
cp -p "$live" "$backup/control-shell.mjs"
restore(){
 echo 'ACTIVE_RESULTS_FIX_ROLLBACK=true'
 cp -p "$backup/control-shell.mjs" "$live"
 systemctl restart zl-prediction-trade.service || true
}
trap restore ERR
python3 - <<'PY'
import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=5) as r:t=json.load(r)
assert t.get('enabled') is False,'OWNER_FOLLOW_NOW_ON_ABORT'
assert (t.get('pendingAction') or {}).get('state') not in ('QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN')
PY
chown --reference="$live" "$work/control-shell.mjs"
chmod --reference="$live" "$work/control-shell.mjs"
cp -p "$work/control-shell.mjs" "$live"
systemctl restart zl-prediction-trade.service
for i in $(seq 1 24);do
 if curl -fsS --max-time 3 http://127.0.0.1:13001/ -o "$work/actual.html" 2>/dev/null &&
    curl -fsS --max-time 3 http://127.0.0.1:13019/ -o "$work/nav.html" 2>/dev/null &&
    curl -fsS --max-time 3 http://127.0.0.1:13001/api/deepseek-round-results?limit=3 -o "$work/ui.json" 2>/dev/null;then
    break
 fi
 sleep 2
done
test -s "$work/actual.html"
test -s "$work/nav.html"
test -s "$work/ui.json"
python3 - "$work/actual.html" "$work/nav.html" "$work/ui.json" <<'PY'
import sys,json,urllib.request
from html.parser import HTMLParser
class Scanner(HTMLParser):
 def __init__(self):super().__init__();self.ids=[]
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if a.get('id'):self.ids.append(a.get('id'))
for html in sys.argv[1:3]:
 s=open(html).read();p=Scanner();p.feed(s)
 assert p.ids.count('roundResultsOnlyCard')==1,('WEB_CARD_NOT_VISIBLE',html)
 assert p.ids.count('rrRows')==1
 assert '5分钟预测' in s and '/api/deepseek-round-results' in s
 assert 'riskControlsAnchor' in s
 assert 'panel-client.js' in s
 assert s.index('id="roundResultsOnlyCard"') < s.index('id="riskControlsAnchor"')
 data=json.load(open(sys.argv[3]))
 assert data.get('ok') is True and data.get('schema')=='ROUND_RESULTS_DISPLAY_ONLY_V1'
 assert data.get('learningDisabled') is True and data.get('usedForAnalysis') is False
 assert isinstance(data.get('records'),list)
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=5) as r:t=json.load(r)
assert t.get('enabled') is False
with urllib.request.urlopen('http://127.0.0.1:13029/api/status',timeout=5) as r:m=json.load(r)
assert m.get('maxCallsPerRound')==1 and m.get('decisionWindowEndMs',0)-m.get('round',0)==5000
print('RESULTS_ACTUAL_WEB_13001_VISIBLE=true')
print('RESULTS_ACTUAL_PUBLIC_NAV_13019_VISIBLE=true')
print('RESULTS_OFFICIAL_READONLY_API_OK=true')
print('RESULTS_EXISTING_TRADE_BUTTONS_UNCHANGED=true')
print('RESULTS_FOLLOW_REMAINS_OFF=true')
print('RESULTS_NO_LEARNING_5S_UNCHANGED=true')
print('RESULTS_CURRENT_ROUNDS',data['summary']['rounds'])
print('RESULTS_CURRENT_SETTLED',data['summary']['settled'])
PY
for u in zl-prediction-deepseek5.service zl-prediction-trade.service zl-futures-bot-paper.service;do
 test "$(systemctl is-active "$u")" = active
done
# HTTPS authentication stays intact and the new UI remains on the protected page.
site=prediction.47-237-188-69.sslip.io
code=$(curl -ks -o /dev/null -w '%{http_code}' --resolve "$site:443:127.0.0.1" "https://$site/")
test "$code" = 401
echo 'RESULTS_PUBLIC_HTTPS_AUTH_STILL_PROTECTED=true'
echo "RESULTS_WEB_BACKUP=$backup"
trap - ERR
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[0-9a-f]{40}',sha):
  print('ACTIVE_RESULTS_FIX_INVALID_REF');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 id=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
 name='zl-fix-live-prediction-results-html',type='RunShellScript',working_user='root',
 command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=180)).body.invoke_id
 for _ in range(105):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(
  region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=id)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:s=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:s=str(r.output)
   print('RESULTS_PUBLIC_FIX_RELEASE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(s[-11000:])
   return 0 if int(r.exit_code)==0 else 5
 print('RESULTS_PUBLIC_FIX_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

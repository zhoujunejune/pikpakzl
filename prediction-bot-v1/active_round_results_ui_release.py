#!/usr/bin/env python3
"""Put visible results on actual prediction frontend with independent read-only watcher.
Never change the 5s model, trading code, credentials, or futures bot.
"""
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/deepseek5-results-public-visibility-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
node=/opt/zl-prediction-node/bin/node
control=/opt/zl-prediction-live/src/railway-diagnostic/control-shell.mjs
dir=/opt/zl-prediction-live/round-results-display
unit=/etc/systemd/system/zl-deepseek-results-display-only.service
test -x "$node" && test -f "$control"
for u in zl-prediction-trade.service zl-prediction-deepseek5.service zl-futures-bot-paper.service;do
 test "$(systemctl is-active "$u")" = active
done
python3 - <<'PY'
import urllib.request,json,pathlib
def get(p,uri):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(p,uri),timeout=7) as r:return json.load(r)
s=get(13029,'/api/status');t=get(13001,'/api/status');q=get(13001,'/api/order-signal-model')
assert s.get('model')=='DEEPSEEK_5M_V1' and s.get('providerModel')=='deepseek-flash'
assert s.get('maxCallsPerRound')==1 and s.get('decisionWindowEndMs',0)-s.get('round',0)==5000
assert s.get('learningDisabled') is True and s.get('configured') is True
assert t.get('enabled') is False,'OWNER_FOLLOW_ACTIVE_NO_RESTART'
assert (t.get('pendingAction') or {}).get('state') not in (
 'QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN')
assert q.get('model')=='DEEPSEEK_5M_V1'
c=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic/control-shell.mjs').read_text()
assert 'function injectRiskControls(html) {' in c
assert 'roundResultsOnlyCard' not in c,'ALREADY_PRESENT_REQUIRES_DIFFERENT_DEPLOY'
print('DISPLAY_ONLY_UI_PRECHECK_REAL_FAST5_FOLLOW_OFF=true')
PY
work=$(mktemp -d /tmp/zl-display-real-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
base="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1"
for item in patch_active_round_results_control.py patch_round_results_panel.py round-results-only-journal.mjs round-results-display-watcher.mjs;do
 curl -fsSL --retry 2 --max-time 30 "$base/$item" -o "$work/$item"
done
python3 "$work/patch_active_round_results_control.py" "$work/patch_round_results_panel.py" "$control" "$work/control-shell.mjs"
"$node" --check "$work/control-shell.mjs"
"$node" --check "$work/round-results-only-journal.mjs"
"$node" --check "$work/round-results-display-watcher.mjs"
grep -q 'port:13045' "$work/control-shell.mjs"
grep -q 'READ_ONLY' "$work/round-results-display-watcher.mjs"
mkdir -p /var/lib/zl-prediction/deepseek5
backup="/var/lib/zl-prediction/archive/source-backups/results-public-real-COMMIT_SHA"
mkdir -p "$backup"
cp -p "$control" "$backup/control-shell.mjs"
test ! -f "$unit" || { echo 'DISPLAY_SERVICE_UNIT_ALREADY_EXISTS_ABORT';exit 19; }
test ! -e "$dir/round-results-display-watcher.mjs" || { echo 'DISPLAY_SERVICE_FILE_ALREADY_EXISTS_ABORT';exit 19; }
rollback(){
 echo 'DISPLAY_ONLY_UI_ROLLBACK=true'
 cp -p "$backup/control-shell.mjs" "$control"
 systemctl stop zl-deepseek-results-display-only.service || true
 systemctl disable zl-deepseek-results-display-only.service || true
 rm -f "$unit"
 systemctl daemon-reload || true
 systemctl restart zl-prediction-trade.service || true
}
trap rollback ERR
python3 - <<'PY'
import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=6) as r:t=json.load(r)
assert t.get('enabled') is False,'FOLLOW_TOGGLED_ON_ABORT'
assert (t.get('pendingAction') or {}).get('state') not in (
 'QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN')
PY
mkdir -p "$dir"
install -m 0644 "$work/round-results-only-journal.mjs" "$dir/round-results-only-journal.mjs"
install -m 0644 "$work/round-results-display-watcher.mjs" "$dir/round-results-display-watcher.mjs"
cat > "$unit" <<'EOF'
[Unit]
Description=Independent read-only DeepSeek 5-minute outcome dashboard
After=network-online.target zl-prediction-deepseek5.service
Wants=network-online.target
[Service]
Type=simple
User=root
WorkingDirectory=/opt/zl-prediction-live/round-results-display
Environment=RESULTS_DISPLAY_PORT=13045
Environment=RESULTS_JOURNAL_FILE=/var/lib/zl-prediction/deepseek5/display-round-results.ndjson
ExecStart=/opt/zl-prediction-node/bin/node /opt/zl-prediction-live/round-results-display/round-results-display-watcher.mjs
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/zl-prediction/deepseek5
MemoryMax=96M
CPUQuota=10%
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now zl-deepseek-results-display-only.service
for i in $(seq 1 16);do
 if curl -fsS --max-time 2 "http://127.0.0.1:13045/api/round-results?limit=2" -o "$work/rounds.json" 2>/dev/null;then break;fi
 sleep 1
done
test -s "$work/rounds.json"
python3 - "$work/rounds.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert r.get('ok') is True and r.get('schema')=='ROUND_RESULTS_DISPLAY_ONLY_V1'
assert r.get('learningDisabled') is True and r.get('usedForAnalysis') is False
print('DISPLAY_READONLY_SEPARATE_SERVICE_START_OK=true')
PY
chown --reference="$control" "$work/control-shell.mjs"
chmod --reference="$control" "$work/control-shell.mjs"
cp -p "$work/control-shell.mjs" "$control"
systemctl restart zl-prediction-trade.service
for i in $(seq 1 28);do
 if curl -fsS --max-time 3 http://127.0.0.1:13001/ -o "$work/page.html" 2>/dev/null &&
    curl -fsS --max-time 3 http://127.0.0.1:13019/ -o "$work/nav.html" 2>/dev/null &&
    curl -fsS --max-time 3 'http://127.0.0.1:13001/api/deepseek-round-results?limit=4' -o "$work/ui.json" 2>/dev/null &&
    curl -fsS --max-time 3 'http://127.0.0.1:13001/api/status' -o "$work/trade.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$work/page.html" && test -s "$work/nav.html" && test -s "$work/ui.json"
python3 - "$work/page.html" "$work/nav.html" "$work/ui.json" "$work/trade.json" <<'PY'
import sys,json,urllib.request
from html.parser import HTMLParser
class P(HTMLParser):
 def __init__(self):super().__init__();self.ids=[]
 def handle_starttag(self,t,a):
  x=dict(a)
  if x.get('id'):self.ids.append(x['id'])
for n in sys.argv[1:3]:
 html=open(n).read();p=P();p.feed(html)
 assert p.ids.count('roundResultsOnlyCard')==1,('RESULTS_CARD_MISSING',n)
 assert p.ids.count('rrRows')==1
 assert '5分钟预测' in html and '/api/deepseek-round-results' in html
 assert 'riskControlsAnchor' in html
 assert 'panel-client.js' in html
 assert html.index('id="roundResultsOnlyCard"')<html.index('id="riskControlsAnchor"')
r=json.load(open(sys.argv[3]));t=json.load(open(sys.argv[4]))
assert r.get('ok') is True and r.get('schema')=='ROUND_RESULTS_DISPLAY_ONLY_V1'
assert r.get('usedForAnalysis') is False and isinstance(r.get('records'),list)
assert t.get('enabled') is False
with urllib.request.urlopen('http://127.0.0.1:13029/api/status',timeout=6) as rr:m=json.load(rr)
assert m.get('maxCallsPerRound')==1
assert m.get('learningDisabled') is True
assert m.get('decisionWindowEndMs',0)-m.get('round',0)==5000
print('PUBLIC_RESULTS_CARD_13001_VISIBLE=true')
print('PUBLIC_RESULTS_CARD_13019_VISIBLE=true')
print('PUBLIC_RESULTS_READONLY_API_OK=true')
print('PUBLIC_RESULTS_MODEL_5S_ONE_CALL_UNCHANGED=true')
print('PUBLIC_RESULTS_FOLLOW_SWITCH_OFF=true')
print('PUBLIC_RESULTS_ROUNDS',r['summary']['rounds'])
print('PUBLIC_RESULTS_SETTLED',r['summary']['settled'])
PY
site=prediction.47-237-188-69.sslip.io
test "$(curl -ks -o /dev/null -w '%{http_code}' --resolve "$site:443:127.0.0.1" "https://$site/")" = 401
test "$(systemctl is-active zl-deepseek-results-display-only.service)" = active
for unit in zl-prediction-deepseek5.service zl-prediction-trade.service zl-futures-bot-paper.service;do
 test "$(systemctl is-active "$unit")" = active
done
echo 'PUBLIC_RESULTS_AUTH_AND_ALL_SERVICES_GOOD=true'
echo "PUBLIC_RESULTS_RECOVERY_BACKUP=$backup"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
  print('DISPLAY_ONLY_UI_INVALID_REF');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 id=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
 name='zl-fix-active-prediction-results-panel',type='RunShellScript',
 working_user='root',command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=210)).body.invoke_id
 for _ in range(115):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=id)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:s=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:s=str(r.output)
   print('PUBLIC_RESULTS_RELEASE',r.invocation_status,'EXIT',r.exit_code)
   print(s[-13000:])
   return 0 if int(r.exit_code)==0 else 5
 print('PUBLIC_RESULTS_RELEASE_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

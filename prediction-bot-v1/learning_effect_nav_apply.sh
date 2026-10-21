#!/bin/bash
set -Eeuo pipefail
: "${LEARNING_NAV_SHA:?}"
test "$(id -u)" -eq 0
panel=/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs
node=/opt/zl-prediction-node/bin/node
test -f "$panel" && test -x "$node"
python3 - <<'PY'
import json,urllib.request
def get(p,e):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(p,e),timeout=7) as x:return json.load(x)
a=get(13029,'/api/status');b=get(13029,'/api/learning-effect');t=get(13001,'/api/status')
assert a.get('maxCallsPerRound')==6 and a.get('decisionWindowEndMs',0)-a.get('round',0)==25000
assert b.get('ok') and b.get('hardDecisionDeadlineMs')==25000
assert t.get('enabled') is False
print('NAV_PRECHECK_MODEL_25S6_AND_FOLLOW_OFF=true')
PY
tmp=$(mktemp -d /tmp/zl-learning-nav-XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$LEARNING_NAV_SHA/prediction-bot-v1/learning_effect_nav_patch.py" -o "$tmp/patch.py"
python3 "$tmp/patch.py" "$panel" "$tmp/patched.mjs"
"$node" --check "$tmp/patched.mjs"
backup=/var/lib/zl-prediction/archive/source-backups/learning-top-nav-$LEARNING_NAV_SHA
mkdir -p "$backup"
cp -p "$panel" "$backup/panel-stats-shell.mjs"
restore(){
 cp -p "$backup/panel-stats-shell.mjs" "$panel"
 systemctl restart zl-prediction-trade.service || true
 echo 'LEARNING_NAV_ROLLED_BACK=true'
}
trap restore ERR
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as x:t=json.load(x)
assert t.get('enabled') is False
PY
cp -p "$tmp/patched.mjs" "$panel"
systemctl restart zl-prediction-trade.service
for i in $(seq 1 25);do
 if curl -fsS --max-time 3 http://127.0.0.1:13001/ -o "$tmp/page.html" 2>/dev/null &&
 curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$tmp/status.json" 2>/dev/null;then break;fi
 sleep 2
done
python3 - "$tmp/page.html" "$tmp/status.json" <<'PY'
from pathlib import Path
import json,sys
html=Path(sys.argv[1]).read_text();t=json.load(open(sys.argv[2]))
assert 'href="#learningEvidenceCard"' in html
assert 'id="learningEvidenceCard"' in html
assert 'AI学习效果 · 查看历史经验与错误复盘' in html
assert t.get('enabled') is False
print('LEARNING_NAV_LINK_AND_TARGET_RENDERED=true')
print('LEARNING_NAV_FOLLOW_OFF=true')
PY
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
test "$(systemctl is-active zl-prediction-trade.service)" = active
echo 'LEARNING_NAV_PUBLISHED=true'
trap - ERR

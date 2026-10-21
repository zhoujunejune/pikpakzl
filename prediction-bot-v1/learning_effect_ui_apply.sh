#!/bin/bash
set -Eeuo pipefail
: "${UI_DEPLOY_SHA:?}"
test "$(id -u)" = 0
panel=/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs
node=/opt/zl-prediction-node/bin/node
test -f "$panel" && test -x "$node"
python3 - <<'PY'
import json,urllib.request
def get(p,u):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(p,u),timeout=7) as r:return json.load(r)
a=get(13029,'/api/status');v=get(13029,'/api/learning-effect');t=get(13001,'/api/status')
assert a.get('maxCallsPerRound')==6 and a.get('decisionWindowEndMs',0)-a.get('round',0)==25000
assert v.get('ok') is True and v.get('hardDecisionDeadlineMs')==25000 and v.get('additionalApiCalls')==0
assert t.get('enabled') is False,'FOLLOW_ON_ABORT'
print('LEARNING_UI_PREFLIGHT_25S6=true')
print('LEARNING_UI_FOLLOW_OFF=true')
PY
tmp=$(mktemp -d /tmp/zl-learning-ui-XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$UI_DEPLOY_SHA/prediction-bot-v1/learning_effect_ui_patch.py" -o "$tmp/patch.py"
python3 -m py_compile "$tmp/patch.py"
python3 "$tmp/patch.py" "$panel" "$tmp/new.mjs"
"$node" --check "$tmp/new.mjs"
grep -q 'const SELECTIVE30_ORDER_DEADLINE_MS = 30000;' /opt/zl-prediction-live/src/railway-diagnostic/wrapper.mjs
backup="/var/lib/zl-prediction/archive/source-backups/learning-ui-$UI_DEPLOY_SHA"
mkdir -p "$backup"
cp -p "$panel" "$backup/panel-stats-shell.mjs"
rollback(){
 echo 'LEARNING_UI_ROLLBACK=true'
 cp -p "$backup/panel-stats-shell.mjs" "$panel"
 systemctl restart zl-prediction-trade.service || true
}
trap rollback ERR
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:s=json.load(r)
assert s.get('enabled') is False,'FOLLOW_TOGGLED_ABORT'
PY
cp -p "$tmp/new.mjs" "$panel"
systemctl restart zl-prediction-trade.service
for i in $(seq 1 25);do
 if curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$tmp/trade.json" 2>/dev/null &&
    curl -fsS --max-time 3 http://127.0.0.1:13029/api/learning-effect -o "$tmp/learning.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$tmp/trade.json" && test -s "$tmp/learning.json"
python3 - "$tmp/trade.json" "$tmp/learning.json" <<'PY'
import json,sys
trade=json.load(open(sys.argv[1]));learning=json.load(open(sys.argv[2]))
assert trade.get('enabled') is False
assert learning.get('ok') is True and learning.get('controlledComparisonVerdict')=='NOT_PROVEN'
assert learning.get('maxCallsPerRound')==6
print('LEARNING_UI_SERVICE_HEALTHY=true')
print('LEARNING_UI_FOLLOW_STILL_OFF=true')
PY
grep -q 'id="learningEvidenceCard"' "$panel"
grep -q 'renderDeepSeekLearningEvidence' "$panel"
grep -q "var expired=Date.now()>=currentRound+25000;" "$panel"
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
test "$(systemctl is-active zl-prediction-trade.service)" = active
echo 'LEARNING_UI_PUBLISHED=true'
echo "LEARNING_UI_BACKUP=$backup"
trap - ERR

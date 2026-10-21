#!/bin/bash
# Real production upgrade, no shadow model, no simulated trades.
set -Eeuo pipefail
: "${VALUE_SHA:?}"
test "$(id -u)" -eq 0
root=/opt/zl-prediction-live/src/railway-diagnostic
wrapper="$root/wrapper.mjs"
helper="$root/live-trade-value-policy.mjs"
node=/opt/zl-prediction-node/bin/node
test -f "$wrapper" && test -x "$node"
python3 - <<'PY'
import json,urllib.request
def get(port,p):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,p),timeout=8) as r:return json.load(r)
m=get(13029,'/api/status')
t=get(13001,'/api/status')
choice=get(13001,'/api/order-signal-model')
assert m.get('model')=='DEEPSEEK_5M_V1' and m.get('maxCallsPerRound')==6
assert m.get('decisionWindowEndMs',0)-m.get('round',0)==25000
assert choice.get('model')=='DEEPSEEK_5M_V1'
assert t.get('enabled') is False,'AUTO_FOLLOW_ACTIVE_OWNER_MUST_PAUSE'
print('VALUE_PRECHECK_FOLLOW_OFF=true')
print('VALUE_LIVE_MODEL_25S6=true')
PY
before=ff35b081191f54229cc501da97df913a0e192fd3115806a3ba65693eef15c0aa
test "$(sha256sum "$wrapper" | awk '{print $1}')" = "$before" || {
 echo 'LIVE_WRAPPER_SOURCE_DRIFT_ABORT';exit 15;
}
tmp=$(mktemp -d /tmp/zl-value-gate-XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT
base="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$VALUE_SHA/prediction-bot-v1"
for f in patch_live_trade_value.py live-trade-value-policy.mjs;do
 curl -fsSL --max-time 25 "$base/$f" -o "$tmp/$f"
done
python3 "$tmp/patch_live_trade_value.py" "$wrapper" "$tmp/wrapper-new.mjs"
"$node" --check "$tmp/wrapper-new.mjs"
"$node" --check "$tmp/live-trade-value-policy.mjs"
backup=/var/lib/zl-prediction/archive/source-backups/deepseek-live-value-$VALUE_SHA
mkdir -p "$backup"
cp -p "$wrapper" "$backup/wrapper.mjs"
if test -f "$helper";then cp -p "$helper" "$backup/old-helper.mjs";fi
rollback(){
 echo 'VALUE_RELEASE_ROLLBACK=true'
 cp -p "$backup/wrapper.mjs" "$wrapper"
 if test -f "$backup/old-helper.mjs";then cp -p "$backup/old-helper.mjs" "$helper";else rm -f "$helper";fi
 systemctl restart zl-prediction-trade.service || true
}
trap rollback ERR
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=8) as r:t=json.load(r)
assert t.get('enabled') is False,'AUTO_FOLLOW_REENABLED_DURING_RELEASE'
PY
cp -p "$tmp/live-trade-value-policy.mjs" "$helper"
cp -p "$tmp/wrapper-new.mjs" "$wrapper"
systemctl restart zl-prediction-trade.service
for i in $(seq 1 25);do
 if curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$tmp/status" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$tmp/status"
python3 - "$tmp/status" <<'PY'
import json,sys,urllib.request
t=json.load(open(sys.argv[1]))
assert t.get('enabled') is False
with urllib.request.urlopen('http://127.0.0.1:13029/api/status',timeout=8) as r:m=json.load(r)
assert m.get('maxCallsPerRound')==6
assert m.get('decisionWindowEndMs',0)-m.get('round',0)==25000
assert m.get('providerModel')=='deepseek-flash'
print('LIVE_TRADE_VALUE_PRODUCTION_HEALTHY=true')
print('LIVE_FOLLOW_REMAINS_OFF=true')
print('LIVE_25S_MAX6_UNCHANGED=true')
PY
generated="$root/trade-control-fixed.mjs"
test -f "$generated"
grep -q 'decideLiveTradeValue' "$generated"
grep -q 'deepseek_live_trade_value' "$generated"
test "$(systemctl is-active zl-prediction-trade.service)" = active
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
echo 'LIVE_PRODUCTION_TRADE_VALUE_GATE_PUBLISHED=true'
echo "LIVE_PRODUCTION_BACKUP=$backup"
trap - ERR

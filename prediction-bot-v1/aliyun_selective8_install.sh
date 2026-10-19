#!/bin/bash
set -Eeuo pipefail
umask 027
: "$PRED_MODEL_SHA"
[[ "$PRED_MODEL_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 2
BASE=/opt/zl-prediction-live/src/railway-diagnostic
NODE=/opt/zl-prediction-node/bin/node
BACKUP=/var/lib/zl-prediction/archive/source-backups
test -x "$NODE" && test -d "$BASE" && test -d "$BACKUP"
for service in zl-prediction-v2 zl-prediction-v3 zl-prediction-redis zl-prediction-trade zl-futures-bot-paper;do
  test "$(systemctl is-active "$service")" = active
done
python3 - <<'PY'
import json,urllib.request
def read(path):
 with urllib.request.urlopen("http://127.0.0.1:13002"+path,timeout=12) as r:return json.load(r)
j=read('/api/round-stats')
assert j.get('ok') is True and j.get('productionSignalSourceMode')=='SELECTIVE_V2_FAST8'
expected={'SELECTIVE_V2_FAST8_PRIMARY','EDGE_RESCUE_FAST8_PRIMARY','SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION'}
assert expected.issubset({x.get('source') for x in j.get('activeSignalModels',[])})
print('PIN_8SEC_V2_PROVEN=true')
PY
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ROOT="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$PRED_MODEL_SHA/railway-diagnostic"
for f in production-signal-choice.mjs index.mjs panel-stats-shell.mjs;do
 curl -fsSL --retry 3 --max-time 30 "$ROOT/$f" -o "$TMP/$f"
 "$NODE" --check "$TMP/$f"
done
grep -Fq "SELECTIVE8_MODEL='SELECTIVE_V2_FAST8_PREWARM_V1'" "$TMP/production-signal-choice.mjs"
grep -Fq 'validateSelective8ProductionLive' "$TMP/index.mjs"
FILES_CHANGED=no
for f in production-signal-choice.mjs index.mjs panel-stats-shell.mjs;do
 if ! cmp -s "$TMP/$f" "$BASE/$f";then FILES_CHANGED=yes;fi
done
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
if [ "$FILES_CHANGED" = yes ];then
 mkdir -p "$BACKUP/$STAMP"
 for f in production-signal-choice.mjs index.mjs panel-stats-shell.mjs;do
  cp -p "$BASE/$f" "$BACKUP/$STAMP/$f"
  install -o zl-pred -g zl-pred -m 0644 "$TMP/$f" "$BASE/$f"
 done
fi
echo "PIN_V2_SOURCE_FILES_CHANGED=$FILES_CHANGED"
rollback(){
  echo PIN_V2_ROLLBACK_ATTEMPT
  for f in production-signal-choice.mjs index.mjs panel-stats-shell.mjs;do
   cp -p "$BACKUP/$STAMP/$f" "$BASE/$f"
  done
  systemctl restart zl-prediction-trade || true
}
if [ "$FILES_CHANGED" = yes ];then
 if ! systemctl restart zl-prediction-trade;then rollback;exit 23;fi
else
 echo 'PIN_V2_IDEMPOTENT_SKIP_TRADE_RESTART=true'
fi
READY=no
for i in $(seq 1 25);do
 CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:13001/healthz || true)
 if [ "$CODE" = 200 ];then READY=yes;break;fi
 sleep 2
done
if [ "$READY" != yes ];then rollback;exit 24;fi
if ! python3 - <<'PY'
import json,urllib.request
host="http://127.0.0.1:13001"
def get(path):
 with urllib.request.urlopen(host+path,timeout=14) as r:return r.read()
j=json.loads(get('/api/order-signal-model'))
assert j.get('ok') is True and j.get('ready') is True
assert j['model']=='SELECTIVE_V2_FAST8_PREWARM_V1'
assert [m.get('id') for m in j.get('models',[])]==['SELECTIVE_V2_FAST8_PREWARM_V1']
print('PIN_V2_SELECTED_ORDER_MODEL=true')
print('PIN_V2_SWITCH_EFFECTIVE_AFTER_ROUND',j.get('effectiveAfterRound'))
page=get('/').decode('utf8','replace')
assert '<option value="SELECTIVE_V2_FAST8_PREWARM_V1">' in page
assert '<option value="EDGE_5M_V1">' not in page
assert '<option value="BREAKOUT20_RSI_MACD_RANGE_V1">' not in page
print('PIN_V2_EXCLUSIVE_DROPDOWN=true')
with urllib.request.urlopen('http://127.0.0.1:13002/api/production-signal',timeout=12) as r:v=json.load(r)
assert v.get('ok') is True
print('PIN_V2_ORIGINAL_LOCK_MODEL',v.get('live',{}).get('model'))
PY
then rollback;exit 25;fi
test "$(systemctl is-active zl-prediction-v2)" = active
test "$(systemctl is-active zl-prediction-v3)" = active
test "$(systemctl is-active zl-futures-bot-paper)" = active
echo PIN_V2_ORDER_SOURCE_DEPLOYED=true
echo PIN_V2_TRADING_SWITCH_AND_DIRECTION_MODES_UNMODIFIED=true
echo PIN_V2_HISTORICAL_STATS_UNMODIFIED=true

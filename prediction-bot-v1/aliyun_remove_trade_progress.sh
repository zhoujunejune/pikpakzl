#!/bin/bash
# Delete five-stage progress UI, preserve trading and order verification core.
set -Eeuo pipefail
umask 027
test "$(id -u)" -eq 0
[[ "$FLOW_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
BASE=/opt/zl-prediction-live/src/railway-diagnostic
FILE="$BASE/panel-stats-shell.mjs"
NODE=/opt/zl-prediction-node/bin/node
ARCHIVE=/var/lib/zl-prediction/archive/source-backups
test -r "$FILE" && test -x "$NODE" && test -d "$ARCHIVE"
for name in zl-prediction-trade zl-prediction-v2 zl-prediction-v3 zl-prediction-redis zl-futures-bot-paper;do
 test "$(systemctl is-active "$name")" = active
done
TEMP=$(mktemp -d)
trap 'rm -rf "$TEMP"' EXIT
curl -fsSL --retry 3 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$FLOW_SOURCE_SHA/railway-diagnostic/panel-stats-shell.mjs" -o "$TEMP/panel-stats-shell.mjs"
"$NODE" --check "$TEMP/panel-stats-shell.mjs"
python3 - "$TEMP/panel-stats-shell.mjs" <<'PY'
import sys
s=open(sys.argv[1]).read()
retired=('liveOrderFlowCard','flowOverall','flowLastOrder','flowPrediction',
 'flowLocked','flowPrepared','flowSubmitted','flowFilled',
 'trade-flow-step','updateOrderSignal','本轮交易进度')
assert not any(x in s for x in retired)
for name in ('refreshActiveDirections','orderSignalModelSelect','directionModeChoices',
 'sourceRateRows','activeFast8EmittedDirection','activeFast8OrderDirection','/api/status'):
 assert name in s,name
print('FLOW_REMOVAL_STATIC_REFS_OK=true')
PY
if cmp -s "$TEMP/panel-stats-shell.mjs" "$FILE";then
 echo 'FLOW_REMOVAL_REDEPLOY_UNNECESSARY=true'
else
 STAMP=$(date -u +%Y%m%dT%H%M%SZ)
 mkdir -p "$ARCHIVE/$STAMP"
 cp -p "$FILE" "$ARCHIVE/$STAMP/panel-stats-shell.mjs"
 install -o zl-pred -g zl-pred -m 0644 "$TEMP/panel-stats-shell.mjs" "$FILE"
 rollback(){
  echo 'FLOW_REMOVAL_ROLLBACK=true'
  cp -p "$ARCHIVE/$STAMP/panel-stats-shell.mjs" "$FILE"
  systemctl restart zl-prediction-trade || true
 }
 if ! systemctl restart zl-prediction-trade;then rollback;exit 21;fi
 READY=no
 for i in $(seq 1 24);do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:13001/healthz || true)
  if [ "$CODE" = 200 ];then READY=yes;break;fi
  sleep 2
 done
 if [ "$READY" != yes ];then rollback;exit 22;fi
fi
python3 - <<'PY'
import json,urllib.request
base='http://127.0.0.1:13001'
def get(path):
 with urllib.request.urlopen(base+path,timeout=15) as r:return r.status,r.read(450000)
code,page=get('/')
assert code==200
for token in (b'liveOrderFlowCard',b'flowOverall',b'flowLastOrder',b'flowSubmitted'):
 assert token not in page,token
for token in (b'activeFast8EmittedDirection',b'directionModeChoices',b'orderSignalModelSelect'):
 assert token in page,token
print('FLOW_REMOVAL_FRONTEND_GONE=true')
code,body=get('/api/status')
assert code==200 and json.loads(body).get('ok') is True
print('FLOW_REMOVAL_SHARED_TRADING_STATUS_PRESERVED=true')
code,body=get('/api/direction-mode')
direction=json.loads(body)
assert code==200 and direction.get('ready') is True
print('FLOW_REMOVAL_DIRECTION_CONFIG_PRESERVED=true')
code,body=get('/api/order-signal-model')
assert code==200 and json.loads(body).get('model')=='SELECTIVE_V2_FAST8_PREWARM_V1'
print('FLOW_REMOVAL_ONLY_PRODUCTION_MODEL_PRESERVED=true')
code,body=get('/api/round-stats')
assert code==200 and json.loads(body).get('productionSignalSourceMode')=='SELECTIVE_V2_FAST8'
print('FLOW_REMOVAL_OFFICIAL_STATS_PRESERVED=true')
PY
test "$(systemctl is-active zl-futures-bot-paper)" = active
test "$(systemctl is-active zl-prediction-v2)" = active
test "$(systemctl is-active zl-prediction-v3)" = active
echo 'FLOW_REMOVAL_COMPLETED=true'
echo 'FLOW_REMOVAL_ORDERS_AND_API_KEYS_UNMODIFIED=true'

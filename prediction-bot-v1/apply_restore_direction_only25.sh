#!/bin/bash
# Restore DeepSeek 25s UP/DOWN only; orders use original verified signal+fresh Binance quote.
# Do not change owner follow switch, do not touch real trades during active following.
set -Eeuo pipefail
: "$RESTORE_SHA"
test -n "$RESTORE_SHA" && test "$(id -u)" -eq 0
app=/opt/zl-prediction-live/deepseek5
trade=/opt/zl-prediction-live/src/railway-diagnostic
node=/opt/zl-prediction-node/bin/node
preUpgrade=/var/lib/zl-prediction/archive/source-backups/deepseek-direct25-9e89a3107b9a9312e3e5d4e9667c0e575de58f57
test -x "$node"
for n in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 test -f "$app/$n" && test -f "$preUpgrade/$n"
done
test -f "$trade/wrapper.mjs"
safestate(){
 python3 - <<'PY'
import json,urllib.request
def get(port,route):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,route),timeout=8) as r:return json.load(r)
d=get(13029,'/api/status');t=get(13001,'/api/status')
c=get(13001,'/api/order-signal-model')
assert d.get('model')=='DEEPSEEK_5M_V1' and d.get('providerModel')=='deepseek-flash'
assert d.get('maxCallsPerRound')==6 and d.get('decisionWindowEndMs',0)-d.get('round',0)==25000
assert c.get('model')=='DEEPSEEK_5M_V1'
assert t.get('enabled') is False,'OWNER_MUST_PAUSE_FOLLOW_BEFORE_RESTART'
assert (t.get('pendingAction') or {}).get('state') not in ('QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN'),'ORDER_IN_FLIGHT_ABORT'
assert (t.get('lastOrder') or {}).get('state') not in ('SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN','RECONCILIATION_REQUIRED'),'LAST_ORDER_UNRESOLVED_ABORT'
print('RESTORE_PRECHECK_FOLLOW_OFF_AND_NO_ACTIVE_ORDER=true')
print('RESTORE_OFFICIAL_SAMPLES',d.get('learning',{}).get('allOfficialSamples'))
PY
}
safestate
# Assert archived files truly restore a direction-only DeepSeek 25s model.
grep -q 'DEADLINE_MS=25000' "$preUpgrade/deepseek-adaptive15-core.mjs"
grep -q 'MAX_AI_CALLS_PER_ROUND=6' "$preUpgrade/deepseek-adaptive15-runner.mjs"
! grep -q 'verifiedBinanceExecutableQuotes' "$preUpgrade/deepseek-adaptive15-core.mjs"
! grep -q 'tradeOpinion' "$preUpgrade/deepseek-adaptive15-runner.mjs"
grep -q 'deepseek_direct_trade_choice' "$trade/wrapper.mjs"
! grep -q 'decideLiveTradeValue' "$trade/wrapper.mjs"
work=$(mktemp -d /tmp/zl-restore-direction25-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
curl -fsSL --max-time 25 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$RESTORE_SHA/prediction-bot-v1/patch_restore_25s_direction_orders.py" \
 -o "$work/patch.py"
python3 "$work/patch.py" "$trade/wrapper.mjs" "$work/wrapper.mjs"
"$node" --check "$work/wrapper.mjs"
for n in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 "$node" --check "$preUpgrade/$n"
done
back="/var/lib/zl-prediction/archive/source-backups/deepseek-direction-only25-$RESTORE_SHA"
mkdir -p "$back"
for n in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 cp -p "$app/$n" "$back/$n"
done
cp -p "$trade/wrapper.mjs" "$back/wrapper.mjs"
rollback(){
 echo RESTORE_25S_ROLLBACK=true
 for n in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
  cp -p "$back/$n" "$app/$n"
 done
 cp -p "$back/wrapper.mjs" "$trade/wrapper.mjs"
 systemctl restart zl-prediction-trade.service || true
 systemctl restart zl-prediction-deepseek5.service || true
}
trap rollback ERR
safestate
for n in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 cp -p "$preUpgrade/$n" "$app/$n"
done
cp -p "$work/wrapper.mjs" "$trade/wrapper.mjs"
systemctl restart zl-prediction-trade.service
systemctl restart zl-prediction-deepseek5.service
for i in $(seq 1 28);do
 if curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$work/trade.json" 2>/dev/null &&
    curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$work/model.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$work/model.json" && test -s "$work/trade.json"
python3 - "$work/trade.json" "$work/model.json" <<'PY'
import json,sys
t=json.load(open(sys.argv[1]));m=json.load(open(sys.argv[2]))
assert t.get('enabled') is False
assert m.get('model')=='DEEPSEEK_5M_V1' and m.get('providerModel')=='deepseek-flash'
assert m.get('maxCallsPerRound')==6 and m.get('decisionWindowEndMs',0)-m.get('round',0)==25000
assert m.get('learning',{}).get('autoFeedback') is True
print('RESTORED_25S6_DIRECTION_ONLY=true')
print('HISTORICAL_OFFICIAL_SAMPLES_PRESERVED',m.get('learning',{}).get('allOfficialSamples'))
print('OWNER_FOLLOW_REMAINS_OFF=true')
PY
test "$(systemctl is-active zl-prediction-trade.service)" = active
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
test -f "$trade/trade-control-fixed.mjs"
! grep -q 'deepseek_direct_trade_choice' "$trade/trade-control-fixed.mjs"
! grep -q 'deepseek_live_trade_value' "$trade/trade-control-fixed.mjs"
! grep -q 'decideLiveTradeValue' "$trade/trade-control-fixed.mjs"
grep -q 'getFreshQuote(p._internal)' "$trade/trade-control-fixed.mjs"
grep -q 'submitPendingOrder' "$trade/trade-control-fixed.mjs"
echo 'PRODUCTION_DIRECTION_ONLY_25S_NORMAL_ORDER_FLOW_RESTORED=true'
echo "BACKUP=$back"
trap - ERR

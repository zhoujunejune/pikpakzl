#!/bin/bash
# Replace live numeric EV trade veto with DeepSeek's own TRADE/NO_TRADE.
# Never stop a live trading service while its follow switch is active.
set -Eeuo pipefail
test "$(id -u)" -eq 0
test -n "$DIRECT_AI_SHA"
model=/opt/zl-prediction-live/deepseek5
trade=/opt/zl-prediction-live/src/railway-diagnostic
node=/opt/zl-prediction-node/bin/node
for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do test -f "$model/$name";done
test -f "$trade/wrapper.mjs" && test -x "$node"
check_safe(){
 python3 - <<'PY'
import urllib.request,json
def get(p,r):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(p,r),timeout=7) as x:return json.load(x)
m=get(13029,'/api/status'); t=get(13001,'/api/status')
c=get(13001,'/api/order-signal-model')
assert m.get('model')=='DEEPSEEK_5M_V1' and m.get('providerModel')=='deepseek-flash'
assert m.get('maxCallsPerRound')==6 and m.get('decisionWindowEndMs',0)-m.get('round',0)==25000
assert c.get('model')=='DEEPSEEK_5M_V1'
assert t.get('enabled') is False,'FOLLOW_IS_ON_OWNER_MUST_TEMPORARILY_STOP'
assert (t.get('pendingAction') or {}).get('state') not in ('QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN'),'UNRESOLVED_CURRENT_ORDER'
assert (t.get('lastOrder') or {}).get('state') not in ('SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN','RECONCILIATION_REQUIRED'),'UNRESOLVED_LAST_ORDER'
print('DIRECT_AI_FOLLOW_OFF_AND_NO_INFLIGHT_ORDERS=true')
print('DIRECT_AI_BEFORE_OFFICIAL',m.get('learning',{}).get('allOfficialSamples'))
PY
}
check_safe
grep -q 'deepseek_live_trade_value' "$trade/wrapper.mjs" || { echo 'LIVE_MATH_GATE_NOT_DETECTED';exit 15; }
grep -q 'const EV_FILTER_ENABLED = false;' "$trade/wrapper.mjs" || { echo 'LEGACY_GATE_CHANGED_ABORT';exit 15; }
work=$(mktemp -d /tmp/zl-direct-deepseek25-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
base="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$DIRECT_AI_SHA/prediction-bot-v1"
for name in patch_deepseek_quote_cognition.py patch_trade_quote_preview.py patch_deepseek_direct_trade.py;do
 curl -fsSL --max-time 25 "$base/$name" -o "$work/$name"
done
python3 "$work/patch_deepseek_quote_cognition.py" "$model" "$work/new-model"
python3 "$work/patch_trade_quote_preview.py" "$trade/wrapper.mjs" "$work/quote-wrapper.mjs"
python3 "$work/patch_deepseek_direct_trade.py" "$work/new-model" "$work/quote-wrapper.mjs" "$work/direct-wrapper.mjs"
for file in "$work/new-model/"*.mjs "$work/direct-wrapper.mjs";do "$node" --check "$file";done
grep -q 'MAX_AI_CALLS_PER_ROUND=6' "$work/new-model/deepseek-adaptive15-runner.mjs"
grep -q 'DEADLINE_MS=25000' "$work/new-model/deepseek-adaptive15-core.mjs"
grep -q 'deepseek_direct_trade_choice' "$work/direct-wrapper.mjs"
! grep -q 'decideLiveTradeValue' "$work/direct-wrapper.mjs"
! grep -q 'EV_FILTER_ENABLED' "$work/direct-wrapper.mjs"
back="/var/lib/zl-prediction/archive/source-backups/deepseek-direct25-$DIRECT_AI_SHA"
mkdir -p "$back"
for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 cp -p "$model/$name" "$back/$name"
done
cp -p "$trade/wrapper.mjs" "$back/wrapper.mjs"
test ! -f "$trade/live-trade-value-policy.mjs" || cp -p "$trade/live-trade-value-policy.mjs" "$back/old-numeric-gate.mjs"
rollback(){
 echo 'DIRECT_AI_DEPLOY_ROLLBACK=true'
 for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
  cp -p "$back/$name" "$model/$name"
 done
 cp -p "$back/wrapper.mjs" "$trade/wrapper.mjs"
 if test -f "$back/old-numeric-gate.mjs";then cp -p "$back/old-numeric-gate.mjs" "$trade/live-trade-value-policy.mjs";fi
 systemctl restart zl-prediction-trade.service || true
 systemctl restart zl-prediction-deepseek5.service || true
}
trap rollback ERR
check_safe
for name in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 cp -p "$work/new-model/$name" "$model/$name"
done
cp -p "$work/direct-wrapper.mjs" "$trade/wrapper.mjs"
systemctl restart zl-prediction-trade.service
systemctl restart zl-prediction-deepseek5.service
for i in $(seq 1 27);do
 if curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$work/trade.json" 2>/dev/null &&
 curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$work/model.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$work/trade.json" && test -s "$work/model.json"
python3 - "$work/trade.json" "$work/model.json" <<'PY'
import json,sys,urllib.request
t=json.load(open(sys.argv[1]));m=json.load(open(sys.argv[2]))
assert t.get('enabled') is False,'FOLLOW_REENABLED_WHILE_DEPLOY'
assert m.get('model')=='DEEPSEEK_5M_V1' and m.get('providerModel')=='deepseek-flash'
assert m.get('maxCallsPerRound')==6 and m.get('decisionWindowEndMs',0)-m.get('round',0)==25000
with urllib.request.urlopen('http://127.0.0.1:13001/api/ai-quote-context?round='+str(m['round']),timeout=4) as x:q=json.load(x)
assert q.get('round')==m['round'] and q.get('ok') is False
print('DIRECT_AI_LIVE_QUOTE_INTERFACE_HEALTHY=true')
print('DIRECT_AI_HISTORICAL_STATS_PRESERVED',m.get('learning',{}).get('allOfficialSamples'))
print('DIRECT_AI_USER_FOLLOW_STILL_OFF=true')
print('DIRECT_AI_25S6_UNCHANGED=true')
PY
test "$(systemctl is-active zl-prediction-trade.service)" = active
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
grep -q 'deepseek_direct_trade_choice' "$trade/trade-control-fixed.mjs"
! grep -q 'decideLiveTradeValue' "$trade/trade-control-fixed.mjs"
! grep -q 'EV_FILTER_ENABLED' "$trade/trade-control-fixed.mjs"
grep -q 'getLiveAiQuotePreview' "$trade/trade-control-fixed.mjs"
# Obsolete policy is not used by any running module. Remove it after verifying
# executable no longer imports it. Backed up above for rollback.
rm -f "$trade/live-trade-value-policy.mjs"
echo 'DEEPSEEK_SOLE_ECONOMIC_TRADE_AUTHORITY_PRODUCTION_PUBLISHED=true'
echo "DIRECT_AI_PRODUCTION_BACKUP=$back"
trap - ERR

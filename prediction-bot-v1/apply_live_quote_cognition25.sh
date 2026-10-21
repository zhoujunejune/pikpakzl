#!/bin/bash
# Direct guarded production update. No shadow and no extra DeepSeek inference calls.
set -Eeuo pipefail
: "$QUOTE_COGNITION_SHA"
test -n "$QUOTE_COGNITION_SHA"
test "$(id -u)" -eq 0
app=/opt/zl-prediction-live/deepseek5
trade=/opt/zl-prediction-live/src/railway-diagnostic
node=/opt/zl-prediction-node/bin/node
test -x "$node"
for n in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do test -f "$app/$n";done
test -f "$trade/wrapper.mjs"
python3 - <<'PY'
import json,urllib.request
def get(port,path):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=6) as r:return json.load(r)
m=get(13029,'/api/status')
t=get(13001,'/api/status')
choice=get(13001,'/api/order-signal-model')
assert m.get('model')=='DEEPSEEK_5M_V1' and m.get('providerModel')=='deepseek-flash'
assert m.get('maxCallsPerRound')==6 and m.get('decisionWindowEndMs',0)-m.get('round',0)==25000
assert choice.get('model')=='DEEPSEEK_5M_V1'
assert t.get('enabled') is False,'OWNER_FOLLOW_ACTIVE_MUST_PAUSE_BEFORE_DEPLOY'
assert (t.get('pendingAction') or {}).get('state') not in ('QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN'),'ACTIVE_OR_UNCERTAIN_ORDER_ABORT'
assert (t.get('lastOrder') or {}).get('state') not in ('SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN','RECONCILIATION_REQUIRED'),'UNRESOLVED_PREVIOUS_ORDER_ABORT'
print('LIVE_QUOTE_PRECHECK_25S6=true')
print('LIVE_QUOTE_PRECHECK_FOLLOW_OFF=true')
print('LIVE_QUOTE_PRECHECK_NO_INFLIGHT_ORDERS=true')
print('LIVE_QUOTE_BEFORE_OFFICIAL',m.get('learning',{}).get('allOfficialSamples'))
PY
grep -q "deepseek_live_trade_value" "$trade/wrapper.mjs" || { echo 'LIVE_MATH_GATE_MISSING_ABORT';exit 14; }
grep -q "const EV_FILTER_ENABLED = false;" "$trade/wrapper.mjs" || { echo 'MATH_GATE_BASE_DRIFT_ABORT';exit 15; }
work=$(mktemp -d /tmp/zl-quote-cognition-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
base="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$QUOTE_COGNITION_SHA/prediction-bot-v1"
for n in patch_deepseek_quote_cognition.py patch_trade_quote_preview.py;do
 curl -fsSL --max-time 25 "$base/$n" -o "$work/$n"
done
python3 "$work/patch_deepseek_quote_cognition.py" "$app" "$work/new-model"
python3 "$work/patch_trade_quote_preview.py" "$trade/wrapper.mjs" "$work/wrapper.mjs"
for n in "$work/new-model/"*.mjs "$work/wrapper.mjs";do "$node" --check "$n";done
grep -q 'MAX_AI_CALLS_PER_ROUND=6' "$work/new-model/deepseek-adaptive15-runner.mjs"
grep -q 'DEADLINE_MS=25000' "$work/new-model/deepseek-adaptive15-core.mjs"
grep -q 'deepseek_live_trade_value' "$work/wrapper.mjs"
grep -q 'getLiveAiQuotePreview' "$work/wrapper.mjs"
back=/var/lib/zl-prediction/archive/source-backups/deepseek-quote-cognition-$QUOTE_COGNITION_SHA
mkdir -p "$back"
for n in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 cp -p "$app/$n" "$back/$n"
done
cp -p "$trade/wrapper.mjs" "$back/wrapper.mjs"
rollback(){
 echo 'LIVE_QUOTE_COGNITION_ROLLBACK=true'
 for n in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
  cp -p "$back/$n" "$app/$n"
 done
 cp -p "$back/wrapper.mjs" "$trade/wrapper.mjs"
 systemctl restart zl-prediction-trade.service || true
 systemctl restart zl-prediction-deepseek5.service || true
}
trap rollback ERR
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=6) as r:t=json.load(r)
assert t.get('enabled') is False,'OWNER_REENABLED_FOLLOW_BEFORE_APPLY'
assert (t.get('pendingAction') or {}).get('state') not in ('QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN')
print('LIVE_QUOTE_LAST_MOMENT_FOLLOW_OFF=true')
PY
for n in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do
 cp -p "$work/new-model/$n" "$app/$n"
done
cp -p "$work/wrapper.mjs" "$trade/wrapper.mjs"
systemctl restart zl-prediction-trade.service
systemctl restart zl-prediction-deepseek5.service
for i in $(seq 1 28);do
 if curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$work/trade.json" 2>/dev/null &&
    curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$work/model.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$work/trade.json" && test -s "$work/model.json"
python3 - "$work/trade.json" "$work/model.json" <<'PY'
import json,sys,urllib.request
t=json.load(open(sys.argv[1]));m=json.load(open(sys.argv[2]))
assert t.get('enabled') is False
assert m.get('model')=='DEEPSEEK_5M_V1' and m.get('providerModel')=='deepseek-flash'
assert m.get('maxCallsPerRound')==6 and m.get('decisionWindowEndMs',0)-m.get('round',0)==25000
r=m['round']
with urllib.request.urlopen('http://127.0.0.1:13001/api/ai-quote-context?round='+str(r),timeout=5) as q:quote=json.load(q)
assert quote.get('round')==r and quote.get('ok') is False
print('LIVE_QUOTE_CONTEXT_ROUTE_ONLINE=true')
print('LIVE_QUOTE_HISTORICAL_SAMPLES',m.get('learning',{}).get('allOfficialSamples'))
print('LIVE_QUOTE_FOLLOW_STILL_OFF=true')
print('LIVE_QUOTE_25S6_UNCHANGED=true')
PY
test "$(systemctl is-active zl-prediction-trade.service)" = active
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
grep -q 'getLiveAiQuotePreview' "$trade/trade-control-fixed.mjs"
grep -q 'decideLiveTradeValue' "$trade/trade-control-fixed.mjs"
echo 'DEEPSEEK_CURRENT_ROUND_REAL_QUOTE_PRODUCTION_PUBLISHED=true'
echo "DEEPSEEK_CURRENT_ROUND_REAL_QUOTE_BACKUP=$back"
trap - ERR

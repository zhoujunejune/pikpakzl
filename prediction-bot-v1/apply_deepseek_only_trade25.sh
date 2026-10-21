#!/bin/bash
# Replace existing production math EV veto with direct DeepSeek economic TRADE/NO_TRADE.
# Trades are permitted only with same-round signed quote evidence and user's follow toggle.
set -Eeuo pipefail
: "$DIRECT_AI_SHA"
test -n "$DIRECT_AI_SHA"
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
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=7) as r:return json.load(r)
m=get(13029,'/api/status')
t=get(13001,'/api/status')
s=get(13001,'/api/order-signal-model')
assert m.get('model')=='DEEPSEEK_5M_V1' and m.get('providerModel')=='deepseek-flash'
assert m.get('maxCallsPerRound')==6 and m.get('decisionWindowEndMs',0)-m.get('round',0)==25000
assert s.get('model')=='DEEPSEEK_5M_V1'
assert t.get('enabled') is False,'OWNER_MUST_STOP_FOLLOW_BEFORE_RELEASE'
assert (t.get('pendingAction') or {}).get('state') not in ('QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN'),'PENDING_ORDER_UNSAFE'
assert (t.get('lastOrder') or {}).get('state') not in ('SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN','RECONCILIATION_REQUIRED'),'LAST_ORDER_UNRESOLVED'
print('DEEPSEEK_DIRECT_PRECHECK_25S6=true')
print('DEEPSEEK_DIRECT_OWNER_FOLLOW_OFF=true')
print('DEEPSEEK_DIRECT_OFFICIAL_SAMPLES',m.get('learning',{}).get('allOfficialSamples'))
PY
grep -q "deepseek_live_trade_value" "$trade/wrapper.mjs" || { echo 'LEGACY_GATE_ALREADY_CHANGED_ABORT';exit 14; }
work=$(mktemp -d /tmp/deepseek-direct-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
base="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$DIRECT_AI_SHA/prediction-bot-v1"
for n in patch_deepseek_quote_cognition.py patch_trade_quote_preview.py patch_deepseek_direct_trade.py;do
 curl -fsSL --max-time 25 "$base/$n" -o "$work/$n"
done
python3 "$work/patch_deepseek_quote_cognition.py" "$app" "$work/new-model"
python3 "$work/patch_trade_quote_preview.py" "$trade/wrapper.mjs" "$work/quote-wrapper.mjs"
python3 "$work/patch_deepseek_direct_trade.py" "$work/new-model" "$work/quote-wrapper.mjs" "$work/direct-wrapper.mjs"
for n in "$work/new-model/"*.mjs "$work/direct-wrapper.mjs";do "$node" --check "$n";done
grep -q 'MAX_AI_CALLS_PER_ROUND=6' "$work/new-model/deepseek-adaptive15-runner.mjs"
grep -q 'DEADLINE_MS=25000' "$work/new-model/deepseek-adaptive15-core.mjs"
grep -q 'deepseek_direct_trade_choice' "$work/direct-wrapper.mjs"
! grep -q 'decideLiveTradeValue' "$work/direct-wrapper.mjs"
! grep -q 'deepseek_live_trade_value' "$work/direct-wrapper.mjs"
! grep -q 'EV_FILTER_ENABLED' "$work/direct-wrapper.mjs"
backup=/var/lib/zl-prediction/archive/source-backups/deepseek-only-direct-trade-$DIRECT_AI_SHA
mkdir -p "$backup"
for n in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do cp -p "$app/$n" "$backup/$n";done
cp -p "$trade/wrapper.mjs" "$backup/wrapper.mjs"
rollback(){
 echo 'DEEPSEEK_DIRECT_RESTORE_OLD_PRODUCTION=true'
 for n in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do cp -p "$backup/$n" "$app/$n";done
 cp -p "$backup/wrapper.mjs" "$trade/wrapper.mjs"
 systemctl restart zl-prediction-trade.service || true
 systemctl restart zl-prediction-deepseek5.service || true
}
trap rollback ERR
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:t=json.load(r)
assert t.get('enabled') is False,'FOLLOW_REENABLED_ABORT_BEFORE_SOURCE_WRITE'
assert (t.get('pendingAction') or {}).get('state') not in ('QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN')
PY
for n in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs;do cp -p "$work/new-model/$n" "$app/$n";done
cp -p "$work/direct-wrapper.mjs" "$trade/wrapper.mjs"
systemctl restart zl-prediction-trade.service
systemctl restart zl-prediction-deepseek5.service
for i in $(seq 1 28);do
 if curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$work/trade.json" 2>/dev/null &&
    curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$work/deepseek.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$work/trade.json" && test -s "$work/deepseek.json"
python3 - "$work/trade.json" "$work/deepseek.json" <<'PY'
import json,sys,urllib.request
t=json.load(open(sys.argv[1]));m=json.load(open(sys.argv[2]))
assert t.get('enabled') is False
assert m.get('model')=='DEEPSEEK_5M_V1' and m.get('providerModel')=='deepseek-flash'
assert m.get('maxCallsPerRound')==6
assert m.get('decisionWindowEndMs',0)-m.get('round',0)==25000
r=m['round']
with urllib.request.urlopen('http://127.0.0.1:13001/api/ai-quote-context?round='+str(r),timeout=5) as q:quote=json.load(q)
assert quote.get('round')==r and quote.get('ok') is False
print('DEEPSEEK_CURRENT_ROUND_BUY_QUOTES_AVAILABLE_TO_AI=true')
print('DEEPSEEK_FOLLOW_STILL_OFF=true')
print('DEEPSEEK_DIRECT_COGNITION_PRODUCTION_HEALTHY=true')
PY
test "$(systemctl is-active zl-prediction-trade.service)" = active
test "$(systemctl is-active zl-prediction-deepseek5.service)" = active
grep -q 'deepseek_direct_trade_choice' "$trade/trade-control-fixed.mjs"
! grep -q 'decideLiveTradeValue' "$trade/trade-control-fixed.mjs"
echo 'DEEPSEEK_SOLE_ECONOMIC_DECISION_PRODUCTION_PUBLISHED=true'
echo "DEEPSEEK_DIRECT_BACKUP=$backup"
trap - ERR

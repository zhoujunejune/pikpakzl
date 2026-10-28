#!/usr/bin/env bash
# Atomic switch of the isolated EVENT10 signal engine and UI, with rollback.
# Never touch the 5-minute production process, existing trade stream, wallets or keys.
set -Eeuo pipefail
test "$(id -u)" -eq 0
[[ "${APP_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || exit 2
for svc in caddy zl-prediction-trade zl-event10-deepseek;do
  systemctl is-active --quiet "$svc" || { echo "RULE_DEPLOY_SERVICE_INACTIVE=$svc"; exit 11; }
done
base=http://127.0.0.1:13020
temp=$(mktemp -d /tmp/event10-pure-rules.XXXXXXXX)
rollback_needed=false
cleanup(){
  code=$?
  trap - EXIT
  if test "$code" -ne 0 && test "$rollback_needed" = true;then
    for f in manual-engine.mjs server.mjs panel.html;do
      cp -p "$temp/backups/$f" "/opt/zl-event10/$f"
    done
    if test -f "$temp/backups/pure-signal.mjs";then
      cp -p "$temp/backups/pure-signal.mjs" /opt/zl-event10/pure-signal.mjs
    else rm -f /opt/zl-event10/pure-signal.mjs;fi
    systemctl restart zl-event10-deepseek || true
    echo EVENT10_RULE_SWITCH_ROLLBACK_APPLIED=true
  fi
  rm -rf "$temp"
  exit "$code"
}
trap cleanup EXIT
mkdir -p "$temp/backups"
for filename in manual-engine.mjs server.mjs pure-signal.mjs panel.html;do
  curl -fsSL --retry 3 --max-time 30 \
    "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$APP_SHA/event10-bot/$filename" \
    -o "$temp/$filename"
done
node=/opt/zl-prediction-node/bin/node
"$node" --check "$temp/manual-engine.mjs"
"$node" --check "$temp/server.mjs"
"$node" --check "$temp/pure-signal.mjs"
test -f /opt/zl-event10/server.mjs
test -f /var/lib/zl-event10/manual-sessions-v2.json
for file in manual-engine.mjs server.mjs panel.html;do cp -p "/opt/zl-event10/$file" "$temp/backups/$file";done
if test -f /opt/zl-event10/pure-signal.mjs;then
  cp -p /opt/zl-event10/pure-signal.mjs "$temp/backups/pure-signal.mjs"
fi
# Auto checks occur every 12 s; wait for an idle handoff, rather than
# failing deployment just because a routine read-only market scan is running.
for n in $(seq 1 35);do
  curl -fsS --max-time 5 "$base/api/status" >"$temp/old-status.json"
  if python3 - "$temp/old-status.json" <<'PYIDLE'
import json,sys
s=json.load(open(sys.argv[1]))
raise SystemExit(0 if not s.get('busyStart') and not s.get('busySettle') else 1)
PYIDLE
  then break;fi
  if [ "$n" -eq 35 ];then echo EVENT10_RULE_DEPLOY_NO_IDLE_WINDOW=true;exit 44;fi
  sleep 1
done
python3 - "$temp/old-status.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
assert s.get('ok') is True and s.get('bot')=='EVENT10'
assert s.get('autoTradingEnabled') is False and s.get('executionAvailable') is False
assert s.get('busyStart') is False and s.get('busySettle') is False
assert (s.get('active') or {}).get('status')!="ANALYZING","EVENT10_MODEL_STILL_ANALYZING"
print('EVENT10_RULE_DEPLOY_PREFLIGHT=true')
PY
predpid=$(systemctl show zl-prediction-trade -p MainPID --value)
stream_pid=$(systemctl show zl-event10-trade-stream -p MainPID --value 2>/dev/null || true)
# Never restart the continuous-trades collector.
rollback_needed=true
for filename in manual-engine.mjs pure-signal.mjs panel.html;do
  install -o root -g root -m 0644 "$temp/$filename" "/opt/zl-event10/$filename"
done
systemctl restart zl-event10-deepseek
ready=0
for x in $(seq 1 25);do
  if curl -fsS --max-time 3 "$base/api/status" -o "$temp/new-status.json" 2>/dev/null;then
    ready=1;break
  fi
  sleep 1
done
test "$ready" = 1 || { echo EVENT10_RULE_HTTP_NOT_READY=true;exit 42; }
python3 - "$temp/old-status.json" "$temp/new-status.json" <<'PY'
import json,sys
a,b=(json.load(open(f)) for f in sys.argv[1:])
assert b.get('ok') is True
assert b.get('providerModel')=='PURE_RULES_V1'
assert b.get('decisionReviewVersion')=='EVENT10_PURE_EMA_VOLUME_DEPTH_RSI_V1_20261029'
assert b.get('autoSignalEnabled') is True and b.get('manualStartEnabled') is True
assert b.get('modelCalls')==0
assert b.get('thinkingMode')=='disabled'
assert b.get('autoTradingEnabled') is False and b.get('executionAvailable') is False
assert (b.get('stats') or {}).get('total',0) >= (a.get('stats') or {}).get('total',0)
assert (b.get('lastSession') or {}).get('id')==(a.get('lastSession') or {}).get('id')
assert b.get('strategyStats',{}).get('proxySettled',0)>=0
assert b.get('strategyStats',{}).get('total',0) >= a.get('strategyStats',{}).get('total',0)
print('EVENT10_PURE_RULE_SIGNAL_ACTIVE=true')
print('EVENT10_OLD_HISTORY_PRESERVED=true')
print('EVENT10_NO_MODEL_REQUESTS=true')
print('EVENT10_NO_REAL_TRADING=true')
print('EVENT10_PREVIOUS_RECORDS='+str((a.get('stats') or {}).get('total',0)))
PY
# Complete read-only signal archive survives restart and supports page navigation.
curl -fsS --max-time 5 "$base/api/signals?limit=25&offset=0" >"$temp/signals.json"
python3 - "$temp/signals.json" "$temp/new-status.json" <<'PYSIGNALS'
import json,sys
history=json.load(open(sys.argv[1]));state=json.load(open(sys.argv[2]))
assert history['ok'] is True and history['version']=='EVENT10_PURE_EMA_VOLUME_DEPTH_RSI_V1_20261029'
assert history['autoTradingEnabled'] is False
assert len(history['records'])<=25
assert history['total']==state['strategyStats']['total']
assert history['stats']['proxySettled']==state['strategyStats']['proxySettled']
print('EVENT10_ALL_VALID_SIGNALS_PERSISTENT_LEDGER_READY=true')
print('EVENT10_SAVED_SIGNALS_TOTAL='+str(history['total']))
PY
curl -fsS --max-time 5 "$base/" >"$temp/served.html"
python3 - "$temp/served.html" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
for key in ('BTC 10分钟事件合约 · 纯信号','立即检测五项条件',
            'id="quickDirection"','id="quickConfidence"',
            'EVENT10_PURE_EMA_VOLUME_DEPTH_RSI_V1_20261029',
            'id="historySummary"','id="olderSignals"','id="newerSignals"'):
 assert key in s,'RULE_PANEL_MISSING_'+key
print('EVENT10_PURE_RULE_FRONTEND_ACTIVE=true')
PY
test "$predpid" = "$(systemctl show zl-prediction-trade -p MainPID --value)"
if test -n "$stream_pid" && test "$stream_pid" != 0;then
  test "$stream_pid" = "$(systemctl show zl-event10-trade-stream -p MainPID --value)"
fi
# Auth-protected route exists at existing production host; no Caddy modification.
status=$(curl -sk --resolve prediction.47-237-188-69.sslip.io:443:127.0.0.1 \
    --max-time 8 -o /dev/null -w '%{http_code}' \
    https://prediction.47-237-188-69.sslip.io/event10/)
test "$status" = 401
echo EVENT10_5MIN_AND_STREAM_PIDS_UNCHANGED=true
echo EVENT10_RULE_SWITCH_COMPLETE=true
rollback_needed=false

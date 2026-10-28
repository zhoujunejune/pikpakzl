#!/usr/bin/env bash
# Restore the previous EVENT10 page, authenticated route and navigation only.
# Preserve its existing AI model, historical data and other trading services.
set -Eeuo pipefail
test "$(id -u)" -eq 0
[[ "${APP_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || { echo EVENT10_INVALID_RESTORE_SHA; exit 2; }
for unit in caddy zl-prediction-trade; do
  systemctl is-active --quiet "$unit" || { echo "EVENT10_PREREQUISITE_NOT_RUNNING=$unit"; exit 11; }
done
prediction_pid=$(systemctl show -p MainPID --value zl-prediction-trade)
base=http://127.0.0.1:13020
repo="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$APP_SHA"
work=$(mktemp -d /tmp/event10-ui-restore.XXXXXXXX)
previous_panel=false
rollback_panel(){
  code=$?
  trap - EXIT
  if test "$code" -ne 0 && test "$previous_panel" = true; then
    cp -p "$work/panel.before" /opt/zl-event10/panel.html
    systemctl restart zl-event10-deepseek || true
    echo EVENT10_PANEL_ROLLED_BACK=true
  fi
  rm -rf "$work"
  exit "$code"
}
trap rollback_panel EXIT
curl -fsSL --retry 3 --max-time 25 "$repo/event10-bot/panel.html" -o "$work/panel.new"
curl -fsSL --retry 3 --max-time 25 "$repo/event10-bot/install_current_routes.sh" -o "$work/routes.sh"
bash -n "$work/routes.sh"
python3 - "$work/panel.new" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text(encoding='utf8')
for marker in ('id="start"', 'id="immediatePrediction"', 'id="quickDirection"',
               'id="quickConfidence"', 'id="records"', 'DeepSeek'):
    assert marker in s, 'EVENT10_PAGE_MARKER_MISSING_'+marker
assert s.index('id="start"') < s.index('id="immediatePrediction"')
print('EVENT10_ORIGINAL_FRONTEND_ASSET_VALID=true')
PY

# Try to revive an existing EVENT10 service first without touching model files.
if ! curl -fsS --max-time 5 "$base/api/status" >"$work/status.before" 2>/dev/null; then
  if test -f /opt/zl-event10/server.mjs && systemctl cat zl-event10-deepseek >/dev/null 2>&1; then
    systemctl start zl-event10-deepseek || true
    for n in 1 2 3 4 5 6; do
      curl -fsS --max-time 4 "$base/api/status" >"$work/status.before" 2>/dev/null && break
      sleep 1
    done
  fi
fi
if test ! -s "$work/status.before"; then
  # Reinstall only the independent EVENT10 service if truly absent.
  # This existing installer requires its authorized separate DeepSeek secret source.
  # It never submits an exchange order; its historical state path is not deleted.
  echo EVENT10_EXISTING_SERVICE_UNAVAILABLE_ATTEMPT_ISOLATED_INSTALL=true
  curl -fsSL --retry 3 --max-time 25 "$repo/event10-bot/install_aliyun.sh" -o "$work/install.sh"
  bash -n "$work/install.sh"
  bash "$work/install.sh"
  curl -fsS --max-time 6 "$base/api/status" >"$work/status.before"
fi
python3 - "$work/status.before" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
assert s.get('ok') is True and s.get('bot')=='EVENT10', 'EVENT10_NOT_READY'
assert s.get('autoTradingEnabled') is False and s.get('executionAvailable') is False, 'EVENT10_TRADE_GATE_UNSAFE'
assert not s.get('busyStart') and not s.get('busySettle')
assert (s.get('active') or {}).get('status')!='ANALYZING','EVENT10_FORECAST_IN_PROGRESS'
print('EVENT10_AI_VERSION_PRESERVED='+str(s.get('decisionReviewVersion')))
PY

# Restore only the independent HTML asset; do not overwrite server or AI code.
test -f /opt/zl-event10/panel.html
if ! cmp -s "$work/panel.new" /opt/zl-event10/panel.html; then
  cp -p /opt/zl-event10/panel.html "$work/panel.before"
  previous_panel=true
  install -o root -g root -m 0644 "$work/panel.new" /opt/zl-event10/panel.html
  systemctl restart zl-event10-deepseek
  for n in 1 2 3 4 5 6 7 8; do
    curl -fsS --max-time 4 "$base/api/status" >"$work/status.after" 2>/dev/null && break
    sleep 1
  done
  test -s "$work/status.after"
else
  cp "$work/status.before" "$work/status.after"
  echo EVENT10_EXISTING_PANEL_ALREADY_CURRENT=true
fi

# Existing installer owns the atomic Caddy and nav-bridge rollback.
bash "$work/routes.sh"
curl -fsS --max-time 6 "$base/" > "$work/page.live"
python3 - "$work/status.before" "$work/status.after" "$work/page.live" <<'PY'
import json,sys
before,after=(json.load(open(x)) for x in sys.argv[1:3])
page=open(sys.argv[3]).read()
for marker in ('id="start"','id="immediatePrediction"','id="quickConfidence"'):
    assert marker in page, 'EVENT10_LIVE_PAGE_NOT_RESTORED'
for key in ('providerModel','decisionReviewVersion','thinkingMode','reasoningEffort'):
    assert before.get(key)==after.get(key), 'EVENT10_MODEL_CHANGED_'+key
assert after.get('autoTradingEnabled') is False and after.get('executionAvailable') is False
assert (after.get('stats') or {}).get('total',0) >= (before.get('stats') or {}).get('total',0)
print('EVENT10_FRONTEND_PAGE_RESTORED=true')
print('EVENT10_HISTORY_AND_AI_SETTINGS_PRESERVED=true')
PY
test "$prediction_pid" = "$(systemctl show -p MainPID --value zl-prediction-trade)"
echo EVENT10_CURRENT_5MIN_TRADING_PROCESS_UNCHANGED=true
echo EVENT10_FRONTEND_RESTORE_COMPLETE=true

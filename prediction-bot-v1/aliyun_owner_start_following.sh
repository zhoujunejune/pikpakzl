#!/bin/bash
# Owner requested: Alibaba's authenticated Start Following arms automation;
# deploying the capability must not turn it on.
set -Eeuo pipefail
umask 027
test "$(id -u)" -eq 0
test -n "$FOLLOW_SOURCE_SHA"
[[ "$FOLLOW_SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]]
BASE=/opt/zl-prediction-live/src/railway-diagnostic
NODE=/opt/zl-prediction-node/bin/node
CONF=/etc/zl-prediction/panel.env
for svc in zl-prediction-trade zl-prediction-v2 zl-prediction-v3 zl-prediction-redis zl-futures-bot-paper zl-prediction-risk-exits;do
 test "$(systemctl is-active "$svc")" = active
done
grep -Fxq 'AUTO_CONFIRM_ENABLED=true' "$CONF"
grep -Fxq 'ZL_OUTER_AUTH_ONLY=true' "$CONF"
grep -Fxq 'RENDER_MIGRATION_PREVIEW=false' "$CONF"
grep -Fxq 'ZL_PUBLIC_ORIGIN=https://prediction.47-237-188-69.sslip.io' "$CONF"
test -r "$BASE/index.mjs" && test -r "$BASE/wrapper.mjs" && test -x "$NODE"
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=14) as r:j=json.load(r)
assert j['ok'] is True and j.get('enabled') is False, 'REDEPLOY_REFUSED_FOLLOW_SWITCH_IS_ALREADY_ON'
with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=10) as r:m=json.load(r)
assert m.get('model')=='SELECTIVE_V2_FAST8_PREWARM_V1'
with urllib.request.urlopen('http://127.0.0.1:13001/api/direction-mode',timeout=10) as r:d=json.load(r)
assert d.get('ready') is True
print('FOLLOW_DEPLOY_EXISTING_SWITCH_OFF_AND_MODEL_FIXED=true')
PY
TMP=$(mktemp -d)
PUBLISHED=no
cleanup(){
 code=$?
 if [ "$PUBLISHED" != yes ];then
  echo "FOLLOW_DEPLOY_ROLLBACK_EXIT=$code"
  systemctl stop zl-prediction-trade.service >/dev/null 2>&1 || true
  for file in index.mjs wrapper.mjs;do
   test ! -f "$TMP/$file.previous" || cp -p "$TMP/$file.previous" "$BASE/$file"
  done
  test ! -f "$TMP/panel.env.previous" || cp -p "$TMP/panel.env.previous" "$CONF"
  systemctl restart zl-prediction-trade.service || true
 fi
 rm -rf "$TMP"
}
trap cleanup EXIT
for file in index.mjs wrapper.mjs;do
 curl -fsSL --retry 3 --max-time 32 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$FOLLOW_SOURCE_SHA/railway-diagnostic/$file" -o "$TMP/$file"
 "$NODE" --check "$TMP/$file"
 cp -p "$BASE/$file" "$TMP/$file.previous"
done
grep -Fq 'function deploymentAllowsLiveFollowing()' "$TMP/index.mjs"
grep -Fq 'body.enabled === true && !deploymentAllowsLiveFollowing()' "$TMP/index.mjs"
grep -Fq 'wrapper.mjs owns the sole automatic-confirm scheduler' "$TMP/index.mjs"
grep -Fq "submitPendingOrder(pendingAction, { source: 'auto' })" "$TMP/wrapper.mjs"
grep -Fq 'pinOK(body.pin, req)' "$TMP/wrapper.mjs"
cp -p "$CONF" "$TMP/panel.env.previous"
systemctl stop zl-prediction-trade.service
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="/var/lib/zl-prediction/archive/source-backups/$STAMP"
mkdir -p "$BACKUP"
for file in index.mjs wrapper.mjs;do
 cp -p "$BASE/$file" "$BACKUP/$file"
 install -o zl-pred -g zl-pred -m 0644 "$TMP/$file" "$BASE/$file"
done
python3 - <<'PY'
from pathlib import Path
s=Path('/etc/zl-prediction/panel.env').read_text()
assert s.count('AUTO_CONFIRM_ENABLED=true\n')==1
assert s.count('RENDER_MIGRATION_PREVIEW=false\n')==1
print('FOLLOW_DEPLOY_EXISTING_AUTO_CAPABILITY_PRESERVED=true')
PY
systemctl start zl-prediction-trade.service
HEALTHY=no
for n in $(seq 1 30);do
 code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:13001/healthz || true)
 if [ "$code" = 200 ];then HEALTHY=yes;break;fi
 sleep 2
done
test "$HEALTHY" = yes
python3 - <<'PY'
import urllib.request,json
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=16) as r:return json.load(r)
status=get('/api/status')
assert status.get('ok') is True
assert status.get('enabled') is False
assert status.get('autoConfirmEnabled') is True
assert status.get('autoConfirmHalted') is False
model=get('/api/order-signal-model')
assert model.get('model')=='SELECTIVE_V2_FAST8_PREWARM_V1'
assert model.get('ready') is True
mode=get('/api/direction-mode')
assert mode.get('ready') is True
risk=get('/api/risk-control')
assert risk.get('persistenceHealthy') is True
health=get('/healthz')
assert health.get('autoConfirmEnabled') is True
print('FOLLOW_DEPLOY_AUTO_CAPABILITY_AVAILABLE=true')
print('FOLLOW_DEPLOY_AUTO_FOLLOW_REMAINS_OFF=true')
print('FOLLOW_DEPLOY_SINGLE_MODEL_INTACT=true')
print('FOLLOW_DEPLOY_DIRECTION_AND_RISK_SETTINGS_INTACT=true')
print('FOLLOW_DEPLOY_NO_ACTUAL_ORDER_SUBMITTED=true')
PY
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
  -X POST http://127.0.0.1:13005/api/control \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://prediction.47-237-188-69.sslip.io' \
  -H 'Sec-Fetch-Site: same-origin' \
  -d '{"enabled":true,"amount":"1"}')
test "$code" = 401
echo 'FOLLOW_DEPLOY_UNAUTHENTICATED_POST_DENIED=true'
for svc in zl-prediction-trade zl-prediction-v2 zl-prediction-v3 zl-prediction-redis zl-futures-bot-paper zl-prediction-risk-exits;do
 test "$(systemctl is-active "$svc")" = active
done
PUBLISHED=yes
echo 'FOLLOW_DEPLOY_COMPLETE=true'

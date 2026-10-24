#!/bin/bash
set -Eeuo pipefail
umask 027
test "$(id -u)" -eq 0
test -n "$DIRECTION_SOURCE_SHA"
[[ "$DIRECTION_SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]]
BASE=/opt/zl-prediction-live/src/railway-diagnostic
NODE=/opt/zl-prediction-node/bin/node
test -d "$BASE" && test -x "$NODE"
for svc in zl-prediction-trade zl-prediction-v2 zl-prediction-v3 zl-prediction-redis zl-futures-bot-paper;do
 test "$(systemctl is-active "$svc")" = active
done
grep -Fxq 'ZL_OUTER_AUTH_ONLY=true' /etc/zl-prediction/panel.env
grep -Fxq 'ZL_PUBLIC_ORIGIN=https://prediction.47-237-188-69.sslip.io' /etc/zl-prediction/panel.env
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ROOT="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$DIRECTION_SOURCE_SHA/railway-diagnostic"
for file in order-direction-policy.mjs index.mjs panel-stats-shell.mjs;do
 curl -fsSL --retry 3 --max-time 30 "$ROOT/$file" -o "$TMP/$file"
 "$NODE" --check "$TMP/$file"
done
grep -Fq 'modes=initialOffDirectionModes()' "$TMP/order-direction-policy.mjs"
grep -Fq 'pinOK(null,req)' "$TMP/index.mjs"
grep -Fq "['FORWARD','INVERSE','OFF'].map" "$TMP/panel-stats-shell.mjs"
grep -Fq 'directionModeChoices' "$TMP/panel-stats-shell.mjs"
grep -Fq "SELECTIVE_V2_FAST8_PREWARM_V1" "$TMP/panel-stats-shell.mjs"
mkdir -p /var/lib/zl-prediction/archive/source-backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="/var/lib/zl-prediction/archive/source-backups/$STAMP"
mkdir -p "$BACKUP"
changed=no
for file in order-direction-policy.mjs index.mjs panel-stats-shell.mjs;do
 if ! cmp -s "$TMP/$file" "$BASE/$file";then
  cp -p "$BASE/$file" "$BACKUP/$file"
  install -o zl-pred -g zl-pred -m 0644 "$TMP/$file" "$BASE/$file"
  changed=yes
 fi
done
echo "DIRECTION_REPAIR_SOURCE_CHANGED=$changed"
if [ "$changed" = yes ];then
 if ! systemctl restart zl-prediction-trade;then
  for file in order-direction-policy.mjs index.mjs panel-stats-shell.mjs;do
   test ! -f "$BACKUP/$file" || cp -p "$BACKUP/$file" "$BASE/$file"
  done
  systemctl restart zl-prediction-trade || true
  exit 20
 fi
fi
ready=no
for i in $(seq 1 30);do
 code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:13001/healthz || true)
 if [ "$code" = 200 ];then ready=yes;break;fi
 sleep 2
done
test "$ready" = yes
python3 - <<'PY'
import json,urllib.request,urllib.error
base="http://127.0.0.1:13001"
def get(route):
 req=urllib.request.Request(base+route,headers={'Accept':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=15) as r:return r.status,r.read()
 except urllib.error.HTTPError as e:return e.code,e.read()
code,body=get('/api/direction-mode')
if code!=200:raise RuntimeError('DIRECTION_REDIS_NOT_READY_HTTP_'+str(code)+'_'+body[:110].decode('utf8','replace'))
d=json.loads(body)
assert d['ok'] and d['ready']
assert len(d['modes'])==3 and all(set(x)=={'UP','DOWN'} for x in d['modes'].values())
assert all(m in ('OFF','FORWARD','INVERSE') for x in d['modes'].values() for m in x.values())
print('DIRECTION_REPAIR_REDIS_PERSISTED=true')
print('DIRECTION_REPAIR_CONFIG_REVISION_EXISTS',bool(d.get('revision')))
print('DIRECTION_REPAIR_SAVED_SIDE_SETTINGS',json.dumps(d['modes'],ensure_ascii=False))
code,body=get('/api/order-signal-model')
order=json.loads(body)
assert code==200 and order['model']=='SELECTIVE_V2_FAST8_PREWARM_V1'
print('DIRECTION_REPAIR_ONLY_SELECTED_MODEL',order['model'])
code,html=get('/')
assert code==200 and b'directionModeChoices' in html and b'orderSignalModelSelect' in html
print('DIRECTION_REPAIR_UI_PRESENT=true')
PY
# A direct localhost call must not bypass the HTTPS authentication gateway.
code=$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' \
 -X POST 'http://127.0.0.1:13005/api/direction-mode' \
 -H 'Content-Type: application/json' \
 --data '{"source":"SELECTIVE_V2_FAST8_PRIMARY","direction":"UP","mode":"FORWARD","expectedRevision":"fake"}')
test "$code" = 401
echo 'DIRECTION_REPAIR_UNAUTHENTICATED_POST_REJECTED=true'
test "$(systemctl is-active zl-futures-bot-paper)" = active
echo 'DIRECTION_REPAIR_KEEP_AUTOTRADE_SWITCH_UNCHANGED=true'
echo 'DIRECTION_REPAIR_DONE=true'

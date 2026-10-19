#!/bin/bash
set -Eeuo pipefail
umask 027
test "$(id -u)" -eq 0
: "$PRED_MIGRATION_SHA"
[[ "$PRED_MIGRATION_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 2
BASE=/opt/zl-prediction-live/src/railway-diagnostic
NODE=/opt/zl-prediction-node/bin/node
ARCHIVE=/var/lib/zl-prediction/archive
test -x "$NODE" && test -d "$BASE" && test -d "$ARCHIVE"
test "$(systemctl is-active zl-prediction-v2)" = active
test "$(systemctl is-active zl-prediction-v3)" = active
test "$(systemctl is-active zl-prediction-redis)" = active
# Only authenticated official Binance Prediction V2 records can label outcomes.
python3 - <<'PY'
import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:13002/api/round-stats',timeout=10) as r:
 j=json.load(r)
assert j.get('ok') is True
assert j.get('settlementSource')=='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY'
print('SINGLEHOST_OFFICIAL_SOURCE_READY',len(j.get('records',[])))
PY
# Archive just the publicly exposed last status once, with explicit limitations.
if [ ! -f "$ARCHIVE/edge-cloudflare-last-public-snapshot.json" ];then
  temp=$(mktemp)
  if curl -fsSL --max-time 14 \
    https://edge-5m-v1.zl528094-3ba.workers.dev/status -o "$temp";then
    python3 - "$temp" "$ARCHIVE/edge-cloudflare-last-public-snapshot.json" <<'PY' || true
import sys,json,os
data=json.load(open(sys.argv[1]))
assert data.get('ok') is True and data.get('model')=='EDGE_5M_V1'
p=sys.argv[2]
with open(p+'.tmp','w') as f:
 json.dump({'scope':'ARCHIVED_PUBLIC_SNAPSHOT_NOT_COMPLETE_DO_HISTORY',
  'results':data.get('results'),'recent':data.get('recent'),
  'generatedAt':data.get('generatedAt')},f)
 f.flush();os.fsync(f.fileno())
os.replace(p+'.tmp',p)
PY
  fi
  rm -f "$temp"
fi
if [ -f "$ARCHIVE/edge-cloudflare-last-public-snapshot.json" ];then
 chown zl-pred:zl-pred "$ARCHIVE/edge-cloudflare-last-public-snapshot.json"
 chmod 640 "$ARCHIVE/edge-cloudflare-last-public-snapshot.json"
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ROOT="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$PRED_MIGRATION_SHA/railway-diagnostic"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$ARCHIVE/source-backups/$STAMP"
for file in local-model-host.mjs edge-5m-service.mjs panel-stats-shell.mjs shadow-breakout20-dashboard.mjs postflip-official-stats.mjs;do
  curl -fsSL --retry 3 --max-time 30 "$ROOT/$file" -o "$TMP/$file"
  "$NODE" --check "$TMP/$file"
done
for file in local-model-host.mjs edge-5m-service.mjs panel-stats-shell.mjs shadow-breakout20-dashboard.mjs postflip-official-stats.mjs;do
  test -f "$BASE/$file" && cp -p "$BASE/$file" "$ARCHIVE/source-backups/$STAMP/$file" || true
  install -m 0644 -o zl-pred -g zl-pred "$TMP/$file" "$BASE/$file"
done
cat > /etc/systemd/system/zl-prediction-native-models.service <<'EOF'
[Unit]
Description=ZL Alibaba-native EDGE and Dynamic model engines
After=network-online.target zl-prediction-redis.service zl-prediction-v2.service zl-prediction-v3.service
Requires=zl-prediction-redis.service
Wants=zl-prediction-v2.service zl-prediction-v3.service
[Service]
Type=simple
User=zl-pred
Group=zl-pred
WorkingDirectory=/opt/zl-prediction-live/src/railway-diagnostic
Environment=NODE_ENV=production
Environment=LOCAL_SHADOW_PORT=13007
Environment=NOVICE_MARKET_ORIGIN=http://127.0.0.1:13003
Environment=ROUND_STATS_ORIGIN=http://127.0.0.1:13002
Environment=EDGE5_TRAINING_PAUSED=true
EnvironmentFile=/etc/zl-prediction/redis.env
ExecStart=/opt/zl-prediction-node/bin/node local-model-host.mjs
Restart=on-failure
RestartSec=6
MemoryMax=320M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/zl-prediction/rounds /var/lib/zl-prediction/archive
LimitNOFILE=8192
[Install]
WantedBy=multi-user.target
EOF
python3 - <<'PY'
from pathlib import Path
p=Path('/etc/zl-prediction/panel.env')
src=p.read_text()
updates={'ROUND_STATS_ORIGIN':'http://127.0.0.1:13002',
'ROUND_STATS_PUBLIC_ORIGIN':'http://127.0.0.1:13002',
'NOVICE_MARKET_ORIGIN':'http://127.0.0.1:13003',
'EDGE5_LOCAL_STATUS_URL':'http://127.0.0.1:13007/edge-5m',
'DYNAMIC_LOCAL_STATUS_URL':'http://127.0.0.1:13007/dynamic-entry'}
old=[line for line in src.splitlines() if line.split('=',1)[0] not in updates]
p.write_text('\n'.join(old+[k+'='+v for k,v in updates.items()])+'\n')
p.chmod(0o640)
PY
systemctl daemon-reload
systemctl enable zl-prediction-native-models.service
systemctl restart zl-prediction-native-models.service
ready=no
for i in $(seq 1 15);do
 code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:13007/healthz || true)
 if [ "$code" = 200 ];then ready=yes;break;fi
 sleep 2
done
test "$ready" = yes
echo SINGLEHOST_NATIVE_MODELS_READY=true
systemctl restart zl-prediction-trade.service
ready=no
for i in $(seq 1 20);do
 ok=yes
 for route in /healthz /api/shadow-breakout20/edge-5m /api/shadow-breakout20/dynamic-entry;do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:13001$route" || true)
  if [ "$code" != 200 ];then ok=no;break;fi
 done
 if [ "$ok" = yes ];then ready=yes;break;fi
 sleep 2
done
test "$ready" = yes
python3 - <<'PY'
import json,urllib.request
for name in ('edge-5m','dynamic-entry'):
 with urllib.request.urlopen('http://127.0.0.1:13001/api/shadow-breakout20/'+name,timeout=8) as r:j=json.load(r)
 assert j['ok'] is True
 assert j['model'] in ('EDGE_5M_V1','DYNAMIC_ENTRY_5M_SHADOW_V1')
 assert j['readOnly'] is True and j['orders'] is False
 print('SINGLEHOST_MODEL_API',name,'records',len(j.get('recent',[])))
PY
test "$(systemctl is-active zl-futures-bot-paper.service)" = active
echo SINGLEHOST_RUNTIME_REQUIRES_NO_RAILWAY_RENDER_CLOUDFLARE_FOR_EDGE_DYNAMIC_BREAKOUT_STATS=true
echo SINGLEHOST_OLD_CLOUDFLARE_COMPLETE_DO_NOT_EXPORTED=true
echo SINGLEHOST_LIVE_TRADING_UNCHANGED=true

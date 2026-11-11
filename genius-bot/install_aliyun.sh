#!/usr/bin/env bash
set -Eeuo pipefail
SHA="$1"
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || exit 32
BASE="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$SHA"
ROOT=/opt/haipai-genius-paper
STATE=/var/lib/haipai-genius-paper
UNIT=/etc/systemd/system/haipai-genius-paper.service
CADDY=/etc/caddy/Caddyfile
NODE=/opt/zl-prediction-node/bin/node
BACK=$(mktemp -d /var/backups/haipai-genius-paper-XXXXXXXX)
STAGE=$(mktemp -d /tmp/haipai-genius-XXXXXXXX)
HAD_ROOT=0;HAD_UNIT=0;SUCCESS=0;CHANGED=0
OLD_EVENT_PID=$(systemctl show zl-event10-deepseek -p MainPID --value)
finish(){
  code=$?
  trap - EXIT
  if [ "$SUCCESS" != 1 ] && [ "$CHANGED" = 1 ];then
    echo HAIPAI_GENIUS_ROLLBACK=true
    cp -p "$BACK/Caddyfile" "$CADDY" || true
    cp -p "$BACK/service" "$UNIT" 2>/dev/null || rm -f "$UNIT"
    rm -rf "$ROOT"
    if [ "$HAD_ROOT" = 1 ];then cp -a "$BACK/oldapp" "$ROOT";fi
    systemctl daemon-reload || true
    if [ "$HAD_UNIT" = 1 ];then systemctl restart haipai-genius-paper || true
    else systemctl disable --now haipai-genius-paper 2>/dev/null || true;fi
    caddy validate --config "$CADDY" >/dev/null 2>&1 && systemctl reload caddy || true
  fi
  rm -rf "$STAGE"
  exit "$code"
}
trap finish EXIT
[[ -x "$NODE" && -r "$CADDY" ]] || exit 31
systemctl is-active --quiet caddy
for file in engine.mjs server.mjs engine.test.mjs;do
  curl -fsSL --max-time 35 "$BASE/genius-bot/$file" -o "$STAGE/$file"
done
"$NODE" --check "$STAGE/engine.mjs"
"$NODE" --check "$STAGE/server.mjs"
"$NODE" --test "$STAGE/engine.test.mjs"
if grep -Eq '/fapi/v1/(order|algoOrder)' "$STAGE/engine.mjs" "$STAGE/server.mjs";then
  echo HAIPAI_GENIUS_REAL_ORDER_ROUTE_FORBIDDEN=true; exit 29
fi
cp -p "$CADDY" "$BACK/Caddyfile"
if [[ -d "$ROOT" ]];then HAD_ROOT=1;cp -a "$ROOT" "$BACK/oldapp";fi
if [[ -r "$UNIT" ]];then HAD_UNIT=1;cp -p "$UNIT" "$BACK/service";fi
install -d -m 0700 "$STATE"
install -d -m 0755 "$ROOT"
for f in engine.mjs server.mjs engine.test.mjs;do install -m 0644 "$STAGE/$f" "$ROOT/$f";done
CHANGED=1
cat > "$UNIT" <<'SYSTEMD'
[Unit]
Description=Haipai Genius DeepSeek futures simulator - PAPER ONLY
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=/opt/haipai-genius-paper
Environment=NODE_ENV=production
Environment=GENIUS_PORT=13023
Environment=GENIUS_STATE_FILE=/var/lib/haipai-genius-paper/state.json
EnvironmentFile=-/etc/zl-event10/ai-model-flash.env
ExecStart=/opt/zl-prediction-node/bin/node /opt/haipai-genius-paper/server.mjs
Restart=on-failure
RestartSec=7
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/var/lib/haipai-genius-paper
[Install]
WantedBy=multi-user.target
SYSTEMD
python3 - "$CADDY" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]);s=p.read_text()
marker='# HAIPAI_GENIUS_PAPER_ROUTE_V1'
assert s.count('prediction.47-237-188-69.sslip.io {')==1
assert 'basic_auth' in s
if marker not in s:
    anchor='# ZL_UNIFIED_PWA_ROUTE_V1'
    assert s.count(anchor)==1,'PWA_ROUTE_ANCHOR_MISSING'
    block='''# HAIPAI_GENIUS_PAPER_ROUTE_V1
  handle_path /genius/* {
    reverse_proxy 127.0.0.1:13023
  }

  '''
    s=s.replace(anchor,block+anchor,1)
else:assert s.count(marker)==1
p.write_text(s)
PY
caddy validate --config "$CADDY"
systemctl daemon-reload
systemctl enable --now haipai-genius-paper
systemctl restart haipai-genius-paper
systemctl reload caddy
for _ in $(seq 1 20);do
  if curl -fsS --max-time 2 http://127.0.0.1:13023/healthz | grep -q '"paperOnly":true';then break;fi
  sleep 1
done
node_status=$(curl -fsS --max-time 5 http://127.0.0.1:13023/api/status)
python3 - "$node_status" <<'PY'
import sys,json
x=json.loads(sys.argv[1]);assert x['mode']=='PAPER_ONLY'
assert x['realTradingEnabled'] is False
assert x['settings']['enabled'] is False
assert x['settings']['leverage']<=10
print('HAIPAI_GENIUS_PAPER_ONLY_VERIFIED=true',flush=True)
print('HAIPAI_GENIUS_DEEPSEEK_CONFIGURED='+str(x['aiConfigured']),flush=True)
PY
HTTP=$(curl -sk --resolve prediction.47-237-188-69.sslip.io:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://prediction.47-237-188-69.sslip.io/genius/api/status)
[[ "$HTTP" = 401 ]] || { echo HAIPAI_GENIUS_AUTH_FAILED="$HTTP";exit 7; }
[[ "$(systemctl show zl-event10-deepseek -p MainPID --value)" == "$OLD_EVENT_PID" ]] || exit 8
systemctl is-active --quiet haipai-genius-paper
SUCCESS=1
echo HAIPAI_GENIUS_BACKEND_DEPLOYED=true
echo HAIPAI_GENIUS_REAL_ORDER_TRADING_ENABLED=false
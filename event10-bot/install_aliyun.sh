#!/usr/bin/env bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
[[ "$APP_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 2
test "$(systemctl is-active zl-prediction-deepseek5)" = active
test -f /etc/zl-prediction/deepseek5.env
node=/opt/zl-prediction-node/bin/node
test -x "$node"
install -d -m 0755 /opt/zl-event10
for f in server.mjs manual-engine.mjs panel.html server.test.mjs;do
 curl -fsSL --retry 3 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$APP_SHA/event10-bot/$f" -o "/opt/zl-event10/$f"
done
"$node" --check /opt/zl-event10/server.mjs
"$node" --test /opt/zl-event10/server.test.mjs
cat >/etc/systemd/system/zl-event10-deepseek.service <<'EOF'
[Unit]
Description=ZL Event Contract Ten Minute Read Only DeepSeek Signal
After=network-online.target
[Service]
User=zl-pred
Group=zl-pred
EnvironmentFile=/etc/zl-prediction/deepseek5.env
Environment=EVENT10_PORT=13020
Environment=EVENT10_STATE_FILE=/var/lib/zl-event10/manual-sessions-v2.json
ExecStart=/opt/zl-prediction-node/bin/node /opt/zl-event10/server.mjs
StateDirectory=zl-event10
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/zl-event10
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now zl-event10-deepseek >/dev/null
systemctl restart zl-event10-deepseek
ready=0
for i in $(seq 1 20);do
  if curl -fsS --max-time 4 http://127.0.0.1:13020/api/status -o /tmp/zl-event10-status.json 2>/dev/null;then
    ready=1
    break
  fi
  sleep 2
done
if test "$ready" -ne 1;then
  echo EVENT10_STARTUP_DIAGNOSTICS
  systemctl status zl-event10-deepseek --no-pager -l || true
  journalctl -u zl-event10-deepseek -n 25 --no-pager -o cat || true
  exit 41
fi
python3 - <<'PY'
import json
with open('/tmp/zl-event10-status.json') as f:
 x=json.load(f)
assert x['configured'] is True, 'EVENT10_DEEPSEEK_NOT_CONFIGURED'
assert x['autoTradingEnabled'] is False and x['executionAvailable'] is False
print('EVENT10_BACKEND_READY=true')
print('EVENT10_PROVIDER_MODEL='+str(x['providerModel']))
PY
rm -f /tmp/zl-event10-status.json

#!/usr/bin/env bash
# Standalone systemd live-futures installation; owner switch OFF by default.
set -Eeuo pipefail
test "$(id -u)" -eq 0 || { echo "FAILED: requires Cloud Assistant root"; exit 20; }
test -f /etc/os-release || exit 21
. /etc/os-release
test "$ID" = ubuntu || { echo "FAILED: not Ubuntu"; exit 22; }
test -f futures-bot-v1/serve.py || { echo "FAILED: source missing"; exit 23; }
# Never interrupt an enabled real-trading engine or a server with owned positions.
# Fail before replacing the service configuration; open exchange-side stops remain untouched.
check_safe_to_restart() {
 python3 - <<'PY'
import json
from pathlib import Path
ctl=Path('/var/lib/zl-futures-bot/live-control.json')
state=Path('/var/lib/zl-futures-bot/live-state.json')
if ctl.exists():
 c=json.loads(ctl.read_text())
 assert c.get('enabled') is False, 'LIVE_OWNER_SWITCH_IS_ON_ABORT_REDEPLOY'
if state.exists():
 s=json.loads(state.read_text())
 assert not s.get('live_positions'), 'LIVE_OWNED_POSITIONS_PRESENT_ABORT_REDEPLOY'
 assert not s.get('pending'), 'LIVE_ORDER_PENDING_ABORT_REDEPLOY'
print('FUTURES_SAFE_RESTART_CHECK=PASS')
PY
}
check_safe_to_restart
echo "INSTALL: preparing Ubuntu Python venv"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3-venv ca-certificates git curl
if ! id zlbot >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/zl-futures-bot --shell /usr/sbin/nologin --no-create-home zlbot
fi
install -d -m 0750 -o zlbot -g zlbot /var/lib/zl-futures-bot
install -d -m 0755 /opt/zl-futures-bot
# One-time retained copy before migrating old single paper position to multi-symbol.
if [ -s /var/lib/zl-futures-bot/state.json ] && [ ! -e /var/lib/zl-futures-bot/state.before-multipair-v1.json ]; then
  install -m 0600 -o zlbot -g zlbot /var/lib/zl-futures-bot/state.json /var/lib/zl-futures-bot/state.before-multipair-v1.json
  echo "STATE_BACKUP_BEFORE_MULTIPAIR: preserved"
fi
python3 -m venv /opt/zl-futures-bot/venv
/opt/zl-futures-bot/venv/bin/python -m pip install --disable-pip-version-check -r futures-bot-v1/requirements.txt
# Absolute path is supplied by our narrowly scoped deploy driver.
SRC="$(pwd)"
cat >/etc/systemd/system/zl-futures-bot-paper.service <<EOF
[Unit]
Description=ZL Futures Bot V1 - owner controlled REAL trading
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=zlbot
Group=zlbot
WorkingDirectory=$SRC
Environment=MODE=live
Environment=ALLOW_REAL_TRADING=I_ACCEPT_REAL_TRADING
Environment=DURABLE_STORAGE_CONFIRMED=YES
Environment=LIVE_CONTROL_FILE=/var/lib/zl-futures-bot/live-control.json
Environment=PAPER_BALANCE=200
Environment=SYMBOLS=BTCUSDT,ETHUSDT,BTCUSDC
Environment=LEVERAGE=10
Environment=RISK_FRACTION=0.015
Environment=MAX_MARGIN_FRACTION=0.15
Environment=MAX_DAILY_LOSS_FRACTION=0.08
Environment=PAPER_TAKER_FEE=0.0005
Environment=STATE_FILE=/var/lib/zl-futures-bot/live-state.json
Environment=CONTROL_FILE=/var/lib/zl-futures-bot/control.json
EnvironmentFile=-/etc/zl-futures-bot-panel.env
Environment=PORT=10000
Environment=BIND_HOST=127.0.0.1
ExecStart=/opt/zl-futures-bot/venv/bin/python -u futures-bot-v1/serve.py
Restart=on-failure
RestartSec=30
StartLimitBurst=3
StartLimitIntervalSec=300
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/zl-futures-bot
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
CapabilityBoundingSet=
UMask=0077
MemoryMax=800M

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 /etc/systemd/system/zl-futures-bot-paper.service
systemctl daemon-reload
systemctl enable zl-futures-bot-paper.service
# enable --now does not restart an already running process after a code update.
# Reload the active Python service to apply new browser routing without touching state.
check_safe_to_restart
systemctl restart zl-futures-bot-paper.service
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --connect-timeout 2 --max-time 3 http://127.0.0.1:10000/healthz >/dev/null; then
    # Validate that the running service exposes the new multi-position schema.
    curl -fsS --max-time 5 http://127.0.0.1:10000/status | /opt/zl-futures-bot/venv/bin/python -c '
import json,sys
s=json.load(sys.stdin)
assert s.get("liveTradingEnabled") is False
assert s.get("mode")=="live"
assert s.get("perSymbolPositionLimit")==1
assert s.get("postCloseCooldownSeconds")==0
# Owner has not armed live yet
assert isinstance(s.get("positions"),list)
print("REAL_FUTURES_LIVE_OFF_STATUS_OK")
'
    echo "INSTALL_OK: service responds locally"
    systemctl is-enabled zl-futures-bot-paper.service
    systemctl is-active zl-futures-bot-paper.service
    echo "REAL_TRADING_CAPABILITY=installed; SWITCH=off"
    echo "INBOUND_PORT_OPENED=false"
    exit 0
  fi
  sleep 2
done
echo "FAILED: localhost service health check"
systemctl status zl-futures-bot-paper.service --no-pager -l | tail -n 20
exit 30

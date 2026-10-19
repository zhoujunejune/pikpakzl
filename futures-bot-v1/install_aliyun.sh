#!/usr/bin/env bash
# Standalone systemd installation of the paper-only futures experiment.
set -Eeuo pipefail
test "$(id -u)" -eq 0 || { echo "FAILED: requires Cloud Assistant root"; exit 20; }
test -f /etc/os-release || exit 21
. /etc/os-release
test "$ID" = ubuntu || { echo "FAILED: not Ubuntu"; exit 22; }
test -f futures-bot-v1/serve.py || { echo "FAILED: source missing"; exit 23; }
echo "INSTALL: preparing Ubuntu Python venv"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3-venv ca-certificates git curl
if ! id zlbot >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/zl-futures-bot --shell /usr/sbin/nologin --no-create-home zlbot
fi
install -d -m 0750 -o zlbot -g zlbot /var/lib/zl-futures-bot
install -d -m 0755 /opt/zl-futures-bot
python3 -m venv /opt/zl-futures-bot/venv
/opt/zl-futures-bot/venv/bin/python -m pip install --disable-pip-version-check -r futures-bot-v1/requirements.txt
# Absolute path is supplied by our narrowly scoped deploy driver.
SRC="$(pwd)"
cat >/etc/systemd/system/zl-futures-bot-paper.service <<EOF
[Unit]
Description=ZL Futures Bot V1 - research only, PAPER trading
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=zlbot
Group=zlbot
WorkingDirectory=$SRC
Environment=MODE=paper
Environment=PAPER_BALANCE=200
Environment=SYMBOLS=BTCUSDT,ETHUSDT,BTCUSDC
Environment=LEVERAGE=10
Environment=RISK_FRACTION=0.015
Environment=MAX_MARGIN_FRACTION=0.15
Environment=MAX_DAILY_LOSS_FRACTION=0.08
Environment=PAPER_TAKER_FEE=0.0005
Environment=STATE_FILE=/var/lib/zl-futures-bot/state.json
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
systemctl restart zl-futures-bot-paper.service
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --connect-timeout 2 --max-time 3 http://127.0.0.1:10000/healthz >/dev/null; then
    echo "INSTALL_OK: service responds locally"
    systemctl is-enabled zl-futures-bot-paper.service
    systemctl is-active zl-futures-bot-paper.service
    echo "REAL_TRADING=false"
    echo "INBOUND_PORT_OPENED=false"
    exit 0
  fi
  sleep 2
done
echo "FAILED: localhost service health check"
systemctl status zl-futures-bot-paper.service --no-pager -l | tail -n 20
exit 30

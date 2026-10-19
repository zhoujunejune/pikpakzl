#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
test "$(id -u)" -eq 0
test -n "$MANAGER_SHA" && test -n "$PREDICTION_SHA"
[[ "$MANAGER_SHA" =~ ^[a-f0-9]{40}$ && "$PREDICTION_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 3
BASE=/opt/zl-exchange-api
STATE=/var/lib/zl-exchange-api
if ! id zlkeys >/dev/null 2>&1;then
  useradd --system --home "$STATE" --shell /usr/sbin/nologin --no-create-home zlkeys
fi
install -d -m 0755 -o root -g root "$BASE"
install -d -m 0700 -o zlkeys -g zlkeys "$STATE" "$STATE/futures" "$STATE/prediction"
FETCH_BASE="https://raw.githubusercontent.com/zhoujunejune/pikpakzl"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 --max-time 25 "$FETCH_BASE/$MANAGER_SHA/exchange-api-manager/server.py" -o "$tmp/server.py"
curl -fsSL --retry 3 --max-time 25 "$FETCH_BASE/$MANAGER_SHA/futures-bot-v1/dashboard.py" -o "$tmp/dashboard.py"
curl -fsSL --retry 3 --max-time 25 "$FETCH_BASE/$PREDICTION_SHA/railway-diagnostic/index.mjs" -o "$tmp/pred-index.mjs"
python3 -m py_compile "$tmp/server.py" "$tmp/dashboard.py"
test -d /opt/zl-futures-bot/src/futures-bot-v1
test -d /opt/zl-prediction-live/src/railway-diagnostic
if ! grep -q '交易所 API 管理' "$tmp/pred-index.mjs"; then
  echo "PREDICTION_NAV_NOT_PRESENT";exit 7
fi
install -m 0644 -o root -g root "$tmp/server.py" "$BASE/server.py"
install -m 0644 "$tmp/dashboard.py" /opt/zl-futures-bot/src/futures-bot-v1/dashboard.py
install -m 0644 -o zl-pred -g zl-pred "$tmp/pred-index.mjs" /opt/zl-prediction-live/src/railway-diagnostic/index.mjs
# EnvironmentFile is opened by systemd's privileged manager; credentials are
# never made readable by the bot user that is not selected.
mkdir -p /etc/systemd/system/zl-futures-bot-paper.service.d
cat > /etc/systemd/system/zl-futures-bot-paper.service.d/20-exchange-api-manager.conf <<EOF
[Service]
EnvironmentFile=-$STATE/futures/binance.env
EOF
for unit in zl-prediction-trade zl-prediction-v2 zl-prediction-v3;do
  mkdir -p "/etc/systemd/system/$unit.service.d"
  cat > "/etc/systemd/system/$unit.service.d/20-exchange-api-manager.conf" <<EOF
[Service]
EnvironmentFile=-$STATE/prediction/binance.env
EOF
done
cat > /etc/systemd/system/zl-exchange-api-manager.service <<EOF
[Unit]
Description=ZL protected exchange API manager for two separate robots
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=zlkeys
Group=zlkeys
ExecStart=/usr/bin/python3 $BASE/server.py
WorkingDirectory=$BASE
Restart=on-failure
RestartSec=6
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$STATE
UMask=0077
MemoryMax=120M
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/zl-api-futures-reload.service <<EOF
[Unit]
Description=Reload futures bot after own exchange API changes
[Service]
Type=oneshot
ExecStart=/bin/systemctl try-restart zl-futures-bot-paper.service
EOF
cat > /etc/systemd/system/zl-api-futures-reload.path <<EOF
[Unit]
Description=Watch only futures bot exchange keys
[Path]
PathChanged=$STATE/futures
Unit=zl-api-futures-reload.service
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/zl-api-prediction-reload.service <<EOF
[Unit]
Description=Reload prediction services after own exchange API changes
[Service]
Type=oneshot
ExecStart=/bin/systemctl try-restart zl-prediction-v3.service zl-prediction-v2.service zl-prediction-trade.service
EOF
cat > /etc/systemd/system/zl-api-prediction-reload.path <<EOF
[Unit]
Description=Watch only prediction bot exchange keys
[Path]
PathChanged=$STATE/prediction
Unit=zl-api-prediction-reload.service
[Install]
WantedBy=multi-user.target
EOF
# Only attach to the two existing authenticated Caddy virtual hosts.
python3 - <<'PY'
from pathlib import Path
p=Path('/etc/caddy/Caddyfile')
src=p.read_text()
HOSTS=['47-237-188-69.sslip.io','prediction.47-237-188-69.sslip.io']
snippet="""  handle_path /api-keys/* {
    reverse_proxy 127.0.0.1:13016 {
      header_up X-ZL-Verified-Login 1
      header_up -Authorization
    }
  }
  handle /api-keys {
    redir /api-keys/ 308
  }
"""
for host in HOSTS:
    start=src.find(host+' {')
    if start<0:raise SystemExit('CADDY_SITE_MISSING')
    end=src.find('\n}\n',start)
    if end<0:raise SystemExit('CADDY_SITE_UNTERMINATED')
    block=src[start:end]
    if 'basic_auth {' not in block:raise SystemExit('CADDY_AUTH_MISSING')
    if 'handle_path /api-keys/* {' in block:
        continue
    marker=block.find('  handle ')
    if marker<0:marker=block.find('  handle_path ')
    if marker<0:raise SystemExit('CADDY_HANDLE_MISSING')
    block=block[:marker]+snippet+block[marker:]
    src=src[:start]+block+src[end:]
backup=Path('/etc/caddy/Caddyfile.before-api-manager')
if not backup.exists():backup.write_text(p.read_text())
p.write_text(src)
PY
if ! caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  cp /etc/caddy/Caddyfile.before-api-manager /etc/caddy/Caddyfile
  echo "CADDY_VALIDATION_FAILED_RESTORED_BACKUP";exit 11
fi
systemctl daemon-reload
systemctl enable zl-exchange-api-manager.service
# Always restart the manager after installing new source; enable --now is not
# enough to load newly deployed Python handlers in an already active process.
systemctl restart zl-exchange-api-manager.service
systemctl enable --now zl-api-futures-reload.path zl-api-prediction-reload.path
systemctl restart zl-futures-bot-paper.service
systemctl restart zl-prediction-trade.service
systemctl reload caddy
for i in 1 2 3 4 5 6 7 8;do
 if [ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:13016/healthz)" = 403 ];then break;fi
 sleep 2
done
test "$(systemctl is-active zl-exchange-api-manager.service)" = active
test "$(systemctl is-active zl-futures-bot-paper.service)" = active
test "$(systemctl is-active zl-prediction-trade.service)" = active
for port in 10000 13001;do
  ready=no
  for attempt in $(seq 1 15);do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$port/healthz" || true)
    if [ "$code" = 200 ];then ready=yes;break;fi
    sleep 2
  done
  printf 'API_MANAGER_SERVICE_PORT_%s_READY=%s\n' "$port" "$ready"
  test "$ready" = yes
done
echo "API_MANAGER_DEPLOYED=true"
echo "API_MANAGER_LOCALHOST_ONLY=true"
echo "API_MANAGER_ROBOTS_INDEPENDENT=true"
echo "API_MANAGER_TRADING_MODE_UNCHANGED=true"
for bot in futures prediction;do
  keydir="$STATE/$bot"
  test -d "$keydir"
  test "$(stat -c '%U:%G %a' "$keydir")" = 'zlkeys:zlkeys 700'
  echo "API_MANAGER_PERSISTENT_CREDENTIAL_DIR_${bot}=yes"
done
test "$(systemctl is-enabled zl-exchange-api-manager.service)" = enabled
test "$(systemctl is-enabled zl-api-futures-reload.path)" = enabled
test "$(systemctl is-enabled zl-api-prediction-reload.path)" = enabled
echo "API_MANAGER_RESTART_AND_RELOAD_WATCHERS_ENABLED=true"

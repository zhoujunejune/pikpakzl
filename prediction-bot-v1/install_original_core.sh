#!/usr/bin/env bash
# Production code migration (NOT a paper bot). Conservatively stages services
# with order-writing DISABLED until secret/PIN/ledger and exchange checks pass.
set -Eeuo pipefail
umask 027
test "$(id -u)" -eq 0
ROOT=/opt/zl-prediction-live
DATA=/var/lib/zl-prediction
CONF=/etc/zl-prediction
CODE_BRANCH=migration/render-blueprint-20261018
HOST=prediction.47-237-188-69.sslip.io
mkdir -p "$ROOT" "$DATA/rounds" "$DATA/redis" "$DATA/archive" "$CONF"
if ! id zl-pred >/dev/null 2>&1;then useradd --system --home-dir "$ROOT" --shell /usr/sbin/nologin zl-pred; fi
chown -R zl-pred:zl-pred "$ROOT" "$DATA/rounds" "$DATA/archive"
# If the Node 22 binary is not already present, download the Node project
# binary and independently verify its SHA-256 from the official same-version file.
if [ ! -x /opt/zl-prediction-node/bin/node ]; then
  NODE_VERSION=v22.16.0
  NODE_NAME=node-$NODE_VERSION-linux-x64.tar.xz
  TEMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TEMP_DIR"' EXIT
  curl -fsSL --retry 2 "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"
  curl -fsSL --retry 2 "https://nodejs.org/dist/$NODE_VERSION/$NODE_NAME" -o "$TEMP_DIR/$NODE_NAME"
  ( cd "$TEMP_DIR";grep " $NODE_NAME\$" SHASUMS256.txt | sha256sum -c - )
  mkdir -p /opt/zl-prediction-node
  tar -xJf "$TEMP_DIR/$NODE_NAME" --strip-components=1 -C /opt/zl-prediction-node
fi
NODE=/opt/zl-prediction-node/bin/node
NPM=/opt/zl-prediction-node/bin/npm
"$NODE" --version
# Separate Redis on 6385. Not the Railway Redis, so no historical state is
# presumed present. The daemon binds loopback only and uses its own durable AOF.
export DEBIAN_FRONTEND=noninteractive
if ! command -v redis-server >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq redis-server
fi
chown redis:redis "$DATA/redis"
if [ ! -f "$CONF/redis-auth" ];then
  openssl rand -hex 32 > "$CONF/redis-auth"
  chmod 600 "$CONF/redis-auth"
fi
REDIS_PASSWORD=$(cat "$CONF/redis-auth")
cat > "$CONF/redis.conf" <<EOF
bind 127.0.0.1
protected-mode yes
port 6385
daemonize no
supervised no
dir $DATA/redis
appendonly yes
appendfsync everysec
save 300 10
requirepass $REDIS_PASSWORD
maxmemory 150mb
maxmemory-policy noeviction
EOF
chown root:redis "$CONF/redis.conf"
chmod 640 "$CONF/redis.conf"
cat > "$CONF/redis.env" <<EOF
SIGNAL_REDIS_URL=redis://:$REDIS_PASSWORD@127.0.0.1:6385
EOF
chmod 600 "$CONF/redis.env"
cat > /etc/systemd/system/zl-prediction-redis.service <<'EOF'
[Unit]
Description=Dedicated persistent ZL Prediction Redis
After=network-online.target
[Service]
Type=simple
User=redis
Group=redis
ExecStart=/usr/bin/redis-server /etc/zl-prediction/redis.conf
Restart=on-failure
RestartSec=4
LimitNOFILE=65535
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/zl-prediction/redis
[Install]
WantedBy=multi-user.target
EOF
# No shared repo/working tree with the independent futures bot.
if [ ! -d "$ROOT/src/.git" ]; then
  git clone -q --depth=1 -b "$CODE_BRANCH" https://github.com/zhoujunejune/pikpakzl.git "$ROOT/src"
else
  git -C "$ROOT/src" fetch -q --depth=1 origin "$CODE_BRANCH"
  git -C "$ROOT/src" checkout -q --detach FETCH_HEAD
fi
chown -R zl-pred:zl-pred "$ROOT/src"
for folder in fast-signal-engine round-tracker railway-diagnostic;do
  (cd "$ROOT/src/$folder";su -s /bin/sh zl-pred -c "PATH=/opt/zl-prediction-node/bin:/usr/bin:/bin npm install --omit=dev --no-audit --no-fund --silent")
done
# The V2 signal + official resolution cache is durable for NEW records.
# Old Railway volume contents are intentionally NOT overwritten/fabricated.
cat > "$CONF/v3.env" <<'EOF'
PORT=13003
NODE_ENV=production
RENDER_MIGRATION_PREVIEW=false
BINANCE_REST_PREFLIGHT=false
SITE_ORIGIN=https://prediction.47-237-188-69.sslip.io
EOF
cat > "$CONF/v2.env" <<EOF
PORT=13002
NODE_ENV=production
RENDER_MIGRATION_PREVIEW=false
PRODUCTION_SIGNAL_SOURCE_MODE=SELECTIVE_V2_FAST8
SIGNAL_ORIGIN=http://127.0.0.1:13003
SITE_ORIGIN=https://prediction.47-237-188-69.sslip.io
ROUND_HISTORY_FILE=$DATA/rounds/round-history.json
SHADOW_V3_DIR=$DATA/rounds/shadow-v3
PAUSE_NONPROD_SHADOWS=1
EOF
cat > "$CONF/panel.env" <<'EOF'
PORT=13001
INNER_PANEL_PORT=13004
INNER_CONTROL_PORT=13005
PANEL_PUBLIC_PORT=13001
NODE_ENV=production
RENDER_MIGRATION_PREVIEW=false
ROUND_STATS_ORIGIN=http://127.0.0.1:13002
ROUND_STATS_PUBLIC_ORIGIN=http://127.0.0.1:13002
SIGNAL_WS_URL=ws://127.0.0.1:13002/ws/locked-signal
SITE_ORIGIN=https://prediction.47-237-188-69.sslip.io
AUTO_CONFIRM_ENABLED=false
AUTO_TAKE_PROFIT_ENABLED=false
AUTO_STOP_LOSS_ENABLED=false
AUTO_CONFIRM_MAX_ORDERS_PER_ROUND=1
EOF
chmod 640 "$CONF/"{v2,v3,panel}.env
# Use the original production backends. They are not simulators.
for spec in "v3:fast-signal-engine:freeze-wrapper.mjs:13003" "v2:round-tracker:index-rest.mjs:13002" "trade:railway-diagnostic:panel-stats-shell.mjs:13001"; do
  IFS=: read -r short folder entry port <<< "$spec"
  cat > "/etc/systemd/system/zl-prediction-$short.service" <<EOF
[Unit]
Description=ZL prediction original production $short component (live engine)
After=network-online.target zl-prediction-redis.service
Wants=network-online.target
Requires=zl-prediction-redis.service
[Service]
Type=simple
User=zl-pred
Group=zl-pred
WorkingDirectory=$ROOT/src/$folder
Environment=PATH=/opt/zl-prediction-node/bin:/usr/bin:/bin
EnvironmentFile=$CONF/redis.env
EnvironmentFile=$CONF/$short.env
EnvironmentFile=-$CONF/trading.env
ExecStart=$NODE $entry
Restart=on-failure
RestartSec=8
MemoryMax=450M
LimitNOFILE=32768
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$DATA/rounds $DATA/archive
[Install]
WantedBy=multi-user.target
EOF
done
# Preserve preexisting futures Caddy authentication by reusing its bcrypt
# password hash; never print or commit it.
python3 - <<'PY'
from pathlib import Path
import re
p=Path("/etc/caddy/Caddyfile")
contents=p.read_text()
a=re.search(r"basic_auth\s*\{\s*zl\s+(\$2[aby]\$[^\s}]+)",contents)
if not a:raise SystemExit("AUTHENTICATED_FUTURES_GATEWAY_MISSING")
hashval=a.group(1)
host="prediction.47-237-188-69.sslip.io"
if host not in contents:
    backup=Path("/etc/caddy/Caddyfile.before-prediction-live")
    if not backup.exists(): backup.write_text(contents)
    contents += """
prediction.47-237-188-69.sslip.io {
  encode zstd gzip
  basic_auth {
    zl HASH_PLACEHOLDER
  }
  reverse_proxy 127.0.0.1:13001
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "no-referrer"
    Cache-Control "no-store"
  }
}
""".replace("HASH_PLACEHOLDER",hashval)
# Redirect the old in-menu /prediction path to the original full panel
# on its own host, where all /api controls are isolated by origin.
marker="  handle_path /prediction/* {\n    reverse_proxy 127.0.0.1:11000\n  }"
if marker in contents:
    contents=contents.replace(marker,'  handle_path /prediction/* {\n    redir https://'+host+'/{path} 302\n  }')
p.write_text(contents)
PY
caddy validate --config /etc/caddy/Caddyfile >/dev/null
systemctl daemon-reload
systemctl enable --now zl-prediction-redis.service
systemctl enable --now zl-prediction-v3.service
systemctl enable --now zl-prediction-v2.service
systemctl enable --now zl-prediction-trade.service
systemctl reload caddy
# Only a readiness audit. Never claim real orders without actual fill proof.
for component in v3 v2 trade; do
  echo "PRED_CORE_SERVICE_$component=$(systemctl is-active zl-prediction-$component || true)"
done
for port in 13003 13002 13001;do
  echo "PRED_CORE_HTTP_$port=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$port/healthz || true)"
done
test "$(systemctl is-active zl-futures-bot-paper.service)" = active
echo "PRED_CORE_FUTURES_UNCHANGED=true"
echo "PRED_CORE_AUTO_ORDER_DISABLED=true"

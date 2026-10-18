#!/usr/bin/env bash
# Caddy HTTPS + HTTP Basic Auth for SIMULATION ONLY control UI.
set -Eeuo pipefail
: "$PANEL_DOMAIN"
: "$PANEL_BCRYPT_HASH"
: "$PANEL_EXPECTED_IP"
test "$(id -u)" -eq 0
[[ "$PANEL_DOMAIN" =~ ^([0-9]{1,3}-){3}[0-9]{1,3}\.sslip\.io$ ]] || exit 44
test "$(getent ahostsv4 "$PANEL_DOMAIN" | awk 'NR==1{print $1}')" = "$PANEL_EXPECTED_IP" || {
  echo "PANEL_DNS_MISMATCH";exit 45;
}
test -f /etc/systemd/system/zl-futures-bot-paper.service || { echo "PAPER_SERVICE_MISSING";exit 46; }
echo "PANEL: installing HTTPS reverse proxy"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https ca-certificates curl gnupg
if [ ! -f /etc/apt/sources.list.d/caddy-stable.list ]; then
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
fi
apt-get install -y -qq caddy
cat >/etc/caddy/Caddyfile <<EOF
$PANEL_DOMAIN {
  encode zstd gzip
  basic_auth {
    zl $PANEL_BCRYPT_HASH
  }
  reverse_proxy 127.0.0.1:10000
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "no-referrer"
    Cache-Control "no-store"
  }
}
EOF
chmod 0644 /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile >/dev/null
printf 'PUBLIC_ORIGIN=https://%s\n' "$PANEL_DOMAIN" > /etc/zl-futures-bot-panel.env
chmod 0644 /etc/zl-futures-bot-panel.env
systemctl daemon-reload
systemctl restart zl-futures-bot-paper.service
systemctl enable caddy >/dev/null
systemctl restart caddy
systemctl is-active --quiet zl-futures-bot-paper.service
systemctl is-active --quiet caddy.service
echo "PANEL_INSTALLED: Caddy active, backend 127.0.0.1, basic auth on"
echo "PANEL_DOMAIN=$PANEL_DOMAIN"
echo "AUTH_USER=zl"
echo "REAL_TRADING=false"

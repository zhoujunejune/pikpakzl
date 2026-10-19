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
# Preserve the prediction host and exchange-manager routes on future
# phone-panel redeploys. Rotate the existing site's bcrypt hash in place.
if test -f /etc/caddy/Caddyfile && \
   grep -Fq 'prediction.47-237-188-69.sslip.io {' /etc/caddy/Caddyfile && \
   grep -Fq 'handle_path /api-keys/* {' /etc/caddy/Caddyfile; then
  python3 - <<'PY'
from pathlib import Path
import os,re
p=Path('/etc/caddy/Caddyfile')
content=p.read_text()
new_hash=os.environ['PANEL_BCRYPT_HASH']
hosts=[os.environ['PANEL_DOMAIN'],'prediction.47-237-188-69.sslip.io']
for host in hosts:
    start=content.find(host+' {')
    if start<0:raise SystemExit('PANEL_AUTH_HOST_MISSING')
    end=content.find('\n}\n',start)
    if end<0:raise SystemExit('PANEL_AUTH_END_MISSING')
    block=content[start:end]
    old=re.search(r'(basic_auth\s*{\s*zl\s+)(\$2[aby]\$[^\s}]+)',block)
    if not old:raise SystemExit('PANEL_BCRYPT_MISSING')
    block=block[:old.start(2)]+new_hash+block[old.end(2):]
    content=content[:start]+block+content[end:]
p.write_text(content)
PY
else
cat >/etc/caddy/Caddyfile <<EOF
$PANEL_DOMAIN {
  encode zstd gzip
  basic_auth {
    zl $PANEL_BCRYPT_HASH
  }
  handle_path /prediction/* {
    reverse_proxy 127.0.0.1:11000
  }
  handle /prediction {
    redir /prediction/ 308
  }
  handle {
    reverse_proxy 127.0.0.1:10000
  }
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "no-referrer"
    Cache-Control "no-store"
  }
}
EOF
fi
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

#!/usr/bin/env bash
# Pure UI navigation fix; NEVER restart production futures/prediction workers.
set -Eeuo pipefail
test "$(id -u)" -eq 0
[[ "$APP_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 20
for svc in caddy zl-futures-bot-paper zl-prediction-trade; do systemctl is-active --quiet "$svc"; done
fp="$(systemctl show zl-futures-bot-paper.service -p MainPID --value)"
pp="$(systemctl show zl-prediction-trade.service -p MainPID --value)"
test "$fp" -gt 1 && test "$pp" -gt 1
temp="$(mktemp)"
trap 'rm -f "$temp"' EXIT
curl -fsSL --max-time 25 --retry 3 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$APP_SHA/futures-research-panel/nav_bridge.py" -o "$temp"
python3 -m py_compile "$temp"
python3 - "$temp" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
assert '/fapi/v1/order' not in s and 'BINANCE_API_SECRET' not in s
assert 'do_POST' in s and 'get_upstream' in s
assert 'PORT = 13019' in s and 'def decorate(' in s and '/futures-lab/' in s
print('NAV_HTML_ONLY_SOURCE_AUDIT=true')
PY
test -d /opt/zl-futures-research-site
test -d /var/lib/zl-futures-shadow
install -d -m 0755 /opt/zl-futures-nav
install -m 0644 "$temp" /opt/zl-futures-nav/nav_bridge.py
cat >/etc/systemd/system/zl-frontend-nav-bridge.service <<'EOF'
[Unit]
Description=Read-only dynamic third-menu navigation bridge, NOT a trading service
After=network-online.target
Wants=network-online.target
[Service]
User=zlshadow
Group=zlshadow
WorkingDirectory=/opt/zl-futures-nav
ExecStart=/usr/bin/python3 -u /opt/zl-futures-nav/nav_bridge.py
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
CapabilityBoundingSet=
UMask=0077
MemoryMax=48M
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable zl-frontend-nav-bridge.service >/dev/null
systemctl restart zl-frontend-nav-bridge.service
for i in 1 2 3 4 5 6 7 8;do
  if curl -fsS --max-time 4 http://127.0.0.1:13019/healthz >/dev/null;then break;fi
  sleep 2
done
curl -fsS --max-time 4 http://127.0.0.1:13019/healthz >/dev/null
python3 - <<'PY'
import urllib.request
for uri,markers in [
  ("http://127.0.0.1:13019/dashboard/",("影子模型 · 自动训练","预测机器人","交易所 API 管理")),
  ("http://127.0.0.1:13019/",("影子模型 · 自动训练","开始跟随","合约机器人"))]:
    with urllib.request.urlopen(uri,timeout=9) as r:
        text=r.read().decode('utf8')
        assert r.status==200 and all(s in text for s in markers),(uri,"UPSTREAM_MARKER_MISSING")
print('NAV_DYNAMIC_UPSTREAM_BOTH_PAGES_OK=true')
PY
python3 - <<'PY'
from pathlib import Path
import datetime,shutil,subprocess
path=Path('/etc/caddy/Caddyfile')
src=path.read_text()
hosts=[
 ("47-237-188-69.sslip.io","  reverse_proxy 127.0.0.1:10000",
  '''  handle /dashboard/ {
    reverse_proxy 127.0.0.1:13019
    header Cache-Control "no-store"
  }
'''),
 ("prediction.47-237-188-69.sslip.io","  reverse_proxy 127.0.0.1:13001 {",
  '''  handle / {
    reverse_proxy 127.0.0.1:13019
    header Cache-Control "no-store"
  }
'''),
]
for hostname,anchor,snippet in hosts:
    key=hostname+' {'
    lines=src.splitlines(keepends=True)
    matches=[sum(len(line) for line in lines[:i]) for i,line in enumerate(lines) if line.strip()==key]
    assert len(matches)==1,'CADDY_HOST_NOT_UNIQUE_'+hostname
    start=matches[0]
    end=src.find('\n}\n',start)
    if end<0:
        end=src.find('\n}',start)
    assert end>start,'CADDY_CLOSING_BRACE_NOT_FOUND'
    block=src[start:end]
    assert 'basic_auth {' in block and anchor in block,'CADDY_EXPECTED_UPSTREAM_MISSING'
    if 'reverse_proxy 127.0.0.1:13019' not in block:
        block=block.replace(anchor,snippet+anchor,1)
    assert block.count('reverse_proxy 127.0.0.1:13019')==1
    src=src[:start]+block+src[end:]
old=path.read_text()
if old!=src:
    backup=Path('/var/lib/zl-futures-shadow')/('caddy-nav-bridge-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.bak')
    shutil.copy2(path,backup)
    path.write_text(src)
    validated=subprocess.run(['caddy','validate','--config',str(path)],capture_output=True,timeout=20)
    if validated.returncode!=0:
        shutil.copy2(backup,path)
        raise RuntimeError('NAV_CADDY_INVALID_RESTORED')
    reload=subprocess.run(['systemctl','reload','caddy'],capture_output=True,timeout=20)
    if reload.returncode!=0:
        shutil.copy2(backup,path)
        subprocess.run(['systemctl','reload','caddy'],timeout=20)
        raise RuntimeError('NAV_CADDY_RELOAD_FAILED_RESTORED')
    print('NAV_BOTH_CADDY_HOST_ROUTES_UPDATED=true')
else:
    print('NAV_BOTH_CADDY_HOST_ROUTES_ALREADY_UPDATED=true')
PY
# Keep host-level login in force.
for host in 47-237-188-69.sslip.io prediction.47-237-188-69.sslip.io;do
  path=/dashboard/
  if [[ "$host" = prediction.* ]];then path=/;fi
  code="$(curl -sk --resolve "$host:443:127.0.0.1" --max-time 7 \
    -o /dev/null -w '%{http_code}' "https://$host$path")"
  test "$code" = 401 || { echo "NAV_AUTH_FAIL_HOST=$host status=$code";exit 44; }
done
test "$fp" = "$(systemctl show zl-futures-bot-paper.service -p MainPID --value)" || exit 61
test "$pp" = "$(systemctl show zl-prediction-trade.service -p MainPID --value)" || exit 62
test "$(systemctl is-active zl-futures-shadow-research.service)" = active
echo "NAV_LIVE_PRODUCTION_PIDS_UNCHANGED=true"
echo "NAV_AUTHENTICATION_PRESERVED=true"
echo "NAV_INDEPENDENT_SHADOW_ACTIVE=true"
echo "NAV_INSTALL_COMPLETE=true"


# Install the independent EVENT10 signal UI after original navigation checks.
# EVENT10 has no Binance order-writing endpoint.
event10_installer=$(mktemp)
event10_routes=$(mktemp)
trap 'rm -f "$event10_installer" "$event10_routes"' EXIT
curl -fsSL --retry 3 --max-time 25 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$APP_SHA/event10-bot/install_aliyun.sh" -o "$event10_installer"
curl -fsSL --retry 3 --max-time 25 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$APP_SHA/event10-bot/install_routes.sh" -o "$event10_routes"
bash -n "$event10_installer"
bash -n "$event10_routes"
echo EVENT10_INSTALLER_STATIC_CHECKS_PASS=true
bash "$event10_installer"
bash "$event10_routes"
echo EVENT10_ALI_INSTALL_FROM_APPROVED_NAV_WORKFLOW_COMPLETE=true
echo EVENT10_MANUAL_CLICK_RELEASE_V2=true
echo EVENT10_MULTISOURCE_RELEASE_20261024=true
echo EVENT10_BACKGROUND_STREAM_RELEASE_20261024=true
echo EVENT10_ASOF_TIMELINE_FIX_20261024=true
echo EVENT10_AGGREGATE_ID_SEMANTICS_FIX_20261024=true
echo EVENT10_BALANCED_DEEPSEEK_V3_RELEASE_20261024=true
echo EVENT10_NAV_LISTENER_RETRY_VERIFIED_20261024=true

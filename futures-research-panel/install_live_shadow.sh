#!/usr/bin/env bash
# Separate public-market shadow simulator, never touch production processes.
set -Eeuo pipefail
test "$(id -u)" = 0
[[ "$APP_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 42
[[ "$REPORT_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 43
for unit in caddy zl-futures-bot-paper zl-prediction-trade;do systemctl is-active --quiet "$unit";done
fpid="$(systemctl show zl-futures-bot-paper.service -p MainPID --value)"
ppid="$(systemctl show zl-prediction-trade.service -p MainPID --value)"
test "$fpid" -gt 1 && test "$ppid" -gt 1
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
raw="https://raw.githubusercontent.com/zhoujunejune/pikpakzl"
curl -fsSL --max-time 25 "$raw/$APP_SHA/futures-research-panel/live_shadow.py" -o "$scratch/live_shadow.py"
curl -fsSL --max-time 25 "$raw/$APP_SHA/futures-research-panel/index.html" -o "$scratch/index.html"
curl -fsSL --max-time 25 "$raw/$REPORT_SHA/published-results/futures-simulation.json" -o "$scratch/report.json"
python3 -m py_compile "$scratch/live_shadow.py"
python3 - "$scratch/live_shadow.py" "$scratch/index.html" "$scratch/report.json" <<'PY'
import sys,pathlib,json
source=pathlib.Path(sys.argv[1]).read_text()
page=pathlib.Path(sys.argv[2]).read_text()
report=json.loads(pathlib.Path(sys.argv[3]).read_text())
assert 'def do_POST' in source and 'def api(' in source
assert '/fapi/v1/order' not in source and 'BINANCE_API_SECRET' not in source
assert '/futures-lab/live.json' in page
assert report.get('no_live_orders') and len(report.get('rows',[]))==18
print('SHADOW_STATIC_AUDIT_OK=true')
PY
if ! id zlshadow >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/zl-futures-shadow --shell /usr/sbin/nologin --no-create-home zlshadow
fi
install -d -m 0755 /opt/zl-futures-shadow /opt/zl-futures-research-site
install -d -m 0700 -o zlshadow -g zlshadow /var/lib/zl-futures-shadow
install -m 0644 "$scratch/live_shadow.py" /opt/zl-futures-shadow/live_shadow.py
install -m 0644 "$scratch/index.html" /opt/zl-futures-research-site/index.html
install -m 0644 "$scratch/report.json" /opt/zl-futures-research-site/report.json
cat >/etc/systemd/system/zl-futures-shadow-research.service <<'EOF'
[Unit]
Description=Isolated read-only Binance USD-M public-market paper strategy tracker
After=network-online.target
Wants=network-online.target
[Service]
User=zlshadow
Group=zlshadow
WorkingDirectory=/opt/zl-futures-shadow
ExecStart=/usr/bin/python3 -u /opt/zl-futures-shadow/live_shadow.py
Restart=on-failure
RestartSec=12
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=/var/lib/zl-futures-shadow
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
CapabilityBoundingSet=
UMask=0077
MemoryMax=160M
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now zl-futures-shadow-research.service
for i in 1 2 3 4 5 6 7 8;do
 if curl -fsS --max-time 3 http://127.0.0.1:13017/healthz >/dev/null;then break;fi
 sleep 2
done
curl -fsS --max-time 3 http://127.0.0.1:13017/healthz >/dev/null
python3 - <<'PY'
from pathlib import Path
import datetime,shutil,subprocess
p=Path('/etc/caddy/Caddyfile')
old=p.read_text()
lines=old.splitlines(keepends=True)
matches=[sum(len(z) for z in lines[:i]) for i,line in enumerate(lines)
         if line.strip()=='47-237-188-69.sslip.io {']
assert len(matches)==1,'MAIN_HOST_NOT_UNIQUE'
start=matches[0];end=old.find('\n}\n',start)
assert end>start
block=old[start:end]
assert 'basic_auth {' in block and 'reverse_proxy 127.0.0.1:10000' in block
static='''  handle_path /futures-lab/* {
    root * /opt/zl-futures-research-site
    file_server
    header Cache-Control "no-store"
  }
  handle /futures-lab {
    redir /futures-lab/ 308
  }
'''
dynamic='''  handle /futures-lab/live.json {
    reverse_proxy 127.0.0.1:13017
    header Cache-Control "no-store"
  }
'''
if 'handle_path /futures-lab/* {' not in block:
    i=block.find('  handle ')
    assert i>=0
    block=block[:i]+static+block[i:]
if 'handle /futures-lab/live.json {' not in block:
    i=block.index('  handle_path /futures-lab/* {')
    block=block[:i]+dynamic+block[i:]
assert block.count('handle /futures-lab/live.json {')==1
new=old[:start]+block+old[end:]
if new!=old:
    backup=Path('/var/lib/zl-futures-shadow')/('caddy-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.bak')
    shutil.copy2(p,backup)
    p.write_text(new)
    if subprocess.run(['caddy','validate','--config',str(p)],capture_output=True,timeout=15).returncode:
        shutil.copy2(backup,p);raise RuntimeError('CADDY_INVALID_RESTORED')
    if subprocess.run(['systemctl','reload','caddy'],capture_output=True,timeout=15).returncode:
        shutil.copy2(backup,p)
        subprocess.run(['systemctl','reload','caddy'],timeout=15)
        raise RuntimeError('CADDY_RELOAD_FAILED_RESTORED')
    print('SHADOW_CADDY_ROUTE_UPDATED=true')
else:print('SHADOW_CADDY_ROUTE_ALREADY_READY=true')
PY
test "$fpid" = "$(systemctl show zl-futures-bot-paper.service -p MainPID --value)" || exit 61
test "$ppid" = "$(systemctl show zl-prediction-trade.service -p MainPID --value)" || exit 62
test "$(systemctl is-active zl-futures-shadow-research.service)" = active
status=$(curl -sk --resolve 47-237-188-69.sslip.io:443:127.0.0.1 -o /dev/null -w '%{http_code}' --max-time 6 https://47-237-188-69.sslip.io/futures-lab/live.json)
test "$status" = 401 || { echo "SHADOW_AUTH_REQUIRED_EXPECTED_401_ACTUAL=$status";exit 63; }
echo "SHADOW_REAL_ORDERS_SUBMITTED=0"
echo "SHADOW_PRODUCTION_MAIN_PIDS_UNCHANGED=true"
echo "SHADOW_INSTALL_COMPLETE=true"

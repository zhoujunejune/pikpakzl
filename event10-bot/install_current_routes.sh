#!/usr/bin/env bash
# Re-enable only EVENT10 on the current single-panel Caddy topology.
set -Eeuo pipefail
test "$(id -u)" -eq 0
[[ "${APP_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || exit 2
for unit in caddy zl-prediction-trade zl-event10-deepseek;do
  systemctl is-active --quiet "$unit" || { echo "EVENT10_ROUTING_UNIT_DOWN=$unit"; exit 13; }
done
predpid=$(systemctl show zl-prediction-trade -p MainPID --value)
curl -fsS --max-time 5 http://127.0.0.1:13020/api/status >/dev/null
dir=$(mktemp -d /tmp/zl-event10-current-route.XXXXXXXX)
changed=0
restore(){
  code=$?
  trap - EXIT
  if test "$code" -ne 0 && test "$changed" = 1;then
    cp -p "$dir/Caddyfile.before" /etc/caddy/Caddyfile
    caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 && systemctl reload caddy || true
    echo EVENT10_CADDY_ROUTE_ROLLED_BACK=true
  fi
  rm -rf "$dir"
  exit "$code"
}
trap restore EXIT
curl -fsSL --retry 3 --max-time 25 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$APP_SHA/event10-bot/frontend_nav.py" \
 -o "$dir/frontend_nav.py"
python3 -m py_compile "$dir/frontend_nav.py"
install -d -o root -g root -m 0755 /opt/zl-event10
install -o root -g root -m 0644 "$dir/frontend_nav.py" /opt/zl-event10/frontend_nav.py
cat >/etc/systemd/system/zl-event10-frontend-nav.service <<'UNIT'
[Unit]
Description=Read-only navigation for the independent EVENT10 frontend
After=network-online.target zl-prediction-trade.service
Wants=network-online.target
[Service]
User=zl-pred
Group=zl-pred
WorkingDirectory=/opt/zl-event10
ExecStart=/usr/bin/python3 -u /opt/zl-event10/frontend_nav.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
CapabilityBoundingSet=
MemoryMax=64M
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable zl-event10-frontend-nav.service >/dev/null
systemctl restart zl-event10-frontend-nav.service
ready=0
for n in 1 2 3 4 5 6 7 8 9 10;do
  if curl -fsS --max-time 3 http://127.0.0.1:13019/healthz >/dev/null 2>&1;then ready=1;break;fi
  sleep 1
done
test "$ready" = 1
curl -fsS --max-time 8 http://127.0.0.1:13019/ >"$dir/homepage"
python3 - "$dir/homepage" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]).read_text()
assert 'id="zl-event10-restored-nav"' in p
assert 'href="/event10/"' in p
assert '5分钟 API 实盘确认控制台' in p
print('EVENT10_EXISTING_PREDICTION_PANEL_PRESERVED=true')
PY

cp -p /etc/caddy/Caddyfile "$dir/Caddyfile.before"
python3 - <<'PY'
from pathlib import Path
import re
p=Path('/etc/caddy/Caddyfile')
s=p.read_text()
host='prediction.47-237-188-69.sslip.io {'
assert s.count(host)==1,'PREDICTION_CADDY_HOST_NOT_UNIQUE'
a=s.index(host)
end=s.find('\n}',a)
assert end>a,'PREDICTION_CADDY_HOST_END_NOT_FOUND'
block=s[a:end]
assert 'basic_auth {' in block and 'reverse_proxy 127.0.0.1:13001' in block, 'AUTH_OR_PANEL_ROUTING_CHANGED'
pattern=r'(?m)^([ \t]*)handle /event10\* \{\s*\n[ \t]*respond 404\s*\n[ \t]*\}'
m=re.search(pattern,block)
assert m, 'RETIRED_EVENT10_PLACEHOLDER_NOT_FOUND'
indent=m.group(1)
active=(indent+'handle /event10* {\n'
        +indent+'  uri strip_prefix /event10\n'
        +indent+'  reverse_proxy 127.0.0.1:13020\n'
        +indent+'  header Cache-Control "no-store"\n'
        +indent+'}')
block=block[:m.start()]+active+block[m.end():]
pattern_root=r'(?m)^([ \t]*)handle \{\s*\n([ \t]*)reverse_proxy 127\.0\.0\.1:13001 \{'
m=re.search(pattern_root,block)
assert m, 'ORIGINAL_5MIN_FALLBACK_NOT_FOUND'
indent=m.group(1)
nav=(indent+'handle / {\n'+indent+'  reverse_proxy 127.0.0.1:13019\n'+indent+'}\n')
block=block[:m.start()]+nav+block[m.start():]
assert block.count('127.0.0.1:13020')==1 and block.count('127.0.0.1:13019')==1
assert block.count('reverse_proxy 127.0.0.1:13001')==1
assert 'basic_auth {' in block
new=s[:a]+block+s[end:]
p.write_text(new)
print('EVENT10_CADDY_CURRENT_ROUTES_STAGED=true')
PY
changed=1
caddy validate --config /etc/caddy/Caddyfile >/dev/null
systemctl reload caddy
# Current Caddy's Basic Auth must stay in force for BOTH pages.
for path in / /event10/ /event10/api/status;do
  code=$(curl -sk --resolve prediction.47-237-188-69.sslip.io:443:127.0.0.1 \
    --max-time 9 -o /dev/null -w '%{http_code}' \
    "https://prediction.47-237-188-69.sslip.io$path")
  test "$code" = 401 || { echo "EVENT10_LOGIN_PROTECTION_FAILED_PATH=$path CODE=$code"; exit 33; }
done
test "$predpid" = "$(systemctl show zl-prediction-trade -p MainPID --value)"
echo EVENT10_AUTH_AND_CURRENT_MENU_ROUTE_RESTORED=true
echo EVENT10_5MIN_PROCESS_UNCHANGED=true

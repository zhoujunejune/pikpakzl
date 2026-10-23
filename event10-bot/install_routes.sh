#!/usr/bin/env bash
# EVENT10 only: add an authenticated route and HTML-only navigation link.
set -Eeuo pipefail
test "$(id -u)" -eq 0
[[ "$APP_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 2
for svc in caddy zl-frontend-nav-bridge zl-futures-bot-paper zl-prediction-trade zl-event10-deepseek;do
  test "$(systemctl is-active "$svc")" = active
done
predpid=$(systemctl show -p MainPID --value zl-prediction-trade)
futpid=$(systemctl show -p MainPID --value zl-futures-bot-paper)
dir=$(mktemp -d /tmp/zl-event10-routes.XXXXXX)
cp -p /etc/caddy/Caddyfile "$dir/Caddyfile"
cp -p /opt/zl-futures-nav/nav_bridge.py "$dir/nav_bridge.py"
finish(){
 rc=$?
 trap - EXIT
 if test "$rc" -ne 0;then
  cp -p "$dir/Caddyfile" /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 && systemctl reload caddy || true
  cp -p "$dir/nav_bridge.py" /opt/zl-futures-nav/nav_bridge.py
  systemctl restart zl-frontend-nav-bridge || true
 fi
 rm -rf "$dir"
 exit "$rc"
}
trap finish EXIT
curl -fsSL --max-time 25 --retry 3 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$APP_SHA/futures-research-panel/nav_bridge.py" -o "$dir/new-nav.py"
python3 -m py_compile "$dir/new-nav.py"
python3 - <<'PY'
from pathlib import Path
p=Path('/etc/caddy/Caddyfile')
s=p.read_text()
hosts=(('47-237-188-69.sslip.io','  reverse_proxy 127.0.0.1:10000'),
       ('prediction.47-237-188-69.sslip.io','  reverse_proxy 127.0.0.1:13001 {'))
snippet='''  handle_path /event10/* {
    reverse_proxy 127.0.0.1:13020
    header Cache-Control "no-store"
  }
'''
for host,anchor in hosts:
 lines=s.splitlines(keepends=True)
 heads=[sum(len(t) for t in lines[:i]) for i,t in enumerate(lines) if t.strip()==host+' {']
 assert len(heads)==1,host
 a=heads[0]
 b=s.find('\n}\n',a)
 if b<0:b=s.find('\n}',a)
 assert b>a
 block=s[a:b]
 assert 'basic_auth {' in block and anchor in block,host
 if 'handle_path /event10/*' not in block:block=block.replace(anchor,snippet+anchor,1)
 assert block.count('handle_path /event10/*')==1
 s=s[:a]+block+s[b:]
p.write_text(s)
print('EVENT10_CADDY_ROUTE_INSERTED=true')
PY
caddy validate --config /etc/caddy/Caddyfile >/dev/null
systemctl reload caddy
install -o root -g root -m 0644 "$dir/new-nav.py" /opt/zl-futures-nav/nav_bridge.py
systemctl restart zl-frontend-nav-bridge
python3 - <<'PY'
import urllib.request
for uri,marker in (
 ("http://127.0.0.1:13019/dashboard/",'href="/event10/"'),
 ("http://127.0.0.1:13019/",'/event10/'),
 ("http://127.0.0.1:13020/",'锁定当前参考价并让 DeepSeek 分析')
):
 with urllib.request.urlopen(uri,timeout=12) as r:
  assert r.status==200 and marker in r.read().decode('utf-8'),uri
print('EVENT10_INTERNAL_NAV_AND_PAGE_OK=true')
PY
for host in 47-237-188-69.sslip.io prediction.47-237-188-69.sslip.io;do
 code=$(curl -sk --resolve "$host:443:127.0.0.1" --max-time 10 -o /dev/null -w '%{http_code}' "https://$host/event10/")
 test "$code" = 401 || { echo "EVENT10_AUTH_NOT_PRESERVED=$host status=$code";exit 30; }
done
test "$predpid" = "$(systemctl show -p MainPID --value zl-prediction-trade)"
test "$futpid" = "$(systemctl show -p MainPID --value zl-futures-bot-paper)"
echo EVENT10_ROUTES_DEPLOYED=true
echo EVENT10_PRODUCTION_PIDS_UNCHANGED=true

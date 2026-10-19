#!/usr/bin/env bash
# Add static research dashboard under current Caddy login. NEVER restart trading.
set -Eeuo pipefail
test "$(id -u)" -eq 0
[[ "$PANEL_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 40
[[ "$REPORT_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 41
BASE=/opt/zl-futures-research-site
install -d -m 0755 "$BASE"
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT
url="https://raw.githubusercontent.com/zhoujunejune/pikpakzl"
curl -fsSL --retry 3 --max-time 25 "$url/$PANEL_SHA/futures-research-panel/index.html" -o "$temp/index.html"
curl -fsSL --retry 3 --max-time 25 "$url/$REPORT_SHA/published-results/futures-simulation.json" -o "$temp/report.json"
python3 - "$temp/index.html" "$temp/report.json" <<'PY'
import sys,json,pathlib
html=pathlib.Path(sys.argv[1]).read_text()
j=json.loads(pathlib.Path(sys.argv[2]).read_text())
assert '<html' in html and 'id="compare"' in html and 'report.json' in html
assert j.get('kind')=='historical_simulation' and j.get('no_live_orders') is True
assert j.get('official_freqtrade_engine') is False
assert len(j.get('rows',[]))==18
assert all(r.get('symbol') in ('BTCUSDT','ETHUSDT','BTCUSDC') for r in j['rows'])
assert len(html)<200000 and pathlib.Path(sys.argv[2]).stat().st_size<900000
print('RESEARCH_REPORT_VERIFIED_ROWS=18')
PY
systemctl is-active --quiet caddy.service
systemctl is-active --quiet zl-futures-bot-paper.service
systemctl is-active --quiet zl-prediction-trade.service
before_futures=$(systemctl show zl-futures-bot-paper.service -p MainPID --value)
before_prediction=$(systemctl show zl-prediction-trade.service -p MainPID --value)
test "$before_futures" -gt 1 && test "$before_prediction" -gt 1
install -m 0644 "$temp/index.html" "$BASE/index.html.new"
install -m 0644 "$temp/report.json" "$BASE/report.json.new"
mv "$BASE/index.html.new" "$BASE/index.html"
mv "$BASE/report.json.new" "$BASE/report.json"
python3 - <<'PY'
from pathlib import Path
import shutil,subprocess,datetime,re
p=Path('/etc/caddy/Caddyfile')
src=p.read_text()
site_lines=src.splitlines(keepends=True)
matches=[sum(len(z) for z in site_lines[:i]) for i,line in enumerate(site_lines)
         if line.strip()=="47-237-188-69.sslip.io {"]
assert len(matches)==1,"MAIN_HOST_AMBIGUOUS"
start=matches[0]
end=src.find('\n}\n',start)
assert end>start
block=src[start:end]
assert 'basic_auth {' in block,'LOGIN_MISSING'
assert 'reverse_proxy 127.0.0.1:10000' in block,'FUTURES_ROUTE_MISSING'
addon='''  handle_path /research/* {
    root * /opt/zl-futures-research-site
    file_server
    header Cache-Control "no-store"
  }
  handle /research {
    redir /research/ 308
  }
'''
if 'handle_path /research/* {' in block:
    assert block.count('handle_path /research/* {')==1
    print('RESEARCH_ROUTE_ALREADY_PRESENT=true')
else:
    pos=block.find('  handle ')
    if pos<0:raise RuntimeError('CADDY_HANDLE_NOT_FOUND')
    new=src[:start]+block[:pos]+addon+block[pos:]+src[end:]
    backup=Path('/var/lib/zl-futures-research/caddy-backup-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.bak')
    backup.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(p,backup)
    p.write_text(new)
    check=subprocess.run(['caddy','validate','--config',str(p)],capture_output=True,timeout=15)
    if check.returncode:
        shutil.copy2(backup,p)
        raise RuntimeError('CADDY_INVALID_RESTORED')
    reload=subprocess.run(['systemctl','reload','caddy'],capture_output=True,timeout=15)
    if reload.returncode:
        shutil.copy2(backup,p)
        subprocess.run(['systemctl','reload','caddy'],timeout=15)
        raise RuntimeError('CADDY_RELOAD_FAILED_RESTORED')
    print('RESEARCH_ROUTE_INSTALLED=true')
PY
test "$before_futures" = "$(systemctl show zl-futures-bot-paper.service -p MainPID --value)" || exit 63
test "$before_prediction" = "$(systemctl show zl-prediction-trade.service -p MainPID --value)" || exit 64
test "$(systemctl is-active caddy.service)" = active
status=$(curl -sk --resolve 47-237-188-69.sslip.io:443:127.0.0.1 -o /dev/null -w '%{http_code}' --max-time 5 'https://47-237-188-69.sslip.io/research/')
test "$status" = 401 || { echo "RESEARCH_AUTH_FAIL=$status";exit 65; }
echo "RESEARCH_PANEL_INSTALLED=true"
echo "RESEARCH_PANEL_EXISTING_BASIC_AUTH=true"
echo "PRODUCTION_BOT_MAIN_PIDS_UNCHANGED=true"
echo "REAL_ORDERS_SUBMITTED=0"

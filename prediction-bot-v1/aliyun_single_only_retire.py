#!/usr/bin/env python3
"""Retire Alibaba non-single bots. Archive recoverable assets, keep live 5m single trading dependencies."""
import base64,os,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REGION='ap-southeast-1'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
export LC_ALL=C.UTF-8
ARCHIVE=/var/backups/zl-retired-bots-$(date -u +%Y%m%dT%H%M%SZ)
CADDY=/etc/caddy/Caddyfile
PANEL=/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs
NODE=/opt/zl-prediction-node/bin/node
echo SINGLE_ONLY_START_UTC=$(date -u +%FT%TZ)
for svc in caddy zl-prediction-redis zl-prediction-v2 zl-prediction-v3 zl-prediction-trade zl-prediction-fast5 zl-prediction-fast5-stats zl-prediction-risk-exits zl-prediction-official-reference zl-exchange-api-manager;do
  systemctl is-active --quiet "$svc" || { echo "SINGLE_DEPENDENCY_MISSING=$svc";exit 20; }
done
test -f "$CADDY" && test -f "$PANEL" && test -x "$NODE"
python3 - <<'PY'
import json,urllib.request
def get(port,path):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=6) as r:return json.load(r)
single=get(13001,'/api/status')
dual=get(13048,'/api/status')
futures=get(10000,'/status')
event=get(13020,'/api/status')
assert single.get('ok') is True and single.get('enabled') is False,'SINGLE_FOLLOW_ENABLED_ABORT'
assert dual.get('model')=='BINANCE_DUAL5_PAIR_V1' and dual.get('active') is False,'DUAL_ACTIVE_ABORT'
assert futures.get('mode')=='live' and futures.get('liveTradingEnabled') is False,'FUTURES_TRADING_ON_ABORT'
assert not futures.get('positions') and futures.get('pendingOrderUncertain') is False,'FUTURES_POSITION_OR_PENDING_ABORT'
assert event.get('active') is None and event.get('executionAvailable') is False,'EVENT10_RUNNING_ABORT'
print('PRECHECK_SINGLE_OFF_DUAL_OFF_FUTURES_FLAT_EVENT_IDLE=true')
PY
mkdir -p -m 700 "$ARCHIVE"/{source,units,opt,logs}
test ! -e "$ARCHIVE/source/caddy.original" || { echo "EXISTING_CLEANUP_ARCHIVE_ABORT";exit 22; }
cp -p "$CADDY" "$ARCHIVE/source/caddy.original"
cp -p "$PANEL" "$ARCHIVE/source/panel.original"
# Preserve non-secret unit metadata for rollback. No secrets or file content printed.
systemctl list-units --all --no-pager 'zl-*' > "$ARCHIVE/logs/services-before.txt" || true
systemctl list-unit-files --no-pager 'zl-*' > "$ARCHIVE/logs/enabled-before.txt" || true
set +e
python3 - <<'PY'
from pathlib import Path
import re,json,os
caddy=Path('/etc/caddy/Caddyfile')
panel=Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
src=caddy.read_text()
def braced(s,pos):
 start=s.index('{',pos)
 depth=0
 for i in range(start,len(s)):
  if s[i]=='{':depth+=1
  elif s[i]=='}':
   depth-=1
   if depth==0:return s[pos:i+1]
 raise ValueError('UNBALANCED_CADDY')
def site(host):
 match=re.search(r'(?m)^'+re.escape(host)+r' \{$',src)
 assert match,'SITE_NOT_FOUND_'+host
 return braced(src,match.start())
def snippet(block,pattern):
 m=re.search(pattern,block,re.M)
 assert m,'CADDY_SNIPPET_MISSING_'+pattern
 return braced(block,m.start())
mainhost='47-237-188-69.sslip.io'
predhost='prediction.47-237-188-69.sslip.io'
main=site(mainhost); pred=site(predhost)
assert sum(x.strip()==mainhost+' {' for x in src.splitlines())==1 and sum(x.strip()==predhost+' {' for x in src.splitlines())==1,'AMBIGUOUS_SITES'
leftover=src.replace(main,'',1).replace(pred,'',1)
assert all(not z.strip() or z.lstrip().startswith('#') for z in leftover.splitlines()),'UNKNOWN_OTHER_CADDY_CONFIG_ABORT'
authmain=snippet(main,r'(?m)^\s*basic_auth\s*\{')
authpred=snippet(pred,r'(?m)^\s*basic_auth\s*\{')
apiroute=snippet(pred,r'(?m)^\s*handle_path /api-keys/\*\s*\{')
apiredir=snippet(pred,r'(?m)^\s*handle /api-keys\s*\{')
settings1=snippet(pred,r'(?m)^\s*handle /settings/\*\s*\{')
settings2=snippet(pred,r'(?m)^\s*handle /settings\s*\{')
proxy=snippet(pred,r'(?m)^\s*reverse_proxy 127\.0\.0\.1:13001\s*\{')
deny=['/dual5*','/event10*','/api/dual5*','/api/event10*','/dashboard*','/futures-lab*','/research*','/llm*','/deepseek*']
routes='\n'.join('  handle '+p+' { respond 404 }' for p in deny)
newmain=mainhost+' {\n'+authmain+'\n  redir https://'+predhost+'/ 302\n}'
newpred=predhost+' {\n'+authpred+'\n'+apiroute+'\n'+apiredir+'\n'+settings1+'\n'+settings2+'\n'+routes+'\n  handle {\n'+proxy+'\n  }\n}'
newcaddy=newmain+'\n\n'+newpred+'\n'
# Only adjust the live HTML shell; leave signal, settlement, orders, and stop-loss logic intact.
html=panel.read_text()
singlebar=('<header class="zl-v2-bar" data-zl-theme="v2"><div class="zl-v2-inner">'
 '<div class="zl-v2-brand"><span class="zl-v2-logo" aria-hidden="true">◇</span>'
 '<div class="zl-v2-product"><b>BTC · 5分钟单边预测</b><small>LIVE MARKET CONTROL</small></div>'
 '</div></div></header>')
if 'const ZL_HEADER_V2 = ' in html:
 line_pattern=r'(?m)^const ZL_HEADER_V2 = [^\n]+;\s*$'
 assert len(re.findall(line_pattern,html))==1,'SINGLE_HEADER_ANCHOR_AMBIGUOUS'
 html=re.sub(line_pattern,lambda _: 'const ZL_HEADER_V2 = '+json.dumps(singlebar,ensure_ascii=False)+';',html,count=1)
else:
 print('PANEL_V2_HEADER_MISSING_FALLBACK_KEEP')
if 'html=injectDual5RobotMenu(html);' in html:
 html=html.replace('html=injectDual5RobotMenu(html);','',1)
# Remove old three-menu links from the HTML only, not any trading endpoints.
html=html.replace('aria-label="三个机器人切换"','aria-label="单边机器人"')
def write(path,data):
 tmp=path.with_name(path.name+'.singleonly.stage')
 tmp.write_text(data,encoding='utf8')
 st=path.stat()
 os.chmod(tmp,st.st_mode&0o777);os.chown(tmp,st.st_uid,st.st_gid)
 os.replace(tmp,path)
write(caddy,newcaddy);write(panel,html)
print('CADDY_TWO_HOST_SINGLE_ONLY_AND_PANEL_STAGED=true')
PY
patch_rc=$?
set -e
if [ "$patch_rc" -ne 0 ];then
  cp -p "$ARCHIVE/source/caddy.original" "$CADDY"
  cp -p "$ARCHIVE/source/panel.original" "$PANEL"
  echo SINGLE_ONLY_PATCH_ABORT_AND_REVERTED
  exit 30
fi
if ! caddy validate --config "$CADDY" >/dev/null 2>&1 || ! "$NODE" --check "$PANEL";then
 cp -p "$ARCHIVE/source/caddy.original" "$CADDY"
 cp -p "$ARCHIVE/source/panel.original" "$PANEL"
 echo SINGLE_ONLY_SYNTAX_ABORT_AND_REVERTED
 exit 31
fi
if ! systemctl reload caddy || ! systemctl restart zl-prediction-trade;then
 cp -p "$ARCHIVE/source/caddy.original" "$CADDY"
 cp -p "$ARCHIVE/source/panel.original" "$PANEL"
 systemctl reload caddy || true
 systemctl restart zl-prediction-trade || true
 echo SINGLE_ONLY_RESTART_ABORT_AND_REVERTED
 exit 32
fi
ready=no
for i in $(seq 1 25);do
 if curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o /tmp/zl-single-only-status.json &&
    curl -fsS --max-time 3 http://127.0.0.1:13001/ -o /tmp/zl-single-only-page.html;then
   ready=yes;break
 fi
 sleep 1
done
if [ "$ready" != yes ];then
 cp -p "$ARCHIVE/source/caddy.original" "$CADDY"
 cp -p "$ARCHIVE/source/panel.original" "$PANEL"
 systemctl reload caddy || true
 systemctl restart zl-prediction-trade || true
 echo SINGLE_ONLY_PANEL_UNAVAILABLE_ROLLBACK
 exit 33
fi
python3 - <<'PY'
import json
from pathlib import Path
s=json.loads(Path('/tmp/zl-single-only-status.json').read_text())
p=Path('/tmp/zl-single-only-page.html').read_text()
assert s.get('ok') is True and s.get('enabled') is False,'SINGLE_STATE_CHANGED'
assert '5分钟单边预测' in p or 'BTC · 5分钟单边预测' in p,'SINGLE_TITLE_MISSING'
print('SINGLE_CONTROL_PANEL_AND_TRADE_STATUS_VERIFIED=true')
PY
# Only after the retained single-bot interface and service are confirmed:
# stop and disable every independent non-single worker.
retire="zl-api-futures-reload.path zl-api-futures-reload.service zl-deepseek-fast10-shadow.service zl-deepseek-results-display-only.service zl-deepseek-shadow-online.service zl-deepseek-shadow15-online.service zl-event10-deepseek.service zl-event10-trade-stream.service zl-frontend-nav-bridge.service zl-futures-bot-paper.service zl-futures-shadow-research.service zl-prediction-dual5.service zl-prediction-readonly.service zl-prediction-deepseek5.service zl-prediction-llm5.service"
for unit in $retire;do
  systemctl stop "$unit" >/dev/null 2>&1 || true
  systemctl disable "$unit" >/dev/null 2>&1 || true
  f="/etc/systemd/system/$unit"
  if [ -f "$f" ];then mv "$f" "$ARCHIVE/units/$unit";fi
  echo RETIRED_UNIT="$unit"
done
# Futures-only drop-in is never needed by the five-minute prediction bot.
if [ -d /etc/systemd/system/zl-futures-bot-paper.service.d ];then
 mv /etc/systemd/system/zl-futures-bot-paper.service.d "$ARCHIVE/units/zl-futures-bot-paper.service.d"
fi
for dir in /opt/zl-futures-bot /opt/zl-futures-shadow /opt/zl-futures-research-site /opt/zl-futures-nav /opt/zl-prediction-dual5 /opt/zl-event10 /opt/zl-prediction-monitor /opt/zl-freqtrade-research;do
 if [ -d "$dir" ];then mv "$dir" "$ARCHIVE/opt/$(basename "$dir")";echo RETIRED_RUNTIME="$dir";fi
done
systemctl daemon-reload
systemctl reset-failed >/dev/null 2>&1 || true
echo SINGLE_ONLY_POSTCHECK_BEGIN
for svc in caddy zl-prediction-redis zl-prediction-v2 zl-prediction-v3 zl-prediction-trade zl-prediction-fast5 zl-prediction-fast5-stats zl-prediction-risk-exits zl-prediction-official-reference zl-exchange-api-manager;do
  systemctl is-active --quiet "$svc" || { echo "SINGLE_REQUIRED_UNIT_DOWN=$svc";exit 60; }
done
for svc in zl-futures-bot-paper zl-futures-shadow-research zl-prediction-dual5 zl-event10-deepseek zl-event10-trade-stream zl-deepseek-fast10-shadow zl-deepseek-results-display-only zl-frontend-nav-bridge zl-prediction-readonly;do
 if systemctl is-active --quiet "$svc";then echo "RETIRED_STILL_ACTIVE=$svc";exit 61;fi
done
for path in /dual5 /event10/ /futures-lab/ /dashboard/;do
 code=$(curl -sk --resolve "prediction.47-237-188-69.sslip.io:443:127.0.0.1" -o /dev/null -w '%{http_code}' --max-time 4 "https://prediction.47-237-188-69.sslip.io$path" || true)
 echo "RETIRED_ROUTE=$path STATUS=$code"
done
for port in 10000 11000 13019 13020 13021 13048;do
 if ss -ltn | grep -q "127.0.0.1:$port ";then echo "RETIRED_PORT_LISTENING=$port";exit 62;fi
done
curl -fsS --max-time 8 http://127.0.0.1:13001/api/status -o /tmp/zl-single-only-after.json
python3 - <<'PY'
import json
from pathlib import Path
s=json.loads(Path('/tmp/zl-single-only-after.json').read_text())
assert s.get('ok') is True and s.get('enabled') is False
print('SINGLE_ONLY_PRODUCTION_STILL_READY=true')
PY
for port in 13002 13003 13004 13005;do
 code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/healthz" || true)
 echo SINGLE_DEPENDENCY_HTTP="$port:$code"
 test "$code" = 200 || exit 63
done
echo SINGLE_ONLY_REMOVAL_COMPLETE=true
echo SINGLE_ONLY_ARCHIVE="$ARCHIVE"
"""
def main():
 key=os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID');sec=os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET')
 if not key or not sec:
  print('SINGLE_ONLY_AUTH_MISSING');return 2
 cl=Client(api.Config(access_key_id=key,access_key_secret=sec,region_id=REGION,endpoint='swas.ap-southeast-1.aliyuncs.com'))
 try:
  res=cl.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name='zl-retire-non-single-bots',type='RunShellScript',command_content=SCRIPT,working_user='root',timeout=240))
  print('SINGLE_ONLY_REMOTE_INVOCATION_CREATED=true')
  for _ in range(105):
   time.sleep(2)
   d=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=res.body.invoke_id)).body.invocation_result
   if not d or str(d.invocation_status) not in ('Success','Failed','Aborted','ExecutionTimeout','ClientNotRunning','ExitCodeNonzero'):continue
   try:output=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
   except Exception:output=str(d.output or '')
   print('SINGLE_ONLY_REMOTE_STATUS',d.invocation_status,'EXIT',d.exit_code)
   print(output[-28000:])
   return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'SINGLE_ONLY_REMOVAL_COMPLETE=true' in output else 5
  print('SINGLE_ONLY_REMOTE_POLL_TIMEOUT');return 6
 except Exception as ex:
  print('SINGLE_ONLY_CLOUD_ERROR',type(ex).__name__,str(ex)[:300]);return 7
if __name__=='__main__':sys.exit(main())

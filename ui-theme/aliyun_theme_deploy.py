#!/usr/bin/env python3
"""Deploy CSS-only minimal-tech theme to three Alibaba UI surfaces, with safe service gating."""
import base64,gzip,os,sys,time
from pathlib import Path
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

ROOT=Path(__file__).parent
def blob(path):
 return base64.b64encode(gzip.compress(path.read_bytes())).decode("ascii")
def main():
 if not os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID") or not os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET"):
  print("ALIBABA_AUTH_MISSING");return 2
 payloads={"CSS_PAYLOAD":blob(ROOT/"minimal-tech.css"),"PY_PAYLOAD":blob(ROOT/"patch_three_ui.py")}
 script=r"""#!/bin/bash
set -Eeuo pipefail
tmp=$(mktemp -d /tmp/zl-three-theme.XXXXXXXX)
backup=/var/lib/zl-prediction/three-theme-backups/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p -m 700 "$backup"
single=/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs
dual=/opt/zl-prediction-dual5/binance_dual5_dashboard.html
event=/opt/zl-event10/panel.html
for file in "$single" "$dual" "$event";do test -f "$file";done
before_trade_pid=$(systemctl show zl-prediction-trade -p MainPID --value)
before_fast_pid=$(systemctl show zl-prediction-fast5 -p MainPID --value)
before_dual_pid=$(systemctl show zl-prediction-dual5 -p MainPID --value)
changed=0
completed=0
finish(){
 if [ "$changed" = 1 ] && [ "$completed" = 0 ];then
  cp -p "$backup/single.mjs" "$single" || true
  cp -p "$backup/dual.html" "$dual" || true
  cp -p "$backup/event.html" "$event" || true
  systemctl restart zl-prediction-trade || true
  systemctl restart zl-event10-deepseek || true
  echo UI_ROLLBACK_PERFORMED
 fi
 rm -rf "$tmp"
}
trap finish EXIT
python3 - "$tmp" <<'UNPACK'
import gzip,base64,sys,pathlib
dst=pathlib.Path(sys.argv[1])
dst.joinpath('theme.css').write_bytes(gzip.decompress(base64.b64decode('CSS_PAYLOAD')))
dst.joinpath('patch.py').write_bytes(gzip.decompress(base64.b64decode('PY_PAYLOAD')))
UNPACK
python3 - <<'GUARD'
import json,urllib.request
def get(u):
 with urllib.request.urlopen(u,timeout=5) as r:return json.load(r)
p=get('http://127.0.0.1:13001/api/status')
d=get('http://127.0.0.1:13048/api/status')
e=get('http://127.0.0.1:13020/api/status')
assert p.get('enabled') is False, 'SINGLE_FOLLOW_ENABLED_ABORT'
assert d.get('model')=='BINANCE_DUAL5_PAIR_V1' and d.get('active') is False, 'DUAL_LIVE_ACTIVE_ABORT'
assert e.get('active') is None, 'EVENT10_ACTIVE_ANALYSIS_ABORT'
print('UI_PRECHECK_SINGLE_OFF_DUAL_OFF_EVENT_IDLE')
GUARD
python3 "$tmp/patch.py" --css "$tmp/theme.css" --dry-run
cp -p "$single" "$backup/single.mjs"
cp -p "$dual" "$backup/dual.html"
cp -p "$event" "$backup/event.html"
changed=1
python3 "$tmp/patch.py" --css "$tmp/theme.css"
NODE=/opt/zl-prediction-node/bin/node
"$NODE" --check "$single"
python3 - "$tmp" <<'SCRIPTS'
from pathlib import Path
import sys
temp=Path(sys.argv[1])
for name,path in [('dual','/opt/zl-prediction-dual5/binance_dual5_dashboard.html'),('event','/opt/zl-event10/panel.html')]:
 s=Path(path).read_text()
 assert s.count('id="zl-mintech-theme"')==1
 assert s.count('<script>')==1
 js=s.split('<script>',1)[1].split('</script>',1)[0]
 temp.joinpath(name+'.js').write_text(js,encoding='utf8')
 print('UI_INLINE_JS_FOUND',name,len(js))
SCRIPTS
"$NODE" --check "$tmp/dual.js"
"$NODE" --check "$tmp/event.js"
systemctl restart zl-event10-deepseek
systemctl restart zl-prediction-trade
for attempt in $(seq 1 20); do
 if systemctl is-active --quiet zl-event10-deepseek && systemctl is-active --quiet zl-prediction-trade;then
  if curl -fsS --max-time 3 http://127.0.0.1:13001/ -o "$tmp/single.html" &&
     curl -fsS --max-time 3 http://127.0.0.1:13020/ -o "$tmp/event.html";then break;fi
 fi
 sleep 1
done
python3 - "$tmp" <<'POST'
import json,sys,urllib.request
from pathlib import Path
t=Path(sys.argv[1])
a=t.joinpath('single.html').read_text()
b=t.joinpath('event.html').read_text()
assert 'id="zl-mintech-theme"' in a,'SINGLE_THEME_NOT_IN_LIVE_HTML'
assert 'id="zl-mintech-theme"' in b,'EVENT10_THEME_NOT_IN_LIVE_HTML'
assert 'id="zl-mintech-theme"' in Path('/opt/zl-prediction-dual5/binance_dual5_dashboard.html').read_text(),'DUAL_THEME_MISSING'
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=5) as r:one=json.load(r)
with urllib.request.urlopen('http://127.0.0.1:13048/api/status',timeout=5) as r:two=json.load(r)
assert one.get('enabled') is False,'SINGLE_TRADING_STATE_CHANGED'
assert two.get('active') is False,'DUAL_TRADING_STATE_CHANGED'
print('UI_SINGLE_LIVE_THEME_OK')
print('UI_EVENT10_LIVE_THEME_OK')
print('UI_DUAL_SOURCE_THEME_OK')
for path in ('/dual5','/dual5/','/dual5-dashboard','/api/dual5-dashboard'):
 try:
  with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=3) as r:
   x=r.read(100000).decode('utf8','replace')
   print('UI_DUAL_ROUTE',path,r.status,'themed='+str('id="zl-mintech-theme"' in x))
 except Exception:pass
POST
after_fast_pid=$(systemctl show zl-prediction-fast5 -p MainPID --value)
after_dual_pid=$(systemctl show zl-prediction-dual5 -p MainPID --value)
if [ "$before_fast_pid" != "$after_fast_pid" ] || [ "$before_dual_pid" != "$after_dual_pid" ];then
 echo UI_UNRELATED_ENGINE_PID_CHANGED;exit 20
fi
completed=1
echo THREE_BOT_UI_RELEASE_VERIFIED_SINGLE_ENGINES_UNTOUCHED
"""
 for key,v in payloads.items():script=script.replace(key,v)
 c=Client(api.Config(access_key_id=os.environ["ALIBABA_CLOUD_ACCESS_KEY_ID"],access_key_secret=os.environ["ALIBABA_CLOUD_ACCESS_KEY_SECRET"],endpoint="swas.ap-southeast-1.aliyuncs.com",region_id="ap-southeast-1"))
 try:
  r=c.run_command(sw.RunCommandRequest(region_id="ap-southeast-1",instance_id="b67374069bb3457ba6a3a2ede9305d3f",name="zl-three-mintech-ui-deploy",type="RunShellScript",command_content=script,working_user="root",timeout=165))
  for _ in range(78):
   time.sleep(2)
   x=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id="ap-southeast-1",instance_id="b67374069bb3457ba6a3a2ede9305d3f",invoke_id=r.body.invoke_id)).body.invocation_result
   if x and str(x.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout","ClientNotRunning"):
    try:out=base64.b64decode(x.output or "",validate=True).decode("utf8","replace")
    except:out="NO_OUTPUT"
    print("UI_DEPLOY_STATUS",x.invocation_status,"EXIT",x.exit_code)
    print("\n".join(line[:240] for line in out.splitlines() if any(k in line for k in ("UI_","THEME_","Traceback","Error","AssertionError","ROLLBACK")))[-6500:])
    return 0 if str(x.invocation_status)=="Success" and int(x.exit_code)==0 and "THREE_BOT_UI_RELEASE_VERIFIED_SINGLE_ENGINES_UNTOUCHED" in out else 4
  print("UI_DEPLOY_PENDING");return 5
 except Exception as e:print("UI_DEPLOY_TOOL_ERROR",type(e).__name__,str(getattr(e,"code","unknown"))[:80]);return 6
if __name__=="__main__":sys.exit(main())

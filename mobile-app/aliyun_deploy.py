#!/usr/bin/env python3
"""Install the isolated same-origin PWA under /app/ without restarting trading engines."""
import base64
import os
import re
import sys
import time

REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
BRANCH="feature/zl-futures-bot-v1"

REMOTE=r'''#!/usr/bin/env bash
set -Eeuo pipefail
HOST=prediction.47-237-188-69.sslip.io
CADDY=/etc/caddy/Caddyfile
APP=/opt/zl-mobile-app
STAGE=$(mktemp -d /tmp/zl-unified-mobile.XXXXXXXX)
BACK=/var/backups/zl-unified-mobile-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 0700 "$BACK"
changed=0
success=0
had_app=0
checkpoint=PRECHECK
trade_before=$(systemctl show zl-prediction-trade -p MainPID --value)
event_before=$(systemctl show zl-event10-deepseek -p MainPID --value)
finish(){
  code=$?
  trap - EXIT
  if [ "$success" = 0 ];then
    echo "MOBILE_APP_FAILED_CHECKPOINT=$checkpoint EXIT_CODE=$code"
    systemctl show -p ActiveState -p SubState -p CanReload -p MainPID caddy 2>/dev/null || true
  fi
  if [ "$changed" = 1 ] && [ "$success" = 0 ];then
    cp -p "$BACK/Caddyfile" "$CADDY" || true
    if [ "$had_app" = 1 ];then
      rm -rf "$APP"
      cp -a "$BACK/app" "$APP" || true
    else
      rm -rf "$APP"
    fi
    caddy validate --config "$CADDY" >/dev/null 2>&1 && systemctl reload caddy || true
    echo MOBILE_APP_ROLLED_BACK=true
  fi
  rm -rf "$STAGE"
  exit "$code"
}
trap finish EXIT
systemctl is-active --quiet caddy
test -r "$CADDY"
# The five-minute Guardian service is intentionally retired, not a deployment dependency.
test "$trade_before" = 0 || { echo "MOBILE_APP_RETIRED_GUARDIAN_UNEXPECTEDLY_RUNNING=true"; exit 44; }
test "$event_before" != 0
for file in index.html app.js manifest.webmanifest sw.js icon.svg icon-192.png icon-512.png;do
  curl -fsSL --retry 3 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/mobile-app/$file" -o "$STAGE/$file"
done
test -s "$STAGE/index.html" && test -s "$STAGE/app.js"
# Version marker uses exactly the same immutable GitHub revision as static assets.
# Existing WebViews can detect a new revision without installing a new APK.
python3 - "$STAGE" "COMMIT_SHA" <<'HOT_UPDATE'
import json, pathlib, re, sys
directory=pathlib.Path(sys.argv[1])
revision=sys.argv[2]
assert re.fullmatch(r"[a-f0-9]{40}",revision)
js=directory.joinpath("app.js")
content=js.read_text()
assert content.count("__ZL_APP_RELEASE_SHA__")==1
js.write_text(content.replace("__ZL_APP_RELEASE_SHA__",revision))
directory.joinpath("version.json").write_text(
    json.dumps({"commit":revision,"updateType":"web","apkReinstallRequired":False},separators=(",",":")))
print("MOBILE_WEB_HOT_UPDATE_MARKER_READY=true")
HOT_UPDATE
NODE=/opt/zl-prediction-node/bin/node
"$NODE" --check "$STAGE/app.js"
"$NODE" --check "$STAGE/sw.js"
python3 - "$STAGE" <<'PNG'
import json,pathlib,re,struct,sys,zlib,math
p=pathlib.Path(sys.argv[1])
m=json.loads((p/'manifest.webmanifest').read_text())
assert m['scope']=='/app/' and m['start_url']=='/app/' and m['display']=='standalone'
html=(p/'index.html').read_text()
js=(p/'app.js').read_text()
for expected in ('/app/app.js','/app/manifest.webmanifest','panel-event10','panel-more'):
    assert expected in html, expected
for expected in ('/event10/api/status','/event10/api/signals','/event10/api/start'):
    assert expected in js, expected
assert 'localStorage' not in js and 'sessionStorage' not in js
assert 'panel-guardian' not in html and 'panel-overview' not in html
assert '/guardian/api/status' not in js and 'function guardian(' not in js
assert 'APP_VERSION="1.3.5"' in js
assert re.fullmatch(r'[a-f0-9]{40}',json.loads((p/'version.json').read_text())['commit'])
assert '__ZL_APP_RELEASE_SHA__' not in js
assert 'checkHotUpdate' in js and 'hotUpdateBanner' in html
# Deploy the exact user-supplied artwork committed by the branding build.
# Never regenerate the previous synthetic ZL chart icon.
for size in (192,512):
    raw=(p/f'icon-{size}.png').read_bytes()
    assert len(raw)>3000,('ICON_EMPTY',size)
    assert raw[:8]==b'\x89PNG\r\n\x1a\n',('ICON_NOT_PNG',size)
    assert struct.unpack('>II',raw[16:24])==(size,size),('ICON_BAD_DIMENSIONS',size)
assert 'data:image/png;base64,' in (p/'icon.svg').read_text()
print('HAIPAI_REAL_ARTWORK_ICONS_DEPLOYED=true')
print('MOBILE_APP_STATIC_TESTS_OK=true')
PNG
cp -p "$CADDY" "$BACK/Caddyfile"
if test -d "$APP";then cp -a "$APP" "$BACK/app";had_app=1;fi
python3 - "$CADDY" "$STAGE/Caddyfile.staged" <<'CADDY_PATCH'
from pathlib import Path
import sys,re
src=Path(sys.argv[1]).read_text()
host='prediction.47-237-188-69.sslip.io {'
assert src.count(host)==1,'MOBILE_HOST_UNIQUE_REQUIRED'
a=src.index(host)
# Find closing brace for the site's full Caddy block.
depth=0
end=None
for i in range(a+len(host)-1,len(src)):
    if src[i]=='{':depth+=1
    elif src[i]=='}':
        depth-=1
        if depth==0:
            end=i+1
            break
assert end is not None,'MOBILE_CADDY_HOST_UNCLOSED'
block=src[a:end]
assert 'basic_auth' in block and 'reverse_proxy 127.0.0.1:13001' in block, 'MOBILE_AUTH_OR_PRODUCTION_ROUTER_DRIFT'
assert '/event10' in block,'MOBILE_EVENT10_ROUTE_MISSING'
marker='# ZL_UNIFIED_PWA_ROUTE_V1'
if marker not in block:
    route="""  # ZL_UNIFIED_PWA_ROUTE_V1 - static only; authenticated by existing site-level Basic Auth
  @zl_unified_app_exact path /app
  redir @zl_unified_app_exact /app/ 308
  handle_path /app/* {
    root * /opt/zl-mobile-app
    header Cache-Control "no-store"
    header X-Content-Type-Options "nosniff"
    header X-Frame-Options "DENY"
    header Referrer-Policy "no-referrer"
    header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    file_server
  }

"""
    # Insert before existing fallback, independently of which homepage UI is currently active.
    anchors=[m.start() for m in re.finditer(r'(?m)^[ \t]*handle(?:_path)?[ \t]+',block)]
    assert anchors,'MOBILE_CADDY_HANDLERS_NOT_FOUND'
    pos=min(anchors)
    block=block[:pos]+route+block[pos:]
else:
    assert block.count(marker)==1 and 'handle_path /app/*' in block,'MOBILE_EXISTING_ROUTE_DRIFT'
result=src[:a]+block+src[end:]
assert result.count('basic_auth')==src.count('basic_auth'),'MOBILE_AUTH_CHANGED'
assert result.count('reverse_proxy 127.0.0.1:13001')==src.count('reverse_proxy 127.0.0.1:13001')
Path(sys.argv[2]).write_text(result)
print('MOBILE_CADDY_STATIC_ROUTE_STAGED=true')
CADDY_PATCH
install -d -o root -g root -m 0755 "$APP"
for file in index.html app.js manifest.webmanifest sw.js icon.svg icon-192.png icon-512.png version.json;do
  install -o root -g root -m 0644 "$STAGE/$file" "$APP/$file"
done
cp "$STAGE/Caddyfile.staged" "$CADDY"
changed=1
checkpoint=VALIDATE_CADDY
caddy validate --config "$CADDY"
echo MOBILE_CADDY_CONFIG_VALID=true
checkpoint=RELOAD_CADDY
if ! systemctl reload caddy;then
  echo MOBILE_CADDY_SYSTEMD_RELOAD_FAILED=true
  if ! caddy reload --config "$CADDY" --adapter caddyfile;then
    echo MOBILE_CADDY_ADMIN_RELOAD_FAILED=true
    exit 45
  fi
fi
echo MOBILE_CADDY_RELOAD_COMPLETED=true
checkpoint=AUTHENTICATION_CHECK
# A compromised public route must never reveal the app or trading APIs without login.
for route in /app/ /app/app.js /app/version.json /app/manifest.webmanifest /event10/api/status;do
  if ! status=$(curl -skS --max-time 9 --resolve "$HOST:443:127.0.0.1" -o /dev/null -w '%{http_code}' "https://$HOST$route");then
    echo MOBILE_AUTH_CURL_FAILED_PATH=$route
    exit 42
  fi
  test "$status" = 401 || { echo "MOBILE_AUTH_CHECK_FAILED_PATH=$route STATUS=$status"; exit 41; }
done
echo MOBILE_AUTH_CHECKS_PASS=true
checkpoint=PID_INVARIANT
# Live trading and event strategy processes must not be touched by PWA deployment.
test "$trade_before" = "$(systemctl show zl-prediction-trade -p MainPID --value)"
echo MOBILE_APP_GUARDIAN_REMAINS_STOPPED=true
test "$event_before" = "$(systemctl show zl-event10-deepseek -p MainPID --value)"
systemctl is-active --quiet caddy
checkpoint=COMPLETE
echo MOBILE_APP_PWA_RELEASED=true
echo MOBILE_APP_TRADING_ENGINES_UNCHANGED=true
echo MOBILE_APP_HTTPS_URL="https://$HOST/app/"
echo MOBILE_APP_BACKUP="$BACK"
success=1
'''

def main():
    sha=os.environ.get("GITHUB_SHA","")
    if os.environ.get("GITHUB_REF_NAME")!=BRANCH or not re.fullmatch(r"[0-9a-f]{40}",sha):
        print("MOBILE_APP_BAD_REF");return 2
    if not os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID") or not os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET"):
        print("MOBILE_APP_MISSING_ALIBABA_CREDENTIALS");return 3
    from alibabacloud_swas_open20200601.client import Client
    from alibabacloud_swas_open20200601 import models as sw
    from alibabacloud_tea_openapi import models as api
    client=Client(api.Config(access_key_id=os.environ["ALIBABA_CLOUD_ACCESS_KEY_ID"],
        access_key_secret=os.environ["ALIBABA_CLOUD_ACCESS_KEY_SECRET"],
        endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
    request=sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
        name="deploy-unified-mobile-app-static-only",type="RunShellScript",
        command_content=REMOTE.replace("COMMIT_SHA",sha),working_user="root",timeout=240)
    try:
        invoke=client.run_command(request).body.invoke_id
        for _ in range(110):
            time.sleep(2)
            r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
                region_id=REGION,instance_id=INSTANCE,invoke_id=invoke)).body.invocation_result
            if r and str(r.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero","ClientNotRunning"):
                try:output=base64.b64decode(r.output or "",validate=True).decode("utf8","replace")
                except Exception:output=str(r.output or "")
                print("MOBILE_APP_REMOTE_STATUS",r.invocation_status,"exit",r.exit_code)
                print(output[-7000:])
                return 0 if str(r.invocation_status)=="Success" and int(r.exit_code)==0 and "MOBILE_APP_PWA_RELEASED=true" in output else 4
        print("MOBILE_APP_REMOTE_TIMEOUT");return 5
    except Exception as exc:
        print("MOBILE_APP_API_FAILURE",type(exc).__name__,str(getattr(exc,"code","unknown"))[:100]);return 6
if __name__=="__main__":sys.exit(main())

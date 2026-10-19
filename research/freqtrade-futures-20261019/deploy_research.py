#!/usr/bin/env python3
"""Publish only separate static research files to Alibaba, never touch trading services."""
import base64,os,re,sys,time
REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
REPO="https://github.com/zhoujunejune/pikpakzl.git"
BRANCH="research/freqtrade-futures-20261019"
def main():
 sha=os.getenv("RESEARCH_PUBLISHED_SHA","").strip()
 if os.getenv("GITHUB_REF_NAME")!=BRANCH or not re.fullmatch(r"[0-9a-f]{40}",sha):
  print("RESEARCH_DEPLOY_ABORT_UNEXPECTED_BRANCH_OR_SHA");return 11
 kid=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
 secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
 if not kid or not secret:print("RESEARCH_DEPLOY_ABORT_NO_CLOUD_AUTH");return 12
 from alibabacloud_swas_open20200601.client import Client
 from alibabacloud_swas_open20200601 import models as sw
 from alibabacloud_tea_openapi import models as api
 client=Client(api.Config(access_key_id=kid,access_key_secret=secret,
                          endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
 cmd=r'''#!/bin/bash
set -Eeuo pipefail
ROOT=/opt/zl-freqtrade-research
mkdir -p "$ROOT"
if test -d "$ROOT/src/.git"; then
 git -C "$ROOT/src" fetch --depth=1 origin '''+BRANCH+r'''
else
 git clone --depth=1 --branch '''+BRANCH+" "+REPO+r''' "$ROOT/src"
fi
git -C "$ROOT/src" checkout --force --detach '''+sha+r'''
test "$(git -C "$ROOT/src" rev-parse HEAD)" = "'''+sha+r'''"
SRC="$ROOT/src/research/freqtrade-futures-20261019"
python3 - "$SRC/published/data.json" <<'PY'
import sys,json
p=sys.argv[1]
d=json.load(open(p))
assert d.get('kind')=='historical_simulation'
assert d.get('never_live_orders') is True
assert len(d.get('rows',[]))==18
assert len(d.get('data_coverage',{}))==3
assert all(x.get('coverage',0)>.99 for x in d['data_coverage'].values())
print('RESEARCH_DATA_INTEGRITY_OK rows=',len(d['rows']))
PY
test -s "$SRC/index.html"
mkdir -p /srv/zl-research/freqtrade
install -m 0644 "$SRC/index.html" /srv/zl-research/freqtrade/index.html
install -m 0644 "$SRC/published/data.json" /srv/zl-research/freqtrade/data.json
python3 - <<'PY'
from pathlib import Path
from datetime import datetime,timezone
import re,shutil,subprocess
path=Path('/etc/caddy/Caddyfile')
src=path.read_text()
site='47-237-188-69.sslip.io {'
next_site='prediction.47-237-188-69.sslip.io {'
assert src.startswith(site) and src.count('\n'+next_site)==1,'CADDY_SITE_LAYOUT_CHANGED'
first,rest=src.split(next_site,1)
if 'handle_path /research/*' in first:
 assert first.count('handle_path /research/*')==1,'RESEARCH_ROUTE_DUPLICATED'
 assert '/srv/zl-research/freqtrade' in first,'RESEARCH_ROUTE_UNEXPECTED_TARGET'
 print('RESEARCH_CADDY_ROUTE_ALREADY_EXISTS')
else:
 # Insert only before the fallback to the existing futures reverse-proxy.
 pat=r'(?m)^([ \t]*)handle \{[ \t]*\n[ \t]*reverse_proxy 127\.0\.0\.1:10000[ \t]*\n[ \t]*\}'
 matches=list(re.finditer(pat,first))
 assert len(matches)==1,'CADDY_FUTURES_FALLBACK_UNEXPECTED'
 indent=matches[0].group(1)
 addition=(indent+'handle_path /research/* {\n'+
           indent+'    root * /srv/zl-research/freqtrade\n'+
           indent+'    file_server\n'+indent+'}\n'+
           indent+'handle /research {\n'+
           indent+'    redir /research/ 308\n'+indent+'}\n')
 candidate=first[:matches[0].start()]+addition+first[matches[0].start():]+next_site+rest
 assert candidate.count('reverse_proxy 127.0.0.1:10000')==src.count('reverse_proxy 127.0.0.1:10000')
 assert candidate.count('basic_auth')==src.count('basic_auth')
 backup=Path('/var/backups/zl-research-caddy-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
 shutil.copy2(path,backup)
 path.write_text(candidate)
 if subprocess.run(['caddy','validate','--config',str(path)],capture_output=True,timeout=20).returncode:
  shutil.copy2(backup,path);raise RuntimeError('CADDY_SYNTAX_INVALID_ROLLED_BACK')
 if subprocess.run(['systemctl','reload','caddy'],capture_output=True,timeout=25).returncode:
  shutil.copy2(backup,path)
  subprocess.run(['systemctl','reload','caddy'],timeout=25)
  raise RuntimeError('CADDY_RELOAD_FAILED_ROLLED_BACK')
 print('RESEARCH_ROUTE_ADDED_ONLY_TO_MAIN_SITE')
print('RESEARCH_SITE_FILES_READY')
PY
test "$(systemctl is-active zl-futures-bot-paper.service)" = active
test "$(systemctl is-active caddy)" = active
# Authenticated main site should require login (401); no secrets used here.
status=$(curl -ksS --resolve 47-237-188-69.sslip.io:443:127.0.0.1 -o /dev/null -w '%{http_code}' --max-time 10 https://47-237-188-69.sslip.io/research/data.json || true)
test "$status" = 401
echo "RESEARCH_HTTPS_REQUIRES_LOGIN=true"
echo "RESEARCH_PRODUCTION_FUTURES_PROCESS_STILL_ACTIVE=true"
echo "RESEARCH_DEPLOY_ONLY_STATIC_FILES_AND_CADDY_ROUTE=true"
'''
 try:
  i=client.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
        name="zl-public-futures-research-STATIC-ONLY",type="RunShellScript",command_content=cmd,
        working_user="root",timeout=170)).body.invoke_id
  if not i:print("RESEARCH_DEPLOY_INVOCATION_MISSING");return 13
  for _ in range(48):
   time.sleep(4)
   obj=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=i)).body.invocation_result
   if not obj:continue
   if str(obj.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
    raw=obj.output or ""
    try:raw=base64.b64decode(raw,validate=True).decode("utf8","replace")
    except Exception:pass
    print("RESEARCH_DEPLOY_STATUS",obj.invocation_status,"EXIT",obj.exit_code)
    print("RESEARCH_DEPLOY_LOG_TAIL",raw[-3000:])
    return 0 if str(obj.invocation_status)=="Success" and int(obj.exit_code)==0 else 14
  print("RESEARCH_DEPLOY_NO_FINAL_STATUS");return 15
 except Exception as exc:print("RESEARCH_DEPLOY_ERROR_CLASS",type(exc).__name__);return 16
if __name__=="__main__":sys.exit(main())

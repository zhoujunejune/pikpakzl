#!/usr/bin/env python3
"""Hotfix only malformed-request crash in existing Alibaba prediction panel."""
import base64
import os
import re
import sys
import time

REGION = "ap-southeast-1"
INSTANCE = "b67374069bb3457ba6a3a2ede9305d3f"

SCRIPT = r'''#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
from pathlib import Path
import re, os, tempfile, subprocess, shutil, datetime
p=Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
node='/opt/zl-prediction-node/bin/node'
assert os.geteuid()==0, 'must run as root'
assert p.is_file() and not p.is_symlink(), 'expected panel source absent or symlinked'
assert Path(node).is_file(), 'node runtime missing'
src=p.read_text(encoding='utf-8')
marker='// ZL_INVALID_REQUEST_URL_400_GUARD_V1'
if marker in src:
 print('HOTFIX_SOURCE_ALREADY_GUARDED=true')
else:
 pattern=re.compile(r'(?m)^(?P<indent>[ \t]*)const url = new URL\(req\.url, (?P<base>[^\n;]+)\);[ \t]*$')
 matches=list(pattern.finditer(src))
 assert len(matches)==1, 'unexpected count of request URL constructor: '+str(len(matches))
 m=matches[0]
 assert 'http.createServer((req, res) => {' in src[max(0,m.start()-160):m.start()], 'not main HTTP request handler'
 indent=m.group('indent')
 base=m.group('base')
 assert len(base)<200, 'unexpected URL base length'
 replacement=(
  indent+marker+'\n'
  +indent+'let url;\n'
  +indent+'try {\n'
  +indent+'  url = new URL(req.url, '+base+');\n'
  +indent+'} catch (_invalidRequestUrl) {\n'
  +indent+"  res.writeHead(400, {'content-type':'text/plain; charset=utf-8', 'cache-control':'no-store'});\n"
  +indent+"  res.end('Bad Request');\n"
  +indent+'  return;\n'
  +indent+'}'
 )
 new=src[:m.start()]+replacement+src[m.end():]
 stat=p.stat()
 fd,tmp=tempfile.mkstemp(prefix='.panel-502-guard-',suffix='.mjs',dir=str(p.parent))
 os.close(fd)
 try:
  Path(tmp).write_text(new,encoding='utf-8')
  result=subprocess.run([node,'--check',tmp],capture_output=True,text=True,timeout=15)
  assert result.returncode==0, 'syntax check failed: '+result.stderr[-300:]
  stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
  dest=Path('/var/lib/zl-prediction/archive/source-backups/502-guard-'+stamp)
  dest.mkdir(parents=True,exist_ok=False)
  backup=dest/p.name
  shutil.copy2(p,backup)
  os.chown(tmp,stat.st_uid,stat.st_gid)
  os.chmod(tmp,stat.st_mode & 0o777)
  os.replace(tmp,p)
  print('HOTFIX_CHANGED_MAIN_HANDLER=true')
  print('HOTFIX_BACKUP=',str(backup))
 except Exception:
  if Path(tmp).exists():os.unlink(tmp)
  raise
PY
echo "HOTFIX_RESTART_ONLY=zl-prediction-trade.service"
systemctl restart zl-prediction-trade.service
ready=no
for i in $(seq 1 25);do
  if [ "$(systemctl is-active zl-prediction-trade.service || true)" = active ];then
    code=$(curl --max-time 4 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:13001/healthz || true)
    if [ "$code" = 200 ];then ready=yes; break;fi
  fi
  sleep 2
done
if [ "$ready" != yes ];then
  echo "HOTFIX_HEALTH_FAILED=prediction_service_not_ready"
  # Restore last source safely and restart only the target service.
  python3 - <<'PY'
from pathlib import Path
import os,glob,shutil
p=Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
backup=sorted(glob.glob('/var/lib/zl-prediction/archive/source-backups/502-guard-*/panel-stats-shell.mjs'))[-1]
tmp=p.with_name('.panel-502-rollback-'+str(os.getpid()))
shutil.copy2(backup,tmp)
os.replace(tmp,p)
print('HOTFIX_ROLLBACK_SOURCE_RESTORED=true')
PY
  systemctl restart zl-prediction-trade.service || true
  exit 42
fi
/opt/zl-prediction-node/bin/node --version
echo "HOTFIX_LOCAL_HEALTH=200"
echo "HOTFIX_SERVICE_RESTARTS=$(systemctl show zl-prediction-trade.service -p NRestarts --value)"
echo "HOTFIX_CADDY_ACTIVE=$(systemctl is-active caddy.service)"
echo "HOTFIX_FUTURES_ACTIVE=$(systemctl is-active zl-futures-bot-paper.service)"
echo "HOTFIX_V2_ACTIVE=$(systemctl is-active zl-prediction-v2.service)"
echo "HOTFIX_V3_ACTIVE=$(systemctl is-active zl-prediction-v3.service)"
echo "HOTFIX_SUCCESS=true"
'''

def main():
    kid=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
    secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
    if not kid or not secret:
        print("HOTFIX_BLOCKED_MISSING_CREDENTIALS")
        return 2
    from alibabacloud_swas_open20200601.client import Client
    from alibabacloud_swas_open20200601 import models as sw
    from alibabacloud_tea_openapi import models as api
    cl=Client(api.Config(access_key_id=kid,access_key_secret=secret,region_id=REGION,endpoint="swas.ap-southeast-1.aliyuncs.com"))
    try:
        r=cl.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
            name="zl-prediction-invalid-url-502-guard",type="RunShellScript",
            command_content=SCRIPT,working_user="root",timeout=240))
        iid=r.body.invoke_id
        assert iid
        print("HOTFIX_CLOUD_ASSISTANT_ACCEPTED=true")
        for _ in range(65):
            time.sleep(4)
            result=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(
                region_id=REGION,instance_id=INSTANCE,invoke_id=iid)).body.invocation_result
            if not result:continue
            status=str(result.invocation_status)
            if status in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero","ClientNotRunning"):
                raw=result.output or ""
                try: raw=base64.b64decode(raw,validate=True).decode("utf-8","replace")
                except Exception:pass
                print("HOTFIX_CLOUD_STATUS",status)
                print("HOTFIX_CLOUD_EXIT",result.exit_code)
                print("HOTFIX_CLOUD_OUTPUT",raw[-9000:])
                return 0 if status=="Success" and int(result.exit_code)==0 else 4
        print("HOTFIX_WAIT_TIMEOUT")
        return 5
    except Exception as exc:
        print("HOTFIX_CLOUD_EXCEPTION_TYPE",type(exc).__name__)
        print("HOTFIX_CLOUD_ERROR_CODE",str(getattr(exc,"code","unknown"))[:55])
        return 6

if __name__=="__main__":
    sys.exit(main())

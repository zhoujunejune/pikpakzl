#!/usr/bin/env python3
"""Read-only diagnostics for production panel service. No secrets, no trading actions."""
import os,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -e
for unit in zl-prediction-trade zl-prediction-v2 zl-prediction-deepseek5 zl-futures-bot-paper;do
 echo "DIAG_UNIT $unit"
 systemctl show "$unit" -p ActiveState -p SubState -p ExecMainStatus -p NRestarts -p MainPID --no-pager 2>/dev/null | head -5
done
echo DIAG_PANEL_JOURNAL
journalctl -u zl-prediction-trade --since '8 minutes ago' -o cat --no-pager 2>/dev/null | grep -E 'Error|Cannot find|ERR_MODULE|MODULE_NOT_FOUND|SyntaxError|restart|Failed|failed|not found|ENOENT|Unexpected|MODULE_' | tail -20 | cut -c 1-240 || true
echo DIAG_JS_IMPORTS
python3 - <<'PY'
import re,pathlib
root=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
panel=root/'panel-stats-shell.mjs'
if panel.exists():
 s=panel.read_text(errors='replace')
 for m in re.finditer(r"from\s+['\"]\./([^'\"]+)['\"]",s[:6500]):
  p=root/m.group(1)
  print('DIAG_IMPORT',m.group(1),'PRESENT',p.is_file())
 print('DIAG_PANEL_BYTES',panel.stat().st_size)
 print('DIAG_PANEL_HAS_DEEPSEEK','renderDeepSeekRoundStats()' in s)
for port in (13001,13002,13029):
 try:
  import urllib.request
  with urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz',timeout=3) as r:
   print('DIAG_LOCAL_HEALTH',port,r.status)
 except Exception as e:print('DIAG_LOCAL_HEALTH',port,type(e).__name__)
PY
"""
def main():
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 invoke=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='zl-prediction-trade-readonly-incident',type='RunShellScript',working_user='root',command_content=SCRIPT,timeout=65)).body.invoke_id
 for _ in range(32):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=invoke)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   out=r.output or ''
   try:out=base64.b64decode(out,validate=True).decode('utf-8','replace')
   except Exception:pass
   print(out[-9000:]);return 0 if int(r.exit_code)==0 else 3
 return 4
if __name__=='__main__':raise SystemExit(main())

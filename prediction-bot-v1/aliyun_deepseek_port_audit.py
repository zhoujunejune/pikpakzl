#!/usr/bin/env python3
"""Read-only diagnostics of DeepSeek staged server, no secret content or orders."""
import os,base64,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -e
echo "DEEPSEEK_UNIT=$(systemctl is-active zl-prediction-deepseek5 || true)"
echo "DEEPSEEK_PID=$(systemctl show --value -p MainPID zl-prediction-deepseek5 || true)"
echo "DEEPSEEK_UNIT_EXIT=$(systemctl show --value -p ExecMainStatus zl-prediction-deepseek5 || true)"
ss -tlnp '( sport = :13019 )' 2>/dev/null | head -6 | cut -c 1-220
for path in /healthz /api/status /status /signal;do
 code=$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:13019$path" || true)
 echo "DEEPSEEK_PATH $path $code"
done
echo "DEEPSEEK_SOURCE_MATCH=$(grep -c 'DEEPSEEK_5M_V1' /opt/zl-prediction-live/deepseek5/deepseek-5m-engine.mjs || true)"
echo "DEEPSEEK_JOURNAL_BEGIN"
journalctl --no-pager -u zl-prediction-deepseek5.service -n 10 -o cat 2>/dev/null | head -10 | cut -c 1-230
echo "DEEPSEEK_JOURNAL_END"
"""
def main():
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
   access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',
   endpoint='swas.ap-southeast-1.aliyuncs.com'))
 invocation=client.run_command(sw.RunCommandRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   type='RunShellScript',name='zl-deepseek-port-readonly',
   command_content=SCRIPT,working_user='root',timeout=60)).body.invoke_id
 for _ in range(25):
  time.sleep(2)
  o=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
    region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=invocation)).body.invocation_result
  if o and str(o.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:s=base64.b64decode(o.output or '',validate=True).decode('utf-8','replace')
   except:s=o.output or ''
   print(s[-4300:])
   return 0 if int(o.exit_code)==0 else 3
 return 4
if __name__=='__main__':raise SystemExit(main())

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
ss -tlnp '( sport = :13029 )' 2>/dev/null | head -6 | cut -c 1-220
for path in /healthz /api/status /status /signal;do
 code=$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:13029$path" || true)
 echo "DEEPSEEK_PATH $path $code"
done
echo "DEEPSEEK_SOURCE_MATCH=$(grep -c 'DEEPSEEK_5M_V1' /opt/zl-prediction-live/deepseek5/deepseek-5m-engine.mjs || true)"
python3 - <<'PY'
import json,urllib.request,urllib.error,subprocess,datetime
def get(path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:13029'+path,timeout=6) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:
  return e.code,None
s,v=get('/api/status')
print('DEEPSEEK_STATUS_HTTP',s)
if s==200 and isinstance(v,dict):
 print('DEEPSEEK_CONFIGURED',v.get('configured'))
 print('DEEPSEEK_MODEL',v.get('model'))
 print('DEEPSEEK_PROVIDER',v.get('providerModel'))
 print('DEEPSEEK_TRIES',v.get('tries'))
 print('DEEPSEEK_ERROR',str(v.get('error'))[:120])
 print('DEEPSEEK_ROUND',v.get('round'))
 print('DEEPSEEK_LAST_SIGNAL',v.get('lastSignal'))
 signal=v.get('signal') or {}
 print('DEEPSEEK_LOCKED_DIRECTION',(signal.get('latest') or {}).get('direction'))
 print('DEEPSEEK_LOCKED_AT',(signal.get('latest') or {}).get('lockedAt'))
 print('DEEPSEEK_REAL_ORDER_ENABLED',v.get('realOrderEnabled'))
 print('DEEPSEEK_TRADE_INTEGRATION',v.get('tradeIntegration'))
a,c=get('/signal')
print('DEEPSEEK_SIGNAL_HTTP',a)
if a==200 and isinstance(c,dict):
 print('DEEPSEEK_SIGNAL_READONLY',c.get('readOnly'))
 print('DEEPSEEK_SIGNAL_ORDERS',c.get('orders'))
try:
 with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=5) as r:
  old=json.load(r)
 print('PRODUCTION_SELECTED_MODEL',old.get('model'))
except Exception as e: print('PRODUCTION_MODEL_AUDIT_ERROR',type(e).__name__)
PY

echo "DEEPSEEK_JOURNAL_BEGIN"
journalctl --no-pager -u zl-prediction-deepseek5.service --since '10 minutes ago' -o cat 2>/dev/null | grep -E 'DEEPSEEK_5M_RUNNING|MODEL_HTTP|MARKET_INVALID|SIGNAL_LATE' | tail -6 | cut -c 1-180 || true
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

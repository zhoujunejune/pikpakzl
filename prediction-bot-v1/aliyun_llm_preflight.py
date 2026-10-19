#!/usr/bin/env python3
"""Read-only LLM integration preflight; NEVER prints secrets."""
import os,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REGION='ap-southeast-1'; INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
SCRIPT=r'''#!/bin/bash
set -Eeuo pipefail
echo "LLM_PREFLIGHT_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
for f in /etc/zl-prediction/llm.env /etc/zl-prediction/panel.env /etc/zl-prediction/trading.env;do
 echo "LLM_CONFIG_PRESENT_$(basename "$f")=$([ -s "$f" ] && echo yes || echo no)"
 if test -f "$f";then
  for k in DASHSCOPE_API_KEY QWEN_API_KEY QWEN_MODEL LLM_API_BASE_URL LLM_MODEL LLM_SIGNAL_URL AUTO_CONFIRM_ENABLED;do
   if grep -Eq "^$k=.+" "$f";then echo "LLM_CONFIG_KEY_PRESENT_$(basename "$f")_$k=yes";fi
  done
 fi
done
for n in zl-prediction-trade zl-prediction-v2 zl-prediction-v3 zl-prediction-redis zl-futures-bot-paper;do
 echo "LLM_SERVICE_$n=$(systemctl is-active "$n" || true)"
done
echo "LLM_PROCESSES=$(ps -eo comm | grep -xc node || true)"
python3 - <<'PY'
import pathlib,re,hashlib,json,urllib.request
root=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
for n in ('index.mjs','wrapper.mjs','production-signal-choice.mjs','order-direction-policy.mjs','panel-stats-shell.mjs'):
 p=root/n
 if not p.exists():print('LLM_MODULE_ABSENT',n);continue
 c=p.read_text(errors='replace')
 print('LLM_MODULE',n,'lines',len(c.splitlines()),'sha256',hashlib.sha256(c.encode()).hexdigest()[:16])
 for marker in ('DYNAMIC_ORDER_DEADLINE_MS','ORDER_SIGNAL_MODELS=','MODEL_CHOICE_KEY=','async function getSignal(', 'async function prepareWorker(', 'AUTO_CONFIRM_ENABLED','order-signal-model','ZL_INVALID_REQUEST_URL_400_GUARD_V1'):
  if marker in c:print('LLM_MARKER',n,marker)
for port,path in [(13001,'/healthz'),(13001,'/api/order-signal-model'),(13002,'/api/round-stats'),(13003,'/healthz')]:
 try:
  with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=5) as response:
   print('LLM_LOCAL_HTTP',port,path,response.status)
   if path=='/api/order-signal-model':
    j=json.load(response)
    print('LLM_SELECTION_MODELS',[v.get('id') for v in j.get('models',[])])
    print('LLM_CURRENT_MODEL',j.get('model'))
    print('LLM_SELECTION_READY',j.get('ready'))
 except Exception as err: print('LLM_LOCAL_ERROR',port,path,type(err).__name__)
PY
echo "LLM_PREFLIGHT_COMPLETE=true"
'''
def main():
 k=os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID');v=os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET')
 if not (k and v):print('LLM_ALIBABA_CREDENTIALS_MISSING');return 3
 cl=Client(api.Config(access_key_id=k,access_key_secret=v,endpoint='swas.ap-southeast-1.aliyuncs.com',region_id=REGION))
 try:
  inv=cl.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name='zl-llm-integration-preflight-readonly',type='RunShellScript',command_content=SCRIPT,working_user='root',timeout=110)).body.invoke_id
  for _ in range(32):
   time.sleep(3)
   obj=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
   if not obj:continue
   status=str(obj.invocation_status)
   if status in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    raw=obj.output or ''
    try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
    except Exception:pass
    print('LLM_PREFLIGHT_CLOUD_STATUS',status,'EXIT',obj.exit_code)
    print(raw[-12000:])
    return 0 if status=='Success' and int(obj.exit_code)==0 else 4
 except Exception as e:print('LLM_PREFLIGHT_ERROR',type(e).__name__);return 5
 return 6
if __name__=='__main__':sys.exit(main())

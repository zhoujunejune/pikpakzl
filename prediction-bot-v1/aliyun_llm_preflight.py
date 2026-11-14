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
for n in zl-prediction-llm5 zl-prediction-trade zl-prediction-v2 zl-prediction-v3 zl-prediction-redis zl-futures-bot-paper;do
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
for port,path in [(13018,'/api/status'),(13001,'/healthz'),(13001,'/api/order-signal-model'),(13002,'/api/round-stats'),(13003,'/healthz')]:
 try:
  with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=5) as response:
   print('LLM_LOCAL_HTTP',port,path,response.status)
   if path=='/api/status' and port==13018:
    j=json.load(response)
    print('LLM_RUNTIME_CONFIGURED',j.get('configured'))
    print('LLM_RUNTIME_PROVIDER',j.get('providerModel'))
    print('LLM_RUNTIME_ERROR_TYPE',str(j.get('error'))[:100])
    print('LLM_RUNTIME_ORDER_OFF',j.get('realOrderEnabled') is False and j.get('tradeIntegration') is False)
   if path=='/api/order-signal-model':
    j=json.load(response)
    print('LLM_SELECTION_MODELS',[v.get('id') for v in j.get('models',[])])
    print('LLM_CURRENT_MODEL',j.get('model'))
    print('LLM_SELECTION_READY',j.get('ready'))
 except Exception as err: print('LLM_LOCAL_ERROR',port,path,type(err).__name__)
PY
python3 - <<'PY'
import json,urllib.request
for port,path in [(13003,'/api/shadow-market-data'),(13003,'/api/market-data'),(13002,'/api/round-stats')]:
 try:
  with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=6) as r:data=json.load(r)
  print('LLM_MARKET_ENDPOINT',port,path,'http',200,'type',type(data).__name__)
  if isinstance(data,dict):
   print('LLM_MARKET_TOP_KEYS',list(data.keys())[:40])
   for k in ('data','market','snapshot','indicators','btc','features','live','latest','candles','orderBook','ticker'):
    v=data.get(k)
    if isinstance(v,dict):print('LLM_MARKET_NESTED_KEYS',k,list(v.keys())[:35])
    if isinstance(v,list):print('LLM_MARKET_LIST',k,'len',len(v),'lasttype',type(v[-1]).__name__ if v else 'none')
 except Exception as err:print('LLM_MARKET_ENDPOINT',port,path,'error',type(err).__name__)
PY
python3 - <<'QWEN_PROBE'
import json
from pathlib import Path
from urllib import request,error
p=Path('/etc/zl-prediction/llm5.env')
env={}
if p.is_file():
 for line in p.read_text().splitlines():
  if '=' in line and not line.startswith('#'):
   k,v=line.split('=',1)
   if k in ('DASHSCOPE_API_KEY','QWEN_MODEL','QWEN_API_URL'):env[k]=v.strip().strip('"')
key=env.get('DASHSCOPE_API_KEY','')
print('QWEN_SECRET_LOADED',bool(key))
if key:
 model=env.get('QWEN_MODEL','qwen-flash')
 endpoints=[
  ('configured',env.get('QWEN_API_URL','')),
  ('workspace','https://ws-iyku7a7ql0evg7vu.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions')]
 body=json.dumps({'model':model,'messages':[{'role':'user','content':'Reply OK'}],'max_tokens':3}).encode()
 for label,url in endpoints:
  if not url.startswith('https://'):continue
  req=request.Request(url,data=body,method='POST',headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
  try:
   with request.urlopen(req,timeout=15) as response:
    print('QWEN_PROBE',label,'http',response.status,'result','ok')
  except error.HTTPError as err:
   code='UNKNOWN'
   request_id=''
   try:
    x=json.loads(err.read(4096).decode('utf-8','replace'))
    detail=x.get('error') if isinstance(x.get('error'),dict) else {}
    code=str(x.get('code') or detail.get('code') or detail.get('type') or 'UNKNOWN')
    request_id=str(x.get('request_id') or x.get('requestId') or x.get('RequestId') or detail.get('request_id') or detail.get('requestId') or '')
   except Exception:pass
   import re, datetime
   if not request_id:
    request_id=str(err.headers.get('x-acs-request-id') or err.headers.get('x-request-id') or '')
   code=re.sub('[^a-zA-Z0-9._-]','',code)[:75]
   request_id=re.sub('[^a-zA-Z0-9._-]','',request_id)[:130]
   print('QWEN_PROBE',label,'http',err.code,'error_code',code,'request_id',request_id or 'NOT_RETURNED','timestamp_utc',datetime.datetime.now(datetime.timezone.utc).isoformat())
  except Exception as err:
   print('QWEN_PROBE',label,'exception_type',type(err).__name__)
QWEN_PROBE
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

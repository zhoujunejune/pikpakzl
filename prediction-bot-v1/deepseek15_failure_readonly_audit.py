#!/usr/bin/env python3
"""Read-only Alibaba root cause of guarded DeepSeek15 rollback."""
import os,re,time,sys,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/deepseek15-ai-only-prod-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
SHELL=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,urllib.request,urllib.error,subprocess,pathlib,hashlib
def attempt(port,path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=5) as r:
   data=json.load(r) if path!='/' else {}
   print('AI15_FAILURE_API',port,path,'http',r.status,'fields',json.dumps({k:data.get(k) for k in ('ok','model','enabled','decisionRule','maxCallsPerRound','error') if k in data}))
 except Exception as e:print('AI15_FAILURE_API',port,path,'error',type(e).__name__)
for u in ('zl-prediction-trade.service','zl-prediction-deepseek5.service',
 'zl-prediction-risk-exits.service','zl-prediction-redis.service','caddy.service'):
 o=subprocess.run(['systemctl','show',u,'-p','ActiveState','-p','NRestarts','-p','MainPID','--no-pager'],text=True,capture_output=True).stdout
 print('AI15_FAILURE_SYSTEMD',u,o.replace('\n',' ')[:320])
for p in ('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs',
  '/opt/zl-prediction-live/src/railway-diagnostic/wrapper.mjs'):
 raw=pathlib.Path(p).read_bytes()
 print('AI15_FAILURE_SOURCE',pathlib.Path(p).name,hashlib.sha256(raw).hexdigest(),
  '15second',b'LIMIT_MS=15000' in raw,'fallback',b'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK' in raw,
  'deepseek30order',b'DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS' in raw)
for port,path in ((13001,'/healthz'),(13001,'/api/status'),(13029,'/api/status'),(13001,'/api/order-signal-model')):
 attempt(port,path)
for unit in ('zl-prediction-trade.service','zl-prediction-deepseek5.service'):
 o=subprocess.run(['journalctl','-u',unit,'--since','20 minutes ago','-o','cat','--no-pager','-n','700'],
  text=True,capture_output=True,timeout=12).stdout
 counts={};errors=[]
 for line in o.splitlines():
  try:
   item=json.loads(line)
   if isinstance(item,dict):
    event=item.get('event')
    if isinstance(event,str):
     counts[event]=counts.get(event,0)+1
     if 'error' in event.lower() or event in ('control_panel_started','auto_confirm_halted'):
      errors.append({'event':event,'error':str(item.get('error'))[:160],'at':item.get('at')})
     continue
  except:pass
  if any(k in line for k in ('SyntaxError','ReferenceError','TypeError','ERR_MODULE','Uncaught','main process exited','Failed with result','Cannot find','Unexpected token')):
   errors.append({'kind':'node-error','message':line[:270]})
 print('AI15_FAILURE_LOG_COUNTS',unit,json.dumps(counts))
 print('AI15_FAILURE_LOG_ERRORS',unit,json.dumps(errors[-15:])[:6000])
print('AI15_FAILURE_AUDIT_COMPLETE=true')
PY
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 id=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,name='zl-prediction-trade-after-AI15-rollback-readonly',type='RunShellScript',command_content=SHELL,working_user='root',timeout=90)).body.invoke_id
 for _ in range(55):
  time.sleep(2)
  x=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=id)).body.invocation_result
  if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(x.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(x.output)
   print('AI15_FAILURE_CLOUD',x.invocation_status,'EXIT',x.exit_code);print(o[-17000:]);return 0 if int(x.exit_code)==0 else 5
 return 6
if __name__=='__main__':sys.exit(main())

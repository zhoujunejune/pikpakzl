#!/usr/bin/env python3
"""Read-only Alibaba preflight for single-bot GUARDIAN integration; never print secrets."""
import os,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,urllib.request,subprocess,os,re
def get(port,path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=7) as r:return json.load(r)
 except Exception as ex:print('GUARDIAN_ENDPOINT_ERROR',port,type(ex).__name__);return {'error':str(getattr(ex,'code','NETWORK_ERROR'))}
for port,path in [(13001,'/api/status'),(13001,'/api/order-signal-model'),(13003,'/api/shadow-market-data'),(13002,'/api/round-stats'),(13004,'/healthz'),(13005,'/healthz')]:
 d=get(port,path)
 print('GUARDIAN_API',port,path,'ok',d.get('ok'),'keys',sorted(d.keys())[:35])
 if port==13001:print('GUARDIAN_STATE',path,'enabled',d.get('enabled'),'model',d.get('model'))
 if port==13003:
  print('GUARDIAN_FEED',d.get('readOnly'),d.get('symbol'),'latestKeys',sorted((d.get('latest') or {}).keys()),'candles',sorted((d.get('candles') or {}).keys()))
  import time
  latest=d.get('latest') or {}
  now=int(time.time()*1000)
  print('GUARDIAN_FEED_AGE_MS',now-int(latest.get('eventMs') or 0),'ROUND_DELTA_MS',int(latest.get('roundStartMs') or 0)-now//300000*300000)
 if port==13002:
  rows=d.get('records') or []
  print('GUARDIAN_OFFICIAL_ROWS',len(rows),'lastKeys',sorted(rows[-1].keys())[:80] if rows else [])
for f in ['/etc/zl-prediction/trade.env','/etc/zl-prediction/deepseek5.env','/etc/zl-prediction/prediction.env','/etc/zl-prediction/risk.env']:
 if os.path.isfile(f):
  with open(f) as h:keys=[x.split('=',1)[0] for x in h if '=' in x and not x.lstrip().startswith('#')]
  print('GUARDIAN_ENV_KEYS',f,[k for k in keys if any(y in k for y in ('DEEPSEEK','BINANCE','AUTO_RISK'))])
 print('GUARDIAN_ENV_EXISTS',f,os.path.isfile(f))
for s in ['zl-prediction-trade','zl-prediction-v2','zl-prediction-v3','zl-prediction-risk-exits','zl-prediction-deepseek5']:
 print('GUARDIAN_UNIT',s,subprocess.run(['systemctl','is-active',s],capture_output=True,text=True).stdout.strip())
print('GUARDIAN_NODE',os.path.isfile('/opt/zl-prediction-node/bin/node'))
print('GUARDIAN_PANEL_FILE',os.path.isfile('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs'))
model=get(13001,'/api/order-signal-model')
print('GUARDIAN_CURRENT_MODEL',model.get('model'),'CHOICES',[x.get('id') for x in model.get('models',[])])
status=get(13049,'/api/status')
print('GUARDIAN_SHADOW_STATE',status.get('configured'),status.get('latest',{}).get('direction'),status.get('error'))
from pathlib import Path
p=Path('/opt/zl-prediction-live/src/railway-diagnostic/production-signal-choice.mjs')
print('GUARDIAN_SELECTOR_SOURCE',p.is_file(),'containsGuardian',('GUARDIAN_MODEL' in p.read_text()) if p.is_file() else False)
if p.is_file():
 for idx,line in enumerate(p.read_text().splitlines(),1):
  if 'saved.model' in line or 'return apply(raw)' in line or 'ORDER_SIGNAL_MODELS=Object.freeze' in line:
   print('GUARDIAN_SELECTOR_MARKER',idx,line.strip()[:145])
from pathlib import Path
panel=Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
for needle in ['FAST5生产状态暂无法读取','FAST5 V7','2秒锁定','当前生产模型','实时行情更新延迟','实盘自动跟随','FAST5下单方向开关']:
 src=panel.read_text()
 pos=src.find(needle)
 print('LIVE_PANEL_NEEDLE',needle,pos)
 if pos>=0:print('LIVE_PANEL_CONTEXT',needle,repr(src[max(0,pos-500):pos+700])[:1250])
for port,endpoint in [(13001,'/api/status'),(13001,'/api/fast5-status'),(13001,'/api/fast5'),(13049,'/api/status'),(13003,'/api/shadow-market-data')]:
 try:
  import urllib.request,json
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,endpoint),timeout=4) as resp:
   val=json.loads(resp.read(800000))
   if port==13049:val={k:val.get(k) for k in ['model','latest','error','lastTickAt','lastAIAt','stats']}
   elif endpoint=='/api/status':val={k:val.get(k) for k in ['ok','enabled','orderSignalModel','orderSignalModelReady','signal','productionSignal','signalTransport','modelOriginalSignal','autoConfirmEnabled']}
   else:val={'ok':val.get('ok'),'error':val.get('error'),'keys':list(val.keys())[:18]}
   print('LIVE_PANEL_API',port,endpoint,resp.status,str(val)[:750])
 except Exception as ex:print('LIVE_PANEL_API_ERROR',port,endpoint,type(ex).__name__,str(getattr(ex,'code',''))[:40])
print('GUARDIAN_AUDIT_COMPLETE=true')
PY
"""
def main():
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 i=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='guardian-readonly-preflight',type='RunShellScript',command_content=SCRIPT,working_user='root',timeout=85)).body.invoke_id
 for _ in range(48):
  time.sleep(2)
  d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=i)).body.invocation_result
  if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(d.output or '')
   print('GUARDIAN_AUDIT_STATUS',d.invocation_status,d.exit_code)
   print(o[-12000:]);return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 else 4
 return 5
if __name__=='__main__':sys.exit(main())

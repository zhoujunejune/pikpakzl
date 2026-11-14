#!/usr/bin/env python3
"""Inspect read-only shapes of current BTC feed and official Binance prediction resolution, no secrets/prices."""
import os,base64,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,urllib.request,time
def get(url):
 try:
  with urllib.request.urlopen(url,timeout=9) as r:return json.load(r)
 except Exception as e:
  print('AUDIT_ERROR',url.rsplit('/',1)[-1],type(e).__name__);return {}
def sample_keys(v):
 if isinstance(v,dict):return sorted(v.keys())[:55]
 if isinstance(v,list):return {'type':'list','count':len(v),'itemKeys':sorted(v[-1].keys())[:32] if v and isinstance(v[-1],dict) else []}
 return type(v).__name__
market=get('http://127.0.0.1:13003/api/shadow-market-data')
print('FEED_TOPLEVEL',sample_keys(market))
print('FEED_LATEST_KEYS',sample_keys(market.get('latest')))
for key,items in (market.get('candles') or {}).items():
 print('FEED_CANDLE',key,sample_keys(items))
 if isinstance(items,dict):
  for sub,val in items.items():
   if isinstance(val,list):print('FEED_CANDLE_SUB',key,sub,sample_keys(val))
stats=get('http://127.0.0.1:13002/api/round-stats')
print('SETTLEMENT_TOPLEVEL',sample_keys(stats))
print('SETTLEMENT_ROWS',len(stats.get('records',[]) if isinstance(stats.get('records'),list) else []))
for row in (stats.get('records') or [])[-3:]:
 print('SETTLEMENT_ROW_KEYS',sample_keys(row))
 if isinstance(row,dict):
  print('SETTLEMENT_META',
    {'round':row.get('round'),'productionActual':row.get('productionActual'),
     'official':row.get('official'),'finalOutcome':row.get('finalOutcome'),
     'settled':row.get('settled'),'settlementSource':row.get('settlementSource')})
status=get('http://127.0.0.1:13029/api/status')
print('LLM_CONFIGURED',status.get('configured'))
print('LLM_LASTSIGNAL',status.get('lastSignal'))
print('LLM_ERROR',status.get('error'))
sel=get('http://127.0.0.1:13001/api/order-signal-model')
print('PRODUCTION_MODEL',sel.get('model'))
follow=get('http://127.0.0.1:13001/api/status')
print('AUTO_FOLLOW_ENABLED',follow.get('enabled'))
PY
"""
def main():
 cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 inv=cli.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
 instance_id='b67374069bb3457ba6a3a2ede9305d3f',
 name='zl-deepseek-features-official-resolution-audit',
 type='RunShellScript',command_content=SCRIPT,working_user='root',timeout=65)).body.invoke_id
 for _ in range(35):
  time.sleep(2)
  r=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   s=r.output or ''
   try:s=base64.b64decode(s,validate=True).decode('utf-8','replace')
   except Exception:pass
   print(s[-9600:]);return 0 if int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':raise SystemExit(main())

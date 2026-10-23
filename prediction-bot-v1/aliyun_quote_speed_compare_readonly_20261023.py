#!/usr/bin/env python3
"""Read-only comparison of live Alibaba Binance Prediction quote/order latency."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='audit/aliyun-speed-path-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,subprocess,statistics,time,urllib.request,collections
from datetime import datetime,timezone
from zoneinfo import ZoneInfo
tz=ZoneInfo('Asia/Singapore')
cutoff=datetime(2026,10,23,10,5,tzinfo=tz).timestamp()*1000
prestart=datetime(2026,10,23,8,0,tzinfo=tz).timestamp()*1000
now=int(time.time()*1000)
names={'deepseek100ms_locked','api_intent_ready','auto_submit_triggered',
 'fresh_quote_ready','fresh_quote_failed','quote_transport_timeout_retry',
 'quote_connection_prepared','quote_connection_prewarm_failed',
 'api_order_submit_attempt','api_order_submitted_pending_confirmation',
 'order_status_updated'}
events=[]
for unit in ('zl-prediction-deepseek5.service','zl-prediction-trade.service'):
 cmd=['journalctl','-u',unit,'--since','2026-10-23 08:00:00','--no-pager','-o','json','-n','40000']
 p=subprocess.run(cmd,capture_output=True,text=True,timeout=28)
 for line in p.stdout.splitlines():
  try:
   record=json.loads(line); e=json.loads(record.get('MESSAGE',''))
   if not isinstance(e,dict) or e.get('event') not in names:continue
   at=int(record['__REALTIME_TIMESTAMP'])//1000
   if at<prestart or at>now+2000:continue
   events.append((at,e))
  except (ValueError,TypeError,KeyError):continue
print('QUOTESPEED_NOW_LOCAL',datetime.now(tz).isoformat(),flush=True)
try:
 with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=8) as r:st=json.load(r)
except Exception as exc:st={'statusErrorType':type(exc).__name__}
from pathlib import Path
src=Path('/opt/zl-prediction-live/src/railway-diagnostic/index.mjs').read_text()
print('QUOTESPEED_LIVE_STATUS',json.dumps({'followEnabled':st.get('enabled'),
 'autoConfirmEnabled':st.get('autoConfirmEnabled'),
 'selectedModel':st.get('orderSignalModel'),
 'patchInstalled':'ZL_QUOTE_SPEED_20261023' in src,
 'serviceActive':subprocess.run(['systemctl','is-active','--quiet','zl-prediction-trade.service']).returncode==0},ensure_ascii=False))
stages={}
for at,e in events:
 r=e.get('round')
 if not isinstance(r,int):continue
 obj=stages.setdefault(r,{})
 obj.setdefault(e['event'],[]).append((at,e))
def msstat(seq):
 vals=sorted(int(x) for x in seq if isinstance(x,(int,float)) and x>=0)
 if not vals:return {'n':0}
 return {'n':len(vals),'min':vals[0],'p50':vals[(len(vals)-1)//2],
  'p90':vals[int((len(vals)-1)*.9)],'max':vals[-1]}
def stamp(ts):
 return datetime.fromtimestamp(ts/1000,tz).strftime('%H:%M:%S.%f')[:-3]
aggregates={}
details=[]
for round_ms,groups in stages.items():
 submit=groups.get('api_order_submitted_pending_confirmation',[])
 sig=groups.get('deepseek100ms_locked',[])
 quot=groups.get('fresh_quote_ready',[])
 if not submit:continue
 submit_ms,sub_evt=sorted(submit)[0]
 bucket='before' if submit_ms<cutoff else 'after'
 if submit_ms<prestart:continue
 b=aggregates.setdefault(bucket,{'signalToSubmitMs':[],
  'quoteLatencyMs':[],'submitHttpLatencyMs':[],'prepareMs':[],'quoteToSubmitMs':[]})
 signal_ts=max([a for a,e in sig if a<=submit_ms],default=None)
 quote_ts=max([a for a,e in quot if a<=submit_ms],default=None)
 if signal_ts is not None:b['signalToSubmitMs'].append(submit_ms-signal_ts)
 if quot:
  for a,e in quot:
   if isinstance(e.get('quoteLatencyMs'),(int,float)):b['quoteLatencyMs'].append(e['quoteLatencyMs'])
 if isinstance(sub_evt.get('submitLatencyMs'),(int,float)):b['submitHttpLatencyMs'].append(sub_evt['submitLatencyMs'])
 if signal_ts is not None and groups.get('api_intent_ready'):
  intent_ts=min(a for a,e in groups['api_intent_ready'] if a>=signal_ts)
  b['prepareMs'].append(intent_ts-signal_ts)
 if quote_ts is not None:b['quoteToSubmitMs'].append(submit_ms-quote_ts)
 details.append({'roundLocal':stamp(round_ms),'submittedLocal':stamp(submit_ms),
  'bucket':bucket,'signalToSubmitMs':submit_ms-signal_ts if signal_ts else None,
  'quoteLatencyMs':min([e.get('quoteLatencyMs') for a,e in quot if isinstance(e.get('quoteLatencyMs'),(int,float))],default=None),
  'submitHttpLatencyMs':sub_evt.get('submitLatencyMs')})
for bucket in ('before','after'):
 b=aggregates.get(bucket,{})
 print('QUOTESPEED_BUCKET',bucket,json.dumps({k:msstat(b.get(k,[])) for k in
  ('signalToSubmitMs','quoteLatencyMs','submitHttpLatencyMs','prepareMs','quoteToSubmitMs')}))
for bucket in ('before','after'):
 subset=[x for x in events if ('before' if x[0]<cutoff else 'after')==bucket]
 count=collections.Counter(e['event'] for at,e in subset)
 print('QUOTESPEED_EVENTS',bucket,json.dumps({key:count[key] for key in sorted(names)}))
print('QUOTESPEED_LAST_8_SUBMITTED',json.dumps(sorted(details,key=lambda x:x['submittedLocal'],reverse=True)[:8],ensure_ascii=False))
print('QUOTESPEED_AUDIT_COMPLETE=true')
PY
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
  name='zl-quote-speed-before-after-readonly',type='RunShellScript',working_user='root',
  command_content=REMOTE,timeout=120)).body.invoke_id
 for _ in range(65):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf-8','replace')
   except Exception:o=str(r.output)
   print('QUOTESPEED_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(o[-19000:])
   return 0 if int(r.exit_code)==0 else 5
 print('QUOTESPEED_RESULT_UNKNOWN');return 6
if __name__=='__main__':sys.exit(main())

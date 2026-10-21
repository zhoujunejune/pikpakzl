#!/usr/bin/env python3
"""Inspect actual production trade-value decisions, sanitized and read-only."""
import os,sys,time,base64,urllib.request
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
remote=r"""#!/bin/bash
set -eu
python3 - <<'PY'
import json,urllib.request,subprocess,collections,datetime
def get(port,p):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,p),timeout=6) as r:return json.load(r)
 except Exception as e:return {'error':type(e).__name__}
trade=get(13001,'/api/status');deep=get(13029,'/api/status');quality=get(13029,'/api/learning-effect')
p=subprocess.run(['journalctl','-u','zl-prediction-trade.service','--since','12 hours ago','--no-pager','-o','cat'],capture_output=True,text=True,timeout=18)
names=['deepseek_live_trade_value','auto_submit_triggered','fresh_quote_failed',
'order_submit_deadline_expired','submit_blocked_signal_changed',
'ev_filter_blocked','ev_filter_passed','order_post_failed','order_submit_success']
events=[]
for line in p.stdout.splitlines():
 if not any(needle in line for needle in names):continue
 i=line.find('{')
 if i<0:continue
 try:obj=json.loads(line[i:])
 except Exception:continue
 ev=obj.get('event')
 if ev not in names:continue
 safe={k:obj.get(k) for k in ['event','round','decision','reason','samples',
  'quoteChance','conservativeNetEdge','productionDirection','orderDirection',
  'stage','source','error'] if k in obj}
 events.append(safe)
counts=collections.Counter(v['event'] for v in events)
tradeFields={k:trade.get(k) for k in ['enabled','autoConfirmEnabled','autoConfirmHalted',
 'signalModel','signal','pending','pendingAction','lastOrder','lastOrderState'] if k in trade}
for x in ['pending','pendingAction','lastOrder','signal']:
 if isinstance(tradeFields.get(x),dict):
  keep=('state','status','round','direction','productionSignal','signal',
        'quoteChance','tradeValueDecision','tradeValueReason','conservativeNetEdge',
        'error','blockReason','orderAttempts','lockedAt')
  tradeFields[x]={k:tradeFields[x][k] for k in keep if k in tradeFields[x]}
summary={'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'services':{u:subprocess.run(['systemctl','is-active',u],capture_output=True,text=True).stdout.strip()
 for u in ['zl-prediction-trade.service','zl-prediction-deepseek5.service',
 'zl-prediction-v2.service','zl-prediction-v3.service']},
 'follow':trade.get('enabled'),
 'tradeStatus':tradeFields,
 'model':deep.get('providerModel'),'decisionState':deep.get('status'),
 'modelError':deep.get('lastError'),
 'learning':{k:deep.get('learning',{}).get(k) for k in
 ['allOfficialSamples','allOfficialHits','allOfficialAccuracy','recentAccuracy',
  'comparableOfficialCases','similarCaseMinimum','lastError','autoFeedback']},
 'evidence':quality.get('evidence',{}),
 'journalReadOk':p.returncode==0,'events12h':dict(counts),
 'lastValueDecisions':[e for e in events if e['event']=='deepseek_live_trade_value'][-8:],
 'lastRelevantEvents':events[-12:]}
print('ZL_REAL_TRADE_VALUE_AUDIT='+json.dumps(summary,ensure_ascii=False,separators=(',',':')))
PY
"""
client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
instance='b67374069bb3457ba6a3a2ede9305d3f'
task=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=instance,
name='zl-live-trade-value-recent-telemetry-readonly',type='RunShellScript',
working_user='root',command_content="bash -s <<'ZL_READONLY'\n"+remote+"\nZL_READONLY\n",timeout=75)).body.invoke_id
for _ in range(60):
 time.sleep(2)
 r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
  region_id='ap-southeast-1',instance_id=instance,invoke_id=task)).body.invocation_result
 if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
  try:v=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
  except Exception:v=str(r.output)
  print('LIVE_TRADE_VALUE_AUDIT_STATUS',r.invocation_status,'EXIT',r.exit_code)
  for line in v.splitlines():
   if line.startswith('ZL_REAL_TRADE_VALUE_AUDIT='):print(line)
  if int(r.exit_code)!=0:print(v[-1000:])
  sys.exit(0 if int(r.exit_code)==0 else 5)
sys.exit('LIVE_TRADE_VALUE_AUDIT_TIMEOUT')

#!/usr/bin/env python3
"""Summarize only sanitized failed quote reasons from Alibaba production journal."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='audit/aliyun-speed-path-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import subprocess,json,re,collections,time
from datetime import datetime
from zoneinfo import ZoneInfo
tz=ZoneInfo('Asia/Singapore')
since=int(datetime(2026,10,23,10,5,tzinfo=tz).timestamp()*1000)
p=subprocess.run(['journalctl','-u','zl-prediction-trade.service',
 '--since','18 hours ago','--no-pager','-o','json','-n','40000'],
 capture_output=True,text=True,timeout=26)
events=collections.defaultdict(list)
for line in p.stdout.splitlines():
 try:
  z=json.loads(line); e=json.loads(z.get('MESSAGE',''))
  if not isinstance(e,dict):continue
  at=int(z.get('__REALTIME_TIMESTAMP','0'))//1000
  if at<since:continue
  r=e.get('round')
  if not isinstance(r,int):continue
  name=e.get('event')
  if name in ('fresh_quote_failed','auto_submit_triggered','fresh_quote_ready',
   'quote_transport_timeout_retry','api_order_submitted_pending_confirmation',
   'order_retry_requote_failed','auto_order_attempt_result',
   'quote_connection_prepared'):
   events[r].append((at,e))
 except (ValueError,TypeError,KeyError):continue
def cls(e):
 code=e.get('code'); status=e.get('httpStatus')
 msg=str(e.get('error') or '')
 u=msg.upper()
 if isinstance(status,int) and status in (418,429):return 'RATE_LIMIT'
 if status==451 or 'REGION' in u or 'RESTRICTED' in u:return 'REGION_RESTRICTION'
 if 'TIMEOUT' in u or 'TIMED OUT' in u:return 'TIMEOUT'
 if 'BALANCE' in u:return 'BALANCE'
 if 'QUOTE_ID_MISSING' in u:return 'QUOTE_ID_MISSING'
 if 'QUOTE' in u and 'EXPIRED' in u:return 'QUOTE_EXPIRED'
 if 'SLIPPAGE' in u:return 'SLIPPAGE'
 if 'AMOUNT' in u:return 'AMOUNT'
 if 'SIGNATURE' in u or 'TIMESTAMP' in u:return 'AUTH_OR_CLOCK'
 if isinstance(status,int) and status>=500:return 'EXCHANGE_SERVER'
 if status==400:return 'EXCHANGE_BAD_REQUEST'
 if status==403:return 'EXCHANGE_FORBIDDEN'
 if 'FETCH' in u or 'NETWORK' in u:return 'NETWORK'
 if isinstance(status,int) and status>=400:return 'EXCHANGE_HTTP_'+str(status)
 return 'OTHER'
def label(t):
 return datetime.fromtimestamp(t/1000,tz).strftime('%H:%M:%S.%f')[:-3]
out=[]
for r in sorted(events):
 rows=events[r]
 failures=[(at,e) for at,e in rows if e['event']=='fresh_quote_failed']
 if not failures:continue
 last=failures[-1][1]
 outcomes=collections.Counter(e['event'] for _,e in rows)
 code=last.get('code')
 if not isinstance(code,(int,str)) or len(str(code))>14:code=None
 out.append({'round':label(r),'failedAt':label(failures[-1][0]),
  'reasonCategory':cls(last),'httpStatus':last.get('httpStatus'),
  'serverMessageRedacted':re.sub(r'[0-9]+','#',re.sub(r'\b[A-Za-z0-9_]{24,}\b','[REDACTED]',str(last.get('error') or '')[:180])),
  'exchangeCode':code,'eventCounts':dict(outcomes)})
print('QUOTE_FAILURE_AUDIT_STATUS',json.dumps({'journalOk':p.returncode==0,
 'checkedLocal':datetime.now(tz).isoformat(),'failedRounds':len(out),
 'activeQuoteTimeoutRetries':sum(sum(1 for _,e in rows if e['event']=='quote_transport_timeout_retry')
 for rows in events.values())}))
print('QUOTE_FAILURE_AUDIT_CASES',json.dumps(out[-30:],ensure_ascii=False))
PY
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
  name='zl-quote-failure-audit-readonly',type='RunShellScript',working_user='root',
  command_content=REMOTE,timeout=75)).body.invoke_id
 for _ in range(42):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:out=str(r.output)
   print('QUOTE_FAILURE_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(out[-11000:])
   return 0 if int(r.exit_code)==0 else 5
 print('QUOTE_FAILURE_REMOTE_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

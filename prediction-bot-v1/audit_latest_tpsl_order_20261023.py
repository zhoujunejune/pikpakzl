#!/usr/bin/env python3
"""Read-only Alibaba investigation of latest Binance prediction order TP-SL gap."""
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='audit/risk-live-order-20261023'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,subprocess,datetime,time,urllib.request,collections,hashlib,hmac,pathlib,urllib.parse,re,os
from zoneinfo import ZoneInfo
tz=ZoneInfo('Asia/Singapore')
now=int(time.time()*1000)
fmt=lambda t:datetime.datetime.fromtimestamp(t/1000,tz).strftime('%m-%d %H:%M:%S.%f')[:-3]
def get(port,path):
 try:
  with urllib.request.urlopen(f'http://127.0.0.1:{port}'+path,timeout=7) as r:return json.load(r)
 except Exception as e:return {'ok':False,'errorType':type(e).__name__}
ctl=get(13001,'/api/risk-control')
t=get(13001,'/api/status')
print('RISK_LATEST_CHECKED_AT',datetime.datetime.now(tz).isoformat())
print('RISK_LATEST_CONTROL',{k:ctl.get(k) for k in ('ok','takeProfitEnabled','takeProfitPercent',
 'stopLossEnabled','stopLossPercent','persistenceHealthy')})
print('RISK_LATEST_EXECUTION',{k:(ctl.get('execution')or{}).get(k) for k in
 ('enabled','workerRunning','configApplied','persistenceHealthy','transitioning','lastWorkerStartedAt')})
print('RISK_LATEST_FOLLOW',t.get('enabled'))
print('RISK_LATEST_LAST_ORDER',{k:(t.get('lastOrder')or{}).get(k) for k in
 ('state','status','submittedAt','createdAt','lastCheckedAt','fillPercentage','direction','reason','error')})
for unit in ('zl-prediction-risk-exits.service','zl-prediction-trade.service'):
 out=subprocess.run(['systemctl','show',unit,'-p','ActiveState','-p','ExecMainStartTimestamp','-p','NRestarts'],
 capture_output=True,text=True,timeout=6).stdout
 print('RISK_LATEST_UNIT',unit,out.strip().replace('\n',' ')[:250])
for file in ('/tmp/risk-worker-health.json','/tmp/risk-runtime-status.json','/var/lib/zl-prediction/risk-sell-recovery/pending-v1.json'):
 try:
  v=json.loads(pathlib.Path(file).read_text())
  if 'pending' in file:
   print('RISK_LATEST_PENDING_FILE',{'outstanding':len(v.get('outstanding')or[]),
      'types':dict(collections.Counter('statusUnknown' if x[1].get('statusUnknown')
       else 'submitted' if x[1].get('submitted') else 'other'
       for x in v.get('outstanding',[]))),'updated':fmt(v['at']) if v.get('at',0)>1e12 else None})
  else:
   keys=('at','lastTickStartedAt','lastTickFinishedAt','lastSuccessfulPositionsAt','positionsSeen',
    'lastQuoteAt','quoteChecks','quoteErrors','lastErrorAt','lastError','lastSellEventAt','lastSellEvent',
    'workerRunning','configApplied','transitioning')
   print('RISK_LATEST_HEALTH',file,{k:v.get(k) for k in keys if k in v})
 except Exception as e:print('RISK_LATEST_HEALTH_MISSING',file,type(e).__name__)
cmd=['journalctl','-u','zl-prediction-risk-exits.service','--since','150 minutes ago',
 '--no-pager','-o','json','-n','25000']
p=subprocess.run(cmd,capture_output=True,text=True,timeout=25)
events=[];aliases={}
for ln in p.stdout.splitlines():
 try:
  j=json.loads(ln);v=json.loads(j.get('MESSAGE',''))
  e=v.get('event')
  if not isinstance(e,str) or not (e.startswith('risk_') or e.startswith('risk_runtime_')):continue
  tm=int(j['__REALTIME_TIMESTAMP'])//1000
  if tm<now-150*60000 or tm>now+30000:continue
 except Exception:continue
 tok=str(v.get('tokenId') or '')
 alias=None
 if tok:
  if tok not in aliases:aliases[tok]='P'+str(len(aliases)+1)
  alias=aliases[tok]
 row={'t':tm,'e':e,'p':alias}
 for k in ('reason','retryMs','code','httpStatus','status','pollMs','originalOrderVerifiedFailed',
   'confirmedFilled','workerRunning','retrySellBlocked','noOpenPosition','hadOrderId'):
  val=v.get(k)
  if k in ('reason','code','status'):
   if not isinstance(val,str) or len(val)>55 or not re.match(r'^[A-Za-z0-9_ -]+$',val):continue
  elif not isinstance(val,(int,float,bool)):continue
  row[k]=val
 if e=='risk_check':
  cost=v.get('totalCost');price=v.get('currentSellAmount')
  tp=v.get('tpTarget');sl=v.get('slTarget')
  if isinstance(cost,(int,float)) and cost>0 and isinstance(price,(int,float)):
   row['quoteReturnPct']=round((price/cost-1)*100,2)
  if all(isinstance(x,(int,float)) for x in (tp,sl,price)):
   row['tpHit']=price>=tp;row['slHit']=price<=sl
 events.append(row)
events.sort(key=lambda x:x['t'])
print('RISK_LATEST_JOURNAL_OK',p.returncode==0,'events',len(events))
print('RISK_LATEST_EVENT_COUNTS',dict(collections.Counter(x['e'] for x in events)))
interesting={'risk_triggered','risk_sell_submitted','risk_sell_failed','risk_sell_unknown','risk_sell_quote_failed',
 'risk_sell_exception','risk_wallet_error','risk_positions_error','risk_tick_exception',
 'risk_invalid_position','risk_retry_scheduled','risk_sell_finality_pending',
 'risk_sell_final_failed_retry_scheduled','risk_sell_fill_confirmed',
 'risk_unknown_reconcile_pending','risk_unknown_order_found','risk_runtime_worker_started','risk_runtime_worker_exited',
 'risk_worker_started','risk_worker_stopping'}
print('RISK_LATEST_LAST_EVENTS',json.dumps([dict(x,time=fmt(x['t'])) for x in events if x['e'] in interesting][-65:],ensure_ascii=False))
by=collections.defaultdict(list)
for v in events:
 if v['p']:by[v['p']].append(v)
positions=[]
for token,rows in by.items():
 positions.append({
  'p':token,'firstAt':fmt(rows[0]['t']),'lastAt':fmt(rows[-1]['t']),
  'checks':sum(x['e']=='risk_check' for x in rows),
  'latestQuoteGrossPct':next((x.get('quoteReturnPct') for x in reversed(rows) if x['e']=='risk_check'),None),
  'bestQuoteGrossPct':max((x['quoteReturnPct'] for x in rows if 'quoteReturnPct' in x),default=None),
  'worstQuoteGrossPct':min((x['quoteReturnPct'] for x in rows if 'quoteReturnPct' in x),default=None),
  'tpCrossed':any(x.get('tpHit') for x in rows),'slCrossed':any(x.get('slHit') for x in rows),
  'triggered':sum(x['e']=='risk_triggered' for x in rows),
  'sellSubmitted':sum(x['e']=='risk_sell_submitted' for x in rows),
  'failed':sum(x['e'] in ('risk_sell_failed','risk_sell_unknown','risk_sell_quote_failed','risk_sell_exception') for x in rows),
  'lastEvent':rows[-1]['e']})
print('RISK_LATEST_POSITIONS_BY_EVENTS',json.dumps(positions[-18:],ensure_ascii=False))
print('RISK_LATEST_LATEST_CHECKS',json.dumps([
 dict(x,time=fmt(x['t'])) for x in events if x['e']=='risk_check'][-12:],ensure_ascii=False))
# Read-only signed API call for latest ongoing position. This must never
# request quotes or place orders. Never output keys/wallet/token/order identifiers.
pidproc=subprocess.run(['pgrep','-f','^[^ ]*node risk-worker.mjs$'],
 capture_output=True,text=True,timeout=5).stdout.strip().splitlines()
if not pidproc:
 pidproc=subprocess.run(['pgrep','-f','node .*risk-worker.mjs'],
 capture_output=True,text=True,timeout=5).stdout.strip().splitlines()
print('RISK_LATEST_WORKER_PROCESSES',len(pidproc))
try:
 pid=int(pidproc[0])
 env={}
 for kv in (pathlib.Path('/proc')/str(pid)/'environ').read_bytes().split(b'\0'):
  if b'=' in kv:
   k,v=kv.split(b'=',1)
   if k.decode(errors='ignore') in ('BINANCE_PREDICTION_API_KEY','BINANCE_PREDICTION_API_SECRET',
    'BINANCE_PREDICTION_WALLET_ADDRESS'):env[k.decode()]=v.decode()
 key=env.get('BINANCE_PREDICTION_API_KEY','')
 secret=env.get('BINANCE_PREDICTION_API_SECRET','')
 wallet=env.get('BINANCE_PREDICTION_WALLET_ADDRESS','')
 if key and secret and wallet:
  params=urllib.parse.urlencode({'walletAddress':wallet,'tab':'ONGOING','offset':0,'limit':100,
    'timestamp':int(time.time()*1000),'recvWindow':'5000'})
  sig=hmac.new(secret.encode(),params.encode(),hashlib.sha256).hexdigest()
  url='https://api.binance.com/sapi/v1/w3w/wallet/prediction/position/list?'+params+'&signature='+sig
  try:
   req=urllib.request.Request(url,headers={'X-MBX-APIKEY':key,'Accept':'application/json'})
   with urllib.request.urlopen(req,timeout=11) as res:raw=json.loads(res.read())
   ongoing=raw.get('positions') if isinstance(raw.get('positions'),list) else []
   print('RISK_LATEST_ONGOING_COUNT',len(ongoing))
   outputs=[]
   for v in ongoing[-12:]:
    tok=str(v.get('tokenId') or '')
    outputs.append({'p':aliases.get(tok,'UNSEEN'),'positionStatus':v.get('positionStatus'),
      'sharesPositive':float(v.get('shares') or 0)>0,
      'shares':round(float(v.get('shares') or 0),4),
      'cost':round(float(v.get('totalCost') or 0),4),
      'toWin':round(float(v.get('toWin') or 0),4),
      'createTime':v.get('createTime'),'marketEndAt':v.get('marketEndAt')})
   print('RISK_LATEST_ONGOING_SUMMARY',json.dumps(outputs,ensure_ascii=False))
  except Exception as e:
   print('RISK_LATEST_BINANCE_POSITIONS_QUERY_FAILED',type(e).__name__,
    getattr(e,'code',None))
 else:print('RISK_LATEST_SIGNED_POSITION_PROBE_SKIPPED',{'hasKey':bool(key),
   'hasSecret':bool(secret),'hasWallet':bool(wallet)})
except Exception as e:print('RISK_LATEST_POSITION_READ_ERROR',type(e).__name__)

# Pinpoint journal save permissions and exception root cause without credentials.
print('RISK_LATEST_PERSIST_ERROR_DETAIL_START')
err=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
 '--since','2026-10-23 07:05:00 UTC','--no-pager','-o','cat','-n','2000'],
 capture_output=True,text=True,timeout=10).stdout
for line in err.splitlines():
 try:
  j=json.loads(line)
  if j.get('event') not in ('risk_sell_state_persist_failed','risk_sell_exception',
   'risk_tick_exception','risk_sell_finality_pending'):continue
  note=str(j.get('error') or j.get('reason') or '')
  # only error code/name and static file path. No wallet/token IDs.
  print('RISK_LATEST_PERSIST_ERROR',{'at':j.get('at'),'event':j['event'],
    'errorType':note.split(':',1)[0][:100],
    'pathHint':'risk-sell-recovery' in note,
    'reason':note[:220] if re.match(r'^[A-Z_0-9]+(?:\\b|:)',note) else type(note).__name__})
 except:continue
risk=pathlib.Path('/var/lib/zl-prediction/risk-sell-recovery')
for obj in (risk.parent,risk,risk/'pending-v1.json'):
 try:
  stat=obj.stat()
  print('RISK_LATEST_FS_PERMS',str(obj),
   {'exists':True,'mode':oct(stat.st_mode&0o777),'uid':stat.st_uid,
    'gid':stat.st_gid,'rootWritable':os.access(obj,os.W_OK)})
 except Exception as e:print('RISK_LATEST_FS_PERMS',str(obj),'ERROR',type(e).__name__)
try:
 workerpid=int(pidproc[0])
 proc=pathlib.Path('/proc')/str(workerpid)
 st=proc.joinpath('status').read_text()
 print('RISK_LATEST_WORKER_IDS',[(l.split(':',1)[0],l.split(':',1)[1].strip())
  for l in st.splitlines() if l.startswith(('Uid:','Gid:','Groups:','Name:'))])
 print('RISK_LATEST_WORKER_CWD',str(proc.joinpath('cwd').resolve()))
except Exception as e:print('RISK_LATEST_WORKER_ID_ERROR',type(e).__name__)
print('RISK_LATEST_AUDIT_COMPLETE=true')
PY
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[0-9a-f]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
  name='zl-latest-tpsl-position-readonly-audit',type='RunShellScript',
  working_user='root',command_content=REMOTE,timeout=170)).body.invoke_id
 for _ in range(100):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('RISK_LATEST_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(o[-26000:])
   return 0 if int(r.exit_code)==0 else 5
 print('RISK_LATEST_UNCONFIRMED');return 6
if __name__=='__main__':sys.exit(main())

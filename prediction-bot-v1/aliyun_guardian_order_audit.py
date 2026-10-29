#!/usr/bin/env python3
"""Read-only Binance Prediction GUARDIAN chain health / blocking diagnostics."""
import base64,os,time,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SH=r'''#!/bin/bash
set -eu
python3 - <<'PY'
import json,urllib.request,pathlib,subprocess,datetime,collections
now=datetime.datetime.now(datetime.timezone.utc)
def q(port,endpoint):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,endpoint),timeout=5) as r:return json.load(r)
 except Exception as e:return {'error':type(e).__name__}
def fields(d,keys):return {k:d.get(k) for k in keys if k in d}
print('CHAIN_UTC',now.isoformat(timespec='seconds'))
for port in (13001,13005):
 d=q(port,'/api/status')
 ks=['ok','enabled','amount','autoConfirmEnabled','autoConfirmHalted','autoConfirmStopOnError','autoConfirmCooldownMs','orderSignalModel','orderSignalModelReady','guardianRiskReady','guardianExecutionReady','directionModeReady','orderSignal']
 print('CHAIN_STATUS',port,json.dumps(fields(d,ks),ensure_ascii=False,default=str))
 for kind in ('pendingAction','lastOrder'):
  v=d.get(kind) or {};print('CHAIN_ORDER',port,kind,json.dumps(fields(v,['round','state','error','code','blockReason','paymentAccount','orderAttempts','status']),ensure_ascii=False,default=str)[:750])
 bal=d.get('balance') or {}
 try: accounts=[{'type':x.get('accountType'),'enabled':x.get('enabled'),'ge1':float(x.get('availableBalanceDisplay') or 0)>=1} for x in (bal.get('items') or [])]
 except (ValueError,TypeError):accounts=[]
 print('CHAIN_PAYMENT',port,json.dumps({'ok':bal.get('ok'),'error':bal.get('error'),'accounts':accounts},ensure_ascii=False))
g=q(13049,'/api/status');l=g.get('latest') or {}
print('CHAIN_GUARDIAN',json.dumps({'ok':g.get('ok'),'configured':g.get('configured'),'model':g.get('model'),'round':g.get('round'),'latest':fields(l,['direction','round','status','reason']),'observedAgeMs':int(now.timestamp()*1000)-int(g.get('observedAt') or 0),'error':g.get('error'),'recordCount':len(g.get('records') or [])},ensure_ascii=False)[:950])
m=q(13003,'/api/shadow-market-data')
print('CHAIN_FEED',json.dumps({'ok':m.get('ok'),'readOnly':m.get('readOnly'),'symbol':m.get('symbol'),'ageMs':int(now.timestamp()*1000)-int((m.get('latest') or {}).get('eventMs') or 0)}))
root=pathlib.Path('/var/lib/zl-prediction/rounds')
for name,keys in [('risk-control.json',['takeProfitEnabled','stopLossEnabled','takeProfitPercent','stopLossPercent']),('risk-runtime-status.json',['at','enabled','workerRunning','configApplied','guardianDynamicExitEnabled','transitioning']),('risk-worker-health.json',['lastSuccessfulPositionsAt','positionsSeen','lastError'])]:
 try:
  d=json.loads((root/name).read_text());v=fields(d,keys)
  for k in ('at','lastSuccessfulPositionsAt'):
   if k in v:
    try:
     t=datetime.datetime.fromisoformat(str(v.pop(k)).replace('Z','+00:00'))
     v[k+'AgeSec']=round((now-t).total_seconds())
    except Exception:v[k+'AgeSec']='unknown'
  print('CHAIN_RISK',name,json.dumps(v,ensure_ascii=False,default=str)[:500])
 except Exception as e: print('CHAIN_RISK_ERROR',name,type(e).__name__)
for unit in ('zl-prediction-trade','zl-prediction-risk-exits','zl-prediction-guardian-analysis'):
 r=subprocess.run(['systemctl','is-active',unit],capture_output=True,text=True)
 print('CHAIN_UNIT',unit,r.stdout.strip())
p=subprocess.run(['journalctl','-u','zl-prediction-trade','--since','3 hours ago','-o','json','--no-pager','-n','12000'],capture_output=True,text=True,timeout=20)
watch={'api_confirm_control','api_intent_ready','auto_submit_triggered','guardian_signal_recheck_completed','submit_blocked_signal_changed','fresh_quote_failed','fresh_quote_ready','api_order_submit_attempt','api_order_failed','api_order_submitted_pending_confirmation','order_status_updated','order_retry_requote_failed','order_submit_attempt_denied','order_submit_deadline_expired','auto_confirm_halted','guardian_feed_unavailable','intent_prepare_failed','prediction_wallet_quote_insufficient_spot_fallback','prediction_wallet_insufficient_spot_unavailable','order_status_conflict_auto_halted'}
events=[];count=collections.Counter()
for x in p.stdout.splitlines():
 try:
  j=json.loads(x);d=json.loads(j.get('MESSAGE',''));k=d.get('event') if isinstance(d,dict) else None
  if k not in watch:continue
  count[k]+=1
  ts=datetime.datetime.fromtimestamp(int(j['__REALTIME_TIMESTAMP'])/1e6,datetime.timezone(datetime.timedelta(hours=8))).strftime('%m-%d %H:%M:%S')
  events.append({'t':ts,'event':k,**fields(d,['round','code','httpStatus','retries','signalRecovered','currentSignalIdMatches','spotQuoteOk','state','blockReason','paymentAccount'])})
 except Exception:pass
print('CHAIN_JOURNAL_STATUS',p.returncode,'COUNTS',json.dumps(count,ensure_ascii=False))
for x in events[-20:]: print('CHAIN_EVENT',json.dumps(x,ensure_ascii=False,default=str)[:380])
print('CHAIN_RISK_REGISTRY_DIAG_BEGIN')
import os,stat,pwd
service=subprocess.run(['systemctl','show','zl-prediction-trade','-p','User','-p','Group','-p','Environment','--no-pager'],capture_output=True,text=True).stdout
user=next((v.split('=',1)[1].strip() for v in service.splitlines() if v.startswith('User=')),'')
if not user:user='root'
print('REG_SERVICE_USER',user)
env=next((v.split('=',1)[1].strip() for v in service.splitlines() if v.startswith('Environment=')),'')
import shlex
overrides=[x.split('=',1)[1] for x in shlex.split(env) if x.startswith('GUARDIAN_REGISTRY_FILE=')]
target=pathlib.Path(overrides[0] if overrides else '/var/lib/zl-prediction/guardian5/guardian-live-orders.json')
print('REG_TARGET',str(target))
for d in (target.parent.parent,target.parent,target):
 try:
  st=d.stat()
  mode=stat.filemode(st.st_mode)
  try:owner=pwd.getpwuid(st.st_uid).pw_name
  except KeyError:owner='uid'+str(st.st_uid)
  print('REG_PATH',str(d),'exists',True,'mode',mode,'owner',owner,'size',st.st_size)
 except FileNotFoundError:print('REG_PATH',str(d),'exists',False)
 except Exception as e:print('REG_PATH_ERROR',str(d),type(e).__name__)
p=subprocess.run(['runuser','-u',user,'--','test','-w',str(target.parent if target.parent.exists() else target.parent.parent)],capture_output=True,text=True)
print('REG_USER_CAN_WRITE_DIRECTORY',p.returncode==0)
if target.exists():
 try:
  raw=json.loads(target.read_text())
  print('REG_JSON_VALID',True,'modelMatches',raw.get('model')=='ZL_GUARDIAN_5M_V1','entriesIsArray',isinstance(raw.get('entries'),list),'entriesCount',len(raw.get('entries') or []))
 except Exception as e:print('REG_JSON_VALID',False,'reason',type(e).__name__)
print('CHAIN_RISK_REGISTRY_DIAG_END')
print('CHAIN_READONLY_DONE=true')
PY
'''
def main():
 if not os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID') or not os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET'):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 q=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='guardian-order-readonly-audit',type='RunShellScript',command_content=SH,working_user='root',timeout=95)).body.invoke_id
 for _ in range(52):
  time.sleep(2)
  d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=q)).body.invocation_result
  if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
   except Exception:out='UNAVAILABLE'
   print('CHAIN_REMOTE_STATUS',d.invocation_status,d.exit_code);print(out[-13500:])
   return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 else 4
 return 5
if __name__=='__main__':sys.exit(main())

#!/usr/bin/env python3
"""GUARDIAN production read-only audit. No writes, orders, restarts, or key disclosure."""
import os,time,sys,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SHELL=r"""#!/bin/bash
set -uo pipefail
python3 - <<'PY'
import json,subprocess,urllib.request,time,datetime,pathlib,collections,hashlib,re
now=time.time()*1000
print('AUDIT_TIME',datetime.datetime.now(datetime.timezone.utc).isoformat())
def get(port,path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=4) as a:return json.load(a)
 except Exception as e:return {'readError':type(e).__name__}
s=get(13001,'/api/status')
g=get(13049,'/api/status')
f=get(13003,'/api/shadow-market-data')
print('STATUS',json.dumps({k:s.get(k) for k in ('ok','enabled','orderSignalModel','orderSignalModelReady','guardianRiskReady','guardianExecutionReady','directionModeReady','autoConfirmEnabled','autoConfirmHalted','amount')},ensure_ascii=False))
for key in ('pendingAction','lastOrder'):
 x=s.get(key) or {}
 print('ORDER',key,json.dumps({k:x.get(k) for k in ('state','round','status','code','blockReason','paymentAccount','error')},ensure_ascii=False)[:400])
print('SIGNAL',json.dumps({'ok':g.get('ok'),'model':g.get('model'),'configured':g.get('configured'),'latest':(g.get('latest') or {}).get('direction'),'lastReason':str((g.get('latest') or {}).get('reason',''))[:90],'error':str(g.get('error') or '')[:60],'feedAgeMs':round(now-float(g.get('observedAt') or 0)),'aiCalls':g.get('aiCallsCurrentRound')},ensure_ascii=False))
m=f.get('latest') or {}
print('MARKET',json.dumps({'ok':f.get('ok'),'symbol':f.get('symbol'),'ageMs':round(now-float(m.get('eventMs') or 0)),'roundMatches':int(m.get('roundStartMs') or 0)==int(now)//300000*300000}))
root=pathlib.Path('/var/lib/zl-prediction/rounds')
data={}
for k,fn in [('config','risk-control.json'),('runtime','risk-runtime-status.json'),('health','risk-worker-health.json')]:
 try:data[k]=json.loads((root/fn).read_text())
 except Exception as e: data[k]={};print('RISK_FILE_ERROR',k,type(e).__name__)
cfg,run,hl=data['config'],data['runtime'],data['health']
print('RISK',json.dumps({'fixedTP':cfg.get('takeProfitEnabled'),'fixedSL':cfg.get('stopLossEnabled'),'SLPercent':cfg.get('stopLossPercent'),'riskEnabled':run.get('enabled'),'workerRunning':run.get('workerRunning'),'configApplied':run.get('configApplied'),'dynamicExitEnabled':run.get('guardianDynamicExitEnabled'),'transitioning':run.get('transitioning'),'positionsSeen':hl.get('positionsSeen'),'riskTime':run.get('at'),'positionsTime':hl.get('lastSuccessfulPositionsAt')},ensure_ascii=False))
def age(v):
 try:
  ts=(v/1000 if v>1e11 else v) if isinstance(v,(int,float)) else datetime.datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()
  return round(now/1000-ts,1)
 except:return None
print('RISK_AGES_SEC',age(run.get('at')),age(hl.get('lastSuccessfulPositionsAt')))
for svc in ('zl-prediction-trade','zl-prediction-risk-exits','zl-prediction-guardian-analysis'):
 q=subprocess.run(['systemctl','is-active',svc],text=True,capture_output=True)
 print('SERVICE',svc,q.stdout.strip())
for name in ('wrapper.mjs','guardian-live-bridge.mjs','index.mjs','payment-source-priority.mjs'):
 p=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')/name
 if p.exists():
  t=p.read_text()
  print('LIVE_SOURCE',name,hashlib.sha256(t.encode()).hexdigest()[:16],int('GUARDIAN_RECHECK_V2' in t),int('takeProfitEnabled===true&&config.stopLossEnabled===true' in t))
# Examine trade-gate drift without printing any runtime secrets or entire source.
for name in ('wrapper.mjs','index.mjs'):
 try:
  src=(pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')/name).read_text()
  lines=src.splitlines()
  for keyword in ('guardianFixedReadiness','AUTO_CONFIRM_COOLDOWN_MS','GUARDIAN_RISK_OR_QUOTE_BLOCKED','guardianQuoteGate(current,quote'):
   loc=[i for i,line in enumerate(lines) if keyword in line]
   for i in loc[:2]:
    excerpt='\\n'.join(lines[max(0,i-4):min(len(lines),i+9)])
    print('GUARDIAN_RUNTIME_GATE_SOURCE',name,keyword,i+1,excerpt[:1150])
 except Exception as e:print('GUARDIAN_RUNTIME_GATE_READ_FAILED',name,type(e).__name__)
events=set('api_confirm_control api_intent_ready auto_submit_triggered guardian_quote_unexecutable guardian_signal_recheck_completed submit_blocked_signal_changed fresh_quote_failed fresh_quote_ready guardian_quote_capacity_recovery intent_prepare_failed api_order_submit_attempt order_submit_attempt_denied order_status_updated order_status_conflict_auto_halted order_retry_requote_failed prediction_wallet_quote_insufficient_spot_fallback prediction_wallet_insufficient_spot_unavailable order_submit_deadline_expired auto_confirm_failed api_order_submitted api_order_failed guardian_feed_unavailable'.split())
q=subprocess.Popen(['journalctl','-u','zl-prediction-trade','--since','8 hours ago','--no-pager','-o','json'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,errors='replace')
counts=collections.Counter();recent=[]
for line in q.stdout:
 try:
  envelope=json.loads(line);x=json.loads(envelope.get('MESSAGE','{}'));event=x.get('event')
  if event not in events:continue
  counts[event]+=1
  rec={'atChina':datetime.datetime.fromtimestamp(int(envelope.get('__REALTIME_TIMESTAMP','0'))/1000000,datetime.timezone(datetime.timedelta(hours=8))).isoformat()}
  rec.update({k:x[k] for k in ('event','round','code','httpStatus','source','retries','signalRecovered','signalIdMatches','state','blockReason','paymentAccount','quoteOk','candidateWei','configuredAmount','failureKind','marketTopicId','signal','productionSignal','amount','amountIn','quoteAttempts','reason','exchangeError') if k in x})
  if 'error' in x:rec['error']=str(x['error'])[:90]
  recent.append(rec)
  if len(recent)>80:recent.pop(0)
 except (ValueError,TypeError,AttributeError):continue
q.wait(timeout=12)
print('EVENT_COUNTS',json.dumps(counts,ensure_ascii=False,separators=(',',':')))
for row in recent:print('EVENT',json.dumps(row,ensure_ascii=False,separators=(',',':')))
import os,stat
service='zl-prediction-trade'
vals={}
for key in ('User','Group','MainPID','ProtectSystem','ReadWritePaths','StateDirectory','DynamicUser','RootDirectory'):
 x=subprocess.run(['systemctl','show',service,'--property='+key,'--value'],capture_output=True,text=True)
 vals[key]=x.stdout.strip()[:200]
print('SERVICE_SANDBOX',json.dumps(vals,ensure_ascii=False))
pid=vals.get('MainPID','0')
rootpath='/var/lib/zl-prediction/guardian5/guardian-live-orders.json'
# Read the actual deployed registry defaults. The previous hardcoded fallback
# incorrectly reported an OLD path even after deployment changed the source.
for module in ('guardian-live-bridge.mjs','guardian-risk-integration.mjs'):
 try:
  content=(pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')/module).read_text()
  match=re.search(r"(?:GUARDIAN_REGISTRY|REGISTRY)\s*=\s*process\.env\.GUARDIAN_REGISTRY_FILE\s*\|\|\s*['\"]([^'\"]+)",content)
  derived=match.group(1) if match else None
  print('REGISTRY_MODULE_DEFAULT',module,derived)
  if module=='guardian-live-bridge.mjs' and derived:rootpath=derived
 except Exception as e:print('REGISTRY_MODULE_READ_ERROR',module,type(e).__name__)
if pid.isdigit() and int(pid)>0:
 try:
  raw=pathlib.Path('/proc')/pid/'environ'
  for entry in raw.read_bytes().split(b'\0'):
   if entry.startswith(b'GUARDIAN_REGISTRY_FILE='):rootpath=entry.split(b'=',1)[1].decode('utf8','replace')[:200]
 except Exception as e:print('REGISTRY_ENV_READ_ERROR',type(e).__name__)
pfile=pathlib.Path(rootpath)
print('REGISTRY_PATH',rootpath)
for pp in (pfile,pfile.parent,pfile.parent.parent,pfile.parent.parent.parent):
 try:
  st=pp.stat()
  print('REGISTRY_PATH_STAT',str(pp),oct(stat.S_IMODE(st.st_mode)),st.st_uid,st.st_gid,'dir',pp.is_dir())
 except Exception as e:print('REGISTRY_PATH_STAT',str(pp),type(e).__name__)
u=vals.get('User') or 'root'
base=next((z for z in pfile.parents if z.exists()),None)
if base:
 cmd=['test','-w',str(base)]
 if u!='root':cmd=['runuser','-u',u,'--']+cmd
 v=subprocess.run(cmd,capture_output=True,text=True)
 print('REGISTRY_NEAREST_EXISTING_PARENT_WRITABLE',str(base),u,v.returncode==0)
 if pfile.parent.exists():
  cmd=['test','-w',str(pfile.parent)]
  if u!='root':cmd=['runuser','-u',u,'--']+cmd
  v=subprocess.run(cmd,capture_output=True,text=True)
  print('REGISTRY_PARENT_WRITABLE',u,v.returncode==0)
if pfile.exists():
 print('REGISTRY_FILE_EXISTS',True,'size',pfile.stat().st_size)
else:print('REGISTRY_FILE_EXISTS',False)
balance=s.get('balance') or {}
balances=[]
for x in balance.get('items') or []:
 if not isinstance(x,dict):continue
 try:sufficient=float(x.get('availableBalanceDisplay') or 0)>=float(s.get('amount') or 1)
 except:sufficient=None
 balances.append({'accountType':x.get('accountType'),'enabled':x.get('enabled'),'sufficientForConfiguredAmount':sufficient})
print('PAYMENT_OPTIONS',json.dumps({'ok':balance.get('ok'),'cached':balance.get('cached'),'cacheAgeMs':balance.get('cacheAgeMs'),'accounts':balances},separators=(',',':')))
env={}
if pid.isdigit() and int(pid)>0:
 try:
  for entry in (pathlib.Path('/proc')/pid/'environ').read_bytes().split(b'\0'):
   if b'=' not in entry:continue
   k,val=entry.split(b'=',1)
   if k in (b'AUTO_CONFIRM_ENABLED',b'AUTO_CONFIRM_STOP_ON_ERROR',b'AUTO_CONFIRM_MAX_ORDERS_PER_ROUND',b'MAX_ORDER_SUBMIT_ATTEMPTS',b'AUTO_CONFIRM_COOLDOWN_MS'):
    env[k.decode()]=val.decode('utf8','replace')[:50]
 except Exception as e:print('CONFIG_ENV_ERROR',type(e).__name__)
print('AUTO_CONFIG',json.dumps(env,separators=(',',':')))
print('READ_ONLY_AUDIT_FINISHED=true')
PY
"""
def main():
 if not os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID') or not os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET'): print('NO_AK');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 try:
  result=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='guardian-comprehensive-read-only',type='RunShellScript',command_content=SHELL,working_user='root',timeout=65))
  ident=result.body.invoke_id
  for _ in range(39):
   time.sleep(2)
   d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=ident)).body.invocation_result
   if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ClientNotRunning'):
    try:out=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
    except Exception:out='UNREADABLE'
    print('AUDIT_RESULT',d.invocation_status,d.exit_code)
    print(out[-12500:])
    return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'READ_ONLY_AUDIT_FINISHED=true' in out else 4
  print('AUDIT_TIMEOUT');return 5
 except Exception as e:
  print('AUDIT_API_ERROR',type(e).__name__,getattr(e,'code','') );return 6
if __name__=='__main__':sys.exit(main())

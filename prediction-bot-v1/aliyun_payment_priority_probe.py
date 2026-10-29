#!/usr/bin/env python3
"""Read-only SWAS prediction wallet-route deployment preflight."""
import os,base64,sys,time,json
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as o
REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
SH=r'''#!/bin/bash
set -u
echo PROBE_START
for svc in zl-prediction-trade zl-prediction-v2 zl-prediction-v3;do
 echo "SERVICE:$svc:$(systemctl is-active "$svc" 2>/dev/null || true)"
done
ROOT=/opt/zl-prediction-live/src
if [ -d "$ROOT/.git" ];then
 echo "REPO_PRESENT:yes"
 git -C "$ROOT" rev-parse --short HEAD 2>/dev/null | sed 's/^/SERVER_SHA:/'
else echo "REPO_PRESENT:no";fi
for file in railway-diagnostic/index.mjs railway-diagnostic/wrapper.mjs railway-diagnostic/payment-source-priority.mjs;do
 if [ -f "$ROOT/$file" ];then
   echo "FILE:$file:present"
   sha256sum "$ROOT/$file" | cut -d' ' -f1 | sed 's/^/CONTENT_SHA256:/'
   git hash-object "$ROOT/$file" | sed 's/^/GIT_BLOB_SHA:/'
 else echo "FILE:$file:missing";fi
done
python3 - <<'PY'
import json,urllib.request
for p in (13005,13004,13001):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d/api/status'%p,timeout=2) as response:
   d=json.load(response)
  print('PREDICTION_CONTROL_STATUS',json.dumps({'port':p,'ok':d.get('ok'),'enabled':d.get('enabled'),'pendingState':(d.get('pendingAction') or {}).get('state'),'lastOrderState':(d.get('lastOrder') or {}).get('state'),'autoConfirmEnabled':d.get('autoConfirmEnabled')},separators=(',',':')))
  break
 except Exception as e:print('PREDICTION_PORT_UNAVAILABLE',p,type(e).__name__)
PY
for p in 13005 13004 13001;do
 echo "HEALTHZ_PORT:$p:$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:$p/healthz || true)"
done
echo "TRADE_SERVICE_RECENT_FAILURES_BEGIN"
journalctl -u zl-prediction-trade --since '18 minutes ago' --no-pager -o cat 2>/dev/null | python3 -c 'import re,sys
rows=[]
for line in sys.stdin:
 if re.search(r"Error|ERR_|Cannot find|failed|exit|missing|SyntaxError|MODULE_NOT_FOUND|EACCES|address already|ECONNREFUSED",line,re.I):
  line=re.sub(r"(?i)(key|token|password|secret)[=:]\\s*\\S+",r"\\1=[REDACTED]",line.strip()[:210])
  rows.append(line)
print("\\n".join(rows[-17:]))' || true
echo "TRADE_SERVICE_RECENT_FAILURES_END"
python3 - <<'PY'
import subprocess
r=subprocess.run(['runuser','-u','zl-pred','--','journalctl','-u','zl-prediction-trade','--since','2 minutes ago','-n','1','-o','json','--no-pager'],capture_output=True,text=True,timeout=10)
print('ZL_PRED_JOURNAL_ACCESS',r.returncode==0 and bool(r.stdout.strip()),'rc',r.returncode,'rows',len(r.stdout.splitlines()))
PY
echo GUARDIAN_INCIDENT_AUDIT_BEGIN
python3 - <<'PY'
import json,subprocess,datetime,re
tz=datetime.timezone(datetime.timedelta(hours=8))
start='2026-10-29 14:05:00 UTC'; end='2026-10-29 14:25:00 UTC'
proc=subprocess.run(['journalctl','-u','zl-prediction-trade','--since',start,'--until',end,'-o','json','--no-pager'],capture_output=True,text=True,timeout=15)
watch={'api_confirm_control','api_intent_ready','auto_submit_triggered','fresh_quote_failed','prediction_wallet_quote_insufficient_spot_fallback','prediction_wallet_insufficient_spot_unavailable','fresh_quote_ready','order_post_attempt','order_submit_attempt','order_confirmed','order_submission_unknown','submit_blocked_signal_changed','auto_confirm_failed','guardian_signal_locked','order_submit_blocked'}
events=[]
for raw in proc.stdout.splitlines():
 try:
  j=json.loads(raw); m=json.loads(j.get('MESSAGE',''))
  if not isinstance(m,dict) or m.get('event') not in watch:continue
  timestamp=int(j['__REALTIME_TIMESTAMP'])/1000000
  local=datetime.datetime.fromtimestamp(timestamp,tz)
  rd=m.get('round')
  fields={k:m[k] for k in ('enabled','round','productionSignal','orderSignal','mappingMode','code','httpStatus','state','source','reason','paymentAccount','spotQuoteOk','orderSignalModel') if k in m and isinstance(m[k],(str,int,float,bool))}
  fields={k:(str(v)[:80] if isinstance(v,str) else v) for k,v in fields.items()}
  events.append((local, m['event'], fields))
 except (ValueError,TypeError,KeyError,OverflowError):continue
print('AUDIT_JOURNAL_RETURN',proc.returncode)
for a,b in [('22:10','22:15'),('22:15','22:20')]:
 lo=datetime.datetime.fromisoformat('2026-10-29T'+a+':00').replace(tzinfo=tz)
 hi=datetime.datetime.fromisoformat('2026-10-29T'+b+':00').replace(tzinfo=tz)
 rows=[(t,ev,fields) for t,ev,fields in events if lo<=t<hi]
 print('AUDIT_WINDOW',a,b,'matched_events',len(rows))
 for t,ev,fields in rows[-30:]:print('AUDIT_EVENT',t.isoformat(timespec='seconds'),ev,json.dumps(fields,ensure_ascii=False,separators=(',',':')))
print('GUARDIAN_INCIDENT_AUDIT_END')
PY
echo GUARDIAN_RECENT_TRADE_DIAGNOSTIC_BEGIN
python3 - <<'PY'
import json,subprocess,datetime,urllib.request,re
tz=datetime.timezone(datetime.timedelta(hours=8))
try:
 with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=4) as r:s=json.load(r)
 p=s.get('pendingAction') or {}; last=s.get('lastOrder') or {}
 print('TRADE_13001_STATUS',json.dumps({'ok':s.get('ok'),'enabled':s.get('enabled'),'model':s.get('orderSignalModel'),'pending':{k:p.get(k) for k in ('round','state','error','code','paymentAccount','blockReason')},'last':{k:last.get(k) for k in ('round','state','error','code','paymentAccount','blockReason')}},ensure_ascii=False,default=str)[:1200])
except Exception as e:print('TRADE_13001_STATUS_ERROR',type(e).__name__)
cmd=['journalctl','-u','zl-prediction-trade','--since','2 hours ago','-n','8000','-o','json','--no-pager']
p=subprocess.run(cmd,capture_output=True,text=True,timeout=18)
selected=[]
watch={'api_confirm_control','api_intent_ready','auto_submit_triggered','fresh_quote_failed','fresh_quote_ready','prediction_wallet_quote_insufficient_spot_fallback','prediction_wallet_insufficient_spot_unavailable','prediction_wallet_insufficient_spot_fallback','order_retry_requote_failed','order_post_attempt','order_submit_attempt','order_confirmed','order_submission_unknown','order_submit_result','order_confirmed_filled','order_retry_rejected','order_failed','auto_confirm_failed','api_order_submitted','api_order_failed'}
for line in p.stdout.splitlines():
 try:
  obj=json.loads(line); raw=obj.get('MESSAGE','');m=json.loads(raw)
  if not isinstance(m,dict):continue
  ev=m.get('event','')
  if ev not in watch and not ('liquidity' in str(m.get('error','')).lower() or str(m.get('code',''))=='-9000'):continue
  ts=datetime.datetime.fromtimestamp(int(obj['__REALTIME_TIMESTAMP'])/1e6,tz).isoformat(timespec='seconds')
  data={}
  for k in ('round','state','productionSignal','orderSignal','mappingMode','code','httpStatus','source','spotQuoteOk','paymentAccount','reason','error','amount','attempt','attempts','status'):
   if k in m and isinstance(m[k],(str,int,float,bool)):
    v=m[k]
    if isinstance(v,str):v=re.sub(r'(?i)(api.?key|secret|token|password)[=:][^\s,]+',r'\1=[REDACTED]',v)[:150]
    data[k]=v
  selected.append((ts,ev,data))
 except (ValueError,KeyError,TypeError,OverflowError):continue
print('RECENT_JOURNAL_OK',p.returncode==0,'matches',len(selected))
for ts,ev,data in selected[-35:]:
 print('RECENT_TRADE_EVENT',ts,ev,json.dumps(data,ensure_ascii=False,separators=(',',':')))
print('GUARDIAN_RECENT_TRADE_DIAGNOSTIC_END')
PY
echo GUARDIAN_2320_AUDIT_BEGIN
python3 - <<'PY'
import subprocess,json,datetime,urllib.request
tz=datetime.timezone(datetime.timedelta(hours=8))
lo=datetime.datetime(2026,10,29,23,19,tzinfo=tz)
hi=datetime.datetime(2026,10,29,23,26,tzinfo=tz)
roundms=1793287200000
wanted=('event','round','currentRound','currentDirection','currentStatus','state','enabled','amount','productionSignal','orderSignal','mappingMode','signal','direction','rawDirection','source','code','httpStatus','error','reason','blockReason','spotQuoteOk','accountType','paymentAccount','attempt','attempts','orderId','orderStatus','quoteRemainingMs','signalGeneratedAt','autoConfirmEnabled')
for unit in ('zl-prediction-trade','zl-prediction-guardian-analysis'):
 p=subprocess.run(['journalctl','-u',unit,'--since','2026-10-29 15:19:00 UTC','--until','2026-10-29 15:27:00 UTC','-o','json','--no-pager'],capture_output=True,text=True,timeout=18)
 out=[]
 for line in p.stdout.splitlines():
  try:
   obj=json.loads(line);at=datetime.datetime.fromtimestamp(int(obj['__REALTIME_TIMESTAMP'])/1e6,tz)
   if not lo<=at<hi:continue
   m=json.loads(obj.get('MESSAGE',''))
   if not isinstance(m,dict) or not m.get('event') or str(m.get('event')).startswith(('stats_','market_','feed_','heartbeat_','poll_')):continue
   fields={k:m[k] for k in wanted if k in m and isinstance(m[k],(str,int,float,bool))}
   for k,v in list(fields.items()):
    if k=='orderId': fields[k]='PRESENT' if v else None
    elif k=='error' or k=='reason' or k=='blockReason': fields[k]=str(v)[:120]
    elif isinstance(v,str):fields[k]=v[:100]
   out.append((at.isoformat(timespec='seconds'),fields))
  except (ValueError,KeyError,TypeError,OverflowError):continue
 print('TARGET_UNIT',unit,'journal_ok',p.returncode==0,'events',len(out))
 for at,fields in out[-75:]:print('TARGET_EVENT',at,json.dumps(fields,ensure_ascii=False,separators=(',',':')))
for port in (13001,13005,13049):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d/api/status'%port,timeout=5) as r:s=json.load(r)
  pending=s.get('pendingAction') or {}; last=s.get('lastOrder') or {}
  records=s.get('records') or []
  matched=[{k:x.get(k) for k in ('round','at','predictedDirection','status','subjectiveConfidence')} for x in records if isinstance(x,dict) and x.get('round')==roundms]
  msg={'port':port,'ok':s.get('ok'),'enabled':s.get('enabled'),'model':s.get('orderSignalModel') or s.get('model'),
    'round':s.get('round'),'latestDirection':(s.get('latest') or {}).get('direction'),'latestReason':str((s.get('latest') or {}).get('reason',''))[:110],
    'pending':{k:pending.get(k) for k in ('round','state','code','error','blockReason','paymentAccount')},
    'last':{k:last.get(k) for k in ('round','state','code','error','blockReason','paymentAccount')},
    'targetRecords':matched[:4]}
  print('TARGET_API',json.dumps(msg,ensure_ascii=False,default=str))
 except Exception as e:print('TARGET_API_ERROR',port,type(e).__name__)
print('GUARDIAN_2320_AUDIT_END')
PY
echo PROBE_END
'''
def main():
 if not os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID") or not os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET"):
  print("ALICLOUD_CREDENTIALS_UNAVAILABLE");return 2
 c=Client(o.Config(access_key_id=os.environ["ALIBABA_CLOUD_ACCESS_KEY_ID"],access_key_secret=os.environ["ALIBABA_CLOUD_ACCESS_KEY_SECRET"],endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
 try:
  r=c.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name="zl-payment-priority-readonly-probe",type="RunShellScript",command_content=SH,working_user="root",timeout=70))
  if not r.body.invoke_id:print("NO_INVOKE_ID");return 3
  for _ in range(35):
   time.sleep(2)
   x=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=r.body.invoke_id)).body.invocation_result
   if x and str(x.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout","ClientNotRunning"):
    output=x.output or ""
    try:output=base64.b64decode(output,validate=True).decode("utf8","replace")
    except Exception:pass
    print("PROBE_STATUS",x.invocation_status,"EXIT",x.exit_code)
    print(output[-6000:])
    return 0 if str(x.invocation_status)=="Success" and int(x.exit_code)==0 else 4
  print("PROBE_PENDING");return 5
 except Exception as e:print("PROBE_ERROR",type(e).__name__,str(getattr(e,'code','unknown'))[:80]);return 6
if __name__=="__main__":sys.exit(main())

#!/usr/bin/env python3
"""Read-only diagnostics of isolated Alibaba prediction components (no secrets)."""
import os,base64,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as s
from alibabacloud_tea_openapi import models as o
cl=Client(o.Config(access_key_id=os.environ["ALIBABA_CLOUD_ACCESS_KEY_ID"],access_key_secret=os.environ["ALIBABA_CLOUD_ACCESS_KEY_SECRET"],endpoint="swas.ap-southeast-1.aliyuncs.com",region_id="ap-southeast-1"))
script=r"""#!/bin/bash
set -Eeuo pipefail
echo "HEALTH_MEM_AVAILABLE=$(free -m | awk '/Mem:/{print $7}')"
for n in zl-futures-bot-paper zl-prediction-redis zl-prediction-v3 zl-prediction-v2 zl-prediction-trade;do
  echo "HEALTH_SERVICE_$n=$(systemctl is-active "$n" || true)"
  echo "HEALTH_RESULT_$n=$(systemctl show "$n" --property=Result --value 2>/dev/null || true)"
  echo "HEALTH_EXIT_$n=$(systemctl show "$n" --property=ExecMainStatus --value 2>/dev/null || true)"
done
for port in 13001 13002 13003 13004 13005;do
 echo "HEALTH_HTTP_$port=$(curl -s --max-time 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:$port/healthz || true)"
done
echo "AUDIT_TIME_UTC=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "AUDIT_UPTIME=$(uptime -p)"
echo "AUDIT_SWAP_MB=$(free -m | awk '/Swap:/{print $2}')"
echo "AUDIT_DISK_USED=$(df -h / | awk 'NR==2{print $5}')"
for name in zl-prediction-trade zl-prediction-v2 zl-prediction-v3 zl-exchange-api-manager zl-futures-bot-paper;do
  echo "AUDIT_RESTARTS_$name=$(systemctl show "$name" --property=NRestarts --value)"
  echo "AUDIT_MEMORY_CURRENT_$name=$(systemctl show "$name" --property=MemoryCurrent --value)"
  echo "AUDIT_MEMORY_MAX_$name=$(systemctl show "$name" --property=MemoryMax --value)"
  echo "AUDIT_MAINPID_$name=$(systemctl show "$name" --property=MainPID --value)"
done
for port in 10000 13001 13002 13003 13004 13005 13016;do
  echo "AUDIT_PORT_$port=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:$port/healthz" || true)"
done
journalctl --no-pager -k --since '3 hours ago' -o cat 2>/dev/null |
  python3 -c 'import sys,re; s=[x for x in sys.stdin if re.search(r"Out of memory|Killed process|oom-kill|memory cgroup",x,re.I)];print("AUDIT_KERNEL_OOM_EVENTS",len(s))' || true
for service in zl-prediction-trade zl-prediction-v2 zl-prediction-v3;do
  journalctl --no-pager -u "$service" --since '3 hours ago' -o cat 2>/dev/null |
    python3 -c 'import sys,re,collections;lines=sys.stdin.read().splitlines();rules={"heap_failure":r"heap out of memory|Allocation failed|ENOMEM|Mark-Compact|FATAL ERROR","runtime_exception":r"uncaughtException|uncaught exception|TypeError:|ReferenceError:|SyntaxError:","network_failure":r"ECONNREFUSED|ETIMEDOUT|EADDRINUSE|ERR_CONNECTION","process_exit":r"exited|SIGKILL|SIGTERM","redis_error":r"WRONGPASS|NOAUTH|Redis.*Error"};print("AUDIT_JOURNAL_TYPES",len(lines),{k:sum(bool(re.search(p,x,re.I)) for x in lines) for k,p in rules.items()})' || true
done
echo "AUDIT_EVENT_SUMMARY_BEGIN"
journalctl --no-pager -u zl-prediction-trade --since '3 hours ago' -o cat |
  python3 -c '
import sys,json,collections
count=collections.Counter()
events=[]
errors=[]
for line in sys.stdin:
 try:
  o=json.loads(line)
 except Exception:continue
 if not isinstance(o,dict):continue
 kind=str(o.get("event",""))
 if not kind:continue
 count[kind]+=1
 if kind.endswith("_exited") or "start" in kind or "failed" in kind or "error" in kind:
  events.append((str(o.get("at",o.get("ts","unknown")))[0:28],kind,str(o.get("code",""))[:10],str(o.get("signal",""))[:15]))
print("AUDIT_EVENT_COUNTS",count.most_common(20))
print("AUDIT_RECENT_PROCESS_EVENTS",events[-30:])
' || true
echo "AUDIT_EVENT_SUMMARY_END"
echo "EDGE_SETTLEMENT_SOURCE_AUDIT_BEGIN"
python3 - <<'PY'
import json,time,datetime,urllib.request,urllib.error
urls={
 'EDGE_WORKER':'https://edge-5m-v1.zl528094-3ba.workers.dev/status',
 'RENDER_V2':'https://zl-signal-v2-migration.onrender.com/api/round-stats',
 'ALIYUN_V2':'http://127.0.0.1:13002/api/round-stats',
 'ALIYUN_EDGE_PROXY':'http://127.0.0.1:13001/api/shadow-breakout20/edge-5m',
}
observations={}
def utc(v):
 try:
  n=float(v)
  if n<1e9:return str(v)
  if n>1e11:n/=1000
  return datetime.datetime.fromtimestamp(n,datetime.timezone.utc).isoformat(timespec='minutes')
 except:return "invalid"
for label,url in urls.items():
 try:
  req=urllib.request.Request(url,headers={'Accept':'application/json','User-Agent':'zl-edge-resolution-audit/1.0'})
  with urllib.request.urlopen(req,timeout=16) as response:
   status=response.status
   data=json.loads(response.read(2_500_000))
  out={'http':status,'ok':data.get('ok') if isinstance(data,dict) else None}
  if label in ('EDGE_WORKER','ALIYUN_EDGE_PROXY'):
   recent=data.get('recent',[]) if isinstance(data,dict) else []
   results=data.get('results',{}) if isinstance(data,dict) else {}
   health=data.get('health',{}) if isinstance(data,dict) else {}
   out.update({'model':data.get('model'),'statsScope':data.get('statsScope'),
    'results':{x:results.get(x) for x in ('pending','locked','observedRounds','overall','up','down')},
    'health':{str(k):str(v)[:170] for k,v in health.items() if not any(z in str(k).lower() for z in ['secret','token','password','key','auth','url','address'])},
    'last_twelve':[{'round':x.get('round'),'roundUtc':utc(x.get('round')),'actual':x.get('actual'),'direction':x.get('direction'),
      'pendingReason':str(x.get('pendingReason') or '')[:90],'officialStatus':str(x.get('officialStatus') or '')[:55]}
      for x in recent[:12] if isinstance(x,dict)]})
   observations[label]=recent
  else:
   records=data.get('records',[]) if isinstance(data,dict) else []
   out.update({'totalRecordCount':len(records),'settlementSource':data.get('settlementSource'),
     'summary':{k:data.get('summary',{}).get(k) for k in ('settled','pending','samples','hits')},
     'latestRecords':[{'round':x.get('roundStartMs'),'roundUtc':utc(x.get('roundStartMs')),
      'officialDirection':x.get('officialDirection'),'actual':x.get('actual'),
      'resolutionEvidence':str(x.get('resolutionEvidence') or '')[:95],
      'settledAt':utc(x.get('officialSettledAt') or x.get('settledAt') or 0)}
      for x in records[:15] if isinstance(x,dict)]})
   observations[label]=records
  print("EDGE_AUDIT",label,json.dumps(out,ensure_ascii=False,default=str)[:6500])
 except urllib.error.HTTPError as e:
  print("EDGE_AUDIT",label,json.dumps({'http':e.code,'error':'HTTP_FAILURE'}))
 except Exception as e:
  print("EDGE_AUDIT",label,json.dumps({'error':type(e).__name__,'description':str(e)[:85]}))
edge=observations.get('EDGE_WORKER') or []
for source in ('RENDER_V2','ALIYUN_V2'):
 rows=observations.get(source) or []
 m={}
 for row in rows:
  if isinstance(row,dict):
   try:m[int(row.get('roundStartMs'))]=row
   except:pass
 paired=[]
 for x in edge[:30]:
  if not isinstance(x,dict):continue
  try:rr=int(x.get('round'))
  except:continue
  if rr in m:
   y=m[rr]
   paired.append({'roundUtc':utc(rr),'edgeActual':x.get('actual'),
    'sourceOfficial':y.get('officialDirection'),'sourceActual':y.get('actual'),
    'sourceEvidence':str(y.get('resolutionEvidence') or '')[:70]})
 print('EDGE_AUDIT_MATCH',source,json.dumps({'edgeWindow':len(edge[:30]),'sourceRows':len(rows),
  'matchedRounds':len(paired),'matched':paired[:12]},ensure_ascii=False))
PY
echo "EDGE_SETTLEMENT_SOURCE_AUDIT_END"
echo "HEALTH_LOG_TRADE_ERROR_TYPES_BEGIN"
journalctl -u zl-prediction-trade.service --no-pager --since '30 minutes ago' -o cat 2>/dev/null | python3 -c 'import re,sys;lines=[x.strip() for x in sys.stdin if re.search(r"Error:|ERR_|EACCES|ENOENT|Failed|denied|status=|signal=",x,re.I)];print("\n".join(re.sub(r"(?i)(token|secret|password|key)\s*[:=]\s*\S+",r"\1=[REDACTED]",x[:180]) for x in lines[-20:]))' || true
echo "HEALTH_LOG_TRADE_ERROR_TYPES_END"
"""
req=cl.run_command(s.RunCommandRequest(region_id="ap-southeast-1",instance_id="b67374069bb3457ba6a3a2ede9305d3f",name="zl-prediction-runtime-health",type="RunShellScript",command_content=script,working_user="root",timeout=75))
iid=req.body.invoke_id
for _ in range(25):
 time.sleep(2)
 r=cl.describe_invocation_result(s.DescribeInvocationResultRequest(region_id="ap-southeast-1",instance_id="b67374069bb3457ba6a3a2ede9305d3f",invoke_id=iid)).body.invocation_result
 if r and str(r.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout"):
  raw=r.output or ""
  try:raw=base64.b64decode(raw,validate=True).decode("utf8","replace")
  except:pass
  print("DIAGNOSTIC_RESULT",str(r.invocation_status),r.exit_code)
  print(raw[-7000:])
  break

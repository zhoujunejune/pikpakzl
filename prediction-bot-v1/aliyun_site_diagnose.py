#!/usr/bin/env python3
"""Diagnose HTTPS/Caddy/prediction availability without reading credentials."""
import base64,os,time,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REGION="ap-southeast-1"; INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
SCRIPT=r'''#!/bin/bash
set -Eeuo pipefail
echo "SITE_AUDIT_UTC=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "SITE_AUDIT_IPS=$(hostname -I | awk '{print $1}')"
echo "SITE_AUDIT_MEMORY_MB=$(free -m | awk '/Mem:/{print $7}')"
echo "SITE_AUDIT_DISK=$(df -h / | awk 'NR==2{print $5}')"
for service in caddy zl-prediction-trade zl-prediction-v2 zl-prediction-v3 zl-prediction-native-models zl-prediction-redis zl-exchange-api-manager zl-futures-bot-paper;do
 echo "SITE_SERVICE_$service=$(systemctl is-active "$service" || true)"
 echo "SITE_RESTARTS_$service=$(systemctl show "$service" -p NRestarts --value || true)"
 echo "SITE_MAINEXIT_$service=$(systemctl show "$service" -p ExecMainStatus --value || true)"
done
if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1;then echo SITE_CADDY_VALID=true;else echo SITE_CADDY_VALID=false;fi
for port in 80 443 10000 13001 13002 13003 13007 13016;do
  if ss -ltn "( sport = :$port )" | grep -q LISTEN;then echo "SITE_PORT_$port=LISTEN";else echo "SITE_PORT_$port=CLOSED";fi
done
for port in 10000 13001 13002 13003 13007 13016;do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$port/healthz || true)
  echo "SITE_LOCAL_HEALTH_$port=$code"
done
for host in 47-237-188-69.sslip.io prediction.47-237-188-69.sslip.io;do
 code=$(curl -sk --resolve "$host:443:127.0.0.1" -o /dev/null -w '%{http_code}' --max-time 9 "https://$host/" || true)
 echo "SITE_LOCAL_TLS_NO_AUTH_$host=$code"
 # DNS/IP check without exposing any login details.
 echo "SITE_RESOLVE_$host=$(getent ahostsv4 "$host" | awk 'NR==1{print $1}')"
done
echo "SITE_CADDY_RECENT_EVENTS_BEGIN"
journalctl -u caddy --since '90 minutes ago' --no-pager -o cat 2>/dev/null |
  python3 -c 'import sys,re,collections
rows=sys.stdin.read().splitlines()
patterns={"tls_error":r"tls.*(error|failed)|certificate.*(error|failed)","reverse_proxy_error":r"reverse_proxy|dial tcp|connect: connection refused|upstream.*(error|failed)","parse_error":r"parsing caddyfile|unrecognized directive|invalid configuration|adapting config","permission":r"permission denied|EACCES","bind":r"address already in use","restart":r"serving initial configuration|reload|stop","acme":r"acme|challenge"}
print("SITE_CADDY_LOG_EVENT_COUNT",len(rows))
print("SITE_CADDY_LOG_PATTERN_COUNTS",dict((k,sum(bool(re.search(p,x,re.I)) for x in rows)) for k,p in patterns.items()))
'
echo "SITE_PRED_RECENT_EVENT_TYPES_BEGIN"
journalctl -u zl-prediction-trade --since '90 minutes ago' --no-pager -o cat 2>/dev/null |
  python3 -c 'import sys,re
rows=sys.stdin.read().splitlines()
patterns={"node_error":r"Error:|SyntaxError|ERR_|FATAL ERROR","exited":r"exited|SIGTERM|SIGKILL","oom":r"out of memory|heap out of memory|oom","connection":r"ECONNREFUSED|ETIMEDOUT","started":r"started|listening"}
print("SITE_PRED_LOG_EVENT_COUNT",len(rows))
print("SITE_PRED_LOG_PATTERN_COUNTS",dict((k,sum(bool(re.search(p,x,re.I)) for x in rows)) for k,p in patterns.items()))'
echo "SITE_DEEP_SERVICE_PROPERTIES_BEGIN"
systemctl show zl-prediction-trade.service -p Result -p NRestarts -p Restart -p RestartUSec -p ExecMainStatus -p ExecMainCode -p ActiveEnterTimestamp -p StateChangeTimestamp -p MemoryCurrent -p MemoryPeak --no-pager | sed 's/^/SITE_TRADE_UNIT_/'
echo "SITE_DEEP_RECENT_EXIT_CAUSES"
journalctl -u zl-prediction-trade --since '90 minutes ago' --no-pager -o cat 2>/dev/null |
 python3 -c '
import sys,re,collections,json
rows=sys.stdin.read().splitlines()
pat={
  "node_fatal":r"FATAL ERROR|heap out of memory|Allocation failed",
  "node_exception":r"SyntaxError|TypeError|ReferenceError|uncaughtException|unhandledRejection",
  "exit_status":r"Main process exited|Failed with result|Scheduled restart job",
  "child_exit":r"worker.*exited|child.*exited|exit.*code|exit.*signal",
  "network_error":r"ECONNRESET|ECONNREFUSED|EADDRINUSE|ETIMEDOUT|socket hang up",
  "signal_term":r"SIGTERM|SIGKILL|SIGABRT",
  "file_error":r"ENOENT|EACCES|EMFILE",
  "process_restart":r"Started .*zl-prediction|Starting .*zl-prediction"
}
for name,p in pat.items():
 matches=[row for row in rows if re.search(p,row,re.I)]
 print("SITE_TRADE_CAUSE",name,len(matches))
 for row in matches[-4:]:
  found=re.search(p,row,re.I)
  msg=found.group(0) if found else name
  start=re.search(r"20[0-9][0-9]-[01][0-9]-[0-3][0-9][T ][0-2][0-9]:[0-5][0-9]:[0-5][0-9]",row)
  print("SITE_TRADE_CAUSE_SAMPLE",name,start.group(0) if start else "no-timestamp",msg)
'
echo "SITE_DEEP_CADDY_UPSTREAM_CAUSES"
journalctl -u caddy --since '90 minutes ago' --no-pager -o cat 2>/dev/null |
 python3 -c '
import sys,re,json,collections
m=collections.Counter()
ex=[]
for row in sys.stdin:
 if not re.search(r"reverse_proxy|dial tcp|connect: connection refused|upstream|EOF|502|503",row,re.I):continue
 try:
  d=json.loads(row)
  err=str(d.get("err") or d.get("error") or d.get("msg") or "")
  ts=str(d.get("ts") or "")
 except Exception: err=row;ts=""
 if "connection refused" in err.lower(): typ="connection_refused"
 elif "deadline exceeded" in err.lower() or "timeout" in err.lower():typ="timeout"
 elif "EOF" in err:typ="EOF"
 elif "reset by peer" in err:typ="connection_reset"
 elif "dial tcp" in err:typ="dial_tcp_other"
 elif "reverse_proxy" in err:typ="proxy_other"
 else:typ="other"
 m[typ]+=1
 port=re.search(r"127\.0\.0\.1:(\d+)",err)
 ex.append((ts[:20],typ,port.group(1) if port else "unknown-port"))
print("SITE_CADDY_UPSTREAM_CAUSES",dict(m))
print("SITE_CADDY_UPSTREAM_RECENT",ex[-16:])
'
echo "SITE_DEEP_PRED_ROUTE_CONFIGURATION"
if test -f /etc/caddy/Caddyfile; then
 python3 - <<'PY'
import pathlib,re
s=pathlib.Path("/etc/caddy/Caddyfile").read_text()
for host in ["47-237-188-69.sslip.io","prediction.47-237-188-69.sslip.io"]:
 pos=s.find(host)
 sec=s[max(0,pos):pos+650] if pos>=0 else ""
 matches=re.findall(r"reverse_proxy\s+(?:127\.0\.0\.1|localhost):(\d+)",sec)
 print("SITE_ROUTED_UPSTREAM",host,matches)
PY
fi
echo "SITE_DEEP_AUDIT_COMPLETE"
echo "SITE_NODE_TYPEERROR_DETAILS_BEGIN"
journalctl -u zl-prediction-trade --since '90 minutes ago' --no-pager -o cat 2>/dev/null |
python3 -c '
import sys,re,collections
rows=sys.stdin.read().splitlines()
errors=collections.Counter()
stacks=collections.Counter()
for index,line in enumerate(rows):
 if "TypeError:" not in line:continue
 raw=line.split("TypeError:",1)[1].strip()
 raw=re.sub(r"https?://\S+","[URL]",raw)
 raw=re.sub(r"(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*\S+",r"\1=[MASKED]",raw)
 raw=re.sub(r"[A-Za-z0-9_\-]{48,}","[LONG_VALUE_MASKED]",raw)
 errors[raw[:170]]+=1
 for nxt in rows[index+1:index+5]:
  m=re.search(r"at (?:[^\s]+ )?\(?((?:file://)?/opt/[\w/.\-]+:\d+:\d+)\)?",nxt)
  if m:stacks[m.group(1)]+=1
print("SITE_NODE_TYPEERROR_VARIANTS",errors.most_common(12))
print("SITE_NODE_STACK_LOCATIONS",stacks.most_common(12))
'
echo "SITE_NODE_TYPEERROR_DETAILS_END"
echo "SITE_RUNTIME_955_INSPECT_BEGIN"
python3 - <<'PY'
from pathlib import Path
import re
p=Path("/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs")
if not p.exists():
 print("SITE_RUNTIME_SOURCE_EXISTS=false")
else:
 lines=p.read_text(errors="replace").splitlines()
 print("SITE_RUNTIME_SOURCE_EXISTS=true")
 print("SITE_RUNTIME_SOURCE_LENGTH",len(lines))
 for n in range(947,964):
  if n>len(lines):continue
  line=lines[n-1].strip()
  line=re.sub(r"(?i)(password|token|secret|api[_-]?key)\s*[:=]\s*[^,;}]+",r"\1=[MASKED]",line)
  line=re.sub(r"(?i)(https?://)[^\s'\"]+",r"\1[URL]",line)
  line=re.sub(r"([\"'])([^\"']{36,})\1",r"\1[LONG_LITERAL_MASKED]\1",line)
  print("SITE_RUNTIME_SOURCE_LINE",n,line[:220])
PY
echo "SITE_RUNTIME_955_INSPECT_END"
echo "FOLLOW_GATE_AUDIT_BEGIN"
python3 - <<'PY'
import os,json,hashlib,subprocess
from pathlib import Path
from urllib.request import urlopen
KEYS=('ZL_OUTER_AUTH_ONLY','ZL_PUBLIC_ORIGIN','RENDER_TRADING_USER_ARMED','RENDER_MIGRATION_PREVIEW','AUTO_CONFIRM_ENABLED','AUTO_ORDER_DISABLED')
def safe_env(lines):
 d={}
 for line in lines:
  if '=' not in line:continue
  key,val=line.split('=',1)
  if key in KEYS:d[key]=val.strip().strip('"').strip("'")
 return d
def printable(d):
 return {k:(v if k!='ZL_PUBLIC_ORIGIN' else ('EXPECTED_ORIGIN' if v=='https://prediction.47-237-188-69.sslip.io' else 'NONMATCH_ORIGIN')) for k,v in d.items()}
conf=Path('/etc/zl-prediction/panel.env')
file_env=safe_env(conf.read_text().splitlines()) if conf.exists() else {}
print('FOLLOW_PANEL_ENV',json.dumps(printable(file_env),sort_keys=True))
try:
 pid=int(subprocess.check_output(['systemctl','show','zl-prediction-trade.service','-p','MainPID','--value'],text=True).strip())
 p=Path('/proc')/str(pid)/'environ'
 proc_env=safe_env(p.read_bytes().decode('utf8','replace').split('\0')) if pid>1 and p.exists() else {}
 print('FOLLOW_MAINPID_RUNNING',pid>1)
 print('FOLLOW_PROCESS_ENV',json.dumps(printable(proc_env),sort_keys=True))
 d=proc_env or file_env
 print('FOLLOW_GATE_COMPUTED_ALLOW',bool(
  (d.get('ZL_OUTER_AUTH_ONLY')=='true' and d.get('ZL_PUBLIC_ORIGIN')=='https://prediction.47-237-188-69.sslip.io')
  or d.get('RENDER_TRADING_USER_ARMED')=='true'))
except Exception as exc:print('FOLLOW_PROCESS_AUDIT_ERROR',type(exc).__name__)
root=Path('/opt/zl-prediction-live/src/railway-diagnostic')
for name in ('index.mjs','wrapper.mjs','panel-stats-shell.mjs','trade-control-fixed.mjs'):
 p=root/name
 if p.exists():
  src=p.read_bytes()
  print('FOLLOW_SOURCE',name,'sha256_12',hashlib.sha256(src).hexdigest()[:12],
   'bytes',len(src),'has_deployment_gate',b'deploymentAllowsLiveFollowing' in src)
 else:print('FOLLOW_SOURCE',name,'ABSENT')
for path in ('/api/status','/api/order-signal-model','/healthz'):
 try:
  with urlopen('http://127.0.0.1:13001'+path,timeout=8) as resp:j=json.load(resp)
  keys=('ok','enabled','autoConfirmEnabled','autoConfirmHalted','model','ready','status','signalStatus','source')
  print('FOLLOW_ENDPOINT',path,json.dumps({k:j.get(k) for k in keys if k in j},ensure_ascii=False))
 except Exception as exc:print('FOLLOW_ENDPOINT_ERROR',path,type(exc).__name__)
PY
echo "FOLLOW_GATE_AUDIT_END"
echo "SITE_AUDIT_END"
'''
def main():
    k=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID");v=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
    if not k or not v:print("SITE_AUDIT_MISSING_AUTH");return 2
    client=Client(api.Config(access_key_id=k,access_key_secret=v,endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
    try:
        job=client.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
          name="zl-site-availability-diag",type="RunShellScript",command_content=SCRIPT,working_user="root",timeout=130))
        for _ in range(42):
            time.sleep(3)
            obj=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=job.body.invoke_id)).body.invocation_result
            if not obj:continue
            status=str(obj.invocation_status)
            if status in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
                raw=obj.output or ""
                try:raw=base64.b64decode(raw,validate=True).decode("utf8","replace")
                except:pass
                print("SITE_AUDIT_RESULT",status,obj.exit_code)
                print(raw[-13500:])
                return 0 if status=="Success" and int(obj.exit_code)==0 else 4
    except Exception as e:print("SITE_AUDIT_CALL_FAILED",type(e).__name__);return 3
    print("SITE_AUDIT_NO_RESPONSE");return 5
if __name__=="__main__":sys.exit(main())

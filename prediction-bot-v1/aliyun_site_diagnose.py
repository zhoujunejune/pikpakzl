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

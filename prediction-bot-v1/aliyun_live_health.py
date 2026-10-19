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

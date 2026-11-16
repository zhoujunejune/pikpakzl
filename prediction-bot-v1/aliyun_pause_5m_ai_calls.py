#!/usr/bin/env python3
"""Pause ONLY external LLM calls for BTC 5m prediction, preserving trading/risk/market/event10 processes.
Applies persistent systemd UnsetEnvironment=DEEPSEEK_API_KEY to GUARDIAN's analysis unit.
Never prints, edits or deletes credentials. Does not create/submit/cancel orders.
"""
import base64
import os
import re
import sys
import time

from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REGION = "ap-southeast-1"
INSTANCE = "b67374069bb3457ba6a3a2ede9305d3f"
SHELL = r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'REMOTE'
import json, pathlib, subprocess, time, urllib.request

MAIN="zl-prediction-guardian-analysis"
AI_LEGACY=("zl-prediction-deepseek5","zl-prediction-llm5")
KEEP=("zl-prediction-trade","zl-prediction-risk-exits","zl-prediction-v2","zl-prediction-v3","zl-event10-deepseek")
def run(*args, check=False):
    p=subprocess.run(args,text=True,capture_output=True,timeout=24)
    if check and p.returncode:raise RuntimeError("COMMAND_FAILED:"+args[0]+":"+str(p.returncode))
    return p.stdout.strip()
def state(name):
    return run("systemctl","is-active",name)
def pid(name):
    return run("systemctl","show",name,"-p","MainPID","--value")
def get(port,path):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}",timeout=6) as r:return json.load(r)
    except Exception:return None

before={s:{"state":state(s),"pid":pid(s)} for s in KEEP}
if before["zl-prediction-trade"]["state"]!="active":
    raise RuntimeError("TRADE_SERVICE_NOT_ACTIVE_ABORT")
if before["zl-prediction-risk-exits"]["state"]!="active":
    raise RuntimeError("RISK_EXIT_SERVICE_NOT_ACTIVE_ABORT")
choice=get(13001,"/api/order-signal-model")
if not choice or choice.get("ready") is not True:
    raise RuntimeError("SIGNAL_SELECTION_UNREADABLE_ABORT")
print("FIVE_M_AI_PRESELECTED_MODEL="+str(choice.get("model")),flush=True)
print("FIVE_M_AI_KEEP_SERVICE_SNAPSHOT=true",flush=True)

if run("systemctl","show",MAIN,"-p","LoadState","--value")=="loaded":
    drop=pathlib.Path("/etc/systemd/system/"+MAIN+".service.d/99-pause-external-ai.conf")
    drop.parent.mkdir(parents=True,exist_ok=True)
    expected="[Service]\nUnsetEnvironment=DEEPSEEK_API_KEY\n"
    if drop.exists() and drop.read_text()!=expected:
        raise RuntimeError("EXISTING_AI_PAUSE_DROPIN_CONFLICT_ABORT")
    if not drop.exists():
        drop.write_text(expected)
        drop.chmod(0o644)
    run("systemctl","daemon-reload",check=True)
    # Only GUARDIAN analysis can be restarted; trade, market feeds, exits and EVENT10 stay untouched.
    if state(MAIN)=="active":
        run("systemctl","restart",MAIN,check=True)
        up=False
        for _ in range(12):
            if state(MAIN)=="active":
                s=get(13049,"/api/status")
                if s and s.get("ok") is True:
                    up=True
                    break
            time.sleep(1)
        if not up:raise RuntimeError("GUARDIAN_SERVICE_NOT_HEALTHY_AFTER_PAUSE")
        if s.get("configured") is not False:
            raise RuntimeError("GUARDIAN_AI_KEY_STILL_CONFIGURED_ABORT")
        nowPid=pid(MAIN)
        if not nowPid.isdecimal() or int(nowPid)<1:
            raise RuntimeError("GUARDIAN_PID_MISSING")
        env=(pathlib.Path("/proc")/nowPid/"environ").read_bytes()
        if any(x.startswith(b"DEEPSEEK_API_KEY=") for x in env.split(b"\x00")):
            raise RuntimeError("GUARDIAN_MODEL_KEY_STILL_PRESENT_IN_PROCESS")
        last=s.get("lastAIAt")
        time.sleep(3)
        s2=get(13049,"/api/status")
        if not s2 or s2.get("lastAIAt")!=last or s2.get("configured") is not False:
            raise RuntimeError("GUARDIAN_AI_CONTINUED_AFTER_PAUSE")
        print("FIVE_M_GUARDIAN_RUNNING_WITH_AI_UNCONFIGURED=true",flush=True)
        print("FIVE_M_GUARDIAN_NO_PROVIDER_KEY_IN_PROCESS=true",flush=True)
    else:
        print("FIVE_M_GUARDIAN_ALREADY_STOPPED=true",flush=True)
    print("FIVE_M_GUARDIAN_AI_PAUSE_PERSISTENT=true",flush=True)
else:
    print("FIVE_M_GUARDIAN_UNIT_NOT_INSTALLED=true",flush=True)

for svc in AI_LEGACY:
    load=run("systemctl","show",svc,"-p","LoadState","--value")
    if load=="loaded":
        run("systemctl","disable","--now",svc,check=True)
        if state(svc)=="active":raise RuntimeError("LEGACY_MODEL_STILL_ACTIVE:"+svc)
        print("FIVE_M_LEGACY_AI_STOPPED="+svc,flush=True)
    else:
        print("FIVE_M_LEGACY_AI_ALREADY_ABSENT="+svc,flush=True)
after={s:{"state":state(s),"pid":pid(s)} for s in KEEP}
for s in KEEP:
    if before[s]!=after[s]:raise RuntimeError("UNRELATED_SERVICE_CHANGED:"+s)
print("FIVE_M_MARKET_TRADE_RISK_EVENT10_PIDS_UNCHANGED=true",flush=True)
choice2=get(13001,"/api/order-signal-model")
if not choice2 or choice2.get("model")!=choice.get("model"):
    raise RuntimeError("PRODUCTION_ORDER_SELECTOR_CHANGED")
print("FIVE_M_PRODUCTION_SOURCE_UNCHANGED=true",flush=True)
print("FIVE_M_LLM_CALLS_PAUSED=true",flush=True)
REMOTE
"""

def main():
    sha = os.getenv("GITHUB_SHA", "")
    if os.getenv("GITHUB_REF_NAME") != "feature/zl-futures-bot-v1" or not re.fullmatch("[0-9a-f]{40}", sha):
        raise RuntimeError("EXPECTED_BRANCH_AND_SHA_REQUIRED")
    cli=Client(api.Config(access_key_id=os.environ["ALIBABA_CLOUD_ACCESS_KEY_ID"],
        access_key_secret=os.environ["ALIBABA_CLOUD_ACCESS_KEY_SECRET"],
        region_id=REGION, endpoint="swas.ap-southeast-1.aliyuncs.com"))
    inv=cli.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
        name="pause-guardian5-external-ai-only",type="RunShellScript",working_user="root",
        command_content=SHELL,timeout=120)).body.invoke_id
    if not inv:raise RuntimeError("NO_SWAS_INVOCATION_ID")
    for _ in range(65):
        time.sleep(2)
        obj=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(
            region_id=REGION,instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
        if not obj or str(obj.invocation_status) not in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero","ClientNotRunning","InstanceNotRunning"):
            continue
        output=base64.b64decode(obj.output or "").decode("utf-8","replace")
        for line in output.splitlines():
            if line.startswith("FIVE_M_"):
                print(line,flush=True)
        good=str(obj.invocation_status)=="Success" and int(obj.exit_code)==0 and "FIVE_M_LLM_CALLS_PAUSED=true" in output
        print("FIVE_M_AI_PAUSE_RESULT="+("SUCCESS" if good else "FAILED"),flush=True)
        if not good:print("FIVE_M_PAUSE_INVOCATION_CODE="+str(obj.invocation_status)+"_EXIT_"+str(obj.exit_code),flush=True)
        return 0 if good else 5
    print("FIVE_M_AI_PAUSE_RESULT=TIMEOUT",flush=True)
    return 6

if __name__=="__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Read-only identify screenshot model, official outcomes and actual order router."""
import base64,os,time,json
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r'''#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import collections,json,urllib.request,os
def get(port,path):
 try:
  with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}",timeout=10) as r:return json.load(r)
 except Exception as e:
  return {"ok":False,"error":type(e).__name__}
stats=get(13002,"/api/round-stats")
model=get(13002,"/api/production-signal")
choice=get(13001,"/api/order-signal-model")
print("MODEL_AUDIT_V2_PRODUCTION_MODE",stats.get("productionSignalSourceMode"))
print("MODEL_AUDIT_V2_POLICY",stats.get("productionPolicy"))
print("MODEL_AUDIT_V2_ACTIVE",json.dumps(stats.get("activeSignalModels"),ensure_ascii=False))
print("MODEL_AUDIT_V2_SCREENSHOT_SUMMARY",json.dumps(stats.get("productionSummary"),ensure_ascii=False)[:1050])
print("MODEL_AUDIT_ORDER_SELECTION",json.dumps({k:choice.get(k) for k in ('ok','ready','model','effectiveAfterRound','updatedAt','models')},ensure_ascii=False)[:900])
live=model.get('live') or {}
print("MODEL_AUDIT_CURRENT_PRODUCTION_LOCK",json.dumps({k:live.get(k) for k in ('round','status','model','modelVersion','source','executionEligible','fallbackUsed','generatedAt')},ensure_ascii=False))
entries=stats.get("records") or []
records=[x for x in entries if x.get('productionActual') in ('UP','DOWN') and x.get('productionPrediction') in ('UP','DOWN')]
sources=collections.defaultdict(lambda:{"n":0,"hit":0,"miss":0,"model_versions":set(),"rounds":[]})
for x in records:
 src=x.get("productionSource") or "UNKNOWN"
 g=sources[src]
 g["n"]+=1
 g["hit"]+=int(x.get("productionPrediction")==x.get("productionActual"))
 g["miss"]+=int(x.get("productionPrediction")!=x.get("productionActual"))
 g["model_versions"].add(str(x.get("productionModelVersion") or "NONE"))
 g["rounds"].append(x.get("roundStartMs"))
for name,part in sorted(sources.items()):
 print("MODEL_AUDIT_SOURCE",name,"count",part["n"],"hit",part["hit"],"miss",part["miss"],
  "versions",','.join(part["model_versions"])[:220])
print("MODEL_AUDIT_RECORDS_COVERED",len(records),"latest",max((x.get("roundStartMs") or 0 for x in records),default=0))
for file in ("/etc/zl-prediction/v2.env","/etc/zl-prediction/panel.env"):
 try:
  txt=open(file).read()
  for field in ("PRODUCTION_SIGNAL_SOURCE_MODE","AUTO_CONFIRM_ENABLED","ROUND_STATS_ORIGIN","SIGNAL_WS_URL"):
   val=next((line.split("=",1)[1] for line in txt.splitlines() if line.startswith(field+"=")),None)
   if val is not None:print("MODEL_AUDIT_ENV",os.path.basename(file),field,val[:130])
 except Exception as e:print("MODEL_AUDIT_ENV_ERROR",type(e).__name__)
PY
'''
k=os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID");v=os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
if not k or not v:raise SystemExit("MISSING_DEPLOYMENT_AUTHORIZATION")
c=Client(api.Config(access_key_id=k,access_key_secret=v,region_id="ap-southeast-1",endpoint="swas.ap-southeast-1.aliyuncs.com"))
job=c.run_command(sw.RunCommandRequest(region_id="ap-southeast-1",instance_id="b67374069bb3457ba6a3a2ede9305d3f",name="zl-model-source-audit",type="RunShellScript",command_content=SCRIPT,working_user="root",timeout=100))
for _ in range(45):
 time.sleep(2)
 r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id="ap-southeast-1",instance_id="b67374069bb3457ba6a3a2ede9305d3f",invoke_id=job.body.invoke_id)).body.invocation_result
 if r and str(r.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
  raw=r.output or ""
  try:raw=base64.b64decode(raw,validate=True).decode("utf8","replace")
  except:pass
  print("MODEL_AUDIT_EXIT",r.exit_code)
  print(raw[-11000:])
  raise SystemExit(0 if str(r.invocation_status)=="Success" and int(r.exit_code)==0 else 1)
raise SystemExit("MODEL_AUDIT_NO_RESPONSE")

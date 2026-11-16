#!/usr/bin/env python3
"""Read-only audit of the Alibaba-only signal/settlement cutover."""
import os,base64,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as om
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
echo "CUTOVER_UTC=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "CUTOVER_MEMORY_AVAILABLE_MIB=$(free -m | awk '/Mem:/{print $7}')"
for name in zl-prediction-v2 zl-prediction-v3 zl-prediction-native-models zl-prediction-trade zl-prediction-redis zl-futures-bot-paper;do
  echo "CUTOVER_SERVICE_$name=$(systemctl is-active "$name" || true)"
  echo "CUTOVER_RESTARTS_$name=$(systemctl show "$name" -p NRestarts --value)"
done
python3 - <<'PY'
import json,urllib.request,datetime,os
def read(url):
 with urllib.request.urlopen(url,timeout=8) as r:return json.load(r)
v2=read('http://127.0.0.1:13002/api/round-stats')
assert v2.get('settlementSource')=='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY'
rows=v2.get('records') or []
strict=[]
for r in rows:
 if not isinstance(r,dict):continue
 ev=str(r.get('resolutionEvidence') or '')
 d=r.get('officialDirection')
 prod=r.get('productionActual')
 if d in ('UP','DOWN') and ev.startswith('OFFICIAL_'+d):
  strict.append({'round':r.get('roundStartMs'),'direction':d,'productionActual':prod,'actualSource':r.get('actualSource')})
print('CUTOVER_OFFICIAL_RECORDS',len(rows),'verified',len(strict))
print('CUTOVER_VERIFIED_LATEST',json.dumps(strict[:6],ensure_ascii=False))
for label,url in (('edge','http://127.0.0.1:13001/api/shadow-breakout20/edge-5m'),
 ('dynamic','http://127.0.0.1:13001/api/shadow-breakout20/dynamic-entry')):
 status=read(url)
 assert status.get('ok') is True and status.get('readOnly') is True
 summary=status.get('results') or {}
 health=status.get('health') or {}
 note={'model':status.get('model'),'source':status.get('source'),
  'records':len(status.get('recent') or []),
  'pending':summary.get('pending'),'samples':(summary.get('overall') or {}).get('samples'),
  'marketError':health.get('marketError'),'officialError':health.get('officialError'),
  'lastOfficialAt':health.get('lastOfficialAt'),'storage':health.get('storage'),
  'persisted':health.get('persisted'),'archive':status.get('legacyArchive')}
 print('CUTOVER_MODEL',label,json.dumps(note,ensure_ascii=False,default=str)[:1400])
for name in ('edge-cloudflare-last-public-snapshot.json',
 'breakout20-cloudflare-last-public-snapshot.json'):
 path='/var/lib/zl-prediction/archive/'+name
 try:
  with open(path) as f:d=json.load(f)
  print('CUTOVER_ARCHIVE',name,'exists',True,'scope',d.get('scope'))
 except (OSError,ValueError):
  print('CUTOVER_ARCHIVE',name,'exists',False)
# Check ONLY active runtime files that were switched, and report domain counts.
root='/opt/zl-prediction-live/src/railway-diagnostic/'
for name in ('panel-stats-shell.mjs','shadow-breakout20-dashboard.mjs',
 'postflip-official-stats.mjs','novice-mix-shadow.mjs','dynamic-entry-shadow.mjs',
 'edge-5m-service.mjs','local-model-host.mjs'):
 with open(root+name) as f:src=f.read()
 counts={x:src.count(x) for x in ('railway.app','workers.dev','onrender.com')}
 print('CUTOVER_EXTERNAL_SOURCE_REFERENCES',name,json.dumps(counts))
panel=open('/etc/zl-prediction/panel.env').read()
for key in ('ROUND_STATS_ORIGIN','NOVICE_MARKET_ORIGIN','EDGE5_LOCAL_STATUS_URL','DYNAMIC_LOCAL_STATUS_URL'):
 value=next((l.split('=',1)[1] for l in panel.splitlines() if l.startswith(key+'=')),None)
 print('CUTOVER_PANEL_LOCAL_CONFIG',key,bool(value and value.startswith('http://127.0.0.1:')))
PY
"""
def main():
 key=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID");secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
 if not key or not secret:print("MISSING_ALI_KEYS");return 2
 c=Client(om.Config(access_key_id=key,access_key_secret=secret,
  region_id="ap-southeast-1",endpoint="swas.ap-southeast-1.aliyuncs.com"))
 req=c.run_command(sw.RunCommandRequest(region_id="ap-southeast-1",instance_id="b67374069bb3457ba6a3a2ede9305d3f",
  name="zl-singlehost-live-cutover-readonly-audit",type="RunShellScript",command_content=SCRIPT,working_user="root",timeout=95))
 for _ in range(42):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id="ap-southeast-1",
    instance_id="b67374069bb3457ba6a3a2ede9305d3f",invoke_id=req.body.invoke_id)).body.invocation_result
  if r and str(r.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
   raw=r.output or ""
   try:raw=base64.b64decode(raw,validate=True).decode("utf-8","replace")
   except:pass
   print("CUTOVER_DIAGNOSTIC_EXIT",r.exit_code)
   print(raw[-12000:])
   return 0 if str(r.invocation_status)=="Success" and int(r.exit_code)==0 else 3
 return 4
if __name__=="__main__":raise SystemExit(main())

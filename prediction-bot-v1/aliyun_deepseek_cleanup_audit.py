#!/usr/bin/env python3
"""Read-only audit of which Alibaba units still run retired model calculations.
Does not print service secrets and never modifies any unit, file or order."""
import base64,os,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -euo pipefail
for svc in zl-prediction-llm5 zl-prediction-native-models zl-prediction-v2 zl-prediction-v3 zl-prediction-trade zl-prediction-deepseek5 zl-futures-bot-paper;do
 echo "MODEL_AUDIT_UNIT $svc $(systemctl is-active $svc || true) $(systemctl is-enabled $svc || true)"
done
echo 'MODEL_AUDIT_DEPENDENCIES_START'
for svc in zl-prediction-native-models zl-prediction-llm5;do
 echo "MODEL_AUDIT_SERVICE $svc"
 systemctl show -p RequiredBy -p WantedBy -p BoundBy -p PartOf "$svc" 2>/dev/null | sed -E 's/^([^=]+)=/\1:/' | head -5
done
echo 'MODEL_AUDIT_HTTP_START'
for port in 13001 13002 13003 13007 13018 13029;do
 echo "MODEL_AUDIT_PORT $port $(curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:$port/healthz || true)"
done
echo 'MODEL_AUDIT_MAIN_HTML'
python3 - <<'PY'
from pathlib import Path
p=Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
if p.is_file():
 lines=p.read_text(errors='replace').splitlines()
 print('MODEL_AUDIT_PANEL_LENGTH',len(lines))
 words=('statsCard','async function loadLegacy','function loadLegacy','var sources=','syncActiveCatalog','activeFast8Note','shadow-breakout20','源开关','旧版')
 matches=[i for i,l in enumerate(lines) if any(w in l for w in words)]
 for i in matches[:26]:
  for j in range(max(0,i-1),min(len(lines),i+3)):
   line=lines[j]
   if any(k in line for k in ('API_KEY','API_SECRET','AUTHORIZATION','PASSWORD','PRIVATE_KEY','walletAddress','WALLET_ID')):continue
   print('MODEL_AUDIT_PANEL_LINE',j+1,line[:195])
PY
"""
def main():
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  name='zl-deepseek-retired-model-audit-readonly',type='RunShellScript',
  command_content=SCRIPT,working_user='root',timeout=80)).body.invoke_id
 for _ in range(35):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   out=r.output or ''
   try:out=base64.b64decode(out,validate=True).decode('utf-8','replace')
   except Exception:pass
   print(out[-13000:])
   return 0 if int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':raise SystemExit(main())

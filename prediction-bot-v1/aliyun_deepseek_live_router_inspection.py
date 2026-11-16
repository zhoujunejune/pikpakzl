#!/usr/bin/env python3
"""Read-only inspect a bounded safe set of exact current Alibaba production code sections.
Print no environment contents, credentials, tokens, wallets, or API responses with keys.
"""
import os,base64,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
from pathlib import Path
import re
root=Path('/opt/zl-prediction-live/src/railway-diagnostic')
files={
 'choice':root/'production-signal-choice.mjs',
 'index':root/'index.mjs',
 'wrapper':root/'wrapper.mjs',
 'policy':root/'order-direction-policy.mjs',
}
needle={
 'choice':['SELECTIVE8_MODEL','ORDER_SIGNAL_MODELS=','function validateSelective8ProductionLive','export function validateSelective8ProductionLive','async function refreshModelSelection','export async function refreshModelSelection','function selectedSignalMatches','function selectionPermitsRound'],
 'index':['SELECTIVE8_LOCAL_URL','async function getSignal(','if(choice.model!==SELECTIVE8_MODEL)','if(choice.model===SELECTIVE8_MODEL)','if(choice.model===EDGE_MODEL)','async function prepareWorker(','const mapping=mappedOrderSignal','if(choice.model===SELECTIVE8_MODEL&&','if (signalOverride && choice.model!==SELECTIVE8_MODEL)','import {BASE_MODEL'],
 'wrapper':['function orderSubmitDeadlineForModel(','if (p.signalModelChoice===EDGE_MODEL)','p.signalModelChoice===SELECTIVE8_MODEL','getSignal({ forceHttp: true })','currentRetry=await getSignal','pendingOrderMatchesProduction(p,current)','AUTO_CONFIRM_ENABLED && enabled'],
 'policy':['export const ORDER_SOURCES','export const PRIMARY_SOURCE','export function mappedOrderSignal(','export function orderDirectionForProduction(','export function pendingOrderMatchesProduction('],
}
for name,p in files.items():
 if not p.is_file():
  print('ROUTER_FILE_MISSING',name)
  continue
 lines=p.read_text(encoding='utf8',errors='replace').splitlines()
 print('ROUTER_FILE',name,'linecount',len(lines))
 points=[i for i,line in enumerate(lines) if any(s in line for s in needle[name])]
 print('ROUTER_POINTS',name,points[:35])
 selected=set()
 for i in points[:19]:
  before=5 if name!='index' else 4
  after=8 if name!='index' else 13
  selected.update(range(max(0,i-before),min(len(lines),i+after)))
 for i in sorted(selected)[:200]:
  s=lines[i]
  if re.search(r'(SECRET|API_KEY|PASSWORD|AUTHORIZATION|PRIVATE_KEY|BINANCE_PREDICTION_API|SIGNAL_REDIS_URL|WALLET_ADDRESS|WALLET_ID)',s,re.I):
   continue
  print('ROUTER_CODE',name,i+1,s[:245])
PY
"""
def main():
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 inv=client.run_command(sw.RunCommandRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   name='zl-readonly-deepseek-router-audit',type='RunShellScript',working_user='root',
   command_content=SCRIPT,timeout=70)).body.invoke_id
 for _ in range(25):
  time.sleep(2)
  r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
    instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:s=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except:s=r.output or ''
   print(s[-24000:])
   return 0 if int(r.exit_code)==0 else 4
 return 5
if __name__=='__main__':raise SystemExit(main())

#!/usr/bin/env python3
"""Inspect actual Alibaba panel process and DeepSeek history without modifying services."""
import os,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -e
echo 'PROCESS_PANEL_BEGIN'
ps -eo pid,comm,args | grep -E 'panel-stats-shell\.mjs|control-shell\.mjs|node wrapper\.mjs' | grep -v grep | cut -c 1-220 || true
echo 'PROCESS_PANEL_END'
for name in zl-prediction-panel zl-prediction-v2 zl-prediction-trade zl-prediction-native-models zl-prediction-deepseek5;do
 echo "UNIT $name $(systemctl is-active $name || true)"
 systemctl show "$name" -p ExecStart --value 2>/dev/null | sed -E 's/(Environment|PASSWORD|API_KEY|SECRET)[^;]*/REDACTED/g' | cut -c 1-190 || true
done
python3 - <<'PY'
import urllib.request,json
for url in ('http://127.0.0.1:13029/api/history?limit=3','http://127.0.0.1:13029/api/status'):
 try:
  with urllib.request.urlopen(url,timeout=7) as r:
   x=json.load(r)
   print('HISTORY_ENDPOINT',url.split('/')[-1],r.status,'model',x.get('model'),
      'records',len(x.get('records',[])) if isinstance(x.get('records'),list) else 'none')
 except Exception as e:print('HISTORY_ENDPOINT_FAILURE',url.split('/')[-1],type(e).__name__)
from pathlib import Path
p=Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
if p.is_file():
 s=p.read_text()
 print('LIVE_PANEL_EXISTS=true')
 print('LIVE_PANEL_SIZE',len(s))
 print('LIVE_PANEL_HAS_DEEPSEEK_HISTORY', 'renderDeepSeekRoundStats' in s)
 print('LIVE_PANEL_HAS_LEGACY_TITLE','每轮判断与真实结果' in s)
 print('LIVE_PANEL_ANCHORS_START')
 lines=s.splitlines()
 tokens=('async function load(){','Only the two currently selectable','signalPolicyCard','function chosenModelName(','async function loadOrderModelStats(){','const statsCard =','const statsScript =','const policyScript =','function render','getStats()')
 inds=[i for i,t in enumerate(lines) if any(k in t for k in tokens)]
 for i in inds[:45]:
  print('LIVE_PANEL_ANCHOR',i+1,repr(lines[i][:190]))
  for n in range(i+1,min(i+5,len(lines))):
   if any(x in lines[n] for x in ('API_KEY','API_SECRET','PASSWORD','SECRET','AUTHORIZATION')):continue
   print('LIVE_PANEL_CONTEXT',n+1,repr(lines[n][:180]))
 print('LIVE_STATS_STRUCTURE_BEGIN')
 print('LIVE_STATS_CARD_HEADING',repr(s[s.find('const statsCard ='):s.find('const statsCard =')+320]))
 for needle in ('const statsScript =','async function getStats(){','async function load(){',' // Only the two currently selectable','const policyScript =','const policyCard =','const primaryScript =','async function loadOrderModelStats(){','function chosenModelName(model){','function syncActiveCatalog(j){'):
  ii=[];start=0
  while len(ii)<10:
   at=s.find(needle,start)
   if at<0:break
   ii.append(at);start=at+len(needle)
  print('LIVE_STATS_NEEDLE',repr(needle),'COUNT',s.count(needle),'OFFSETS',ii)
  for at in ii[:2]:
   snippet=s[at:at+430]
   if any(v in snippet for v in ('API_KEY','API_SECRET','PASSWORD','SECRET','AUTHORIZATION')):continue
   print('LIVE_STATS_SNIP',repr(needle),repr(snippet))
 print('LIVE_STATS_STRUCTURE_END')
 print('LIVE_PANEL_ANCHORS_END')
else:print('LIVE_PANEL_EXISTS=false')
PY
"""
def main():
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 v=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='zl-deepseek-panel-process-readonly',type='RunShellScript',working_user='root',command_content=SCRIPT,timeout=50)).body.invoke_id
 for _ in range(28):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=v)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=r.output or ''
   try:raw=base64.b64decode(raw,validate=True).decode()
   except Exception:pass
   print(raw[-7000:]);return 0 if int(r.exit_code)==0 else 3
 return 4
if __name__=='__main__':raise SystemExit(main())

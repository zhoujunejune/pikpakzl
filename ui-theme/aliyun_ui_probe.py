#!/usr/bin/env python3
"""Inspect current UI deployments without changing any service."""
import os,base64,time,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r'''#!/bin/bash
set -e
python3 - <<'PY'
from pathlib import Path
from urllib.request import urlopen
import json,re,subprocess,hashlib
for svc in ('zl-prediction-trade','zl-prediction-fast5','zl-event10-deepseek','zl-prediction-dual5'):
 print('SERVICE',svc,subprocess.run(['systemctl','is-active',svc],capture_output=True,text=True).stdout.strip())
for path in ('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs','/opt/zl-event10/panel.html','/opt/zl-prediction-dual5/binance_dual5_dashboard.html'):
 p=Path(path);print('FRONTEND',path,'exists',p.is_file())
 if not p.is_file():continue
 s=p.read_text(errors='replace')
 print('FILE_META','lines',len(s.splitlines()),'bytes',len(s),'sha12',hashlib.sha256(s.encode()).hexdigest()[:12])
 print('STYLE_MARKERS','styleEnd',s.count('</style>'),'headEnd',s.count('</head>'),'backtick',s.count(chr(96)))
 print('UI_MARKERS',[(k,k in s) for k in ('dashboard-layout-stability','id="banner"','id="engine"','class="card"','class="w"','<main','const statsScript','function injectStats')])
 print('TITLES',re.findall(r'<h[12][^>]*>([^<]{1,95})',s)[:7])
for port,route in ((13001,'/'),(13005,'/'),(13020,'/'),(13048,'/healthz'),(13048,'/api/status')):
 try:
  with urlopen('http://127.0.0.1:%s%s'%(port,route),timeout=3) as r:
   data=r.read(2200).decode('utf8','replace')
   print('HTTP',port,route,r.status,r.headers.get('content-type'),re.sub(r'[\n\r\t]+',' ',data[:170]))
 except Exception as e:print('HTTP_ERROR',port,route,type(e).__name__)
for port in (13001,13048,13020):
 for path in ('/api/status','/api/dual5-status'):
  try:
   with urlopen('http://127.0.0.1:%s%s'%(port,path),timeout=2) as r:
    d=json.load(r)
   if isinstance(d,dict):
    out={k:d.get(k) for k in ('ok','enabled','armed','active','mode','blocked','status','model','configured') if k in d}
    print('MODE',port,path,json.dumps(out,ensure_ascii=False))
  except Exception:pass
PY
'''
def main():
 if not os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID'):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 r=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='zl-three-ui-readonly-audit',type='RunShellScript',command_content=SCRIPT,working_user='root',timeout=85))
 for _ in range(45):
  time.sleep(2)
  x=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=r.body.invoke_id)).body.invocation_result
  if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ClientNotRunning'):
   try:s=base64.b64decode(x.output or '',validate=True).decode('utf8','replace')
   except Exception:s='OUTPUT_UNAVAILABLE'
   print('AUDIT_RESULT',x.invocation_status,x.exit_code)
   print(s[-13500:])
   return 0 if str(x.invocation_status)=='Success' and int(x.exit_code)==0 else 4
 print('AUDIT_PENDING');return 5
if __name__=='__main__':sys.exit(main())

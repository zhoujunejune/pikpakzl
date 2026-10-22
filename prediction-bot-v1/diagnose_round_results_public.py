#!/usr/bin/env python3
"""Diagnose live public page routes without exposing authentication or trading keys."""
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REMOTE=r"""#!/bin/bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from html.parser import HTMLParser
import json,subprocess,urllib.parse
class Parser(HTMLParser):
 def __init__(self):super().__init__();self.stack=[];self.cards=[];self.scripts=0;self.links=[];self.anchors=[]
 def handle_starttag(self,tag,attrs):
  a=dict(attrs);self.stack.append((tag,a.get('id',''),a.get('class','')))
  if a.get('id')=='roundResultsOnlyCard':self.cards.append(list(self.stack[-8:]))
  if tag=='script':self.scripts+=1
  if tag=='a' and (a.get('href') or ''):self.links.append(a.get('href'))
  if a.get('id') in ('riskControlsAnchor','roundResultsOnlyCard','rrRows'):self.anchors.append((tag,a.get('id'),self.stack[-3:]))
 def handle_endtag(self,tag):
  for i in range(len(self.stack)-1,-1,-1):
   if self.stack[i][0]==tag:self.stack=self.stack[:i];break
def probe(port,route):
 try:
  req=Request('http://127.0.0.1:%d%s'%(port,route),headers={'Cache-Control':'no-cache'})
  with urlopen(req,timeout=5) as r:
   text=r.read(500000).decode('utf8','replace');status=r.status;typ=r.headers.get('Content-Type','')
  o={'http':status,'contentType':typ,'bytes':len(text),'hasResultsCard':'id="roundResultsOnlyCard"' in text,'hasResultsScript':'roundResultsOnlyScript' in text or "rrAccuracy" in text,'hasResultApiPath':'/api/deepseek-round-results' in text,'hasRiskAnchor':'id="riskControlsAnchor"' in text,'hasPredNav':'预测机器人' in text,'hasFuturesNav':'合约机器人' in text,'hasLogin':'登录' in text}
  if '<html' in text or '<body' in text:
   p=Parser();p.feed(text)
   o.update({'cardParents':p.cards,'anchors':p.anchors,'scriptCount':p.scripts,'links':p.links[:16]})
   for k in ('id="roundResultsOnlyCard"','id="riskControlsAnchor"','</body>'):
    idx=text.find(k)
    o['pos_'+k]=idx
    if idx>=0:o['snippet_'+k]=text[max(0,idx-95):idx+150].replace('\n',' ')[:245]
  return o
 except HTTPError as e:return {'http':e.code}
 except Exception as e:return {'error':type(e).__name__}
for port,route in ((13029,'/api/status'),(13029,'/api/round-results?limit=2'),(13001,'/api/status'),(13001,'/api/order-signal-model'),(13001,'/api/deepseek-round-results?limit=2'),(13019,'/api/status'),(13002,'/api/round-stats')):
 try:
  with urlopen('http://127.0.0.1:%d%s'%(port,route),timeout=5) as rr:
   data=json.load(rr)
   print('PUBLIC_API_PROBE',port,route,json.dumps({'http':rr.status,'ok':data.get('ok'),'model':data.get('model'),'maxCalls':data.get('maxCallsPerRound'),'keys':list(data)[:13]},ensure_ascii=False))
 except HTTPError as e:print('PUBLIC_API_PROBE',port,route,'HTTP',e.code)
 except Exception as e:print('PUBLIC_API_PROBE',port,route,'ERROR',type(e).__name__)
for port in (13000,13001,13029,13018,13019,13020,13030,3000,3002):
 for route in ('/','/trade-control') if port==13001 else ('/',):
  print('PUBLIC_PATH_PROBE',port,route,json.dumps(probe(port,route),ensure_ascii=False)[:3200])
p=Path('/etc/caddy/Caddyfile')
if p.exists():
 s=p.read_text()
 print('CADDY_FILE_BYTES',len(s))
 lines=s.splitlines()
 for i,line in enumerate(lines):
  # Whitelist only public route/server directives; do not read auth entries.
  clean=line.strip()
  if clean.endswith('{') and not any(z in clean for z in ('basic_auth','basicauth','header','env','@')):
   print('CADDY_BLOCK',i+1,clean[:140])
  elif clean.startswith(('reverse_proxy','handle','handle_path','redir','route','rewrite','root','file_server','respond','import')):
   print('CADDY_ROUTE',i+1,clean[:180])
for unit in ('zl-prediction-trade.service','zl-prediction-panel.service','zl-prediction-nav.service','zl-prediction-deepseek5.service'):
 pid=subprocess.run(['systemctl','show',unit,'-p','MainPID','--value'],capture_output=True,text=True).stdout.strip()
 if pid and pid!='0':
  try:
   raw=Path('/proc/'+pid+'/cmdline').read_bytes().replace(b'\\0',b' ').decode('utf8','replace')
   # Log only path-like executable names, never command arguments or environment.
   safe=[x for x in raw.split(' ') if x.endswith(('.mjs','.js','.cjs','.py'))]
   print('PUBLIC_MAIN_EXEC',unit,pid,[Path(x).name for x in safe][:5])
  except Exception as e:print('PUBLIC_MAIN_EXEC_ERR',unit,type(e).__name__)
for name in ('zl-prediction-trade.service','zl-prediction-panel.service','zl-prediction-deepseek5.service','caddy.service'):
 out=subprocess.run(['systemctl','show',name,'-p','ActiveState','--no-pager'],capture_output=True,text=True)
 print('PUBLIC_UNIT',name,out.stdout.strip())
# Check listener path and intended public hostname WITHOUT credentials.
host='prediction.47-237-188-69.sslip.io'
for endpoint in ('/','/trade-control','/prediction','/deepseek/'):
 cmd=['curl','-ksS','-o','/dev/null','--max-time','4','-w','%{http_code} %{redirect_url}',
 '--resolve',host+':443:127.0.0.1','https://'+host+endpoint]
 out=subprocess.run(cmd,capture_output=True,text=True)
 print('PUBLIC_CADDY_UNAUTH',endpoint,out.stdout.strip()[:130])
PY
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 assert os.getenv('GITHUB_REF_NAME')=='fix/deepseek5-results-public-visibility-20261022'
 assert re.fullmatch('[a-f0-9]{40}',sha)
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 id=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
 instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='zl-results-public-routing-diagnostics',
 type='RunShellScript',working_user='root',command_content=REMOTE,timeout=85)).body.invoke_id
 for _ in range(60):
  time.sleep(2)
  x=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=id)).body.invocation_result
  if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(x.output or '',validate=True).decode('utf8','replace')
   except Exception:out=str(x.output)
   print('RESULTS_PUBLIC_DIAG',x.invocation_status,'EXIT',x.exit_code)
   print(out[-19000:])
   return 0 if int(x.exit_code)==0 else 5
 return 6
if __name__=='__main__':sys.exit(main())

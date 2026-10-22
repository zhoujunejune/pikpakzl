#!/usr/bin/env python3
"""Read-only pre-release check for current AI and trader settings; does not place orders."""
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import urllib.request,json,pathlib,hashlib,subprocess
def get(port,route):
 try:
  with urllib.request.urlopen(f'http://127.0.0.1:{port}'+route,timeout=8) as r:return json.load(r)
 except Exception as e:return {'ok':False,'error':type(e).__name__}
m=get(13029,'/api/status');t=get(13001,'/api/status');sel=get(13001,'/api/order-signal-model')
print('AI15_PREFLIGHT_MODEL',json.dumps({k:m.get(k) for k in ('model','providerModel','configured',
  'round','maxCallsPerRound','decisionWindowEndMs','decisionRule','learningDisabled','lastDecision')},ensure_ascii=False))
print('AI15_PREFLIGHT_TRADE',json.dumps({k:t.get(k) for k in ('ok','enabled','amount','autoConfirmEnabled','startAfterRound',
 'pendingAction','lastOrderState','lastOrder','modelOriginalSignal') if k not in ('lastOrder','pendingAction')}|
 {'pendingActionState':(t.get('pendingAction') or {}).get('state')},ensure_ascii=False))
print('AI15_PREFLIGHT_SELECTED_MODEL',json.dumps({k:sel.get(k) for k in ('model','ok','revision')},ensure_ascii=False))
for p in ('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs',
  '/opt/zl-prediction-live/src/railway-diagnostic/wrapper.mjs',
  '/opt/zl-prediction-live/src/railway-diagnostic/index.mjs'):
 f=pathlib.Path(p);s=f.read_text() if f.exists() else ''
 print('AI15_PREFLIGHT_SOURCE',p,'present',f.exists(),'sha256',
 hashlib.sha256(s.encode()).hexdigest() if s else '-',
 'fiveSecond',('const LIMIT_MS=5000;' in s),
 'fifteenSecond',('const LIMIT_MS=15000;' in s),
 'priceFallback',('REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK' in s),
 'has30secDeepseekOrderWindow',('DEEPSEEK15_ORDER_SUBMIT_DEADLINE_MS' in s))
for unit in ('zl-prediction-deepseek5.service','zl-prediction-trade.service',
 'zl-prediction-risk-exits.service','zl-prediction-redis.service','zl-futures-bot-paper.service'):
 print('AI15_PREFLIGHT_UNIT',unit,subprocess.getoutput('systemctl is-active '+unit))
for unit in ('zl-prediction-trade.service','zl-prediction-deepseek5.service'):
  sh=subprocess.run(['systemctl','show',unit,'-p','ActiveState','-p','SubState',
    '-p','Result','-p','ExecMainStatus','-p','NRestarts','--no-pager'],capture_output=True,text=True)
  print('AI15_POSTROLLBACK_STATE',unit,sh.stdout.replace('\n',' ').strip()[:600])
  j=subprocess.run(['journalctl','-u',unit,'--since','8 minutes ago','-n','350','--no-pager','-o','cat'],
    capture_output=True,text=True).stdout
  safe=[]
  for line in j.splitlines():
    if any(x in line for x in ('SyntaxError:','ReferenceError:','TypeError:','Error [','EADDRINUSE',
      'Cannot find','Module not found','Exited','Failed','failed','starting','control_panel_started',
      'ERR_MODULE','Unexpected token','CONFIG','SIGTERM','SIGKILL','open /opt')):
      # No API credentials, order IDs, wallet details, URL query strings
      if any(k in line.upper() for k in ('SECRET','PASSWORD','PRIVATE_KEY','AUTHORIZATION','API_KEY','ORDERID','WALLET')):continue
      safe.append(line[:190])
  print('AI15_POSTROLLBACK_JOURNAL_ERRORS',unit,json.dumps(safe[-18:])[:3500])

from collections import Counter
from datetime import datetime,timezone,timedelta
from zoneinfo import ZoneInfo
tz=ZoneInfo('Asia/Singapore')
ai=get(13029,'/api/status')
print('NO_SIGNAL_AI_STATE',json.dumps({k:ai.get(k) for k in ('round','roundDecision','error','lastFailure','lastApiLatencyMs','aiTokens','analysisModelCalls','busy','decisionRule','configured')},ensure_ascii=False))
data=get(13029,'/api/round-results?limit=35')
rows=data.get('records') if isinstance(data,dict) else []
rows=rows if isinstance(rows,list) else []
latest=[]
for r in rows[-18:]:
 if not isinstance(r,dict):continue
 stamp=r.get('round')
 local=datetime.fromtimestamp(stamp/1000,tz).strftime('%Y-%m-%d %H:%M') if isinstance(stamp,(int,float)) else None
 latest.append({'time':local,'status':r.get('status'),'direction':r.get('direction'),
  'decisionMethod':r.get('decisionMethod'),'actual':r.get('actual'),'latencyMs':r.get('latencyMs')})
print('NO_SIGNAL_RECENT_ROUNDS',json.dumps(latest,ensure_ascii=False))
events=[]
log=subprocess.run(['journalctl','-u','zl-prediction-deepseek5.service','--since','4 hours ago',
 '--no-pager','-o','cat','-n','2400'],capture_output=True,text=True,timeout=12)
for line in log.stdout.splitlines():
 try:o=json.loads(line)
 except:continue
 if o.get('event') not in ('deepseek15_round_unavailable','deepseek15_analysis_failed','deepseek15_locked'):
  continue
 timestamp=o.get('at')
 events.append({k:o.get(k) for k in ('event','at','reason','elapsedMs','method','apiLatencyMs','modelCalls','pending')})
print('NO_SIGNAL_EVENT_COUNTS',json.dumps(Counter(e['event'] for e in events),ensure_ascii=False))
print('NO_SIGNAL_ERRORS',json.dumps([e for e in events if e['event']!='deepseek15_locked'][-30:],ensure_ascii=False))
print('NO_SIGNAL_LAST_LOCKS',json.dumps([e for e in events if e['event']=='deepseek15_locked'][-8:],ensure_ascii=False))
print('NO_SIGNAL_AUDIT_OK=true')

print('AI15_PREFLIGHT_DONE=true')
PY
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!='audit/deepseek15-no-signal-20261022' or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 i=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,name='ai15-production-preflight-readonly',type='RunShellScript',command_content=REMOTE,working_user='root',timeout=90)).body.invoke_id
 for n in range(50):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=i)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('AI15_PREFLIGHT_RESULT',r.invocation_status,'EXIT',r.exit_code);print(o[-12000:])
   return 0 if int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':sys.exit(main())

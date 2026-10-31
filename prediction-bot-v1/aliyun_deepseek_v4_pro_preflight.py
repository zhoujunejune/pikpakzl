#!/usr/bin/env python3
"""One-off read-only V4 Pro compatibility probe on the existing Alibaba SWAS instance.
Never prints API credentials, changes trading configuration or submits orders.
"""
import os,time,base64,re,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import os,json,time,urllib.request,urllib.error,subprocess
from pathlib import Path
env={}
for line in Path('/etc/zl-prediction/deepseek5.env').read_text().splitlines():
 if not line or line.lstrip().startswith('#') or '=' not in line:continue
 k,v=line.split('=',1)
 env[k.strip()]=v.strip().strip('"').strip("'")
key=env.get('DEEPSEEK_API_KEY')
if not key:
 print('PRO_PREFLIGHT_KEY_CONFIGURED=false');raise SystemExit(3)
for svc in ('zl-prediction-deepseek5','zl-prediction-trade','zl-futures-bot-paper'):
 if subprocess.check_output(['systemctl','is-active',svc],text=True).strip()!='active':
  print('PRO_PREFLIGHT_SERVICE_NOT_ACTIVE='+svc);raise SystemExit(4)
with urllib.request.urlopen('http://127.0.0.1:13003/api/shadow-market-data',timeout=6) as r:
 market=json.load(r)
latest=market.get('latest') or {}
now=int(time.time()*1000)
if market.get('ok') is not True or market.get('symbol')!='BTCUSDT' or now-int(latest.get('eventMs',0))>18000:
 print('PRO_PREFLIGHT_MARKET_UNAVAILABLE=true');raise SystemExit(5)
payload={'model':'deepseek-v4-pro',
 'thinking':{'type':'enabled'},'reasoning_effort':'high','max_tokens':4096,
 'response_format':{'type':'json_object'},
 'messages':[
 {'role':'system','content':'You are evaluating a Binance BTC 5-minute prediction round in READ-ONLY mode. Use only the current observed market features. If evidence is conflicting, choose WAIT. Return only a JSON object with keys direction (UP, DOWN or WAIT), confidence (0..1), reason (short text), nextReviewSec (15..55).'},
 {'role':'user','content':json.dumps({'roundStartMs':latest.get('roundStartMs'),
  'marketAgeMs':now-int(latest['eventMs']),
  'currentPrice':latest.get('lastPrice'),'roundOpenPrice':latest.get('roundOpenPrice'),
  'candles1mAvailable':bool((market.get('candles') or {}).get('1m')),
  'candles5mAvailable':bool((market.get('candles') or {}).get('5m'))},
  separators=(',',':'))}
 ]}
req=urllib.request.Request('https://api.deepseek.com/chat/completions',
 data=json.dumps(payload).encode(),method='POST',headers={
  'Authorization':'Bearer '+key,'Content-Type':'application/json'})
start=time.monotonic()
try:
 with urllib.request.urlopen(req,timeout=65) as r:
  response=json.load(r)
except urllib.error.HTTPError as e:
 print('PRO_PREFLIGHT_HTTP_STATUS='+str(e.code));raise SystemExit(6)
except Exception as e:
 print('PRO_PREFLIGHT_TRANSPORT_ERROR='+type(e).__name__);raise SystemExit(7)
latency=round((time.monotonic()-start)*1000)
try:
 choice=response['choices'][0]
 if choice.get('finish_reason')=='length':raise ValueError('TRUNCATED')
 data=json.loads(choice['message']['content'])
 if data.get('direction') not in ('UP','DOWN','WAIT'):raise ValueError('DIRECTION')
 if not isinstance(data.get('confidence'),(float,int)) or not 0<=data['confidence']<=1:raise ValueError('CONFIDENCE')
except Exception as e:
 print('PRO_PREFLIGHT_JSON_ERROR='+type(e).__name__);raise SystemExit(8)
print('PRO_PREFLIGHT_OK=true')
print('PRO_PREFLIGHT_RESPONSE_MODEL='+str(response.get('model','unknown'))[:70])
print('PRO_PREFLIGHT_LATENCY_MS='+str(latency))
print('PRO_PREFLIGHT_TOKENS='+str(response.get('usage',{}).get('total_tokens','unknown')))
print('PRO_PREFLIGHT_RESPONSE_VALID=true')
print('PRO_PREFLIGHT_ORDERS_SENT=false')
PY
"""
def main():
 cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
   access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
   endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 inv=cli.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  name='zl-deepseek-v4-pro-readonly-preflight',type='RunShellScript',
  working_user='root',command_content=SCRIPT,timeout=170)).body.invoke_id
 for _ in range(85):
  time.sleep(2)
  r=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
    instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=r.output or ''
   try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
   except Exception:pass
   print('PRO_PREFLIGHT_REMOTE='+str(r.invocation_status),'EXIT='+str(r.exit_code))
   print('\n'.join(x for x in raw.splitlines() if x.startswith('PRO_PREFLIGHT_'))[-2200:])
   return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 else 5
 print('PRO_PREFLIGHT_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

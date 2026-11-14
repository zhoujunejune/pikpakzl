#!/usr/bin/env python3
"""Read-only Binance Prediction market/detail diagnostics through Alibaba SWAS. No quote and no trade."""
import os,sys,re,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import os,json,urllib.request,urllib.parse,hmac,hashlib,time,subprocess,datetime
from pathlib import Path
UNIT='zl-prediction-trade'
pid=subprocess.check_output(['systemctl','show',UNIT,'--property=MainPID','--value'],text=True).strip()
assert pid.isdigit() and int(pid)>0,'TRADE_NOT_RUNNING'
keys={}
for v in (Path('/proc')/pid/'environ').read_bytes().split(b'\0'):
 if b'=' in v:
  key,val=v.split(b'=',1)
  if key in (b'BINANCE_PREDICTION_API_KEY',b'BINANCE_PREDICTION_API_SECRET'):
   keys[key.decode()]=val.decode()
api_key=keys.get('BINANCE_PREDICTION_API_KEY','')
secret=keys.get('BINANCE_PREDICTION_API_SECRET','')
if not api_key or not secret:
 print('DIAG_CREDENTIALS_MISSING=true')
 raise SystemExit(2)
def get(topic_id):
 qs=urllib.parse.urlencode({'marketTopicId':topic_id,'timestamp':int(time.time()*1000),'recvWindow':5000})
 sig=hmac.new(secret.encode(),qs.encode(),hashlib.sha256).hexdigest()
 url='https://api.binance.com/sapi/v1/w3w/wallet/prediction/market/detail?'+qs+'&signature='+sig
 request=urllib.request.Request(url,headers={'X-MBX-APIKEY':api_key,'Accept':'application/json'})
 try:
  with urllib.request.urlopen(request,timeout=12) as r:
   data=json.load(r);status=r.status
 except urllib.error.HTTPError as e:
  status=e.code
  try:data=json.load(e)
  except Exception:data={}
 except Exception as e:
  print('MARKET_FETCH_ERROR',topic_id,type(e).__name__)
  return
 if not isinstance(data,dict):data={}
 if isinstance(data.get('data'),dict):data=data['data']
 result={k:data.get(k) for k in ('marketTopicId','symbol','startDate','endDate','status','tradingStatus','marketStatus','title','slug','chainId','l1Category','l2Category','liquidity','volume') if k in data}
 result['httpStatus']=status;result['topicQueried']=topic_id
 if status!=200:
  result['errorCode']=data.get('code')
  result['errorText']=str(data.get('msg') or data.get('message') or '')[:130]
 rows=[]
 for m in data.get('markets') or []:
  if not isinstance(m,dict):continue
  z={k:m.get(k) for k in ('marketId','title','question','tradingStatus','status','liquidity','volume','price','lastPrice','marketExtId') if k in m}
  outcomes=[]
  for o in m.get('outcomes') or []:
   if not isinstance(o,dict):continue
   tid=str(o.get('tokenId') or '')
   outcomes.append({'name':o.get('name'),'tokenIdHash':hashlib.sha256(tid.encode()).hexdigest()[:12] if tid else None,
    'index':o.get('index'),'tradingStatus':o.get('tradingStatus')})
  z['outcomes']=outcomes
  rows.append(z)
 result['markets']=rows[:12]
 print('BINANCE_READONLY_DETAIL',json.dumps(result,ensure_ascii=False,separators=(',',':'))[:9000])
for topic in (7730501,7730446,7729900):
 get(topic)
print('FORENSICS_FINISHED=true')
PY
"""
def main():
 if not os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID') or not os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET'):
  print('ALIYUN_SECRETS_MISSING');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 i=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',type='RunShellScript',
  name='guardian-binance-market-detail-readonly',
  command_content=REMOTE,working_user='root',timeout=100)).body.invoke_id
 for _ in range(55):
  time.sleep(2)
  d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   invoke_id=i)).body.invocation_result
  if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
   except Exception:o='OUTPUT_DECODE_ERROR'
   print('FORENSICS_RUN',d.invocation_status,d.exit_code)
   print(o[-18000:])
   return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'FORENSICS_FINISHED=true' in o else 5
 print('FORENSICS_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

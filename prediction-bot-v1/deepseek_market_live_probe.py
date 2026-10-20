#!/usr/bin/env python3
"""Read-only proof of a genuine Alibaba BTC 5-minute market sample -> DeepSeek API decision.

Uses GitHub Actions secret only inside the runner; never sends it to SWAS,
persists no orders, and never prints secrets, request bodies or market prices.
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REGION = "ap-southeast-1"
INSTANCE = "b67374069bb3457ba6a3a2ede9305d3f"
READONLY = """#!/bin/bash
set -euo pipefail
python3 - <<'REMOTE'
import json,urllib.request,time
url='http://127.0.0.1:13003/api/shadow-market-data'
with urllib.request.urlopen(url,timeout=8) as r: raw=json.load(r)
now=int(time.time()*1000)
latest=raw.get('latest') or {}
e=latest.get('eventMs')
a=latest.get('roundStartMs')
if raw.get('ok') is not True or raw.get('symbol')!='BTCUSDT' or raw.get('readOnly') is not True:
 raise SystemExit('FEED_NOT_VERIFIED')
if not isinstance(e,(int,float)) or now-e>18000 or now-e< -1000:
 raise SystemExit('FEED_STALE')
if not isinstance(a,(int,float)) or int(a)!=(now//300000)*300000:
 raise SystemExit('FEED_WRONG_ROUND')
if not isinstance(latest.get('lastPrice'),(int,float)) or not isinstance(latest.get('roundOpenPrice'),(int,float)):
 raise SystemExit('FEED_PRICE_MISSING')
result={'round':int(a),'marketAt':int(e),'lastPrice':latest['lastPrice'],'roundOpenPrice':latest['roundOpenPrice'],
 'candles1m':(raw.get('candles') or {}).get('1m'),'candles5m':(raw.get('candles') or {}).get('5m')}
print(json.dumps(result,separators=(',',':'),ensure_ascii=False))
REMOTE
"""

def main():
    key=os.environ.get('DEEPSEEK_API_KEY','')
    if not key:sys.exit('DEEPSEEK_SECRET_NOT_SET')
    cli=Client(api.Config(
        access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
        access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
        endpoint='swas.ap-southeast-1.aliyuncs.com',region_id=REGION))
    invocation=cli.run_command(sw.RunCommandRequest(
        region_id=REGION,instance_id=INSTANCE,
        name='zl-deepseek-readonly-live-btc-probe',type='RunShellScript',
        working_user='root',command_content=READONLY,timeout=40)).body.invoke_id
    result=None
    for _ in range(24):
        time.sleep(2)
        r=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(
            region_id=REGION,instance_id=INSTANCE,invoke_id=invocation)).body.invocation_result
        if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
            if str(r.invocation_status)!='Success' or int(r.exit_code)!=0:
                print('LIVE_MARKET_PROBE_FAILED',str(r.invocation_status),'exit',r.exit_code)
                return 4
            result=r.output or ''
            break
    if result is None:print('LIVE_MARKET_PROBE_TIMEOUT');return 5
    market=None
    candidates=[result]
    try:candidates.insert(0,base64.b64decode(result,validate=True).decode('utf-8','replace'))
    except Exception:pass
    for raw in candidates:
        for line in reversed(raw.splitlines()):
            try:
                item=json.loads(line.strip())
                if isinstance(item,dict) and 'round' in item and 'marketAt' in item:
                    market=item
                    break
            except Exception:pass
        if market is not None:break
    if market is None:
        print('LIVE_MARKET_DECODE_FAILED')
        print('LIVE_MARKET_RAW_LENGTH',len(result))
        print('LIVE_MARKET_OUTPUT_LINES',len(result.splitlines()))
        print('LIVE_MARKET_BASE64_DECODABLE',len(candidates)>1)
        return 6
    print('LIVE_MARKET_SAMPLE_VALID=true')
    print('LIVE_MARKET_5M_ROUND',market['round'])
    body=json.dumps({
        'model':'deepseek-flash','max_tokens':256,
        'thinking':{'type':'disabled'},'response_format':{'type':'json_object'},
        'messages':[
          {'role':'system','content':'Predict BTCUSDT 5-minute direction using only provided current-round market data. Return one valid JSON object: {"direction":"UP or DOWN","confidence":0.5,"reason":"short explanation"}. Confidence is not calibrated.'},
          {'role':'user','content':json.dumps(market,separators=(',',':'),ensure_ascii=False)}
        ]
    }).encode()
    req=urllib.request.Request('https://api.deepseek.com/chat/completions',method='POST',
        data=body,headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=30) as response:
            data=json.load(response)
    except urllib.error.HTTPError as err:
        print('DEEPSEEK_LIVE_HTTP',err.code);return 7
    except Exception as exc:
        print('DEEPSEEK_LIVE_REQUEST_ERROR',type(exc).__name__);return 8
    try:
        response_text=data['choices'][0]['message']['content']
        decision=json.loads(response_text)
        direction=decision['direction']
        assert direction in ('UP','DOWN')
    except Exception:
        print('DEEPSEEK_LIVE_JSON_INVALID');return 9
    print('DEEPSEEK_LIVE_HTTP=200')
    print('DEEPSEEK_LIVE_DIRECTION',direction)
    print('DEEPSEEK_LIVE_MODEL',data.get('model','unknown'))
    print('DEEPSEEK_LIVE_TOKENS',data.get('usage',{}).get('total_tokens','unknown'))
    print('DEEPSEEK_LIVE_EXECUTED_ORDERS=false')
    print('DEEPSEEK_LIVE_SAMPLE_VERIFIED=true')
    return 0

if __name__=='__main__':
    try:sys.exit(main())
    except Exception as exc:
        print('LIVE_PROBE_ERROR',type(exc).__name__)
        sys.exit(10)

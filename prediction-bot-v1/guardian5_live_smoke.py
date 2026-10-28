#!/usr/bin/env python3
"""Authenticated public smoke: verify GUARDIAN belongs to single bot and cannot trade."""
import os,sys,json,base64,urllib.request,urllib.error,time
HOST='https://prediction.47-237-188-69.sslip.io'
pw=os.environ['ZL_PANEL_PASSWORD']
auth='Basic '+base64.b64encode(('zl:'+pw).encode()).decode()
def get(p,authorized=True):
 h={'Cache-Control':'no-store'}
 if authorized:h['Authorization']=auth
 req=urllib.request.Request(HOST+p,headers=h)
 try:
  with urllib.request.urlopen(req,timeout=16) as r:return r.status,r.read(800000)
 except urllib.error.HTTPError as e:return e.code,e.read(1000)
def main():
 assert get('/guardian/',False)[0]==401,'GUARDIAN_PUBLIC_AUTH_BYPASS'
 print('GUARDIAN_BASIC_AUTH_PRESERVED=true')
 code,body=get('/guardian/')
 assert code==200,('GUARDIAN_UI_HTTP',code)
 html=body.decode('utf8','replace')
 assert 'GUARDIAN' in html and '影子' in html
 print('GUARDIAN_PUBLIC_CHINESE_UI_OK=true')
 code,body=get('/guardian/api/status')
 assert code==200,('GUARDIAN_STATUS_HTTP',code)
 s=json.loads(body)
 assert s.get('ok') and s.get('model')=='ZL_GUARDIAN_5M_V1'
 assert s.get('configured') and s.get('readOnly') and s.get('orders') is False
 assert s.get('productionIntegration') is False and s.get('autoTP_SL') is False
 assert s.get('automaticTradeEligibility',{}).get('eligible') is False
 assert s.get('lastTickAt') and time.time()*1000-s['lastTickAt']<45000
 print('GUARDIAN_PUBLIC_SHADOW_STATUS_OK=true')
 print('GUARDIAN_LATEST_DIRECTION',s.get('latest',{}).get('direction'))
 print('GUARDIAN_LATEST_REASON',str(s.get('latest',{}).get('reason') or '-')[:170])
 print('GUARDIAN_RUNTIME_ERROR',str(s.get('error') or '-')[:130])
 print('GUARDIAN_CURRENT_SHADOW_SIGNALS',s.get('stats',{}).get('shadowPredictions'))
 code,body=get('/')
 assert code==200 and '5分钟单边预测' in body.decode('utf8','replace')
 print('GUARDIAN_ORIGINAL_SINGLE_PAGE_PRESERVED=true')
 code,body=get('/api/status')
 assert code==200
 d=json.loads(body);assert d.get('enabled') is False
 print('GUARDIAN_ORIGINAL_LIVE_SWITCH_STILL_OFF=true')
 print('GUARDIAN_ACTIVE_ROUTING_NAME',d.get('orderSignalModel'))
 print('GUARDIAN_STATUS_MODEL_READY',d.get('orderSignalModelReady'))
 assert d.get('orderSignal') is None,'LEGACY_ORDER_SIGNAL_STILL_EXPOSED'
 assert d.get('pendingAction') is None,'LEGACY_PENDING_ACTION'
 print('GUARDIAN_ONLY_ORDER_ROUTING_VERIFIED=true')
 sc,body=get('/api/order-signal-model')
 print('GUARDIAN_PRODUCTION_SELECTOR_HTTP',sc)
 try:
  parsed=json.loads(body)
  print('GUARDIAN_PRODUCTION_SELECTOR_RESULT',str({k:parsed.get(k) for k in ['model','ready','error','models']})[:700])
  assert sc==200 and parsed.get('model')=='ZL_GUARDIAN_5M_V1'
  assert parsed.get('ready') is True
  assert [x.get('id') for x in parsed.get('models',[])]==['ZL_GUARDIAN_5M_V1']
  print('GUARDIAN_SOLE_PRODUCTION_MODEL_CONFIRMED=true')
  c2,raw2=get('/api/status')
  d2=json.loads(raw2)
  print('GUARDIAN_RECHECK_MODEL',d2.get('orderSignalModel'),'READY',d2.get('orderSignalModelReady'))
  assert c2==200 and d2.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1' and d2.get('orderSignalModelReady') is True,'TRADE_STATUS_MODEL_NOT_READY'
 except json.JSONDecodeError:
  raise AssertionError('GUARDIAN_PRODUCTION_SELECTOR_JSON_INVALID')
 for p in ('/dual5','/event10/','/futures-lab/'):
  assert get(p)[0]==404,('RETIRED_ROUTE_RETURNED',p)
 for n in range(20):
  sc,raw=get('/api/order-signal-model')
  assert sc==200,('GUARDIAN_MODEL_UNSTABLE',n,sc)
  x=json.loads(raw)
  assert x.get('model')=='ZL_GUARDIAN_5M_V1' and x.get('ready') is True,('GUARDIAN_MODEL_CHANGED',n)
  sc,raw=get('/api/status')
  assert sc==200,('GUARDIAN_STATUS_UNSTABLE',n,sc)
  y=json.loads(raw)
  assert y.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1' and y.get('orderSignalModelReady') is True
  assert y.get('enabled') is False and y.get('orderSignal') is None
 print('GUARDIAN_40_CONSECUTIVE_PRODUCTION_API_READS_PASSED=true')
 print('GUARDIAN_NO_RETIRED_BOTS_REINTRODUCED=true')
 print('GUARDIAN_PUBLIC_SMOKE_PASSED=true')
if __name__=='__main__':
 try:sys.exit(main() or 0)
 except Exception as e:print('GUARDIAN_SMOKE_FAILED',str(e)[:260]);sys.exit(2)

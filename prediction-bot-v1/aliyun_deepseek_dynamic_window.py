#!/usr/bin/env python3
"""Migrate only already-live DeepSeek validation and trade deadline from 90 to 270 seconds.
No automatic arming of auto-follow. Strict rollback, no exchange orders from this script.
"""
import os,pathlib,shutil,subprocess,urllib.request,json,time,tempfile,sys
from datetime import datetime,timezone
ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
CHOICE=ROOT/'production-signal-choice.mjs'
WRAPPER=ROOT/'wrapper.mjs'
NODE='/opt/zl-prediction-node/bin/node'
def once(s,a,b,n):
 if s.count(a)!=1:raise RuntimeError('UNKNOWN_CODE_CONTEXT:'+n+':'+str(s.count(a)))
 return s.replace(a,b,1)
def get(port,route):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,route),timeout=12) as r:return json.load(r)
def run(*args):subprocess.run(args,check=True,timeout=65,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
def main():
 if os.geteuid()!=0:raise RuntimeError('NEED_ROOT')
 assert get(13001,'/api/order-signal-model').get('model')=='DEEPSEEK_5M_V1'
 model=get(13029,'/api/status')
 assert model.get('model')=='DEEPSEEK_5M_V1' and model.get('configured') is True
 assert model.get('reasoning',{}).get('enabled') is True
 assert model.get('featuresVersion')=='BTC_OHLCV_RSI_MACD_ATR_V2'
 original={p:p.read_text() for p in (CHOICE,WRAPPER)}
 c=original[CHOICE]
 c=once(c,'ts<round||ts>=round+285000||marketAt<round||marketAt>ts||',
        'ts<round||ts>=round+270000||marketAt<round||marketAt>ts||','signal-live-window')
 c=once(c,'ts-marketAt>40000||ts>now+250||now-ts>45000||',
        'ts-marketAt>90000||ts>now+250||now-ts>45000||','thinking-model-market-age')
 c=once(c,'body.generatedAt!==ts||body.expiryAt!==round+285000||',
        'body.generatedAt!==ts||body.expiryAt!==round+270000||','locked-signal-expiry')
 w=original[WRAPPER]
 w=once(w,'const SELECTIVE30_ORDER_DEADLINE_MS = 90000;',
        'const SELECTIVE30_ORDER_DEADLINE_MS = 270000;','dynamic-trade-deadline')
 w=once(w,'DeepSeek本轮第90秒订单提交窗口已截止',
        'DeepSeek本轮第270秒订单提交窗口已截止','deadline-label')
 updated={CHOICE:c,WRAPPER:w}
 with tempfile.TemporaryDirectory(prefix='deepseek-dynamic-stage-') as t:
  for p,s in updated.items():
   newpath=pathlib.Path(t)/p.name;newpath.write_text(s)
   run(NODE,'--check',str(newpath))
  print('DEEPSEEK_DYNAMIC_WINDOW_OFFLINE_VERIFIED=true',flush=True)
  if os.environ.get('DEEPSEEK_DYNAMIC_DRY_RUN')=='1':
   print('DEEPSEEK_DYNAMIC_DRY_RUN_PASSED=true',flush=True);return
  b=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/('deepseek-dynamic-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  b.mkdir(parents=True,exist_ok=False)
  for p in updated:shutil.copy2(p,b/p.name)
  written=[]
  try:
   for p,s in updated.items():
    st=p.stat();tmp=p.with_name(p.name+'.deepseek-window.tmp')
    tmp.write_text(s)
    os.chown(tmp,st.st_uid,st.st_gid);os.chmod(tmp,st.st_mode&0o777)
    os.replace(tmp,p);written.append(p)
   run('systemctl','restart','zl-prediction-trade.service')
   verified=False
   for _ in range(30):
    time.sleep(2)
    try:
     a=get(13001,'/api/order-signal-model')
     d=get(13001,'/api/direction-mode')
     s=get(13001,'/api/status')
     if (a.get('model')=='DEEPSEEK_5M_V1' and
         [x.get('id') for x in a.get('models',[])]==['DEEPSEEK_5M_V1'] and
         list(d.get('modes',{}))==['DEEPSEEK_5M_V1'] and
         s.get('orderSignalModel')=='DEEPSEEK_5M_V1'):
      verified=True;break
    except Exception:pass
   if not verified:raise RuntimeError('DYNAMIC_WINDOW_PRODUCTION_ROUTE_NOT_READY')
   assert subprocess.check_output(['systemctl','is-active','zl-futures-bot-paper'],text=True).strip()=='active'
   print('DEEPSEEK_DYNAMIC_ORDER_WINDOW_END_SEC=270',flush=True)
   print('DEEPSEEK_DYNAMIC_SIGNAL_EXPIRY_SEC=270',flush=True)
   print('DEEPSEEK_30S_FIXED_LOCK_REMOVED=true',flush=True)
   print('DEEPSEEK_TRADE_RECHECK_STILL_ACTIVE=true',flush=True)
   print('DEEPSEEK_CURRENT_AUTO_FOLLOW_ENABLED='+str(s.get('enabled')).lower(),flush=True)
   print('DEEPSEEK_FUTURES_UNCHANGED=true',flush=True)
  except BaseException:
   for p in written:shutil.copy2(b/p.name,p)
   subprocess.run(['systemctl','restart','zl-prediction-trade.service'],timeout=90)
   print('DEEPSEEK_DYNAMIC_ROLLBACK_ATTEMPTED=true',flush=True);raise
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('DEEPSEEK_DYNAMIC_WINDOW_ERROR',type(e).__name__,str(e)[:190]);sys.exit(1)

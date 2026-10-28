#!/usr/bin/env python3
"""Repair only the read-only legacy trade tiles for expired FAST5 signals.
No order logic, routes, direction, risk, balances or autotrade mutation.
"""
import os,sys,re,json,pathlib,tempfile,urllib.request,subprocess,shutil,time
from datetime import datetime,timezone
ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
FILE=ROOT/'fast5-dashboard-inject.mjs'
NODE='/opt/zl-prediction-node/bin/node'
VERSION='FAST5_PREWARM120_5S_V4'
MODEL='FAST5_SPOT_MOMENTUM_V1'
def run(*args):return subprocess.run(args,check=True,timeout=70,capture_output=True,text=True)
def get(p):
 with urllib.request.urlopen('http://127.0.0.1:13001'+p,timeout=7) as r:return r.read(950000)
def main():
 if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch('[0-9a-f]{40}',sys.argv[1]):
  raise RuntimeError('REQUIRE_PINNED_COMMIT_AND_AUTH')
 sha=sys.argv[1]
 if not FILE.is_file():raise RuntimeError('FAST5_UI_MISSING')
 current=FILE.read_text()
 if 'renderTradeTilesSnapshot' in current:
  print('FAST5_TRADE_TILES_PATCH_ALREADY_PRESENT=true');return
 for marker in ['FAST5 独立统计面板','/api/fast5-round-stats',
                '/api/fast5-direction-mode','zlFast5Card']:
  if marker not in current:raise RuntimeError('LIVE_UI_DRIFT_'+marker)
 status=json.loads(get('/api/status'))
 f5=json.loads(get('/api/fast5-live-status'))
 if status.get('enabled') is not False:raise RuntimeError('AUTOTRADING_ENABLED_ABORT')
 if status.get('orderSignalModel')!=MODEL or f5.get('strategyVersion')!=VERSION:
  raise RuntimeError('MODEL_VERSION_NOT_EXPECTED')
 with tempfile.TemporaryDirectory(prefix='fast5-trade-tile-') as t:
  new=pathlib.Path(t)/FILE.name
  url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/prediction-bot-v1/'+FILE.name
  with urllib.request.urlopen(url,timeout=35) as r:new.write_bytes(r.read())
  run(NODE,'--check',str(new))
  text=new.read_text()
  for marker in ['renderTradeTilesSnapshot','下单窗口结束（不可补单）','参考；未提交',
                 '/api/fast5-round-stats','/api/fast5-direction-mode','本轮0.1～5秒锁定']:
   if marker not in text:raise RuntimeError('NEW_UI_MISSING_'+marker)
  archive=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/(
    'fast5-trade-tiles-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  archive.mkdir(parents=True,exist_ok=False)
  backup=archive/FILE.name
  shutil.copy2(FILE,backup)
  st=FILE.stat();fd,temp=tempfile.mkstemp(prefix='.fast5-trade-tiles-',dir=str(FILE.parent))
  try:
   with os.fdopen(fd,'wb') as f:f.write(new.read_bytes())
   os.chmod(temp,st.st_mode&0o777);os.chown(temp,st.st_uid,st.st_gid)
   os.replace(temp,FILE)
  finally:
   if os.path.exists(temp):os.unlink(temp)
  try:
   run('systemctl','restart','zl-prediction-trade.service')
   success=False
   for _ in range(30):
    time.sleep(1)
    try:
     html=get('/').decode('utf8','replace')
     trade=json.loads(get('/api/status'))
     fast=json.loads(get('/api/fast5-live-status'))
     ledger=json.loads(get('/api/fast5-round-stats'))
     if ('renderTradeTilesSnapshot' in html and
       '下单窗口结束（不可补单）' in html and
       '参考；未提交' in html and
       'FAST5 独立统计面板' in html and
       ledger.get('schema')=='FAST5_INDEPENDENT_OFFICIAL_ROUND_LEDGER_V1' and
       fast.get('strategyVersion')==VERSION and
       trade.get('enabled') is False and
       trade.get('orderSignalModel')==MODEL):
      success=True;break
    except Exception:pass
   if not success:raise RuntimeError('POSTDEPLOY_UI_NOT_VERIFIED')
   print('FAST5_TRADE_TILES_SHOW_LOCKED_HISTORY=true',flush=True)
   print('FAST5_TRADE_TILES_EXPIRED_ORDER_MARKED_NOT_EXECUTABLE=true',flush=True)
   print('FAST5_TRADE_TILES_REAL_ORDER_PIPELINE_UNCHANGED=true',flush=True)
   print('FAST5_TRADE_TILES_AUTO_FOLLOW_OFF=true',flush=True)
   print('FAST5_TRADE_TILES_STATS_PRESERVED=true',flush=True)
   print('FAST5_TRADE_TILES_BACKUP='+str(backup),flush=True)
  except BaseException:
   shutil.copy2(backup,FILE)
   subprocess.run(['systemctl','restart','zl-prediction-trade.service'],timeout=75)
   print('FAST5_TRADE_TILES_ROLLBACK_ATTEMPTED=true',flush=True)
   raise
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('FAST5_TRADE_TILES_REPAIR_FAILED',type(e).__name__,str(e)[:240],flush=True)
  sys.exit(1)

#!/usr/bin/env python3
"""Guarded UI-only restoration of FAST5 stats: no trading/model/API changes."""
import json,os,re,pathlib,sys,subprocess,shutil,tempfile,urllib.request,time
from datetime import datetime,timezone
ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
UI=ROOT/'fast5-dashboard-inject.mjs'
MODEL='FAST5_SPOT_MOMENTUM_V1'
V4='FAST5_PREWARM120_5S_V4'
NODE='/opt/zl-prediction-node/bin/node'
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=8) as response:
  return response.read(1000000)
def j(path):return json.loads(get(path))
def cp(s,d):shutil.copy2(s,d)
def run(*cmd):return subprocess.run(cmd,check=True,timeout=65,capture_output=True,text=True)
def main():
 if os.geteuid()!=0:raise RuntimeError('AUTHORIZED_ROOT_REQUIRED')
 if len(sys.argv)!=2 or not re.fullmatch('[a-f0-9]{40}',sys.argv[1]):
  raise RuntimeError('PINNED_COMMIT_REQUIRED')
 commit=sys.argv[1]
 if not UI.is_file() or not (ROOT/'panel-stats-shell.mjs').is_file():
  raise RuntimeError('EXISTING_UI_MISSING')
 if 'injectFast5Dashboard' not in (ROOT/'panel-stats-shell.mjs').read_text():
  raise RuntimeError('WRONG_ACTIVE_PANEL_INJECTOR')
 if run('systemctl','is-active','zl-prediction-trade').stdout.strip()!='active':
  raise RuntimeError('TRADE_SERVER_DOWN')
 trade=j('/api/status');signal=j('/api/fast5-live-status')
 if trade.get('enabled') is not False:raise RuntimeError('AUTO_FOLLOW_NOT_OFF')
 if trade.get('orderSignalModel')!=MODEL or signal.get('strategyVersion')!=V4:
  raise RuntimeError('FAST5_V4_MODEL_NOT_CONFIRMED')
 current=UI.read_text()
 if 'FAST5 独立统计面板' in current:
  print('F5_STATS_ALREADY_RESTORED=true',flush=True);return
 if 'FAST5 独立统计' not in current or 'zlF5Card' not in current:
  raise RuntimeError('FRONTEND_BASELINE_DRIFT')
 with tempfile.TemporaryDirectory(prefix='f5-stats-panel-') as work:
  dest=pathlib.Path(work)/UI.name
  url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+commit+'/prediction-bot-v1/'+UI.name
  with urllib.request.urlopen(url,timeout=35) as response:dest.write_bytes(response.read())
  run(NODE,'--check',str(dest))
  text=dest.read_text()
  for expected in ['FAST5 独立统计面板','zlF5StatAccuracy','zlF5OfficialRows','/api/round-stats',
                   '本轮0.1～5秒锁定']:
   if expected not in text:raise RuntimeError('MISSING_REQUIRED_UI_'+expected[:20])
  backup=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/(
   'fast5-stat-panel-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  cp(UI,backup/UI.name)
  backupfile=backup/UI.name
  st=UI.stat()
  fd,filename=tempfile.mkstemp(prefix='.f5-stats-',dir=str(UI.parent))
  try:
   with os.fdopen(fd,'wb') as f:f.write(dest.read_bytes())
   os.chmod(filename,st.st_mode&0o777);os.chown(filename,st.st_uid,st.st_gid)
   os.replace(filename,UI)
  finally:
   if os.path.exists(filename):os.unlink(filename)
  try:
   run('systemctl','restart','zl-prediction-trade.service')
   ok=False
   for _ in range(25):
    time.sleep(1.2)
    try:
     html=get('/').decode('utf8','replace')
     settlement=j('/api/round-stats');t=j('/api/status');sig=j('/api/fast5-live-status')
     if ('FAST5 独立统计面板' in html and 'zlF5StatAccuracy' in html and
         'zlF5OfficialRows' in html and settlement.get('ok') is True and
         isinstance(settlement.get('records'),list) and
         sig.get('strategyVersion')==V4 and t.get('enabled') is False and
         t.get('orderSignalModel')==MODEL):
      ok=True;break
    except Exception:pass
   if not ok:raise RuntimeError('FAST5_STATS_FRONTEND_NOT_VERIFIED')
   print('FAST5_STATS_PANEL_RESTORED=true',flush=True)
   print('FAST5_STATS_OFFICIAL_SETTLEMENT_AVAILABLE=true',flush=True)
   print('FAST5_STATS_OTHER_MODELS_NOT_MIXED=true',flush=True)
   print('FAST5_STATS_SIGNAL_MODEL_STILL_V4=true',flush=True)
   print('FAST5_STATS_AUTO_FOLLOW_OFF=true',flush=True)
   print('FAST5_STATS_UI_BACKUP='+str(backupfile),flush=True)
  except BaseException:
   cp(backupfile,UI)
   subprocess.run(['systemctl','restart','zl-prediction-trade.service'],timeout=70)
   print('FAST5_STATS_UI_ROLLBACK_ATTEMPTED=true',flush=True)
   raise
if __name__=='__main__':
 try:main()
 except Exception as error:
  print('FAST5_STATS_RESTORE_FAILED',type(error).__name__,str(error)[:250],flush=True)
  sys.exit(1)

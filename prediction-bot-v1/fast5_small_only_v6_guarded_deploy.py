#!/usr/bin/env python3
"""Atomic V6 small-only signal strategy and independent winrate reset.
No trade placement. Abort while live follow enabled/pending. Original V5 ledger archived.
"""
import os,sys,re,json,sqlite3,pathlib,shutil,subprocess,tempfile,urllib.request,time
from datetime import datetime,timezone
ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
SIDE=pathlib.Path('/opt/zl-prediction-fast5')
CHOICE=ROOT/'production-signal-choice.mjs'
CALC=SIDE/'fast5-real-market-calculator.mjs'
UI=ROOT/'fast5-dashboard-inject.mjs'
STATS=SIDE/'fast5_independent_stats_service.py'
DB=pathlib.Path('/var/lib/zl-prediction/fast5-stats/rounds.sqlite3')
UNIT_FAST='zl-prediction-fast5.service'
UNIT_TRADE='zl-prediction-trade.service'
UNIT_STATS='zl-prediction-fast5-stats.service'
MODEL='FAST5_SPOT_MOMENTUM_V1'
OLD='FAST5_REGIME_FLIP_GT5BPS_15M_V5'
NEW='FAST5_SMALL_ONLY_LE5BPS_15M_V6'
REGIME='REGIME_PREV15_CLOSED_1M_NET_BPS_V1'
NODE='/opt/zl-prediction-node/bin/node'
PATHS=[CALC,CHOICE,UI,STATS]
def run(*cmd,timeout=80):
 return subprocess.run(cmd,timeout=timeout,check=True,text=True,capture_output=True)
def data(port,path):
 with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=8) as r:return json.load(r)
def guarded_install(dest,raw):
 st=dest.stat();fd,name=tempfile.mkstemp(dir=str(dest.parent),prefix='.fast5-regime-')
 try:
  with os.fdopen(fd,'wb') as f:f.write(raw)
  os.chmod(name,st.st_mode&0o777)
  os.chown(name,st.st_uid,st.st_gid)
  os.replace(name,dest)
 finally:
  if os.path.exists(name):os.unlink(name)
def patch_validator(text):
 marker='\nexport function validateFast5ProductionLive(body,now=Date.now()){'
 if text.count(marker)!=1:raise RuntimeError('VALIDATOR_ENTRY_DRIFT')
 p=text.index(marker)
 head,tail=text[:p],text[p:]
 if OLD not in tail or 'REGIME_PREV15_CLOSED_1M_NET_BPS_V1' not in tail:
  raise RuntimeError('EXPECTED_V5_VALIDATOR_NOT_FOUND')
 if '\nexport ' in tail[len(marker):]:raise RuntimeError('VALIDATOR_NOT_LAST_EXPORT')
 tail=tail.replace(OLD,NEW)
 pairs=[
  ("!['SMALL','MEDIUM','LARGE'].includes(lock.regime)||","lock.regime!=='SMALL'||"),
  ("lock.invertByRegime!==(lock.regime!=='SMALL')||","lock.invertByRegime!==false||"),
  ("lock.direction!==(lock.invertByRegime?\n     (lock.originalDirection==='UP'?'DOWN':'UP'):lock.originalDirection)||",
   "lock.direction!==lock.originalDirection||")
 ]
 for before,after in pairs:
  if tail.count(before)!=1:raise RuntimeError('V5_VALIDATOR_EXPECTED_PATTERN_MISSING_'+before[:38])
  tail=tail.replace(before,after,1)
 if "lock.regime!=='SMALL'||" not in tail or 'lock.direction!==lock.originalDirection||' not in tail:
  raise RuntimeError('V6_SMALL_ONLY_VALIDATOR_NOT_ENFORCED')
 return head+tail

def main():
 if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch(r'[0-9a-f]{40}',sys.argv[1]):
  raise RuntimeError('ROOT_AND_PINNED_COMMIT_REQUIRED')
 sha=sys.argv[1]
 for p in PATHS:
  if not p.is_file():raise RuntimeError('SOURCE_FILE_MISSING_'+str(p))
 for unit in (UNIT_FAST,UNIT_TRADE,UNIT_STATS):
  if run('systemctl','is-active',unit).stdout.strip()!='active':
   raise RuntimeError('SERVICE_INACTIVE_'+unit)
 initial=data(13001,'/api/status')
 signal=data(13046,'/api/status')
 oldstats=data(13047,'/api/round-stats')
 directions=data(13001,'/api/direction-mode')
 if initial.get('enabled') is not False:raise RuntimeError('AUTO_FOLLOW_MUST_BE_OFF')
 if (initial.get('pendingAction') or {}).get('state') in (
  'READY','QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN'):
  raise RuntimeError('PENDING_REAL_ORDER_BLOCKS_DEPLOY')
 if initial.get('orderSignalModel')!=MODEL or signal.get('strategyVersion')!=OLD:
  raise RuntimeError('NOT_EXPECTED_V5_PRODUCTION')
 if oldstats.get('strategyVersion')!=OLD or oldstats.get('schema')!='FAST5_INDEPENDENT_OFFICIAL_ROUND_LEDGER_V1':
  raise RuntimeError('V5_STATS_NOT_READY')
 old_modes=(directions.get('modes') or {}).get(MODEL)
 if not isinstance(old_modes,dict):raise RuntimeError('DIRECTION_MODES_UNKNOWN')
 if not DB.is_file():raise RuntimeError('PERSISTENT_LEDGER_MISSING')
 revision=directions.get('revision')
 with tempfile.TemporaryDirectory(prefix='fast5-v6-staging-') as td:
  temp=pathlib.Path(td)
  target={CALC:'fast5-real-market-calculator.mjs',
          UI:'fast5-dashboard-inject.mjs',
          STATS:'fast5_independent_stats_service.py'}
  staged={}
  for p,name in target.items():
   url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/prediction-bot-v1/'+name
   with urllib.request.urlopen(url,timeout=35) as r:raw=r.read()
   staged[p]=raw
   dest=temp/name;dest.write_bytes(raw)
   if name.endswith('.mjs'):run(NODE,'--check',str(dest))
   else:run('python3','-m','py_compile',str(dest))
  staged[CHOICE]=patch_validator(CHOICE.read_text()).encode()
  choice_path=temp/'production-signal-choice.mjs'
  choice_path.write_bytes(staged[CHOICE])
  run(NODE,'--check',str(choice_path))
  c=staged[CALC].decode()
  u=staged[UI].decode()
  w=staged[STATS].decode()
  if ('REGIME_PREV15_CLOSED_1M_NET_BPS_V1' not in c or NEW not in c or
      "REGIME_VERSION" not in c or "classifyPreRoundRegime" not in c):
   raise RuntimeError('INCORRECT_V6_CLASSIFIER')
  if (NEW not in w or 'FAST5_INDEPENDENT_OFFICIAL_ROUND_LEDGER_V1' not in w or
      'FAST5独立账本' not in u or 'regimeMagnitudeBps' not in u or
      '/api/fast5-round-stats' not in u):
   raise RuntimeError('V6_UI_OR_LEDGER_WRONG')
  # Recheck before any filesystem mutation.
  current=data(13001,'/api/status')
  modes=data(13001,'/api/direction-mode')
  if current.get('enabled') is not False or modes.get('revision')!=revision or (
   modes.get('modes') or {}).get(MODEL)!=old_modes:
   raise RuntimeError('TRADE_MODE_CHANGED_DURING_STAGE')
  backup=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/(
    'fast5-v6-regime-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  for p in PATHS:shutil.copy2(p,backup/p.name)
  archive=backup/'fast5-v5-archive.sqlite3'
  src=sqlite3.connect(str(DB),timeout=10)
  dst=sqlite3.connect(str(archive),timeout=10)
  try:
   src.backup(dst)
   sanity=dst.execute('PRAGMA integrity_check').fetchone()[0]
   if sanity!='ok':raise RuntimeError('STATS_BACKUP_INTEGRITY_BAD')
  finally:dst.close();src.close()
  if archive.stat().st_size<4096:raise RuntimeError('EMPTY_ARCHIVE_REFUSED')
  modified=False;reset=False
  try:
   run('systemctl','stop',UNIT_STATS,timeout=40)
   # Old WAL/SHM no longer needed once archived via the SQLite backup API.
   for suffix in ('','-wal','-shm'):
    p=pathlib.Path(str(DB)+suffix)
    if p.exists():p.unlink()
   reset=True
   for p,raw in staged.items():guarded_install(p,raw)
   modified=True
   run('systemctl','restart',UNIT_FAST,timeout=55)
   run('systemctl','restart',UNIT_TRADE,timeout=80)
   run('systemctl','start',UNIT_STATS,timeout=55)
   valid=False
   for _ in range(45):
    time.sleep(.8)
    try:
     f=data(13046,'/api/status')
     t=data(13001,'/api/status')
     d=data(13001,'/api/direction-mode')
     l=data(13047,'/api/round-stats')
     page=urllib.request.urlopen('http://127.0.0.1:13001/',timeout=8).read().decode('utf8','replace')
     if (f.get('strategyVersion')==NEW and f.get('model')==MODEL and
       t.get('orderSignalModel')==MODEL and t.get('enabled') is False and
       l.get('strategyVersion')==NEW and l.get('persisted') is True and
       l.get('summary',{}).get('total',999)<=1 and
       all(x.get('version')==NEW for x in l.get('rows',[])) and
       d.get('revision')==revision and (d.get('modes') or {}).get(MODEL)==old_modes and
       '波动分层V5' in page and 'id="zlF5HistoryScroll"' in page and
       '/api/fast5-round-stats' in page and l.get('health',{}).get('signalError') is None):
      valid=True;break
    except Exception:pass
   if not valid:raise RuntimeError('V6_POSTDEPLOY_VERIFICATION_FAILED')
   for unit in (UNIT_FAST,UNIT_TRADE,UNIT_STATS):
    if run('systemctl','is-active',unit).stdout.strip()!='active':
     raise RuntimeError('SERVICE_NOT_ACTIVE_AFTER_DEPLOY_'+unit)
   print('V6_DEPLOY_SUCCESS=true',flush=True)
   print('V6_PRODUCTION_STRATEGY='+NEW,flush=True)
   print('V6_15M_REGIME_RULE=SMALL_LE_5_BPS_KEEP_OTHER_FLIP',flush=True)
   print('V6_DIRECTION_UNCHANGED='+json.dumps(old_modes),flush=True)
   print('V6_STATS_PREVIOUS='+json.dumps(oldstats.get('summary',{})),flush=True)
   print('V6_STATS_RESTARTED='+json.dumps(l.get('summary',{})),flush=True)
   print('V6_STATS_V5_ARCHIVED='+str(archive),flush=True)
   print('V6_AUTOFOLLOW_REMAINS_OFF=true',flush=True)
  except BaseException:
   print('V6_ROLLBACK_BEGIN=true',flush=True)
   subprocess.run(['systemctl','stop',UNIT_STATS],timeout=40)
   for p in PATHS:shutil.copy2(backup/p.name,p)
   if reset:
    for suffix in ('','-wal','-shm'):
     p=pathlib.Path(str(DB)+suffix)
     if p.exists():p.unlink()
    shutil.copy2(archive,DB)
   subprocess.run(['systemctl','restart',UNIT_FAST],timeout=55)
   subprocess.run(['systemctl','restart',UNIT_TRADE],timeout=80)
   subprocess.run(['systemctl','start',UNIT_STATS],timeout=55)
   print('V6_ROLLBACK_ATTEMPTED=true',flush=True)
   raise
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('V6_RELEASE_FAILED',type(e).__name__,str(e)[:300],flush=True)
  sys.exit(1)

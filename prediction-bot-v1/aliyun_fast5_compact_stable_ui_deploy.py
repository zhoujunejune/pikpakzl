#!/usr/bin/env python3
"""Guarded FAST5 UI layout and anti-flicker rollout.
Only replaces fast5-dashboard-inject.mjs and wrapper.mjs.
Does not change trading engine, signal algorithm, API, ledger, controls or credentials.
"""
import json,os,re,pathlib,sys,subprocess,shutil,tempfile,urllib.request,time
from datetime import datetime,timezone
ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
FILES={
 ROOT/'fast5-dashboard-inject.mjs':'prediction-bot-v1/fast5-dashboard-inject.mjs',
 ROOT/'wrapper.mjs':'railway-diagnostic/wrapper.mjs'}
NODE='/opt/zl-prediction-node/bin/node'
MODEL='FAST5_SPOT_MOMENTUM_V1'
VERSION='FAST5_PREWARM120_5S_V4'
UNIT='zl-prediction-trade.service'
def run(*args,timeout=75):
 return subprocess.run(args,check=True,timeout=timeout,capture_output=True,text=True)
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=8) as r:return r.read(1800000)
def js(path):return json.loads(get(path))
def atomic(path,data):
 st=path.stat()
 fd,p=tempfile.mkstemp(dir=str(path.parent),prefix='.fast5-stable-ui-')
 try:
  with os.fdopen(fd,'wb') as out:out.write(data)
  os.chmod(p,st.st_mode&0o777);os.chown(p,st.st_uid,st.st_gid)
  os.replace(p,path)
 finally:
  if os.path.exists(p):os.unlink(p)
def main():
 if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch('[a-f0-9]{40}',sys.argv[1]):
  raise RuntimeError('ROOT_AND_PINNED_COMMIT_REQUIRED')
 sha=sys.argv[1]
 for f in FILES:
  if not f.is_file():raise RuntimeError('LIVE_SOURCE_MISSING_'+f.name)
 status=js('/api/status')
 sig=js('/api/fast5-live-status')
 directions=js('/api/direction-mode')
 stats=js('/api/fast5-round-stats')
 if (status.get('enabled') is not False or
     (status.get('pendingAction') or {}).get('state') in
       ('READY','QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN')):
  raise RuntimeError('LIVE_ORDER_OR_AUTOFOLLOW_ACTIVE_ABORT')
 if status.get('orderSignalModel')!=MODEL or sig.get('strategyVersion')!=VERSION:
  raise RuntimeError('FAST5_PRODUCTION_ROUTE_NOT_V4')
 if stats.get('schema')!='FAST5_INDEPENDENT_OFFICIAL_ROUND_LEDGER_V1':
  raise RuntimeError('FAST5_STATS_LEDGER_NOT_READY')
 originals={p:p.read_bytes() for p in FILES}
 # Existing frontend assets may have been updated independently.
 # Always stage both pinned versions, backup both originals, verify and roll back
 # as one unit. A partial prior update is not a reason to leave the UI broken.
 if 'zlFast5Card' not in originals[ROOT/'fast5-dashboard-inject.mjs'].decode():
  raise RuntimeError('FAST5_CURRENT_UI_BASELINE_UNKNOWN')
 if 'panel-client.js' not in originals[ROOT/'wrapper.mjs'].decode():
  raise RuntimeError('TRADE_WRAPPER_BASELINE_UNKNOWN')
 with tempfile.TemporaryDirectory(prefix='fast5-stable-ui-release-') as td:
  stage=pathlib.Path(td);downloads={}
  for dest,path in FILES.items():
   url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/'+path
   with urllib.request.urlopen(url,timeout=35) as r:content=r.read()
   downloads[dest]=content
   target=stage/dest.name;target.write_bytes(content)
   run(NODE,'--check',str(target))
  f5=downloads[ROOT/'fast5-dashboard-inject.mjs'].decode()
  wrapper=downloads[ROOT/'wrapper.mjs'].decode()
  for requirement in ('id="zlF5HistoryScroll"','height:300px;max-height:300px',
      'scroll.scrollTop=previousScroll','fingerprint!==statsRowsFingerprint',
      "setInterval(load,1800)","/api/fast5-round-stats",'/api/fast5-direction-mode'):
   if requirement not in f5:raise RuntimeError('LAYOUT_CODE_MISSING_'+requirement[:50])
  for requirement in ("if(n&&n.textContent!==next)","if(n&&n.innerHTML!==v)",
                      "if(refreshPending||document.hidden)return","/panel-client.js?v=9"):
   if requirement not in wrapper:raise RuntimeError('WRAPPER_CODE_MISSING_'+requirement)
  if js('/api/status').get('enabled') is not False:raise RuntimeError('AUTOTRADE_CHANGED_ABORT')
  backup=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/(
    'fast5-compact-stable-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  for path in FILES:shutil.copy2(path,backup/path.name)
  try:
   for file,data in downloads.items():atomic(file,data)
   run('systemctl','restart',UNIT,timeout=95)
   verified=False
   for _ in range(35):
    time.sleep(1)
    try:
     html=get('/').decode('utf8','replace')
     script=get('/panel-client.js?v=9').decode('utf8','replace')
     tr=js('/api/status')
     f=js('/api/fast5-live-status')
     d=js('/api/direction-mode')
     s=js('/api/fast5-round-stats')
     if (('id="zlF5HistoryScroll"' in html and 'height:300px;max-height:300px' in html and
          'scroll.scrollTop=previousScroll' in html and
          'setInterval(load,1800)' in html and
          '/panel-client.js?v=9' in html and
          "if(n&&n.innerHTML!==v)" in script and
          "if(refreshPending||document.hidden)return" in script and
          tr.get('enabled') is False and tr.get('orderSignalModel')==MODEL and
          f.get('strategyVersion')==VERSION and
          d.get('revision')==directions.get('revision') and
          d.get('modes')==directions.get('modes') and
          s.get('schema')=='FAST5_INDEPENDENT_OFFICIAL_ROUND_LEDGER_V1' and
          s.get('persisted') is True)):
      verified=True;break
    except Exception:pass
   if not verified:raise RuntimeError('FAST5_STABLE_UI_LIVE_VALIDATION_FAILED')
   if run('systemctl','is-active','zl-prediction-trade').stdout.strip()!='active':
    raise RuntimeError('TRADE_SERVICE_NOT_ACTIVE')
   print('FAST5_COMPACT_HISTORY_FIXED_HEIGHT_300PX=true',flush=True)
   print('FAST5_HISTORY_SCROLL_INDEPENDENT=true',flush=True)
   print('FAST5_ANTI_FLICKER_DEDUPED_UPDATES=true',flush=True)
   print('FAST5_TRADE_PANEL_CACHE_BUST_V9=true',flush=True)
   print('FAST5_NO_MODEL_OR_ORDER_CHANGES=true',flush=True)
   print('FAST5_AUTOFOLLOW_UNCHANGED_OFF=true',flush=True)
   print('FAST5_DIRECTION_REVISION_UNCHANGED=true',flush=True)
   print('FAST5_LEDGER_PRESERVED=true',flush=True)
   print('FAST5_STABLE_UI_BACKUP='+str(backup),flush=True)
  except BaseException:
   print('FAST5_STABLE_UI_ROLLBACK_START=true',flush=True)
   for path in FILES:shutil.copy2(backup/path.name,path)
   subprocess.run(['systemctl','restart',UNIT],timeout=85)
   print('FAST5_STABLE_UI_ROLLBACK_ATTEMPTED=true',flush=True)
   raise
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('FAST5_STABLE_UI_DEPLOY_FAILED',type(e).__name__,str(e)[:250],flush=True)
  sys.exit(1)

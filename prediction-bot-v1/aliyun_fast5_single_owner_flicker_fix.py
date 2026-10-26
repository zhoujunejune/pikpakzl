#!/usr/bin/env python3
"""Single-owner FAST5 trading-tile flicker hotfix. UI only.
Replaces wrapper.mjs while preserving independent FAST5 stats and read-only
historical tiles, without changing trade engine or submitting an order.
"""
import os,sys,re,json,pathlib,tempfile,urllib.request,subprocess,shutil,time
from datetime import datetime,timezone
ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
WRAPPER=ROOT/'wrapper.mjs'
UNIT='zl-prediction-trade.service'
NODE='/opt/zl-prediction-node/bin/node'
MODEL='FAST5_SPOT_MOMENTUM_V1'
VERSION='FAST5_PREWARM120_5S_V4'
GUARD="if(j.orderSignalModel!=='FAST5_SPOT_MOMENTUM_V1'||(s.status==='LOCKED'&&s.round!=null))"
def run(*args,timeout=75):
 return subprocess.run(args,check=True,timeout=timeout,capture_output=True,text=True)
def read(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=9) as r:return r.read(1200000)
def get(path):return json.loads(read(path))
def replace_atomic(path,data):
 st=path.stat()
 fd,p=tempfile.mkstemp(dir=str(path.parent),prefix='.fast5-single-owner-')
 try:
  with os.fdopen(fd,'wb') as o:o.write(data)
  os.chmod(p,st.st_mode&0o777);os.chown(p,st.st_uid,st.st_gid)
  os.replace(p,path)
 finally:
  if os.path.exists(p):os.unlink(p)
def verify_runtime(expected_enabled):
 html=read('/').decode('utf8','replace')
 js=read('/panel-client.js?v=10').decode('utf8','replace')
 trade=get('/api/status');fast=get('/api/fast5-live-status')
 stats=get('/api/fast5-round-stats')
 return (
  '/panel-client.js?v=10' in html and
  GUARD in js and 'function refresh()' in js and
  'renderTradeTilesSnapshot' in html and
  'id="zlF5HistoryScroll"' in html and
  'height:300px;max-height:300px' in html and
  stats.get('schema')=='FAST5_INDEPENDENT_OFFICIAL_ROUND_LEDGER_V1' and
  stats.get('persisted') is True and
  trade.get('enabled') is expected_enabled and
  trade.get('orderSignalModel')==MODEL and
  fast.get('strategyVersion')==VERSION)
def main():
 if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch('[a-f0-9]{40}',sys.argv[1]):
  raise RuntimeError('ROOT_AND_PINNED_SHA_REQUIRED')
 sha=sys.argv[1]
 if not WRAPPER.is_file():raise RuntimeError('WRAPPER_MISSING')
 state=get('/api/status');fast=get('/api/fast5-live-status')
 enabled=state.get('enabled')
 if enabled is not True and enabled is not False:
  raise RuntimeError('AUTO_FOLLOW_STATE_UNAVAILABLE')
 if (state.get('pendingAction') or {}).get('state') in (
  'READY','QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN'):
  raise RuntimeError('PENDING_ORDER_UI_RESTART_BLOCKED')
 if state.get('orderSignalModel')!=MODEL or fast.get('strategyVersion')!=VERSION:
  raise RuntimeError('WRONG_PRODUCTION_FAST5_MODEL')
 old=WRAPPER.read_text()
 if 'panel-client.js?v=9' not in old and 'panel-client.js?v=10' not in old:
  raise RuntimeError('UNEXPECTED_CLIENT_SCRIPT_VERSION')
 if GUARD in old and '/panel-client.js?v=10' in old and verify_runtime(enabled):
  print('FAST5_SINGLE_OWNER_ALREADY_LIVE=true',flush=True);return
 with tempfile.TemporaryDirectory(prefix='fast5-single-owner-') as td:
  new=pathlib.Path(td)/'wrapper.mjs'
  url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/railway-diagnostic/wrapper.mjs'
  with urllib.request.urlopen(url,timeout=35) as r:new.write_bytes(r.read())
  run(NODE,'--check',str(new))
  incoming=new.read_text()
  for term in (GUARD,'/panel-client.js?v=10',
      "if(refreshPending||document.hidden)return",
      "if(n&&n.innerHTML!==v)"):
   if term not in incoming:raise RuntimeError('STAGED_WRAPPER_MISSING_'+term[:35])
  # Validate only the desired 5 tiles are inside the exclusive ownership guard.
  block=incoming.split(GUARD,1)[1].split("text('amountView'",1)[0]
  for call in ("text('round'","text('status'","text('direction'",
               "text('orderDirection'","text('score'"):
   if call not in block:raise RuntimeError('TILE_PROTECTION_MISSING_'+call)
  backup=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/(
   'fast5-single-owner-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  saved=backup/'wrapper.mjs'
  shutil.copy2(WRAPPER,saved)
  modified=False
  try:
   # Do not interrupt the first 20s order window or any pending order.
   # When auto-follow is ON, execute only in an idle 70s-180s interval,
   # with at least two minutes until the next round begins.
   started=time.monotonic()
   while True:
    active=get('/api/status')
    if active.get('enabled') is not enabled:
     raise RuntimeError('AUTO_FOLLOW_STATE_CHANGED_DURING_STAGING')
    pending=active.get('pendingAction')
    if pending is not None:
     raise RuntimeError('PENDING_ORDER_UI_RESTART_BLOCKED')
    current_ms=int(time.time()*1000)
    into=current_ms%300000
    if enabled is False or (70000<=into<=180000):
     break
    if time.monotonic()-started>215:
     raise RuntimeError('NO_SAFE_ROUND_MAINTENANCE_WINDOW')
    time.sleep(4)
   print('FAST5_UI_MAINTENANCE_ELAPSED_MS='+str(into),flush=True)
   modified=True
   replace_atomic(WRAPPER,new.read_bytes())
   run('systemctl','restart',UNIT,timeout=95)
   good=False
   for _ in range(35):
    time.sleep(1)
    try:
     if verify_runtime(enabled):
      good=True;break
    except Exception:pass
   if not good:raise RuntimeError('BROWSER_SCRIPT_OR_SERVER_VERIFICATION_FAILED')
   if run('systemctl','is-active',UNIT).stdout.strip()!='active':
    raise RuntimeError('TRADE_SERVICE_INACTIVE')
   print('FAST5_SINGLE_DOM_OWNER_FIX_LIVE=true',flush=True)
   print('FAST5_EXPIRED_LOCK_NO_LONGER_OVERWRITTEN_WITH_DASH=true',flush=True)
   print('FAST5_LIVE_LOCK_ORDER_TILE_PATH_PRESERVED=true',flush=True)
   print('FAST5_BROWSER_CLIENT_SCRIPT_V10=true',flush=True)
   print('FAST5_STATS_300PX_SCROLL_PRESERVED=true',flush=True)
   print('FAST5_NO_TRADE_LOGIC_MODIFIED=true',flush=True)
   print('FAST5_AUTO_FOLLOW_UNCHANGED='+str(enabled).lower(),flush=True)
   print('FAST5_BACKUP='+str(saved),flush=True)
  except BaseException:
   if modified:
    shutil.copy2(saved,WRAPPER)
    subprocess.run(['systemctl','restart',UNIT],timeout=90)
    print('FAST5_SINGLE_OWNER_ROLLBACK_ATTEMPTED=true',flush=True)
   else:
    print('FAST5_SINGLE_OWNER_SAFETY_ABORT_WITHOUT_RESTART=true',flush=True)
   raise
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('FAST5_SINGLE_OWNER_RELEASE_FAILED',type(e).__name__,str(e)[:240],flush=True)
  sys.exit(1)

#!/usr/bin/env python3
"""Deploy persistent, independent FAST5 round ledger and restore live statistics.
Guard: live FAST5 V4 and auto-follow OFF; touches no trading algorithms, amounts,
orders, risk controls, direction modes or historical official records.
"""
import os,sys,re,json,pathlib,subprocess,tempfile,urllib.request,shutil,time
from datetime import datetime,timezone
ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
WORK=pathlib.Path('/opt/zl-prediction-fast5')
PANEL=ROOT/'panel-stats-shell.mjs'
UI=ROOT/'fast5-dashboard-inject.mjs'
WORKER=WORK/'fast5_independent_stats_service.py'
UNIT=pathlib.Path('/etc/systemd/system/zl-prediction-fast5-stats.service')
NODE='/opt/zl-prediction-node/bin/node'
MODEL='FAST5_SPOT_MOMENTUM_V1';VERSION='FAST5_PREWARM120_5S_V4'
MARKER="  if (req.method === 'GET' && url.pathname === '/api/fast5-live-status') {"
ROUTE="""  // Strict read-only FAST5 independent signal journal joined to official settlement.
  if (req.method === 'GET' && url.pathname === '/api/fast5-round-stats') {
    void fetch('http://127.0.0.1:13047/api/round-stats',
      {headers:{accept:'application/json'},signal:AbortSignal.timeout(1700)})
      .then(async response=>{
        if(!response.ok)throw Error('FAST5_STATS_HTTP_'+response.status);
        const data=await response.json();
        if(data?.ok!==true||data?.model!=='FAST5_SPOT_MOMENTUM_V1'||
           data?.schema!=='FAST5_INDEPENDENT_OFFICIAL_ROUND_LEDGER_V1')
          throw Error('FAST5_STATS_SOURCE_INVALID');
        res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        res.end(JSON.stringify(data));
      }).catch(()=>{
        if(res.headersSent)return;
        res.writeHead(503,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        res.end(JSON.stringify({ok:false,error:'FAST5_LEDGER_TEMPORARILY_UNAVAILABLE'}));
      });
    return;
  }
"""
SYSTEMD="""[Unit]
Description=FAST5 independent persistent signal statistics (read-only)
After=network.target zl-prediction-fast5.service zl-prediction-trade.service
Wants=zl-prediction-fast5.service
[Service]
Type=simple
User=root
WorkingDirectory=/opt/zl-prediction-fast5
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 /opt/zl-prediction-fast5/fast5_independent_stats_service.py
Restart=always
RestartSec=2
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
"""
def command(*args,timeout=85):
 return subprocess.run(args,timeout=timeout,check=True,capture_output=True,text=True)
def jsonget(route):
 with urllib.request.urlopen('http://127.0.0.1:13001'+route,timeout=9) as r:return json.load(r)
def getlocal(port,path):
 with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=9) as r:return json.load(r)
def install(path,data,existing=None):
 path.parent.mkdir(parents=True,exist_ok=True)
 fd,tmp=tempfile.mkstemp(prefix='.fast5-ledger-',dir=str(path.parent))
 try:
  with os.fdopen(fd,'wb') as f:f.write(data)
  if existing:
   s=existing.stat()
   os.chmod(tmp,s.st_mode&0o777)
   os.chown(tmp,s.st_uid,s.st_gid)
  else:os.chmod(tmp,0o644)
  os.replace(tmp,path)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def main():
 if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch('[0-9a-f]{40}',sys.argv[1]):
  raise RuntimeError('AUTHORIZED_PINNED_COMMIT_REQUIRED')
 sha=sys.argv[1]
 if UNIT.exists():raise RuntimeError('STATS_SERVICE_ALREADY_INSTALLED_ABORT')
 if WORKER.exists():raise RuntimeError('STATS_WORKER_ALREADY_EXISTS_ABORT')
 for p in (PANEL,UI):
  if not p.is_file():raise RuntimeError('ORIGINAL_PANEL_MISSING_'+str(p))
 state=jsonget('/api/status')
 s=jsonget('/api/fast5-live-status')
 if state.get('enabled') is not False or state.get('orderSignalModel')!=MODEL:
  raise RuntimeError('LIVE_TRADING_SELECTION_NOT_SAFE')
 if s.get('model')!=MODEL or s.get('strategyVersion')!=VERSION:
  raise RuntimeError('FAST5_V4_NOT_READY')
 psrc=PANEL.read_text()
 if psrc.count(MARKER)!=1 or '/api/fast5-round-stats' in psrc:
  raise RuntimeError('LIVE_PANEL_PROXY_ANCHOR_DRIFT')
 if 'injectFast5Dashboard' not in psrc:raise RuntimeError('WRONG_FRONTEND')
 if 'FAST5 独立统计面板' not in UI.read_text():
  raise RuntimeError('CURRENT_STATS_PANEL_NOT_PRESENT')
 with tempfile.TemporaryDirectory(prefix='fast5-ledger-release-') as tempdir:
  tmp=pathlib.Path(tempdir)
  for n in ('fast5_independent_stats_service.py','fast5-dashboard-inject.mjs'):
   url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/prediction-bot-v1/'+n
   with urllib.request.urlopen(url,timeout=35) as r:(tmp/n).write_bytes(r.read())
  command('/usr/bin/python3','-m','py_compile',str(tmp/'fast5_independent_stats_service.py'))
  command(NODE,'--check',str(tmp/'fast5-dashboard-inject.mjs'))
  if 'FAST5_INDEPENDENT_OFFICIAL_ROUND_LEDGER_V1' not in (tmp/'fast5_independent_stats_service.py').read_text():
   raise RuntimeError('BAD_STATISTICS_WORKER_VERSION')
  if '/api/fast5-round-stats' not in (tmp/'fast5-dashboard-inject.mjs').read_text():
   raise RuntimeError('NEW_STATISTICS_UI_MISSING')
  # JS app keeps existing order and signal routes byte-for-byte unchanged.
  patched=psrc.replace(MARKER,ROUTE+MARKER,1)
  (tmp/'panel-stats-shell.mjs').write_text(patched)
  command(NODE,'--check',str(tmp/'panel-stats-shell.mjs'))
  if jsonget('/api/status').get('enabled') is not False:
   raise RuntimeError('AUTO_FOLLOW_CHANGED_ABORT')
  backup=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/(
    'fast5-ledger-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  shutil.copy2(PANEL,backup/PANEL.name)
  shutil.copy2(UI,backup/UI.name)
  touched=False
  try:
   install(WORKER,(tmp/'fast5_independent_stats_service.py').read_bytes())
   install(UNIT,SYSTEMD.encode())
   install(PANEL,patched.encode(),PANEL)
   install(UI,(tmp/'fast5-dashboard-inject.mjs').read_bytes(),UI)
   touched=True
   command('systemctl','daemon-reload')
   command('systemctl','enable','--now','zl-prediction-fast5-stats.service')
   command('systemctl','restart','zl-prediction-trade.service')
   checked=False
   for _ in range(32):
    time.sleep(1)
    try:
     ledger=jsonget('/api/fast5-round-stats')
     trade=jsonget('/api/status')
     fast=jsonget('/api/fast5-live-status')
     html=urllib.request.urlopen('http://127.0.0.1:13001/',timeout=6).read().decode('utf8','replace')
     if (ledger.get('ok') is True and
        ledger.get('schema')=='FAST5_INDEPENDENT_OFFICIAL_ROUND_LEDGER_V1' and
        isinstance(ledger.get('rows'),list) and
        ledger.get('persisted') is True and
        ledger.get('health',{}).get('lastPollAt') is not None and
        ledger.get('health',{}).get('signalError') is None and
        ledger.get('health',{}).get('officialError') is None and
        fast.get('strategyVersion')==VERSION and trade.get('enabled') is False and
        trade.get('orderSignalModel')==MODEL and
        'FAST5逐轮信号与官方结算' in html and
        'zlF5StatAccuracy' in html):
      checked=True
      break
    except Exception:pass
   if not checked:raise RuntimeError('FAST5_LEDGER_LIVE_VERIFICATION_FAILED')
   for unit in ('zl-prediction-trade','zl-prediction-fast5','zl-prediction-fast5-stats'):
    if command('systemctl','is-active',unit).stdout.strip()!='active':
     raise RuntimeError('POST_DEPLOY_INACTIVE_'+unit)
   print('FAST5_LEDGER_PRODUCTION_ACTIVE=true',flush=True)
   print('FAST5_LEDGER_OFFICIAL_SETTLEMENT_JOIN_ACTIVE=true',flush=True)
   print('FAST5_LEDGER_UP_DOWN_WAIT_PERSISTED=true',flush=True)
   print('FAST5_LEDGER_UI_REAL_STATS_PRESENT=true',flush=True)
   print('FAST5_LEDGER_STRATEGY_UNCHANGED='+VERSION,flush=True)
   print('FAST5_LEDGER_AUTO_FOLLOW_OFF=true',flush=True)
   print('FAST5_LEDGER_SUMMARY='+json.dumps(ledger.get('summary',{})),flush=True)
   print('FAST5_LEDGER_BACKUP='+str(backup),flush=True)
  except BaseException:
   print('FAST5_LEDGER_ROLLBACK_STARTED=true',flush=True)
   subprocess.run(['systemctl','disable','--now','zl-prediction-fast5-stats.service'],timeout=40,capture_output=True)
   shutil.copy2(backup/PANEL.name,PANEL)
   shutil.copy2(backup/UI.name,UI)
   UNIT.unlink(missing_ok=True)
   WORKER.unlink(missing_ok=True)
   subprocess.run(['systemctl','daemon-reload'],timeout=30)
   subprocess.run(['systemctl','restart','zl-prediction-trade.service'],timeout=65)
   print('FAST5_LEDGER_ROLLBACK_ATTEMPTED=true',flush=True)
   raise
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('FAST5_LEDGER_RELEASE_ERROR',type(e).__name__,str(e)[:260],flush=True)
  sys.exit(1)

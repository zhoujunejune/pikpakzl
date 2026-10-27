#!/usr/bin/env python3
"""Install a visible dual5 navigation entry into the actual Alibaba frontend.
UI-only, no trading settings or risk worker changes; atomic rollback.
"""
import os,re,sys,json,shutil,time,pathlib,tempfile,subprocess,urllib.request
from datetime import datetime,timezone
ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
SHELL=ROOT/'panel-stats-shell.mjs'
MENU=ROOT/'dual5-menu-nav.mjs'
NODE='/opt/zl-prediction-node/bin/node'
IMPORT_MARKER="import http from 'node:http';"
FUNC_MARKER="function injectStats(html) {"
ADDED_IMPORT="import {injectDual5RobotMenu} from './dual5-menu-nav.mjs';"
ADDED_FUNC="function injectStats(html) {\n  html=injectDual5RobotMenu(html);"
EXPECTED='BINANCE_DUAL5_PAIR_V1'
def sh(*args,timeout=85):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=timeout)
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=9) as r:
  return r.status,r.read(850000)
def jsonget(path):return json.loads(get(path)[1])
def atomic(path,content,mode=None,uid=None,gid=None):
 fd,tmp=tempfile.mkstemp(prefix='.dual5-menu-',dir=str(path.parent))
 try:
  with os.fdopen(fd,'wb') as f:f.write(content)
  if mode is not None:os.chmod(tmp,mode)
  if uid is not None:os.chown(tmp,uid,gid)
  os.replace(tmp,path)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def main():
 if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch('[a-f0-9]{40}',sys.argv[1]):
  raise RuntimeError('PINNED_SHA_AND_ROOT_REQUIRED')
 sha=sys.argv[1]
 if not SHELL.is_file():raise RuntimeError('PANEL_SOURCE_NOT_FOUND')
 if MENU.exists():raise RuntimeError('DUAL5_MENU_ALREADY_PRESENT_ABORT')
 if sh('systemctl','is-active','zl-prediction-trade.service').stdout.strip()!='active':
  raise RuntimeError('TRADE_SERVICE_NOT_ACTIVE')
 old_status=jsonget('/api/status')
 dual=jsonget('/api/dual5-status')
 if old_status.get('enabled') is not False:
  raise RuntimeError('AUTO_FOLLOW_MUST_BE_OFF_FOR_UI_RESTART')
 if (old_status.get('pendingAction') or {}).get('state') in ('READY','QUOTING','SUBMITTING',
  'SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN'):
  raise RuntimeError('PENDING_ORDER_CANNOT_RESTART')
 if dual.get('model')!=EXPECTED or dual.get('active') is not False:
  raise RuntimeError('DUAL5_NOT_INSTALLED_OR_ALREADY_TRADING')
 if '/api/dual5-arm' not in SHELL.read_text():raise RuntimeError('DUAL5_ROUTE_NOT_PRESENT')
 if 'id="riskSave"' not in get('/dual5')[1].decode('utf8','replace'):
  raise RuntimeError('DUAL5_RISK_PANEL_NOT_READY')
 source=SHELL.read_text()
 if (source.count(IMPORT_MARKER)!=1 or source.count(FUNC_MARKER)!=1 or
   ADDED_IMPORT in source or 'injectDual5RobotMenu(html)' in source):
  raise RuntimeError('PANEL_NAV_INJECTION_ANCHOR_DRIFT')
 uri='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/prediction-bot-v1/dual5-menu-nav.mjs'
 with urllib.request.urlopen(uri,timeout=32) as resp:menu_bytes=resp.read()
 if b'id="dual5RobotMenu"' not in menu_bytes or b'href="/dual5"' not in menu_bytes:
  raise RuntimeError('MENU_SOURCE_INVALID')
 updated=source.replace(IMPORT_MARKER,IMPORT_MARKER+'\n'+ADDED_IMPORT,1)
 updated=updated.replace(FUNC_MARKER,ADDED_FUNC,1)
 with tempfile.TemporaryDirectory(prefix='dual5-nav-stage-') as d:
  stage=pathlib.Path(d)
  (stage/'dual5-menu-nav.mjs').write_bytes(menu_bytes)
  (stage/'panel-stats-shell.mjs').write_text(updated)
  sh(NODE,'--check',str(stage/'dual5-menu-nav.mjs'))
  sh(NODE,'--check',str(stage/'panel-stats-shell.mjs'))
  backup=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/(
   'dual5-menu-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  shutil.copy2(SHELL,backup/SHELL.name)
  if jsonget('/api/status').get('enabled') is not False:
   raise RuntimeError('FOLLOW_CHANGED_BEFORE_UI_RELEASE')
  try:
   stat=SHELL.stat()
   atomic(MENU,menu_bytes,0o644,stat.st_uid,stat.st_gid)
   atomic(SHELL,updated.encode(),stat.st_mode&0o777,stat.st_uid,stat.st_gid)
   sh('systemctl','restart','zl-prediction-trade.service',timeout=90)
   ready=False
   for _ in range(38):
    time.sleep(1)
    try:
     _,body=get('/')
     html=body.decode('utf8','replace')
     d=jsonget('/api/dual5-status')
     t=jsonget('/api/status')
     _,second=get('/dual5')
     if (html.count('id="dual5RobotMenu"')==1 and
       'href="/dual5"' in html and
       html.index('id="dual5RobotMenu"')<html.index('5分钟 API 实盘确认控制台') and
       'UP + DOWN 双边机器人' in html and
       d.get('model')==EXPECTED and d.get('active') is False and
       t.get('enabled') is False and
       'id="riskSave"' in second.decode('utf8','replace')):
      ready=True;break
    except Exception:pass
   if not ready:raise RuntimeError('VISIBLE_ROOT_NAV_OR_DUAL5_ROUTE_NOT_VERIFIED')
   for unit in ('zl-prediction-trade.service','zl-prediction-risk-exits.service',
                'zl-prediction-dual5.service'):
    if sh('systemctl','is-active',unit).stdout.strip()!='active':
     raise RuntimeError('PRODUCTION_UNIT_DOWN_'+unit)
   print('DUAL5_HOME_NAV_VISIBLE=true',flush=True)
   print('DUAL5_MENU_TOP_LEVEL=true',flush=True)
   print('DUAL5_MENU_PRODUCTION_ROUTE=/dual5',flush=True)
   print('DUAL5_PAIR_PRODUCTION_HEALTH='+str(d.get('health')),flush=True)
   print('DUAL5_INDEPENDENT_TPSL_UI_PRESENT=true',flush=True)
   print('DUAL5_FOLLOW_STILL_OFF=true',flush=True)
   print('DUAL5_LIVE_SWITCH_STILL_OFF=true',flush=True)
   print('DUAL5_MENU_BACKUP='+str(backup),flush=True)
  except BaseException:
   print('DUAL5_MENU_ROLLBACK_START=true',flush=True)
   shutil.copy2(backup/SHELL.name,SHELL)
   MENU.unlink(missing_ok=True)
   subprocess.run(['systemctl','restart','zl-prediction-trade.service'],timeout=90)
   print('DUAL5_MENU_ROLLBACK_ATTEMPTED=true',flush=True)
   raise
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('DUAL5_MENU_DEPLOY_ERROR',type(e).__name__,str(e)[:320],flush=True)
  sys.exit(1)

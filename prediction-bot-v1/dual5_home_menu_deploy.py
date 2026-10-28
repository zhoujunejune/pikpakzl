#!/usr/bin/env python3
"""Guarded frontend-only deploy: add dual5 third robot choice to homepage.
Does not change strategies, credentials, orders, order settings, risk, or dual5.
"""
import os,sys,re,pathlib,urllib.request,tempfile,subprocess,shutil,time,json
from datetime import datetime,timezone
ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
PANEL=ROOT/'panel-stats-shell.mjs'
NAV=ROOT/'dual5-robot-navigation.mjs'
NODE='/opt/zl-prediction-node/bin/node'
IMPORT="import {injectRobotMenu} from './dual5-robot-navigation.mjs';\n"
ANCHOR="function injectStats(html) {\n"
BLOCK="function injectStats(html) {\n  html=injectRobotMenu(html);\n"
MODEL='BINANCE_DUAL5_PAIR_V1'
def run(*args,timeout=90):
 return subprocess.run(args,check=True,capture_output=True,text=True,timeout=timeout)
def get(route):
 with urllib.request.urlopen('http://127.0.0.1:13001'+route,timeout=10) as r:
  return r.status,r.read(1500000)
def getjson(route):
 code,b=get(route)
 if code!=200:raise RuntimeError('HTTP_'+str(code)+'_'+route)
 return json.loads(b)
def put(dst,data,ref=None):
 fd,tmp=tempfile.mkstemp(prefix='.dual5-nav-',dir=str(dst.parent))
 try:
  with os.fdopen(fd,'wb') as f:f.write(data)
  if ref is not None:
   st=ref.stat()
   os.chown(tmp,st.st_uid,st.st_gid)
   os.chmod(tmp,st.st_mode&0o777)
  else:
   st=PANEL.stat()
   os.chown(tmp,st.st_uid,st.st_gid)
   os.chmod(tmp,0o644)
  os.replace(tmp,dst)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def main():
 if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch('[a-f0-9]{40}',sys.argv[1]):
  raise RuntimeError('AUTHORIZED_COMMIT_REQUIRED')
 if not PANEL.is_file():raise RuntimeError('PANEL_NOT_PRESENT')
 if NAV.exists():raise RuntimeError('NAV_MODULE_ALREADY_PRESENT_ABORT')
 existing=PANEL.read_text()
 if existing.count(ANCHOR)!=1 or 'injectRobotMenu' in existing:
  raise RuntimeError('HOME_INJECTION_MARKER_DRIFT')
 if not all(x in existing for x in ('/dual5','/api/dual5-risk','/api/dual5-status')):
  raise RuntimeError('DUAL5_PROXY_NOT_INSTALLED')
 trade=getjson('/api/status')
 dual=getjson('/api/dual5-status')
 if trade.get('enabled') is not False:raise RuntimeError('EXISTING_AUTO_FOLLOW_MUST_BE_OFF_FOR_RESTART')
 if dual.get('model')!=MODEL or dual.get('active') is not False:
  raise RuntimeError('DUAL5_MUST_BE_DEPLOYED_AND_OFF')
 if (trade.get('pendingAction') or {}).get('state') in ('READY','QUOTING','SUBMITTING',
  'SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN'):
  raise RuntimeError('PENDING_ORDER_RESTART_BLOCKED')
 sha=sys.argv[1]
 url=('https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+
      '/prediction-bot-v1/dual5-robot-navigation.mjs')
 with urllib.request.urlopen(url,timeout=35) as r:module=r.read()
 if any(x.encode() not in module for x in ('href="/dual5"','id="zlDual5RobotLink"',
  '5分钟UP+DOWN双边','function injectRobotMenu')):
  raise RuntimeError('NEW_NAV_INCOMPLETE')
 patched=IMPORT+existing.replace(ANCHOR,BLOCK,1)
 with tempfile.TemporaryDirectory(prefix='dual5-nav-release-') as d:
  path=pathlib.Path(d)
  (path/'dual5-robot-navigation.mjs').write_bytes(module)
  (path/'panel-stats-shell.mjs').write_text(patched)
  run(NODE,'--check',str(path/'dual5-robot-navigation.mjs'))
  run(NODE,'--check',str(path/'panel-stats-shell.mjs'))
  again=getjson('/api/status')
  if again.get('enabled') is not False:raise RuntimeError('FOLLOW_CHANGED_BEFORE_RESTART')
  if (again.get('pendingAction') or {}).get('state') in ('READY','QUOTING','SUBMITTING'):
   raise RuntimeError('ORDER_BECAME_IN_FLIGHT')
  backup=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/(
    'dual5-home-menu-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  shutil.copy2(PANEL,backup/PANEL.name)
  changed=False
  try:
   put(NAV,module)
   put(PANEL,patched.encode(),PANEL)
   changed=True
   run('systemctl','restart','zl-prediction-trade.service',timeout=100)
   verified=False;checks={}
   for _ in range(35):
    time.sleep(1)
    try:
     status,body=get('/')
     html=body.decode('utf8','replace')
     dual_st=getjson('/api/dual5-status')
     t=getjson('/api/status')
     hstatus,dual_page=get('/dual5')
     dual_html=dual_page.decode('utf8','replace')
     if (status==200 and hstatus==200 and
         html.count('id="zlRobotMenu"')==1 and
         html.count('id="zlDual5RobotLink"')==1 and
         'href="/dual5"' in html and '5分钟UP+DOWN双边' in html and
         'href="/"' in html and 'href="/api-keys/"' in html and
         dual_st.get('model')==MODEL and dual_st.get('active') is False and
         t.get('enabled') is False and
         'UP / DOWN 独立止盈止损' in dual_html and
         'id="riskSave"' in dual_html):
      verified=True
      checks={'menu':True,'dual5Link':True,'dual5Page':True,
       'dual5TradeOff':True,'originalFollowOff':True}
      break
    except Exception:
     pass
   if not verified:raise RuntimeError('DUAL5_HOME_MENU_LIVE_VALIDATION_FAILED')
   if run('systemctl','is-active','zl-prediction-trade.service').stdout.strip()!='active':
    raise RuntimeError('EXISTING_PANEL_NOT_ACTIVE')
   print('DUAL5_HOME_MENU_LIVE=true')
   print('DUAL5_HOME_THIRD_ROBOT_LINK_VISIBLE=true')
   print('DUAL5_HOME_AND_DUAL5_NAV_VALIDATED=true')
   print('DUAL5_INDEPENDENT_TPSL_PRESERVED=true')
   print('DUAL5_TRADE_OFF=true')
   print('FAST5_FOLLOW_OFF=true')
   print('DUAL5_HOME_CHECKS='+json.dumps(checks))
   print('DUAL5_HOME_BACKUP='+str(backup))
  except BaseException:
   if changed:
    shutil.copy2(backup/PANEL.name,PANEL)
   NAV.unlink(missing_ok=True)
   subprocess.run(['systemctl','restart','zl-prediction-trade.service'],timeout=95)
   print('DUAL5_HOME_MENU_ROLLBACK_ATTEMPTED=true')
   raise
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('DUAL5_HOME_MENU_ERROR',type(e).__name__,str(e)[:250])
  sys.exit(1)

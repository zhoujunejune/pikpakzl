#!/usr/bin/env python3
"""Guarded upgrade of independently deployed Binance dual5 worker + page.
Set UP/DOWN spend defaults to 1 USDT each and remove daily hard stop.
Preserve ALL existing original FAST5, risk-worker and trade settings.
"""
import json,os,re,sys,shutil,time,pathlib,tempfile,subprocess,urllib.request
from datetime import datetime,timezone
ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
SHELL=ROOT/'panel-stats-shell.mjs'
APP=pathlib.Path('/opt/zl-prediction-dual5')
WORKER=APP/'binance_dual5_pairs.mjs'
PAGE=APP/'binance_dual5_dashboard.html'
CONFIG=pathlib.Path('/var/lib/zl-prediction/dual5/config.json')
NODE='/opt/zl-prediction-node/bin/node'
BRIDGE_ANCHOR="  if (url.pathname === '/api/dual5-risk' && req.method === 'POST') {"
BRIDGE=r"""
  // Explicit same-origin owner action; separate per-side USDT stake amounts.
  if (url.pathname === '/api/dual5-amounts' && req.method === 'POST') {
    if (req.headers.origin !== 'https://prediction.47-237-188-69.sslip.io' ||
        req.headers['sec-fetch-site'] !== 'same-origin') {
      res.writeHead(403,{'content-type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'SAME_ORIGIN_AUTH_REQUIRED'}));return;
    }
    void (async()=>{
      try{
        let body='',total=0;
        for await(const chunk of req){
          total+=chunk.length;if(total>900)throw Error('AMOUNTS_REQUEST_TOO_LARGE');
          body+=chunk.toString('utf8');
        }
        const payload=JSON.parse(body);
        if(!payload?.amounts||typeof payload.amounts!=='object')
          throw Error('BOTH_AMOUNT_VALUES_REQUIRED');
        const response=await fetch('http://127.0.0.1:13048/api/amounts',{
          method:'POST',
          headers:{'Content-Type':'application/json','Origin':req.headers.origin,
            'Sec-Fetch-Site':req.headers['sec-fetch-site']},
          body:JSON.stringify({amounts:payload.amounts}),
          signal:AbortSignal.timeout(2500)
        });
        const result=await response.text();
        res.writeHead(response.status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        res.end(result);
      }catch(e){
        res.writeHead(503,{'content-type':'application/json'});
        res.end(JSON.stringify({ok:false,error:'DUAL5_AMOUNTS_UNAVAILABLE'}));
      }
    })();
    return;
  }
"""
def cmd(*args,timeout=95):
 return subprocess.run(args,timeout=timeout,check=True,capture_output=True,text=True)
def get(route,port=13001):
 with urllib.request.urlopen('http://127.0.0.1:'+str(port)+route,timeout=8) as r:return json.load(r)
def atomic(p,data):
 st=p.stat()
 fd,tmp=tempfile.mkstemp(dir=str(p.parent),prefix='.dual5-amounts-')
 try:
  with os.fdopen(fd,'wb') as f:f.write(data)
  os.chmod(tmp,st.st_mode&0o777);os.chown(tmp,st.st_uid,st.st_gid)
  os.replace(tmp,p)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def main():
 if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch('[0-9a-f]{40}',sys.argv[1]):
  raise RuntimeError('ROOT_AND_PINNED_GITHUB_COMMIT_REQUIRED')
 sha=sys.argv[1]
 for p in (WORKER,PAGE,SHELL,CONFIG):
  if not p.is_file():raise RuntimeError('DUAL5_PRODUCTION_FILE_MISSING_'+p.name)
 for unit in ('zl-prediction-dual5.service','zl-prediction-trade.service'):
  if cmd('systemctl','is-active',unit).stdout.strip()!='active':
   raise RuntimeError('PRODUCTION_SERVICE_INACTIVE_'+unit)
 old_main=get('/api/status');old_dual=get('/api/dual5-status')
 if old_main.get('enabled') is not False:raise RuntimeError('ORIGINAL_FAST5_FOLLOW_ON_RESTART_NOT_SAFE')
 if old_dual.get('model')!='BINANCE_DUAL5_PAIR_V1' or old_dual.get('active') is not False:
  raise RuntimeError('DUAL5_MUST_BE_IDLE_BEFORE_AMOUNTS_UPGRADE')
 if old_dual.get('blocked') is True:raise RuntimeError('DUAL5_UNRESOLVED_ORDER_BLOCKED')
 if (old_main.get('pendingAction') or {}).get('state') in (
  'READY','QUOTING','SUBMITTING','SUBMISSION_UNKNOWN','SUBMITTED_PENDING_CONFIRMATION'):
  raise RuntimeError('ORIGINAL_PENDING_ORDER_IN_PROGRESS')
 cfg=json.loads(CONFIG.read_text())
 if cfg.get('armed') is not False or cfg.get('blocked') is True:
  raise RuntimeError('DUAL5_LIVE_OR_RECOVERY_STATE_UNSAFE')
 shell=SHELL.read_text()
 if shell.count(BRIDGE_ANCHOR)!=1 or "/api/dual5-amounts" in shell:
  raise RuntimeError('DUAL5_BRIDGE_SOURCE_DRIFT_OR_ALREADY_INSTALLED')
 if "/api/dual5-risk" not in shell or "url.pathname === '/dual5'" not in shell:
  raise RuntimeError('EXISTING_DUAL5_ROUTE_MISSING')
 with tempfile.TemporaryDirectory(prefix='dual5-amounts-stage-') as directory:
  tmp=pathlib.Path(directory)
  for p in (WORKER,PAGE):
   url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/prediction-bot-v1/'+p.name
   with urllib.request.urlopen(url,timeout=35) as r:(tmp/p.name).write_bytes(r.read())
  new_worker=(tmp/WORKER.name).read_text()
  new_html=(tmp/PAGE.name).read_text()
  for token in ("DEFAULT_SIDE_USDT=1","req.url==='/api/amounts'","validStake",
                "amounts:config.amounts","config.armed=false;config.blocked=true"):
   if token not in new_worker:raise RuntimeError('DUAL5_NEW_WORKER_INVARIANT_MISSING_'+token)
  for forbidden in ("MAX_DAILY_SPEND","DAILY_BUDGET_STOP","MAX_SIDE_USDT"):
   if forbidden in new_worker:raise RuntimeError('LEGACY_AMOUNT_GATE_STILL_PRESENT_'+forbidden)
  for token in ('id="upAmount"','id="downAmount"','id="amountSave"',
                "/api/dual5-amounts","id="riskSave""):
   if token not in new_html:raise RuntimeError('DUAL5_AMOUNT_UI_MISSING_'+token)
  new_shell=shell.replace(BRIDGE_ANCHOR,BRIDGE+BRIDGE_ANCHOR,1)
  (tmp/'panel-stats-shell.mjs').write_text(new_shell)
  cmd(NODE,'--check',str(tmp/WORKER.name))
  cmd(NODE,'--check',str(tmp/'panel-stats-shell.mjs'))
  if get('/api/status').get('enabled') is not False or get('/api/dual5-status').get('active') is not False:
   raise RuntimeError('TRADE_SWITCH_CHANGED_BEFORE_DEPLOY')
  backup=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/(
   'dual5-up-down-amounts-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  for p in (WORKER,PAGE,SHELL,CONFIG):shutil.copy2(p,backup/p.name)
  try:
   # Persist the requested 1 + 1 USDT defaults, retaining all other settings.
   updated_config={**cfg,'amounts':{'UP':1,'DOWN':1}}
   atomic(CONFIG,json.dumps(updated_config,indent=2,ensure_ascii=False).encode('utf8'))
   atomic(WORKER,(tmp/WORKER.name).read_bytes())
   atomic(PAGE,(tmp/PAGE.name).read_bytes())
   atomic(SHELL,new_shell.encode('utf8'))
   cmd('systemctl','restart','zl-prediction-dual5.service',timeout=80)
   cmd('systemctl','restart','zl-prediction-trade.service',timeout=95)
   checked=False
   for _ in range(39):
    time.sleep(1)
    try:
     active=get('/api/dual5-status');bot=get('/api/status')
     with urllib.request.urlopen('http://127.0.0.1:13001/dual5',timeout=6) as r:
      page=r.read(160000).decode('utf8','replace')
     if (active.get('ok') is True and active.get('amounts')=={'UP':1,'DOWN':1} and
         active.get('dailySpendMax') is None and active.get('active') is False and
         active.get('blocked') is False and bot.get('enabled') is False and
         '/api/dual5-amounts' in page and 'id="upAmount"' in page and
         'id="downAmount"' in page and 'id="amountSave"' in page and
         'id="riskSave"' in page):
      checked=True;break
    except Exception:pass
   if not checked:raise RuntimeError('DUAL5_AMOUNTS_LIVE_VERIFICATION_FAILED')
   # Exercise the precise owner save API with the SAME defaults.
   request=urllib.request.Request('http://127.0.0.1:13001/api/dual5-amounts',
    method='POST',data=b'{"amounts":{"UP":1,"DOWN":1}}',
    headers={'Content-Type':'application/json',
     'Origin':'https://prediction.47-237-188-69.sslip.io','Sec-Fetch-Site':'same-origin'})
   with urllib.request.urlopen(request,timeout=9) as r:
    saved=json.load(r)
   if saved.get('ok') is not True or saved.get('amounts')!={'UP':1,'DOWN':1}:
    raise RuntimeError('DUAL5_AMOUNTS_POST_SAVE_NOT_CONFIRMED')
   actual=get('/api/dual5-status')
   if (actual.get('amounts')!={'UP':1,'DOWN':1} or
       actual.get('dailySpendMax') is not None or actual.get('active') is not False):
    raise RuntimeError('DUAL5_AMOUNTS_NOT_PERSISTED')
   for unit in ('zl-prediction-dual5.service','zl-prediction-trade.service',
                 'zl-prediction-risk-exits.service'):
    if cmd('systemctl','is-active',unit).stdout.strip()!='active':
     raise RuntimeError('PRODUCTION_SERVICE_DOWN_'+unit)
   print('DUAL5_AMOUNTS_PRODUCTION_DEPLOYED=true',flush=True)
   print('DUAL5_UP_AMOUNT_USDT=1',flush=True)
   print('DUAL5_DOWN_AMOUNT_USDT=1',flush=True)
   print('DUAL5_PER_SIDE_SAVE_API_VERIFIED=true',flush=True)
   print('DUAL5_DAILY_HARD_CAP_REMOVED=true',flush=True)
   print('DUAL5_MAX_ONE_PAIR_PER_ROUND_UNCHANGED=true',flush=True)
   print('DUAL5_UP_DOWN_TPSL_PRESERVED=true',flush=True)
   print('DUAL5_LIVE_SWITCH_OFF=true',flush=True)
   print('DUAL5_FAST5_FOLLOW_OFF=true',flush=True)
   print('DUAL5_RELEASE_BACKUP='+str(backup),flush=True)
  except BaseException:
   print('DUAL5_AMOUNTS_ROLLBACK_BEGIN=true',flush=True)
   for p in (WORKER,PAGE,SHELL,CONFIG):
    shutil.copy2(backup/p.name,p)
   subprocess.run(['systemctl','restart','zl-prediction-dual5.service'],timeout=85)
   subprocess.run(['systemctl','restart','zl-prediction-trade.service'],timeout=95)
   print('DUAL5_AMOUNTS_ROLLBACK_ATTEMPTED=true',flush=True)
   raise
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('DUAL5_AMOUNTS_DEPLOY_ERROR',type(e).__name__,str(e)[:270],flush=True)
  sys.exit(1)

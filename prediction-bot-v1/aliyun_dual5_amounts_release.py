#!/usr/bin/env python3
"""Guarded Alibaba dual5 amount UI release; NO new order and no base bot changes."""
import os,sys,re,json,time,shutil,pathlib,tempfile,subprocess,urllib.request
from datetime import datetime,timezone
ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
PANEL=ROOT/'panel-stats-shell.mjs'
APP=pathlib.Path('/opt/zl-prediction-dual5')
WORKER=APP/'binance_dual5_pairs.mjs'
PAGE=APP/'binance_dual5_dashboard.html'
NODE='/opt/zl-prediction-node/bin/node'
ANCHOR="  if (url.pathname === '/api/dual5-risk' && req.method === 'POST') {"
ROUTE=r"""
  // Owner-only same-origin per-side stake amounts. Risk and exit modules untouched.
  if (url.pathname === '/api/dual5-amounts' && req.method === 'POST') {
    if (req.headers.origin !== 'https://prediction.47-237-188-69.sslip.io' ||
        req.headers['sec-fetch-site'] !== 'same-origin') {
      res.writeHead(403,{'content-type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'SAME_ORIGIN_AUTH_REQUIRED'}));return;
    }
    void (async()=>{
      try{
        let body='',bytes=0;
        for await(const chunk of req){
          bytes+=chunk.length;
          if(bytes>1200)throw Error('AMOUNT_REQUEST_TOO_LARGE');
          body+=chunk.toString('utf8');
        }
        const data=JSON.parse(body);
        const valid=n=>typeof n==='number'&&Number.isFinite(n)&&
          n>=1&&n<=1000&&Math.abs(n*100-Math.round(n*100))<0.000001;
        if(!valid(data?.amounts?.UP)||!valid(data?.amounts?.DOWN))
          throw Error('INVALID_UP_DOWN_AMOUNTS');
        const response=await fetch('http://127.0.0.1:13048/api/amounts',{
          method:'POST',
          headers:{'Content-Type':'application/json',
            'Origin':req.headers.origin,'Sec-Fetch-Site':req.headers['sec-fetch-site']},
          body:JSON.stringify({amounts:data.amounts}),
          signal:AbortSignal.timeout(2700)
        });
        const out=await response.text();
        res.writeHead(response.status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        res.end(out);
      }catch(e){
        res.writeHead(400,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        res.end(JSON.stringify({ok:false,error:'INVALID_AMOUNT_OR_BACKEND_UNAVAILABLE'}));
      }
    })();
    return;
  }
"""
def run(*args,timeout=85):
 return subprocess.run(args,check=True,timeout=timeout,capture_output=True,text=True)
def get(port,path):
 with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=9) as r:return r.status,r.read(1400000)
def obj(port,path):return json.loads(get(port,path)[1])
def atomic(path,content):
 old=path.stat()
 fd,tmp=tempfile.mkstemp(prefix='.dual5-amount-',dir=str(path.parent))
 try:
  with os.fdopen(fd,'wb') as out:out.write(content)
  os.chmod(tmp,old.st_mode&0o777)
  os.chown(tmp,old.st_uid,old.st_gid)
  os.replace(tmp,path)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def main():
 if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch('[a-f0-9]{40}',sys.argv[1]):
  raise RuntimeError('ROOT_AND_COMMIT_SHA_REQUIRED')
 sha=sys.argv[1]
 for path in (PANEL,WORKER,PAGE):
  if not path.is_file():raise RuntimeError('LIVE_FILE_MISSING_'+str(path))
 before=obj(13001,'/api/status')
 pair=obj(13048,'/api/status')
 if before.get('enabled') is not False:raise RuntimeError('MAIN_AUTOFOLLOW_ON')
 if (before.get('pendingAction') or {}).get('state') in (
    'READY','QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN'):
  raise RuntimeError('PENDING_ORDER_NOT_SAFE_TO_RESTART')
 if pair.get('model')!='BINANCE_DUAL5_PAIR_V1' or pair.get('active') is not False or pair.get('blocked') is True:
  raise RuntimeError('DUAL5_NOT_IDLE_OR_MANUAL_BLOCK')
 for unit in ('zl-prediction-trade.service','zl-prediction-dual5.service','zl-prediction-risk-exits.service'):
  if run('systemctl','is-active',unit).stdout.strip()!='active':
   raise RuntimeError('PRODUCTION_UNIT_NOT_ACTIVE_'+unit)
 old_panel=PANEL.read_text()
 if old_panel.count(ANCHOR)!=1 or "'/api/dual5-amounts'" in old_panel:
  raise RuntimeError('PANEL_AMOUNT_PROXY_ANCHOR_DRIFT')
 if '/api/dual5-arm' not in old_panel or '/api/dual5-status' not in old_panel:
  raise RuntimeError('DUAL5_EXISTING_ROUTES_MISSING')
 with tempfile.TemporaryDirectory(prefix='dual5-amount-live-') as td:
  stage=pathlib.Path(td)
  for name in (WORKER.name,PAGE.name):
   url=('https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+
         '/prediction-bot-v1/'+name)
   with urllib.request.urlopen(url,timeout=30) as response:
    (stage/name).write_bytes(response.read())
  run(NODE,'--check',str(stage/WORKER.name))
  ws=(stage/WORKER.name).read_text()
  page=(stage/PAGE.name).read_text()
  for word in ('DEFAULT_SIDE_USDT=1','dailySpendMax:null',
    "req.url==='/api/amounts'",'amounts:config.amounts',
    "quoteFor(topic,pair.up,wallet,config.amounts.UP)",
    "quoteFor(topic,pair.down,wallet,config.amounts.DOWN)",
    'UNHEDGED_OR_UNKNOWN_STOPPED'):
   if word not in ws:raise RuntimeError('AMOUNT_WORKER_REGRESSION_'+word)
  if 'MAX_DAILY_SPEND' in ws or 'DAILY_BUDGET_STOP' in ws or 'MAX_SIDE_USDT' in ws:
   raise RuntimeError('HARD_DAILY_LIMIT_NOT_REMOVED')
  for word in ('id="upAmount"','id="downAmount"','id="amountSave"',
               '/api/dual5-amounts','每日硬性金额限制','id="riskSave"'):
   if word not in page:raise RuntimeError('AMOUNT_FRONTEND_MISSING_'+word)
  patched=old_panel.replace(ANCHOR,ROUTE+ANCHOR,1)
  (stage/'patched-panel.mjs').write_text(patched)
  run(NODE,'--check',str(stage/'patched-panel.mjs'))
  if obj(13001,'/api/status').get('enabled') is not False:
   raise RuntimeError('MAIN_FOLLOW_CHANGED_BEFORE_DEPLOY')
  if obj(13048,'/api/status').get('active') is not False:
   raise RuntimeError('DUAL5_ACTIVATED_BEFORE_DEPLOY')
  archive=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/(
   'dual5-amounts-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  archive.mkdir(parents=True,exist_ok=False)
  for f in (PANEL,WORKER,PAGE):shutil.copy2(f,archive/f.name)
  touched=False
  try:
   atomic(WORKER,(stage/WORKER.name).read_bytes())
   atomic(PAGE,(stage/PAGE.name).read_bytes())
   atomic(PANEL,patched.encode())
   touched=True
   run('systemctl','restart','zl-prediction-dual5.service',timeout=70)
   run('systemctl','restart','zl-prediction-trade.service',timeout=90)
   verified=False
   for _ in range(40):
    time.sleep(1)
    try:
     d=obj(13001,'/api/dual5-status')
     main=obj(13001,'/api/status')
     html=get(13001,'/dual5')[1].decode('utf8','replace')
     if (d.get('ok') is True and
      d.get('model')=='BINANCE_DUAL5_PAIR_V1' and
      d.get('active') is False and
      d.get('dailySpendMax','__missing__') is None and
      d.get('amounts',{}).get('UP')==1 and
      d.get('amounts',{}).get('DOWN')==1 and
      main.get('enabled') is False and
      'id="amountSave"' in html and
      '/api/dual5-amounts' in html and
      'id="riskSave"' in html and
      "'/api/dual5-amounts'" in PANEL.read_text()):
       verified=True;break
    except Exception:pass
   if not verified:raise RuntimeError('FRONTEND_OR_PERSISTED_STAKES_VERIFY_FAILED')
   for unit in ('zl-prediction-dual5.service','zl-prediction-trade.service','zl-prediction-risk-exits.service'):
    if run('systemctl','is-active',unit).stdout.strip()!='active':
     raise RuntimeError('POST_DEPLOY_SERVICE_INACTIVE_'+unit)
   print('DUAL5_AMOUNT_DEPLOY_SUCCESS=true',flush=True)
   print('DUAL5_UP_USDT='+str(d['amounts']['UP']),flush=True)
   print('DUAL5_DOWN_USDT='+str(d['amounts']['DOWN']),flush=True)
   print('DUAL5_DAILY_HARD_LIMIT_REMOVED=true',flush=True)
   print('DUAL5_AMOUNT_SAVING_PROXY_ACTIVE=true',flush=True)
   print('DUAL5_EXISTING_TP_SL_PRESERVED=true',flush=True)
   print('DUAL5_FOLLOW_OFF=true',flush=True)
   print('DUAL5_LIVE_TRADING_OFF=true',flush=True)
   print('DUAL5_BACKUP='+str(archive),flush=True)
  except BaseException:
   print('DUAL5_AMOUNT_ROLLBACK_START=true',flush=True)
   if touched:
    for f in (PANEL,WORKER,PAGE):shutil.copy2(archive/f.name,f)
    subprocess.run(['systemctl','restart','zl-prediction-dual5.service'],timeout=75)
    subprocess.run(['systemctl','restart','zl-prediction-trade.service'],timeout=90)
   print('DUAL5_AMOUNT_ROLLBACK_ATTEMPTED=true',flush=True)
   raise
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('DUAL5_AMOUNT_RELEASE_FAILED',type(e).__name__,str(e)[:290],flush=True)
  sys.exit(1)

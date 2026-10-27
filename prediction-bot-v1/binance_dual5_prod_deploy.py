#!/usr/bin/env python3
"""Deploy isolated Binance BTC 5m UP+DOWN pair service with authenticated UI.
Default live trading OFF. Existing FAST5/buy/risk algorithms untouched.
"""
import os,sys,re,json,pathlib,shutil,subprocess,tempfile,urllib.request,time
from datetime import datetime,timezone
ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
PANEL=ROOT/'panel-stats-shell.mjs'
RISK_WORKER=ROOT/'risk-worker.mjs'
APP=pathlib.Path('/opt/zl-prediction-dual5')
SOURCE=APP/'binance_dual5_pairs.mjs'
PAGE=APP/'binance_dual5_dashboard.html'
CONFIG=pathlib.Path('/var/lib/zl-prediction/dual5/config.json')
UNIT=pathlib.Path('/etc/systemd/system/zl-prediction-dual5.service')
MODEL='BINANCE_DUAL5_PAIR_V1'
ROUTE_ANCHOR="  if (req.method === 'GET' && url.pathname === '/api/fast5-round-stats') {"
NODE='/opt/zl-prediction-node/bin/node'
UNIT_CONTENT="""[Unit]
Description=Independent Binance 5-min complementary outcome pair trader (owner OFF by default)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=zl-pred
Group=zl-pred
WorkingDirectory=/opt/zl-prediction-dual5
EnvironmentFile=-/var/lib/zl-exchange-api/prediction/binance.env
Environment=DUAL5_CONFIG=/var/lib/zl-prediction/dual5/config.json
Environment=DUAL5_PORT=13048
ExecStart=/opt/zl-prediction-node/bin/node /opt/zl-prediction-dual5/binance_dual5_pairs.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=false
[Install]
WantedBy=multi-user.target
"""
ROUTE=r"""
  // DUAL5: independent UP+DOWN strategy. The existing producer/order paths are untouched.
  if (req.method === 'GET' && url.pathname === '/dual5') {
    try {
      const page=dual5fs.readFileSync('/opt/zl-prediction-dual5/binance_dual5_dashboard.html');
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
        'x-content-type-options':'nosniff'});
      res.end(page);
    } catch(e) {
      res.writeHead(503,{'content-type':'text/plain; charset=utf-8'});
      res.end('DUAL5_PAGE_UNAVAILABLE');
    }
    return;
  }
  if (url.pathname === '/api/dual5-status' && req.method === 'GET') {
    void fetch('http://127.0.0.1:13048/api/status',
      {signal:AbortSignal.timeout(2500),cache:'no-store'})
      .then(async reply=>{
        const raw=await reply.text();
        res.writeHead(reply.status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        res.end(raw);
      })
      .catch(()=>{
        res.writeHead(503,{'content-type':'application/json'});
        res.end(JSON.stringify({ok:false,error:'DUAL5_WORKER_UNAVAILABLE'}));
      });
    return;
  }
  if (url.pathname === '/api/dual5-risk' && req.method === 'POST') {
    if (req.headers.origin !== 'https://prediction.47-237-188-69.sslip.io' ||
        req.headers['sec-fetch-site'] !== 'same-origin') {
      res.writeHead(403,{'content-type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'SAME_ORIGIN_AUTH_REQUIRED'}));return;
    }
    void (async()=>{
      try{
        let b='',bytes=0;
        for await (const chunk of req){
          bytes+=chunk.length;if(bytes>1400)throw Error('RISK_REQUEST_TOO_LARGE');
          b+=chunk.toString('utf8');
        }
        const data=JSON.parse(b);
        if(!data?.risk?.UP||!data?.risk?.DOWN)throw Error('RISK_BOTH_SIDES_REQUIRED');
        const reply=await fetch('http://127.0.0.1:13048/api/risk',{
          method:'POST',
          headers:{'Content-Type':'application/json','Origin':req.headers.origin,
            'Sec-Fetch-Site':req.headers['sec-fetch-site']},
          body:JSON.stringify({risk:data.risk}),signal:AbortSignal.timeout(2700)});
        const raw=await reply.text();
        res.writeHead(reply.status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        res.end(raw);
      }catch(e){
        res.writeHead(503,{'content-type':'application/json'});
        res.end(JSON.stringify({ok:false,error:'DUAL5_RISK_CONFIG_UNAVAILABLE'}));
      }
    })();
    return;
  }
  if (url.pathname === '/api/dual5-arm' && req.method === 'POST') {
    if (req.headers.origin !== 'https://prediction.47-237-188-69.sslip.io' ||
        req.headers['sec-fetch-site'] !== 'same-origin') {
      res.writeHead(403,{'content-type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'SAME_ORIGIN_AUTH_REQUIRED'}));return;
    }
    void (async()=>{
      try{
        let b='',bytes=0;
        for await(const chunk of req){
          bytes+=chunk.length;if(bytes>800)throw Error('CONFIG_REQUEST_TOO_LARGE');
          b+=chunk.toString('utf8');
        }
        const data=JSON.parse(b);
        if(typeof data.armed!=='boolean')throw Error('INVALID_ARM_SETTING');
        const reply=await fetch('http://127.0.0.1:13048/api/arm',{
          method:'POST',
          headers:{'Content-Type':'application/json',
            'Origin':req.headers.origin,'Sec-Fetch-Site':req.headers['sec-fetch-site']},
          body:JSON.stringify({armed:data.armed}),
          signal:AbortSignal.timeout(2700)});
        const raw=await reply.text();
        res.writeHead(reply.status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        res.end(raw);
      }catch(e){
        res.writeHead(503,{'content-type':'application/json'});
        res.end(JSON.stringify({ok:false,error:'DUAL5_CONFIG_UNAVAILABLE'}));
      }
    })();
    return;
  }
"""
def sh(*args,timeout=90):
 return subprocess.run(args,timeout=timeout,check=True,capture_output=True,text=True)
def api(port,path):
 with urllib.request.urlopen('http://127.0.0.1:%s%s'%(port,path),timeout=8) as r:return json.load(r)
def install(dest,raw,mode=None,uid=None,gid=None):
 dest.parent.mkdir(parents=True,exist_ok=True)
 fd,tmp=tempfile.mkstemp(prefix='.dual5-',dir=str(dest.parent))
 try:
  with os.fdopen(fd,'wb') as f:f.write(raw)
  if mode is not None:os.chmod(tmp,mode)
  if uid is not None:os.chown(tmp,uid,gid)
  os.replace(tmp,dest)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def main():
 if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch(r'[0-9a-f]{40}',sys.argv[1]):
  raise RuntimeError('ROOT_AND_PINNED_SHA_REQUIRED')
 sha=sys.argv[1]
 if not PANEL.is_file() or not RISK_WORKER.is_file():raise RuntimeError('EXISTING_DASHBOARD_OR_RISK_WORKER_MISSING')
 if UNIT.exists() or SOURCE.exists():raise RuntimeError('DUAL5_ALREADY_DEPLOYED_ABORT')
 if sh('systemctl','is-active','zl-prediction-risk-exits.service').stdout.strip()!='active':
  raise RuntimeError('EXISTING_RISK_EXITS_NOT_RUNNING_ABORT')
 if sh('systemctl','is-active','zl-prediction-trade.service').stdout.strip()!='active':
  raise RuntimeError('EXISTING_PRODUCTION_TRADE_DOWN_ABORT')
 trade=api(13001,'/api/status')
 if trade.get('enabled') is not False:raise RuntimeError('EXISTING_AUTO_FOLLOW_ON_ABORT_FOR_SAFETY')
 if (trade.get('pendingAction') or {}).get('state') in ('READY','QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN'):
  raise RuntimeError('EXISTING_REAL_PENDING_ORDER_ABORT')
 text=PANEL.read_text()
 if text.count(ROUTE_ANCHOR)!=1 or '/api/dual5-status' in text:
  raise RuntimeError('EXISTING_DASHBOARD_ROUTE_DRIFT')
 if not pathlib.Path('/var/lib/zl-exchange-api/prediction/binance.env').is_file():
  raise RuntimeError('EXISTING_BINANCE_SERVICE_ENV_NOT_FOUND')
 node_user=sh('id','-u','zl-pred').stdout.strip()
 node_gid=sh('id','-g','zl-pred').stdout.strip()
 if not node_user.isdigit() or not node_gid.isdigit():raise RuntimeError('TRADE_USER_NOT_FOUND')
 uid,gid=int(node_user),int(node_gid)
 with tempfile.TemporaryDirectory(prefix='dual5-prod-release-') as dir:
  tmp=pathlib.Path(dir)
  for name in ('binance_dual5_pairs.mjs','binance_dual5_dashboard.html','risk-worker.mjs'):
   directory='railway-diagnostic' if name=='risk-worker.mjs' else 'prediction-bot-v1'
   uri='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/'+directory+'/'+name
   with urllib.request.urlopen(uri,timeout=30) as r:(tmp/name).write_bytes(r.read())
  sh(NODE,'--check',str(tmp/'binance_dual5_pairs.mjs'))
  core=(tmp/'binance_dual5_pairs.mjs').read_text()
  page=(tmp/'binance_dual5_dashboard.html').read_text()
  for needle in ('calcPair','MAX_DAILY_SPEND','MIN_EDGE','complimentaryTokens',
   'config.armed=false;config.blocked=true','LIVE_PAIR_SUBMISSION','UNHEDGED_OR_UNKNOWN_STOPPED'):
   if needle not in core:raise RuntimeError('DUAL5_UNSAFE_BUILD_'+needle)
  for needle in ('UP + DOWN','/api/dual5-status','/api/dual5-arm','启用独立双边实盘'):
   if needle not in page:raise RuntimeError('DUAL5_MISSING_WEB_CONTROL_'+needle)
  if '/api/dual5-risk' not in page or 'DOWN 持仓' not in page:
   raise RuntimeError('DUAL5_INDEPENDENT_TPSL_FRONTEND_MISSING')
  old_risk=RISK_WORKER.read_text()
  updated_risk=(tmp/'risk-worker.mjs').read_text()
  for needle in ('DUAL5_CONFIG_FILE','function dual5RiskFor(position)',
                 'riskSide: targets.riskSide','PREDICTION_WALLET_LOOKUP_FAILED'):
   if needle not in updated_risk:raise RuntimeError('DUAL5_RISK_WORKER_SCOPE_FAILED')
  if 'DUAL5_CONFIG_FILE' in old_risk:
   raise RuntimeError('DUAL5_RISK_WORKER_ALREADY_INSTALLED_ABORT')
  # If production has drifted from the repo baseline, do not blindly overwrite.
  baseline_url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/f529b8424ffd50e886c567d5ecc1850a4a54e411/railway-diagnostic/risk-worker.mjs'
  with urllib.request.urlopen(baseline_url,timeout=30) as response:baseline=response.read()
  if RISK_WORKER.read_bytes()!=baseline:raise RuntimeError('EXISTING_RISK_WORKER_SOURCE_DRIFT_ABORT')
  sh(NODE,'--check',str(tmp/'risk-worker.mjs'))
  patched=text
  if "import fs from 'node:fs';" not in patched:
   patched="import * as dual5fs from 'node:fs';\n"+patched
  else:
   patched="import {readFileSync as dual5ReadFileSync} from 'node:fs';\n"+patched
   patched=patched.replace('dual5fs.readFileSync','dual5ReadFileSync')
  patched=patched.replace(ROUTE_ANCHOR,ROUTE+ROUTE_ANCHOR,1)
  t=tmp/'patched-panel.mjs';t.write_text(patched)
  sh(NODE,'--check',str(t))
  if api(13001,'/api/status').get('enabled') is not False:
   raise RuntimeError('TRADE_FOLLOW_CHANGED_DURING_PREPARATION')
  backup=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/(
   'dual5-prod-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  shutil.copy2(PANEL,backup/PANEL.name)
  shutil.copy2(RISK_WORKER,backup/RISK_WORKER.name)
  touched=False
  try:
   APP.mkdir(parents=True,exist_ok=True)
   os.chown(APP,uid,gid)
   CONFIG.parent.mkdir(parents=True,exist_ok=True)
   os.chown(CONFIG.parent,uid,gid)
   os.chmod(CONFIG.parent,0o750)
   if not CONFIG.exists():
    default={'armed':False,'blocked':False,'dailySpend':0,
      'lastOrderRound':0,'dailyDate':None,'legs':{},
      'risk':{'UP':{'takeProfitEnabled':True,'takeProfitPct':30,
        'stopLossEnabled':True,'stopLossPct':30},
      'DOWN':{'takeProfitEnabled':True,'takeProfitPct':30,
        'stopLossEnabled':True,'stopLossPct':30}}}
    install(CONFIG,json.dumps(default,indent=2).encode(),0o600,uid,gid)
   install(SOURCE,(tmp/SOURCE.name).read_bytes(),0o640,uid,gid)
   install(RISK_WORKER,(tmp/RISK_WORKER.name).read_bytes(),RISK_WORKER.stat().st_mode&0o777,RISK_WORKER.stat().st_uid,RISK_WORKER.stat().st_gid)
   install(PAGE,(tmp/PAGE.name).read_bytes(),0o640,uid,gid)
   install(UNIT,UNIT_CONTENT.encode(),0o644,0,0)
   sh('systemctl','daemon-reload')
   sh('systemctl','enable','--now',UNIT.name)
   sh('systemctl','restart','zl-prediction-risk-exits.service',timeout=80)
   for _ in range(22):
    time.sleep(1)
    try:
     d=api(13048,'/api/status')
     if d.get('model')==MODEL and d.get('active') is False and d.get('mode')=='PRODUCTION_IDLE':
      break
    except Exception:pass
   else:raise RuntimeError('DUAL5_STARTUP_STATUS_NOT_READY')
   install(PANEL,patched.encode(),PANEL.stat().st_mode&0o777,PANEL.stat().st_uid,PANEL.stat().st_gid)
   touched=True
   sh('systemctl','restart','zl-prediction-trade.service',timeout=80)
   valid=False
   for _ in range(24):
    time.sleep(1)
    try:
     trade2=api(13001,'/api/status');q=api(13001,'/api/dual5-status')
     html=urllib.request.urlopen('http://127.0.0.1:13001/dual5',timeout=5).read().decode('utf8')
     if (q.get('ok') is True and q.get('mode')=='PRODUCTION_IDLE' and
       q.get('active') is False and trade2.get('enabled') is False and
       '启用独立双边实盘' in html and '/api/dual5-arm' in html and
       'id="riskSave"' in html and '/api/dual5-risk' in html):
      valid=True;break
    except Exception:pass
   if not valid:raise RuntimeError('DUAL5_POSTDEPLOY_ROUTE_OR_TRADING_STATE_FAILED')
   print('DUAL5_DEPLOY_SUCCESS=true',flush=True)
   print('DUAL5_MODULE='+MODEL,flush=True)
   print('DUAL5_REAL_ORDER_IMPLEMENTED=true',flush=True)
   print('DUAL5_LIVE_SWITCH_DEFAULT_OFF=true',flush=True)
   print('DUAL5_UP_DOWN_INDEPENDENT_TPSL_READY=true',flush=True)
   print('DUAL5_BOTH_DEFAULT_TP30_SL30=true',flush=True)
   print('DUAL5_EXISTING_RISK_EXECUTOR_REUSED=true',flush=True)
   print('DUAL5_PRODUCTION_UI=/dual5',flush=True)
   print('DUAL5_FAST5_ORIGINAL_MODEL_UNCHANGED=true',flush=True)
   print('DUAL5_BASE_TRADING_FOLLOW_OFF=true',flush=True)
   print('DUAL5_FIRST_STATUS='+json.dumps({k:q.get(k) for k in
    ('health','lastError','checked','quoteChecks','lastOpportunity','mode')},ensure_ascii=False),flush=True)
   print('DUAL5_BACKUP='+str(backup),flush=True)
  except BaseException:
   print('DUAL5_ROLLBACK_STARTED=true',flush=True)
   subprocess.run(['systemctl','disable','--now',UNIT.name],timeout=45)
   shutil.copy2(backup/RISK_WORKER.name,RISK_WORKER)
   subprocess.run(['systemctl','restart','zl-prediction-risk-exits.service'],timeout=85)
   if touched:
    shutil.copy2(backup/PANEL.name,PANEL)
    subprocess.run(['systemctl','restart','zl-prediction-trade.service'],timeout=85)
   UNIT.unlink(missing_ok=True)
   SOURCE.unlink(missing_ok=True);PAGE.unlink(missing_ok=True)
   subprocess.run(['systemctl','daemon-reload'],timeout=30)
   print('DUAL5_ROLLBACK_ATTEMPTED=true',flush=True)
   raise
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('DUAL5_PRODUCTION_ERROR',type(e).__name__,str(e)[:280],flush=True)
  sys.exit(1)

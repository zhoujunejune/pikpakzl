#!/usr/bin/env python3
"""Guarded dual5 fast-entry scanner release. No live order, no risk-setting change."""
import os
import re
import sys
import json
import time
import shutil
import pathlib
import tempfile
import subprocess
import urllib.request
import urllib.parse
import hashlib
import hmac
from datetime import datetime, timezone

APP=pathlib.Path('/opt/zl-prediction-dual5')
WORKER=APP/'binance_dual5_pairs.mjs'
PAGE=APP/'binance_dual5_dashboard.html'
PANEL=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
ROUTE_ANCHOR="  if (url.pathname === '/api/dual5-risk' && req.method === 'POST') {"
FUNDING_PROXY=r"""
  // Owner-only authenticated payment selection; no auto-switch, transfer or order.
  if (url.pathname === '/api/dual5-funding' && req.method === 'POST') {
    if (req.headers.origin !== 'https://prediction.47-237-188-69.sslip.io' ||
        req.headers['sec-fetch-site'] !== 'same-origin') {
      res.writeHead(403,{'content-type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'SAME_ORIGIN_AUTH_REQUIRED'}));return;
    }
    void (async()=>{
      try{
        let body='',bytes=0;
        for await(const chunk of req){
          bytes+=chunk.length;if(bytes>350)throw Error('FUNDING_REQUEST_TOO_LARGE');
          body+=chunk.toString('utf8');
        }
        const data=JSON.parse(body);
        if(data?.fundingSource!=='MPC'&&data?.fundingSource!=='CEX')
          throw Error('INVALID_FUNDING_SOURCE_MPC_OR_CEX');
        const upstream=await fetch('http://127.0.0.1:13048/api/funding',{
          method:'POST',
          headers:{'Content-Type':'application/json',
            'Origin':req.headers.origin,'Sec-Fetch-Site':req.headers['sec-fetch-site']},
          body:JSON.stringify({fundingSource:data.fundingSource}),
          signal:AbortSignal.timeout(3000)
        });
        const raw=await upstream.text();
        res.writeHead(upstream.status,{'content-type':'application/json; charset=utf-8',
          'cache-control':'no-store'});
        res.end(raw);
      }catch(e){
        res.writeHead(400,{'content-type':'application/json'});
        res.end(JSON.stringify({ok:false,error:'INVALID_FUNDING_SOURCE_OR_UNAVAILABLE'}));
      }
    })();
    return;
  }
"""
RECOVERY_PROXY=r"""
  // Explicit same-origin owner click only; worker verifies exact FAILED zero-fill and no position.
  if (url.pathname === '/api/dual5-reconcile-known-zero-fill' && req.method === 'POST') {
    if (req.headers.origin !== 'https://prediction.47-237-188-69.sslip.io' ||
        req.headers['sec-fetch-site'] !== 'same-origin') {
      res.writeHead(403,{'content-type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'SAME_ORIGIN_AUTH_REQUIRED'}));return;
    }
    void (async()=>{
      try{
        let body='',bytes=0;
        for await(const chunk of req){
          bytes+=chunk.length;if(bytes>100)throw Error('RECOVERY_REQUEST_TOO_LARGE');
          body+=chunk.toString('utf8');
        }
        if(body.trim()!=='{}')throw Error('RECOVERY_EMPTY_BODY_REQUIRED');
        const upstream=await fetch('http://127.0.0.1:13048/api/reconcile-known-zero-fill',{
          method:'POST',
          headers:{'Content-Type':'application/json','Origin':req.headers.origin,
            'Sec-Fetch-Site':req.headers['sec-fetch-site']},
          body:'{}',signal:AbortSignal.timeout(45000)
        });
        const text=await upstream.text();
        res.writeHead(upstream.status,{'content-type':'application/json; charset=utf-8',
          'cache-control':'no-store'});
        res.end(text);
      }catch(e){
        res.writeHead(503,{'content-type':'application/json'});
        res.end(JSON.stringify({ok:false,error:'BINANCE_RECONCILIATION_UNAVAILABLE'}));
      }
    })();
    return;
  }
"""
FLAT_PROXY=r"""
  // Owner-initiated, same-origin Binance wallet risk audit; never places an order.
  if (url.pathname === '/api/dual5-reconcile-flat-wallet' && req.method === 'POST') {
    if (req.headers.origin !== 'https://prediction.47-237-188-69.sslip.io' ||
        req.headers['sec-fetch-site'] !== 'same-origin') {
      res.writeHead(403,{'content-type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'SAME_ORIGIN_AUTH_REQUIRED'}));return;
    }
    void (async()=>{
      try{
        let body='',bytes=0;
        for await(const chunk of req){
          bytes+=chunk.length;if(bytes>80)throw Error('REQUEST_TOO_LARGE');
          body+=chunk.toString('utf8');
        }
        if(body.trim()!=='{}')throw Error('EMPTY_AUDIT_PAYLOAD_REQUIRED');
        const upstream=await fetch('http://127.0.0.1:13048/api/reconcile-flat-wallet',{
          method:'POST',
          headers:{'Content-Type':'application/json','Origin':req.headers.origin,
            'Sec-Fetch-Site':req.headers['sec-fetch-site']},
          body:'{}',signal:AbortSignal.timeout(55000)
        });
        const raw=await upstream.text();
        res.writeHead(upstream.status,{'content-type':'application/json; charset=utf-8',
          'cache-control':'no-store'});
        res.end(raw);
      }catch(e){
        res.writeHead(503,{'content-type':'application/json'});
        res.end(JSON.stringify({ok:false,error:'RISK_AUDIT_TEMPORARILY_UNAVAILABLE'}));
      }
    })();
    return;
  }
"""
NODE='/opt/zl-prediction-node/bin/node'
BACKUPS=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')

def run(*args, timeout=90):
    return subprocess.run(args, check=True, timeout=timeout, capture_output=True, text=True)

def obj(port, path):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=10) as r:
        return json.loads(r.read(1400000))

def page(port, path):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=10) as r:
        return r.read(1000000).decode('utf8', 'replace')

def atomic_replace(dest, new_data):
    st=dest.stat()
    fd,tmp=tempfile.mkstemp(prefix='.dual5-speed-',dir=str(dest.parent))
    try:
        with os.fdopen(fd,'wb') as out:out.write(new_data)
        os.chmod(tmp,st.st_mode & 0o777)
        os.chown(tmp,st.st_uid,st.st_gid)
        os.replace(tmp,dest)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def check_pending_exposure_readonly():
    """Gate code-only deploy when stale pending markers survive a previous manual unlock.
    Never alter the config. Two signed Binance snapshots must both show zero exposure.
    """
    pid=run('systemctl','show','-p','MainPID','--value',
        'zl-prediction-dual5.service',timeout=8).stdout.strip()
    entries=pathlib.Path('/proc/'+pid+'/environ').read_bytes().split(bytes([0]))
    env=dict(z.split('=',1) for z in
        (x.decode('utf8','ignore') for x in entries if b'=' in x))
    key=env.get('BINANCE_PREDICTION_API_KEY','')
    secret=env.get('BINANCE_PREDICTION_API_SECRET','')
    if not key or not secret:raise RuntimeError('BINANCE_READONLY_CREDENTIALS_UNAVAILABLE')
    def signed_get(route,params=None):
        q=urllib.parse.urlencode({**(params or {}),
            'timestamp':int(time.time()*1000),'recvWindow':5000})
        sig=hmac.new(secret.encode(),q.encode(),hashlib.sha256).hexdigest()
        req=urllib.request.Request('https://api.binance.com'+route+'?'+q+'&signature='+sig,
            headers={'X-MBX-APIKEY':key,'Cache-Control':'no-store'})
        with urllib.request.urlopen(req,timeout=20) as resp:return json.load(resp)
    wallets=signed_get('/sapi/v1/w3w/wallet/prediction/wallet/list').get('wallets') or []
    wallet=next((w for w in wallets if w.get('walletAddress') and w.get('walletId')),None)
    if not wallet:raise RuntimeError('BINANCE_PREDICTION_WALLET_UNAVAILABLE')
    for i in (1,2):
        params={'walletAddress':wallet['walletAddress'],'offset':0,'limit':100}
        orders=signed_get('/sapi/v1/w3w/wallet/prediction/order/list',params)
        positions=signed_get('/sapi/v1/w3w/wallet/prediction/position/list',
            {**params,'tab':'ONGOING'})
        if not isinstance(orders.get('orders'),list) or not isinstance(positions.get('positions'),list):
            raise RuntimeError('BINANCE_READONLY_SNAPSHOT_INCOMPLETE')
        if orders['orders'] or positions['positions']:
            raise RuntimeError('OPEN_ORDERS_OR_ONGOING_POSITIONS_ABORT')
        for result in (orders,positions):
            t=result.get('total')
            if t is not None and (not str(t).isdigit() or int(t)>0):
                raise RuntimeError('BINANCE_SNAPSHOT_TOTAL_NONZERO_ABORT')
        if i==1:time.sleep(1.3)
    print('DUAL5_PENDING_MARKERS_WALLET_FLAT_TWICE_VERIFIED=true',flush=True)


def main():
    if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch(r'[0-9a-f]{40}',sys.argv[1]):
        raise RuntimeError('ROOT_AND_SHA_REQUIRED')
    sha=sys.argv[1]
    for f in (WORKER,PAGE,PANEL):
        if not f.is_file():raise RuntimeError('LIVE_DUAL5_FILE_MISSING')
    main_before=obj(13001,'/api/status')
    dual_before=obj(13048,'/api/status')
    if main_before.get('enabled') is not False:
        raise RuntimeError('MAIN_ROBOT_IS_ACTIVE_ABORT')
    if dual_before.get('model')!='BINANCE_DUAL5_PAIR_V1':
        raise RuntimeError('WRONG_DUAL5_MODEL')
    if dual_before.get('active') is not False:
        raise RuntimeError('DUAL5_MUST_BE_IDLE')
    previous_blocked=dual_before.get('blocked')
    if previous_blocked not in (True,False):raise RuntimeError('UNKNOWN_LOCK_STATE_ABORT')
    if (main_before.get('pendingAction') or {}).get('state') in (
        'READY','QUOTING','SUBMITTING','SUBMITTED_PENDING_CONFIRMATION','SUBMISSION_UNKNOWN'):
        raise RuntimeError('BASE_BOT_PENDING_ORDER_ABORT')
    # Never change, drop, or resolve pending orders in a code-only release.
    pending_legs=[leg for leg in (dual_before.get('legs') or {}).values()
                  if isinstance(leg,dict) and leg.get('status')=='ORDER_PENDING']
    if pending_legs and previous_blocked is not True:
        if any(not isinstance(p.get('round'),(int,float)) or
               time.time()*1000-float(p['round'])<600000 for p in pending_legs):
            raise RuntimeError('RECENT_UNLOCKED_PENDING_ORDER_ABORT')
        check_pending_exposure_readonly()
    for unit in ('zl-prediction-dual5.service','zl-prediction-trade.service','zl-prediction-risk-exits.service'):
        if run('systemctl','is-active',unit).stdout.strip()!='active':
            raise RuntimeError('SERVICE_NOT_ACTIVE_'+unit)
    with tempfile.TemporaryDirectory(prefix='dual5-fast-stage-') as td:
        stage=pathlib.Path(td)
        for target in (WORKER,PAGE):
            url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/prediction-bot-v1/'+target.name
            with urllib.request.urlopen(url,timeout=30) as resp:
                (stage/target.name).write_bytes(resp.read())
        run(NODE,'--check',str(stage/WORKER.name))
        new_worker=(stage/WORKER.name).read_text()
        new_page=(stage/PAGE.name).read_text()
        for marker in ('ROUND_BOUNDARY_FAST_V1','nextScanDelayMs','elapsed<15000?700',
                       'record.firstOrderSubmitAt=Date.now()','record.bothConfirmedAt=Date.now()',
                       'profitFilterEnabled:false','UNHEDGED_OR_UNKNOWN_STOPPED',
                       "if(!estimate.ok){state.health='INVALID_PAIR_QUOTES';return}",
                       'if(!reassess.ok || Number(down.expireAt)',
                       "quoteFor(topic,pair.up,wallet,config.amounts.UP,config.fundingSource)",
                       "quoteFor(topic,pair.down,wallet,config.amounts.DOWN,config.fundingSource)",
                       "req.url==='/api/funding'","STOP_TRADING_BEFORE_FUNDING_EDIT",
                       "place(wallet,topic,q1,fundingSource)",
                       "place(wallet,topic,down,fundingSource)",
                       'const ENTRY_WINDOW_MS=15000,CONFIRM_WINDOW_MS=12000',
                       "exactOrderResult(orders,id,topic)",
                       "record.phase='UP_ZERO_FILL_CONFIRMED'",
                       "req.url==='/api/reconcile-known-zero-fill'",
                       "EXACT_BINANCE_FAILED_ZERO_FILL_NOT_PROVEN",
                       "OPEN_POSITION_IN_RECOVERY_MARKET",
                       "HISTORIC_PENDING_LEG_MISMATCH",
                       "req.url==='/api/reconcile-flat-wallet'",
                       "LATEST_ROUND_NOT_YET_SAFE_TO_RECONCILE",
                       "BINANCE_ACCOUNT_SNAPSHOT_INCOMPLETE",
                       "reconcileStalePendingForFundingChange",
                       "FUNDING_RECONCILIATION_STATE_CHANGED",
                       "NO_OPEN_EXPOSURE_VERIFIED",
                       "TRADING_NOT_OFF_OR_NOTHING_TO_RECONCILE",
                       "clearedStalePending:pending.length"):
            if marker not in new_worker:raise RuntimeError('SCANNER_GUARD_MISSING_'+marker)
        for marker in ('id="upAmount"','id="downAmount"','id="riskSave"',
                       'id="firstScanLag"','id="pairExecution"',
                       'id="fundingSource"','id="fundingSave"','/api/dual5-funding',
                       'id="riskUnlock"','id="riskUnlockPanel"',
                       '/api/dual5-reconcile-flat-wallet',
                       'const hasStalePending=Object.values(d.legs||{})',
                       '核验无持仓并恢复操作'):
            if marker not in new_page:raise RuntimeError('FRONTEND_GUARD_MISSING_'+marker)
        if any(old in new_worker for old in ('if(raw>=1-2*fee-MIN_EDGE/3.2)', 'if(!estimate.feasible)', 'if(!reassess.feasible')):
            raise RuntimeError('PROFIT_FILTER_STILL_BLOCKS_ROUND_OPEN_ORDERS')
        if 'DAILY_BUDGET_STOP' in new_worker or 'MAX_DAILY_SPEND' in new_worker:
            raise RuntimeError('SPENDING_HARD_CAP_REGRESSION')
        panel_before=PANEL.read_text()
        if panel_before.count(ROUTE_ANCHOR)!=1:
            raise RuntimeError('DUAL5_FUNDING_PROXY_ANCHOR_DRIFT')
        if panel_before.count("'/api/dual5-funding'")!=1:
            raise RuntimeError('DUAL5_FUNDING_PROXY_NOT_ALREADY_INSTALLED')
        patched=panel_before
        if "'/api/dual5-reconcile-flat-wallet'" not in patched:
            patched=patched.replace(ROUTE_ANCHOR,FLAT_PROXY+ROUTE_ANCHOR,1)
        (stage/'panel-stats-shell.mjs').write_text(patched)
        run(NODE,'--check',str(stage/'panel-stats-shell.mjs'))
        if obj(13048,'/api/status').get('active') is not False or obj(13001,'/api/status').get('enabled') is not False:
            raise RuntimeError('LIVE_STATE_CHANGED_ABORT')
        archive=BACKUPS/('dual5-fast-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        archive.mkdir(parents=True,exist_ok=False)
        for f in (WORKER,PAGE,PANEL):shutil.copy2(f,archive/f.name)
        touched=False
        try:
            atomic_replace(WORKER,(stage/WORKER.name).read_bytes())
            atomic_replace(PAGE,(stage/PAGE.name).read_bytes())
            if patched!=panel_before:atomic_replace(PANEL,patched.encode('utf8'))
            touched=True
            run('systemctl','restart','zl-prediction-dual5.service',timeout=70)
            if patched!=panel_before:run('systemctl','restart','zl-prediction-trade.service',timeout=90)
            verified=False
            for _ in range(30):
                time.sleep(1)
                try:
                    d=obj(13048,'/api/status')
                    base=obj(13001,'/api/status')
                    ui=page(13001,'/dual5')
                    if (d.get('ok') is True and d.get('model')=='BINANCE_DUAL5_PAIR_V1'
                      and d.get('scanMode')=='ROUND_BOUNDARY_FAST_V1'
                      and d.get('entryMode')=='ROUND_OPEN_VALID_QUOTES_V2'
                      and d.get('profitFilterEnabled') is False
                      and d.get('active') is False and d.get('blocked') is previous_blocked
                      and d.get('trackedCount')==dual_before.get('trackedCount')
                      and d.get('legs')==dual_before.get('legs')
                      and d.get('amounts')==dual_before.get('amounts')
                      and d.get('risk')==dual_before.get('risk')
                      and d.get('fundingSource')==dual_before.get('fundingSource','MPC')
                      and base.get('enabled') is False
                      and "'/api/dual5-funding'" in PANEL.read_text()
                      and "'/api/dual5-reconcile-flat-wallet'" in PANEL.read_text()
                      and 'id="riskUnlock"' in ui
                      and 'id="fundingSource"' in ui and 'id="fundingSave"' in ui
                      and '/api/dual5-funding' in ui
                      and 'id="firstScanLag"' in ui and 'id="pairExecution"' in ui):
                        verified=True
                        break
                except Exception:
                    pass
            if not verified:raise RuntimeError('FAST_SCAN_LIVE_VERIFY_FAILED')
            for unit in ('zl-prediction-dual5.service','zl-prediction-trade.service','zl-prediction-risk-exits.service'):
                if run('systemctl','is-active',unit).stdout.strip()!='active':
                    raise RuntimeError('SERVICE_INACTIVE_AFTER_RELEASE_'+unit)
            print('DUAL5_FAST_SCAN_DEPLOY_SUCCESS=true',flush=True)
            print('DUAL5_FUNDING_SWITCH_PENDING_RECONCILIATION_PATCH_LIVE=true',flush=True)
            print('DUAL5_OWNER_ONLY_HISTORIC_RECOVERY_BUTTON_DEPLOYED=true',flush=True)
            print('DUAL5_OWNER_WALLET_RISK_AUDIT_BUTTON_LIVE=true',flush=True)
            print('DUAL5_15S_ENTRY_AND_ZERO_FILL_TERMINAL_FIX_LIVE=true',flush=True)
            print('DUAL5_EXISTING_ORDER_LOCK_UNCHANGED='+str(previous_blocked).lower(),flush=True)
            print('DUAL5_MPC_CEX_OWNER_SELECTOR_LIVE=true',flush=True)
            print('DUAL5_FUNDING_SOURCE='+str(d.get('fundingSource')),flush=True)
            print('DUAL5_SCAN_MODE=ROUND_BOUNDARY_FAST_V1',flush=True)
            print('DUAL5_ROUND_OPEN_ORDERS_WITHOUT_PROFIT_FILTER=true',flush=True)
            print('DUAL5_AMOUNTS_AND_TP_SL_UNCHANGED=true',flush=True)
            print('DUAL5_FOLLOW_OFF=true',flush=True)
            print('DUAL5_MAIN_ROBOT_OFF=true',flush=True)
            print('DUAL5_BACKUP='+str(archive),flush=True)
        except BaseException:
            print('DUAL5_FAST_SCAN_ROLLBACK_START=true',flush=True)
            if touched:
                for f in (WORKER,PAGE,PANEL):shutil.copy2(archive/f.name,f)
                subprocess.run(['systemctl','restart','zl-prediction-dual5.service'],timeout=75)
                if patched!=panel_before:
                    subprocess.run(['systemctl','restart','zl-prediction-trade.service'],timeout=90)
            print('DUAL5_FAST_SCAN_ROLLBACK_ATTEMPTED=true',flush=True)
            raise

if __name__=='__main__':
    try:main()
    except Exception as e:
        print('DUAL5_FAST_SCAN_RELEASE_FAILED',type(e).__name__,str(e)[:250],flush=True)
        sys.exit(1)

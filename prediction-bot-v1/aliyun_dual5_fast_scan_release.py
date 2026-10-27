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
from datetime import datetime, timezone

APP=pathlib.Path('/opt/zl-prediction-dual5')
WORKER=APP/'binance_dual5_pairs.mjs'
PAGE=APP/'binance_dual5_dashboard.html'
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

def main():
    if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch(r'[0-9a-f]{40}',sys.argv[1]):
        raise RuntimeError('ROOT_AND_SHA_REQUIRED')
    sha=sys.argv[1]
    for f in (WORKER,PAGE):
        if not f.is_file():raise RuntimeError('LIVE_DUAL5_FILE_MISSING')
    main_before=obj(13001,'/api/status')
    dual_before=obj(13048,'/api/status')
    if main_before.get('enabled') is not False:
        raise RuntimeError('MAIN_ROBOT_IS_ACTIVE_ABORT')
    if dual_before.get('model')!='BINANCE_DUAL5_PAIR_V1':
        raise RuntimeError('WRONG_DUAL5_MODEL')
    if dual_before.get('active') is not False or dual_before.get('blocked') is True:
        raise RuntimeError('DUAL5_MUST_BE_IDLE_AND_UNBLOCKED')
    for leg in (dual_before.get('legs') or {}).values():
        if isinstance(leg,dict) and leg.get('status')=='ORDER_PENDING':
            raise RuntimeError('ORDER_PENDING_ABORT')
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
                       "quoteFor(topic,pair.up,wallet,config.amounts.UP)",
                       "quoteFor(topic,pair.down,wallet,config.amounts.DOWN)"):
            if marker not in new_worker:raise RuntimeError('SCANNER_GUARD_MISSING_'+marker)
        for marker in ('id="upAmount"','id="downAmount"','id="riskSave"',
                       'id="firstScanLag"','id="pairExecution"'):
            if marker not in new_page:raise RuntimeError('FRONTEND_GUARD_MISSING_'+marker)
        if any(old in new_worker for old in ('if(raw>=1-2*fee-MIN_EDGE/3.2)', 'if(!estimate.feasible)', 'if(!reassess.feasible')):
            raise RuntimeError('PROFIT_FILTER_STILL_BLOCKS_ROUND_OPEN_ORDERS')
        if 'DAILY_BUDGET_STOP' in new_worker or 'MAX_DAILY_SPEND' in new_worker:
            raise RuntimeError('SPENDING_HARD_CAP_REGRESSION')
        if obj(13048,'/api/status').get('active') is not False or obj(13001,'/api/status').get('enabled') is not False:
            raise RuntimeError('LIVE_STATE_CHANGED_ABORT')
        archive=BACKUPS/('dual5-fast-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        archive.mkdir(parents=True,exist_ok=False)
        for f in (WORKER,PAGE):shutil.copy2(f,archive/f.name)
        touched=False
        try:
            atomic_replace(WORKER,(stage/WORKER.name).read_bytes())
            atomic_replace(PAGE,(stage/PAGE.name).read_bytes())
            touched=True
            run('systemctl','restart','zl-prediction-dual5.service',timeout=70)
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
                      and d.get('active') is False and d.get('blocked') is False
                      and d.get('amounts')==dual_before.get('amounts')
                      and d.get('risk')==dual_before.get('risk')
                      and base.get('enabled') is False
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
            print('DUAL5_SCAN_MODE=ROUND_BOUNDARY_FAST_V1',flush=True)
            print('DUAL5_ROUND_OPEN_ORDERS_WITHOUT_PROFIT_FILTER=true',flush=True)
            print('DUAL5_AMOUNTS_AND_TP_SL_UNCHANGED=true',flush=True)
            print('DUAL5_FOLLOW_OFF=true',flush=True)
            print('DUAL5_MAIN_ROBOT_OFF=true',flush=True)
            print('DUAL5_BACKUP='+str(archive),flush=True)
        except BaseException:
            print('DUAL5_FAST_SCAN_ROLLBACK_START=true',flush=True)
            if touched:
                for f in (WORKER,PAGE):shutil.copy2(archive/f.name,f)
                subprocess.run(['systemctl','restart','zl-prediction-dual5.service'],timeout=75)
            print('DUAL5_FAST_SCAN_ROLLBACK_ATTEMPTED=true',flush=True)
            raise

if __name__=='__main__':
    try:main()
    except Exception as e:
        print('DUAL5_FAST_SCAN_RELEASE_FAILED',type(e).__name__,str(e)[:250],flush=True)
        sys.exit(1)

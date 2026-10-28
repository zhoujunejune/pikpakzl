#!/usr/bin/env python3
"""Guarded live FAST5 V7 trend upgrade. Trading controls stay untouched.
Keeps V6 statistics database intact and starts separate V7 SQLite ledger.
Atomic source backups and rollback if postdeploy verification fails.
"""
import os,sys,re,json,pathlib,shutil,subprocess,tempfile,urllib.request,time
from datetime import datetime,timezone
ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
SIDE=pathlib.Path('/opt/zl-prediction-fast5')
CALC=SIDE/'fast5-real-market-calculator.mjs'
UI=ROOT/'fast5-dashboard-inject.mjs'
STATS=SIDE/'fast5_independent_stats_service.py'
CHOICE=ROOT/'production-signal-choice.mjs'
INDEX=ROOT/'index.mjs'
DB_OLD=pathlib.Path('/var/lib/zl-prediction/fast5-stats/rounds.sqlite3')
DB_NEW=pathlib.Path('/var/lib/zl-prediction/fast5-stats/rounds-v7.sqlite3')
NODE='/opt/zl-prediction-node/bin/node'
OLD='FAST5_SMALL_ONLY_LE5BPS_15M_V6'
NEW='FAST5_BULL_BEAR_TREND_2S_V7'
MODEL='FAST5_SPOT_MOMENTUM_V1'
UNITS=('zl-prediction-fast5.service','zl-prediction-trade.service','zl-prediction-fast5-stats.service')
PATHS=(CALC,CHOICE,INDEX,UI,STATS)
VALIDATOR=r"""
export function validateFast5ProductionLive(body,now=Date.now()){
 const round=roundOf(now),lock=body?.latest;
 const ts=lock?.lockedAt,marketAt=lock?.marketAt;
 if(body?.ok!==true||body?.model!=='FAST5_SPOT_MOMENTUM_V1'||
   body?.strategyVersion!=='FAST5_BULL_BEAR_TREND_2S_V7'||
   body?.readOnly!==true||body?.requiresDeepSeek!==false||
   body?.orders!==false||body?.productionIntegration!==false||
   body?.marketSource!=='BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR'||
   body?.lastError!=null) return {ok:false,reason:'FAST5_V7_UNTRUSTED_SOURCE'};
 if(!lock||lock.model!==body.model||lock.strategyVersion!==body.strategyVersion||
   lock.round!==round||body.round!==round||
   lock.status!=='LOCKED'||!['UP','DOWN'].includes(lock.direction)||
   lock.source!=='BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR'||
   lock.requiresDeepSeek!==false||lock.orders!==false||
   lock.productionIntegration!==false||
   lock.confidenceIsCalibrated!==false||lock.officialOracleLiveQuoteUsed!==false||
   !Number.isSafeInteger(ts)||ts<round||ts>=round+2000||ts>now+250||
   now-ts>16000||now>=round+20000||
   !Number.isSafeInteger(marketAt)||marketAt<round-1300||marketAt>ts||
   ts-marketAt>1300||
   lock.trendVersion!=='MULTISCALE_15S_120S_15M_REAL_MARKET_V1'||
   lock.decisionMethod!=='MULTISCALE_15S_120S_15M_REAL_MARKET_V1'||
   lock.signalReason!=='WEIGHTED_SIGNED_REAL_SPOT_TREND'||
   !Number.isFinite(lock.scoreBps)||lock.scoreBps===0||
   !Number.isFinite(lock.trendScoreBps)||lock.trendScoreBps!==lock.scoreBps||
   lock.direction!==(lock.scoreBps<0?'DOWN':'UP')||
   lock.trendDirection!==lock.direction||
   !['REAL_TICKS_PREVIOUS_120S','CLOSED_1M_PREVIOUS_120S','RECENT_CLOSED_1M_TREND'].includes(lock.prewarmSource)||
   !Number.isSafeInteger(lock.prewarmSamples)||lock.prewarmSamples<1||
   !Number.isSafeInteger(lock.prewarmSpanMs)||lock.prewarmSpanMs<60000)
   return {ok:false,reason:'FAST5_V7_INVALID_OR_LATE_TREND_LOCK'};
 if(lock.prewarmOnly===true){
  if(lock.currentRoundQuoteVerified!==false||
    lock.roundOpenPrice!==null||lock.openingObservedPrice!==null)
   return {ok:false,reason:'FAST5_V7_WRONG_PREWARM_EVIDENCE'};
 }else if(lock.prewarmOnly===false){
  if(lock.currentRoundQuoteVerified!==true||marketAt<round||
    ts-marketAt>800||!Number.isFinite(lock.roundOpenPrice)||lock.roundOpenPrice<=0||
    !Number.isFinite(lock.openingObservedPrice)||lock.openingObservedPrice<=0)
   return {ok:false,reason:'FAST5_V7_WRONG_OPENING_QUOTE'};
 }else return {ok:false,reason:'FAST5_V7_MISSING_PROVENANCE'};
 return {ok:true,round,direction:lock.direction,lockedAt:ts,
  marketAt,score:Math.abs(lock.scoreBps),prewarmOnly:lock.prewarmOnly};
}
"""
def run(*args,timeout=80):
 return subprocess.run(args,check=True,timeout=timeout,capture_output=True,text=True)
def get(port,url):
 with urllib.request.urlopen('http://127.0.0.1:'+str(port)+url,timeout=8) as r:return json.load(r)
def put(path,data):
 st=path.stat();fd,name=tempfile.mkstemp(dir=str(path.parent),prefix='.fast5-v7-')
 try:
  with os.fdopen(fd,'wb') as f:f.write(data)
  os.chmod(name,st.st_mode&0o777)
  os.chown(name,st.st_uid,st.st_gid)
  os.replace(name,path)
 finally:
  if os.path.exists(name):os.unlink(name)
def validator_upgrade(s):
 marker='\nexport function validateFast5ProductionLive(body,now=Date.now()){'
 if s.count(marker)!=1:raise RuntimeError('FAST5_VALIDATOR_ENTRY_DRIFT')
 start=s.index(marker);old=s[start:]
 if OLD not in old or 'lock.regimeMagnitudeBps' not in old:
  raise RuntimeError('EXPECTED_V6_VALIDATOR_NOT_PRESENT')
 if '\nexport ' in old[len(marker):]:raise RuntimeError('EXPECTED_LAST_EXPORT_NOT_FOUND')
 return s[:start]+'\n'+VALIDATOR.strip()+'\n'
def accelerate_fast_pickup(s):
 marker='let fastLivePrepareCheckBusy=false;'
 start=s.find(marker)
 if start<0 or s.count(marker)!=1:raise RuntimeError('FAST_LOCAL_PICKUP_NOT_FOUND')
 end=s.find('setInterval(prepareWorker, 1200);',start)
 if end<0 or end-start>1600:raise RuntimeError('FAST_PICKUP_EXPECTED_SOURCE_MISSING')
 part=s[start:end]
 if part.count('},120);')!=1 or 'modelSelectionSnapshot().model!==SELECTIVE8_MODEL' not in part:
  raise RuntimeError('FAST_PICKUP_GUARD_DRIFT')
 return s[:start]+part.replace('},120);','},80);')+s[end:]
def test_validator(tmp):
 test="""const roundOf=t=>Math.floor(t/300000)*300000;\n"""+VALIDATOR+"""
const R=1793095800000;
const mk=()=>({ok:true,model:'FAST5_SPOT_MOMENTUM_V1',
 strategyVersion:'FAST5_BULL_BEAR_TREND_2S_V7',
 marketSource:'BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR',
 readOnly:true,requiresDeepSeek:false,orders:false,productionIntegration:false,
 lastError:null,round:R,latest:{
 model:'FAST5_SPOT_MOMENTUM_V1',strategyVersion:'FAST5_BULL_BEAR_TREND_2S_V7',
 status:'LOCKED',round:R,direction:'DOWN',trendDirection:'DOWN',
 trendVersion:'MULTISCALE_15S_120S_15M_REAL_MARKET_V1',
 decisionMethod:'MULTISCALE_15S_120S_15M_REAL_MARKET_V1',
 signalReason:'WEIGHTED_SIGNED_REAL_SPOT_TREND',scoreBps:-0.123,
 trendScoreBps:-0.123,lockedAt:R+400,marketAt:R+340,
 prewarmSource:'CLOSED_1M_PREVIOUS_120S',prewarmSamples:2,prewarmSpanMs:120000,
 prewarmOnly:false,currentRoundQuoteVerified:true,
 roundOpenPrice:80000,openingObservedPrice:79999,
 source:'BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR',requiresDeepSeek:false,orders:false,
 productionIntegration:false,confidenceIsCalibrated:false,
 officialOracleLiveQuoteUsed:false}});
if(!validateFast5ProductionLive(mk(),R+500).ok)throw Error('REAL_LOCK_REJECTED');
let a=mk();a.latest.lockedAt=R+1999;a.latest.marketAt=R+1900;
if(!validateFast5ProductionLive(a,R+1999).ok)throw Error('PRE2S_LOCK_REJECTED');
a=mk();a.latest.lockedAt=R+2000;
if(validateFast5ProductionLive(a,R+2000).ok)throw Error('TWO_SECOND_LOCK_ACCEPTED');
a=mk();a.latest.scoreBps=0;
if(validateFast5ProductionLive(a,R+600).ok)throw Error('ZERO_MOMENTUM_ACCEPTED');
a=mk();a.latest.direction='UP';
if(validateFast5ProductionLive(a,R+600).ok)throw Error('WRONG_SIGN_ACCEPTED');
a=mk();a.latest.marketAt=R-1500;a.latest.prewarmOnly=true;
a.latest.currentRoundQuoteVerified=false;a.latest.roundOpenPrice=null;a.latest.openingObservedPrice=null;
if(validateFast5ProductionLive(a,R+600).ok)throw Error('STALE_TICK_ACCEPTED');
console.log('FAST5_V7_VALIDATOR_SANITY=true');
"""
 p=tmp/'validator-v7-test.mjs';p.write_text(test)
 run(NODE,'--check',str(p));print(run(NODE,str(p)).stdout.strip(),flush=True)
def main():
 if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch('[a-f0-9]{40}',sys.argv[1]):
  raise RuntimeError('PINNED_SHA_AND_ROOT_REQUIRED')
 sha=sys.argv[1]
 if any(not p.is_file() for p in PATHS):raise RuntimeError('LIVE_FILES_NOT_PRESENT')
 for unit in UNITS:
  if run('systemctl','is-active',unit).stdout.strip()!='active':
   raise RuntimeError('LIVE_SERVICE_INACTIVE_'+unit)
 state=get(13001,'/api/status')
 choice=get(13001,'/api/order-signal-model')
 dirs=get(13001,'/api/direction-mode')
 live=get(13046,'/api/status')
 oldstats=get(13047,'/api/round-stats')
 if state.get('enabled') is not False:raise RuntimeError('AUTO_FOLLOW_ON_DEPLOY_BLOCKED')
 if (state.get('pendingAction') or {}).get('state') in (
   'READY','QUOTING','SUBMITTING','SUBMISSION_UNKNOWN','SUBMITTED_PENDING_CONFIRMATION'):
  raise RuntimeError('PENDING_REAL_ORDER_DEPLOY_BLOCKED')
 if (state.get('orderSignalModel')!=MODEL or choice.get('model')!=MODEL or
  live.get('strategyVersion')!=OLD or oldstats.get('strategyVersion')!=OLD):
  raise RuntimeError('V6_STAGED_MODEL_OR_LEDGER_MISMATCH')
 saved_directions=(dirs.get('modes') or {}).get(MODEL)
 if not isinstance(saved_directions,dict) or not dirs.get('revision'):
  raise RuntimeError('DIRECTION_SETTINGS_NOT_READY')
 if not DB_OLD.is_file():raise RuntimeError('V6_HISTORY_MISSING')
 if DB_NEW.exists():raise RuntimeError('V7_DB_ALREADY_EXISTS_ABORT_FOR_REVIEW')
 with tempfile.TemporaryDirectory(prefix='fast5-v7-stage-') as temp:
  tmp=pathlib.Path(temp)
  sources={CALC:'fast5-real-market-calculator.mjs',
    UI:'fast5-dashboard-inject.mjs',
    STATS:'fast5_independent_stats_service.py'}
  staged={}
  for p,name in sources.items():
   url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/prediction-bot-v1/'+name
   with urllib.request.urlopen(url,timeout=35) as r:data=r.read()
   staged[p]=data
   f=tmp/name;f.write_bytes(data)
   if name.endswith('.mjs'):run(NODE,'--check',str(f))
   else:run('python3','-m','py_compile',str(f))
  staged[CHOICE]=validator_upgrade(CHOICE.read_text()).encode()
  staged[INDEX]=accelerate_fast_pickup(INDEX.read_text()).encode()
  for p in (CHOICE,INDEX):
   path=tmp/p.name;path.write_bytes(staged[p]);run(NODE,'--check',str(path))
  test_validator(tmp)
  if NEW not in staged[CALC].decode() or 'SIGNAL_END_MS=2000' not in staged[CALC].decode():
   raise RuntimeError('FAST5_TREND_CALCULATOR_INCORRECT')
  if NEW not in staged[STATS].decode() or 'rounds-v7.sqlite3' not in staged[STATS].decode() or \
     '/api/fast5-round-stats' not in staged[UI].decode() or \
     '实时多空趋势' not in staged[UI].decode():
   raise RuntimeError('V7_STATS_OR_UI_MISMATCH')
  again=get(13001,'/api/status')
  new_dirs=get(13001,'/api/direction-mode')
  if again.get('enabled') is not False or \
     (again.get('pendingAction') or {}).get('state') in ('READY','QUOTING','SUBMITTING') or \
     new_dirs.get('revision')!=dirs.get('revision') or \
     (new_dirs.get('modes') or {}).get(MODEL)!=saved_directions:
   raise RuntimeError('TRADE_OR_DIRECTION_CHANGED_ABORT')
  backup=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/(
   'fast5-trend-v7-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  for p in PATHS:shutil.copy2(p,backup/p.name)
  # V6 statistics file and WAL are deliberately left untouched.
  try:
   run('systemctl','stop',UNITS[2],timeout=45)
   for p,bytes_ in staged.items():put(p,bytes_)
   run('systemctl','restart',UNITS[0],timeout=60)
   run('systemctl','restart',UNITS[1],timeout=85)
   run('systemctl','start',UNITS[2],timeout=45)
   verified=False
   for _ in range(55):
    time.sleep(.8)
    try:
     f=get(13046,'/api/status');t=get(13001,'/api/status')
     d=get(13001,'/api/direction-mode');stats=get(13047,'/api/round-stats')
     html=urllib.request.urlopen('http://127.0.0.1:13001/',timeout=7).read().decode('utf8','replace')
     if (f.get('model')==MODEL and f.get('strategyVersion')==NEW and
        f.get('requiresDeepSeek') is False and
        f.get('lastError') is None and f.get('fetchAttempts',0)>=2 and
        t.get('orderSignalModel')==MODEL and t.get('enabled') is False and
        d.get('revision')==dirs.get('revision') and
        (d.get('modes') or {}).get(MODEL)==saved_directions and
        stats.get('strategyVersion')==NEW and stats.get('persisted') is True and
        stats.get('summary',{}).get('total',999)<=1 and
        stats.get('health',{}).get('signalError') is None and
        stats.get('health',{}).get('officialError') is None and
        '实时多空趋势（2秒锁定）' in html and
        'id="zlF5Forward"' in html and 'id="zlF5HistoryScroll"' in html and
        '/api/fast5-round-stats' in html):
      verified=True;break
    except Exception:pass
   if not verified:raise RuntimeError('V7_POSTDEPLOY_STATUS_CHECK_FAILED')
   for unit in UNITS:
    if run('systemctl','is-active',unit).stdout.strip()!='active':
     raise RuntimeError('V7_SERVICE_NOT_ACTIVE_'+unit)
   print('FAST5_V7_DEPLOY_SUCCESS=true',flush=True)
   print('FAST5_V7_TREND_MODEL='+NEW,flush=True)
   print('FAST5_V7_DEADLINE_MS=2000',flush=True)
   print('FAST5_V7_ORDER_PICKUP_INTERVAL_MS=80',flush=True)
   print('FAST5_V7_V6_HISTORY_UNMODIFIED=true',flush=True)
   print('FAST5_V7_NEW_LEDGER='+str(DB_NEW),flush=True)
   print('FAST5_V7_DIRECTIONS_UNCHANGED='+json.dumps(saved_directions),flush=True)
   print('FAST5_V7_TRADE_FOLLOW_OFF=true',flush=True)
   print('FAST5_V7_STATS='+json.dumps(stats.get('summary',{})),flush=True)
   print('FAST5_V7_BACKUP='+str(backup),flush=True)
  except BaseException:
   print('FAST5_V7_ROLLBACK_START=true',flush=True)
   subprocess.run(['systemctl','stop',UNITS[2]],timeout=45)
   for p in PATHS:shutil.copy2(backup/p.name,p)
   subprocess.run(['systemctl','restart',UNITS[0]],timeout=65)
   subprocess.run(['systemctl','restart',UNITS[1]],timeout=90)
   subprocess.run(['systemctl','start',UNITS[2]],timeout=45)
   print('FAST5_V7_ROLLBACK_ATTEMPTED=true',flush=True)
   raise
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('FAST5_V7_RELEASE_FAILED',type(e).__name__,str(e)[:290],flush=True)
  sys.exit(1)

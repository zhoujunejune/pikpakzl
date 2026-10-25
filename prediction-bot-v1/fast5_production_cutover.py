#!/usr/bin/env python3
"""Switch production signal from DeepSeek to validated FAST5 while follow is OFF.
Keeps trade placement code, TP/SL code, API secrets and historic orders untouched.
The old Redis keys are preserved to allow a safe rollback.
"""
import os,sys,re,json,time,subprocess,shutil,tempfile,pathlib,urllib.request,socket
from datetime import datetime,timezone

TR=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
SIDE=pathlib.Path('/opt/zl-prediction-fast5')
UNIT=pathlib.Path('/etc/systemd/system/zl-prediction-fast5.service')
NODE='/opt/zl-prediction-node/bin/node'
MODEL='FAST5_SPOT_MOMENTUM_V1'
OLD='DEEPSEEK_5M_V1'
FIELDS=['production-signal-choice.mjs','order-direction-policy.mjs',
        'index.mjs','wrapper.mjs','panel-stats-shell.mjs']
FAST_FILES=['fast5-real-market-calculator.mjs','fast5-real-market-service.mjs']

def get(port,route):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}{route}',timeout=8) as r:return json.load(r)
def run(*argv,timeout=55):
 subprocess.run(argv,check=True,timeout=timeout,stdout=subprocess.DEVNULL)
def replace1(s,a,b):
 if s.count(a)!=1:raise RuntimeError('SOURCE_DRIFT_'+a[:50]+'_'+str(s.count(a)))
 return s.replace(a,b,1)
def install(dest,data):
 dest=pathlib.Path(dest)
 st=dest.stat()
 fd,temp=tempfile.mkstemp(prefix='.fast5-pending-',dir=dest.parent)
 try:
  with os.fdopen(fd,'wb') as f:f.write(data.encode())
  os.chmod(temp,st.st_mode&0o777);os.chown(temp,st.st_uid,st.st_gid)
  os.replace(temp,dest)
 finally:
  if os.path.exists(temp):os.unlink(temp)
def patch_choice(s):
 s=replace1(s,"export const SELECTIVE8_MODEL='DEEPSEEK_5M_V1';",
            "export const SELECTIVE8_MODEL='FAST5_SPOT_MOMENTUM_V1';")
 s=replace1(s,"export const MODEL_CHOICE_KEY='trade-control:order-signal-choice:v1';",
            "export const MODEL_CHOICE_KEY='trade-control:order-signal-choice:v2:fast5';")
 s=replace1(s,"name:'DeepSeek 5分钟生产信号'","name:'FAST5 本地实时行情信号'")
 s=replace1(s,"const initial=JSON.stringify({model:BASE_MODEL,revision:crypto.randomUUID(),",
            "const initial=JSON.stringify({model:SELECTIVE8_MODEL,revision:crypto.randomUUID(),")
 s=replace1(s,"updatedAt:new Date().toISOString(),effectiveAfterRound:null});",
            "updatedAt:new Date().toISOString(),effectiveAfterRound:roundOf(Date.now())});")
 if 'export function validateFast5ProductionLive(' in s:raise RuntimeError('FAST5_VALIDATOR_ALREADY_PRESENT')
 s+="""

export function validateFast5ProductionLive(body,now=Date.now()){
 const round=roundOf(now),lock=body?.latest;
 const ts=lock?.lockedAt,marketAt=lock?.marketAt;
 if(body?.ok!==true||body?.model!=='FAST5_SPOT_MOMENTUM_V1'||
    body?.readOnly!==true||body?.requiresDeepSeek!==false||
    body?.orders!==false||body?.productionIntegration!==false||
    body?.marketSource!=='BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR'||
    body?.lastError!=null)
  return {ok:false,reason:'FAST5_UNTRUSTED_PROVENANCE'};
 if(!lock||lock.model!==body.model||lock.round!==round||body.round!==round||
    lock.status!=='LOCKED'||!['UP','DOWN'].includes(lock.direction)||
    lock.source!=='BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR'||
    lock.decisionMethod!=='CAUSAL_REAL_TICK_PLUS_CLOSED_1M_MOMENTUM'||
    lock.requiresDeepSeek!==false||lock.orders!==false||
    lock.confidenceIsCalibrated!==false||lock.officialOracleLiveQuoteUsed!==false)
  return {ok:false,reason:'FAST5_MISSING_CURRENT_ROUND_LOCK'};
 if(!Number.isSafeInteger(ts)||ts<round+4000||ts>=round+12000||
    !Number.isSafeInteger(marketAt)||marketAt<round||marketAt>ts||
    ts-marketAt>1200||ts>now+250||now-ts>16000||now>=round+20000||
    !Number.isSafeInteger(lock.samples)||lock.samples<4||
    typeof lock.scoreBps!=='number'||!Number.isFinite(lock.scoreBps)||
    !Number.isSafeInteger(body.lastObservationAt)||body.lastObservationAt<round)
   return {ok:false,reason:'FAST5_EXPIRED_OR_UNVERIFIED_LIVE_MARKET'};
 return {ok:true,round,direction:lock.direction,lockedAt:ts,marketAt,
   score:Math.abs(lock.scoreBps)};
}
"""
 return s

def patch_direction(s):
 s=replace1(s,"export const ORDER_DIRECTION_POLICY='DEEPSEEK_5M_SOURCE_SIDE_V1';",
            "export const ORDER_DIRECTION_POLICY='FAST5_REAL_MARKET_SOURCE_SIDE_V1';")
 s=replace1(s,"export const PRIMARY_SOURCE='DEEPSEEK_5M_V1';",
            "export const PRIMARY_SOURCE='FAST5_SPOT_MOMENTUM_V1';")
 s=replace1(s,"export const ORDER_MODE_REDIS_KEY='trade-control:direction-mode:v4';",
            "export const ORDER_MODE_REDIS_KEY='trade-control:direction-mode:v5:fast5';")
 start=s.index('export async function hydrateDirectionSettings(){')
 end=s.index('// Refresh from the shared Redis authority',start)
 assert 'DEEPSEEK_5M_V1' in s[start:end]
 replacement="""export async function hydrateDirectionSettings(){
 try{
  const db=await client();
  let raw=await db.get(ORDER_MODE_REDIS_KEY);
  if(!raw){
   const prior=await db.get('trade-control:direction-mode:v4');
   if(!prior)throw Error('PRIOR_DIRECTION_CONFIGURATION_MISSING');
   const previous=JSON.parse(prior);
   const oldModes=previous?.modes?.['DEEPSEEK_5M_V1'];
   if(!oldModes||Object.keys(previous.modes).length!==1||
      !['UP','DOWN'].every(k=>['FORWARD','INVERSE','OFF'].includes(oldModes[k])))
     throw Error('FAST5_PRIOR_DIRECTION_MODES_INVALID');
   const currentRound=Math.floor(Date.now()/300000)*300000;
   const migrated={modes:{[PRIMARY_SOURCE]:{UP:oldModes.UP,DOWN:oldModes.DOWN}},
    revision:crypto.randomUUID(),updatedAt:new Date().toISOString(),
    effectiveAfterRound:currentRound};
   const proposed=JSON.stringify(migrated);
   const result=await db.set(ORDER_MODE_REDIS_KEY,proposed,{NX:true});
   raw=result==='OK'?proposed:await db.get(ORDER_MODE_REDIS_KEY);
  }
  if(!raw)throw Error('FAST5_DIRECTION_CONFIGURATION_MISSING');
  return applyDirectionSettings(JSON.parse(raw));
 }catch(err){invalidateDirectionSettings();throw err}
}

"""
 return s[:start]+replacement+s[end:]

def patch_trade(s):
 s=replace1(s,"validateDeepSeekProductionLive,RSI_INPUT_VERSION",
            "validateDeepSeekProductionLive,validateFast5ProductionLive,RSI_INPUT_VERSION")
 s=replace1(s,"const SELECTIVE8_LOCAL_URL='http://127.0.0.1:13029/signal';",
            "const SELECTIVE8_LOCAL_URL='http://127.0.0.1:13046/api/signal';")
 start=s.index('  if(choice.model!==SELECTIVE8_MODEL)return null;',s.index('async function getSignal('))
 end=s.index('  if(choice.model===EDGE_MODEL){',start)
 block=s[start:end]
 if "validateDeepSeekProductionLive" not in block:raise RuntimeError('TRADING_SOURCE_DRIFT')
 replacement="""  if(choice.model!==SELECTIVE8_MODEL)return null;
  try{
   const res=await fetch(SELECTIVE8_LOCAL_URL,{cache:'no-store',
    signal:AbortSignal.timeout(1200),headers:{accept:'application/json'}});
   if(!res.ok)return null;
   const valid=validateFast5ProductionLive(await res.json());
   if(!valid.ok)return null;
   return {
    round:valid.round,status:'LOCKED',direction:valid.direction,
    rawDirection:valid.direction,randomFlipApplied:false,
    model:SIGNAL_MODEL_NAME,upstreamModel:SELECTIVE8_MODEL,
    source:'FAST5_SPOT_MOMENTUM_V1',generatedAt:valid.lockedAt,
    lockedAt:valid.lockedAt,marketAt:valid.marketAt,
    score:valid.score,confidence:null,modelProbability:null,
    frozen:true,executionEligible:true,inputVersion:SELECTIVE8_MODEL,
    qualityGate:'FAST5_REAL_MARKET_UNCALIBRATED',
    signalId:SIGNAL_MODEL_NAME+':'+valid.round+':FAST5_SPOT_MOMENTUM_V1:'+valid.lockedAt+':'+valid.direction,
    transport:'aliyun_fast5_loopback_real_ticks'
   };
  }catch{return null}
"""
 return s[:start]+replacement+s[end:]
def patch_wrapper(s):
 s=replace1(s,'const SELECTIVE30_ORDER_DEADLINE_MS = 30000;',
            'const SELECTIVE30_ORDER_DEADLINE_MS = 20000;')
 return s
def patch_panel(s):
 if 'FAST5_SPOT_MOMENTUM_V1' in s:raise RuntimeError('PANEL_ALREADY_FAST5')
 if 'DEEPSEEK_5M_V1' not in s:raise RuntimeError('PANEL_MODEL_MISSING')
 return s.replace('DEEPSEEK_5M_V1','FAST5_SPOT_MOMENTUM_V1').replace('DeepSeek 5分钟生产信号','FAST5 本地实时行情信号')
PATCHERS=dict(zip(FIELDS,[patch_choice,patch_direction,patch_trade,patch_wrapper,patch_panel]))
def main():
 if os.geteuid()!=0:raise RuntimeError('AUTHORIZED_SYSTEM_ACCOUNT_REQUIRED')
 if len(sys.argv)!=2 or not re.fullmatch('[0-9a-f]{40}',sys.argv[1]):raise RuntimeError('INVALID_RELEASE_SHA')
 sha=sys.argv[1]
 assert os.path.isfile(NODE) and TR.is_dir()
 for unit in ['zl-prediction-trade','zl-prediction-deepseek5','zl-prediction-v2','zl-prediction-v3','zl-futures-bot-paper']:
  if subprocess.check_output(['systemctl','is-active',unit],text=True).strip()!='active':raise RuntimeError('SERVICE_INACTIVE_'+unit)
 trade=get(13001,'/api/status');choice=get(13001,'/api/order-signal-model');modes=get(13001,'/api/direction-mode')
 if trade.get('enabled') is not False:raise RuntimeError('AUTO_FOLLOW_MUST_BE_OFF')
 if choice.get('model')!=OLD or [i.get('id') for i in choice.get('models',[])]!=[OLD]:raise RuntimeError('UNEXPECTED_PRODUCTION_SELECTOR')
 if list(modes.get('modes',{}))!=[OLD]:raise RuntimeError('UNEXPECTED_DIRECTION_MODE')
 if SIDE.exists() or UNIT.exists():raise RuntimeError('FAST5_ALREADY_INSTALLED')
 with socket.socket() as sk:
  sk.bind(('127.0.0.1',13046))
 with tempfile.TemporaryDirectory(prefix='zl-fast5-release-') as tmp:
  work=pathlib.Path(tmp)
  for file in FAST_FILES:
   url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+sha+'/prediction-bot-v1/'+file
   with urllib.request.urlopen(url,timeout=30) as r:(work/file).write_bytes(r.read())
   run(NODE,'--check',str(work/file))
  src={f:(TR/f).read_text() for f in FIELDS}
  modified={f:PATCHERS[f](src[f]) for f in FIELDS}
  for name,value in modified.items():
   path=work/name;path.write_text(value)
   run(NODE,'--check',str(path))
  if get(13001,'/api/status').get('enabled') is not False:raise RuntimeError('FOLLOW_TOGGLED_ABORT')
  backup=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/('fast5-signal-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  for name in FIELDS:shutil.copy2(TR/name,backup/name)
  installed=[];sideStarted=False;tradeRestarted=False;deepseekStopped=False
  try:
   SIDE.mkdir(mode=0o755)
   for file in FAST_FILES:shutil.copy2(work/file,SIDE/file);os.chmod(SIDE/file,0o644)
   UNIT.write_text("""[Unit]
Description=FAST5 local BTCUSDT direction, no LLM or orders
After=network-online.target zl-prediction-v3.service
[Service]
Type=simple
DynamicUser=yes
WorkingDirectory=/
Environment=FAST5_SIGNAL_PORT=13046
ExecStart=/opt/zl-prediction-node/bin/node /opt/zl-prediction-fast5/fast5-real-market-service.mjs
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
CapabilityBoundingSet=
MemoryMax=96M
[Install]
WantedBy=multi-user.target
""")
   os.chmod(UNIT,0o644)
   run('systemctl','daemon-reload')
   sideStarted=True
   run('systemctl','enable','--now','zl-prediction-fast5.service')
   ready=False
   for i in range(30):
    time.sleep(.5)
    try:
     z=get(13046,'/api/status')
     if z.get('model')==MODEL and z.get('readOnly') is True and z.get('requiresDeepSeek') is False and z.get('fetchAttempts',0)>=2 and z.get('lastError') is None and z.get('lastFetchAt') is not None:
      ready=True;break
    except Exception:pass
   if not ready:raise RuntimeError('FAST5_SERVICE_FEED_NOT_READY')
   print('FAST5_SIDECAR_WITH_LIVE_FEED=true',flush=True)
   if get(13001,'/api/status').get('enabled') is not False:raise RuntimeError('FOLLOW_WENT_ON_ABORT')
   for f in FIELDS:install(TR/f,modified[f]);installed.append(f)
   run('systemctl','restart','zl-prediction-trade.service',timeout=80)
   tradeRestarted=True
   ready=False
   for i in range(35):
    time.sleep(1.2)
    try:
     ch=get(13001,'/api/order-signal-model')
     md=get(13001,'/api/direction-mode')
     st=get(13001,'/api/status')
     if(ch.get('model')==MODEL and [a.get('id') for a in ch.get('models',[])]==[MODEL] and
        md.get('ready') is True and list(md.get('modes',{}))==[MODEL] and
        md['modes'][MODEL]==modes['modes'][OLD] and
        st.get('enabled') is False and st.get('orderSignalModel')==MODEL):
      ready=True;break
    except Exception:pass
   if not ready:raise RuntimeError('FAST5_TRADE_SELECTOR_OR_MODES_UNVERIFIED')
   for unit in ['zl-prediction-fast5','zl-prediction-trade','zl-prediction-v2','zl-prediction-v3','zl-futures-bot-paper']:
    if subprocess.check_output(['systemctl','is-active',unit],text=True).strip()!='active':raise RuntimeError('AFTER_DEPLOY_SERVICE_NOT_ACTIVE_'+unit)
   print('FAST5_PRODUCTION_SIGNAL_SELECTED=true',flush=True)
   print('FAST5_PRODUCTION_DIRECTION_MODES_PRESERVED=true',flush=True)
   print('FAST5_AUTOFOLLOW_OFF=true',flush=True)
   # No more automatic DeepSeek calls now that no production code reads its signal.
   run('systemctl','disable','--now','zl-prediction-deepseek5.service')
   deepseekStopped=True
   print('FAST5_DEEPSEEK_API_CALLER_DISABLED=true',flush=True)
   print('FAST5_OLD_REDIS_AUTHORITIES_UNMODIFIED=true',flush=True)
   print('FAST5_HISTORY_AND_TP_SL_UNMODIFIED=true',flush=True)
   print('FAST5_SOURCE_BACKUP='+str(backup),flush=True)
  except BaseException:
   if deepseekStopped:
    subprocess.run(['systemctl','enable','--now','zl-prediction-deepseek5.service'],timeout=30)
   for f in installed:shutil.copy2(backup/f,TR/f)
   if installed or tradeRestarted:subprocess.run(['systemctl','restart','zl-prediction-trade.service'],timeout=60)
   if sideStarted:subprocess.run(['systemctl','disable','--now','zl-prediction-fast5.service'],timeout=30)
   if UNIT.exists():UNIT.unlink()
   for f in FAST_FILES:
    if (SIDE/f).exists():(SIDE/f).unlink()
   if SIDE.exists():SIDE.rmdir()
   subprocess.run(['systemctl','daemon-reload'],timeout=20)
   print('FAST5_DEPLOY_ROLLBACK_ATTEMPTED=true',flush=True)
   raise

if __name__=='__main__':
 try:main()
 except Exception as e:
  print('FAST5_PRODUCTION_CUTOVER_FAILED',type(e).__name__,str(e)[:260],flush=True)
  sys.exit(1)

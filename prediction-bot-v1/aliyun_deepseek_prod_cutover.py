#!/usr/bin/env python3
"""Production cutover to DeepSeek 5m only. Old signal logic is archived, not used.
Backups, fail-closed validation, rollback. Never erase Binance order or official settlement history.
Requires an already healthy locally deployed DeepSeek provider and installed prediction trade control.
"""
import os,json,time,re,sys,shutil,tempfile,pathlib,subprocess,urllib.request
from datetime import datetime,timezone

ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
NODE='/opt/zl-prediction-node/bin/node'
MODEL='DEEPSEEK_5M_V1'
FILES={
 'choice': ROOT/'production-signal-choice.mjs',
 'policy': ROOT/'order-direction-policy.mjs',
 'trade': ROOT/'index.mjs',
 'wrapper': ROOT/'wrapper.mjs',
 'panel': ROOT/'panel-stats-shell.mjs',
}
def once(s,b,a,label):
 n=s.count(b)
 if n!=1:raise RuntimeError('CUTOVER_CONTEXT_MISMATCH:'+label+':'+str(n))
 return s.replace(b,a,1)
def one_regex(s,pattern,repl,label,flags=re.S):
 nxt,n=re.subn(pattern,repl,s,count=1,flags=flags)
 if n!=1:raise RuntimeError('CUTOVER_REGEX_MISMATCH:'+label)
 return nxt
def get(port,path):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=10) as r:return json.load(r)
def service(name):
 return subprocess.check_output(['systemctl','is-active',name],text=True,timeout=9).strip()
def run(*args):
 subprocess.run(args,check=True,timeout=85,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

VALIDATOR=r"""
// DeepSeek is the sole trusted production signal. Invalid/stale data is never
// replaced with previous V2/Edge direction or a fabricated UP/DOWN signal.
export function validateDeepSeekProductionLive(body,now=Date.now()){
 const round=roundOf(now),lock=body?.latest,entry=lock?.entry;
 const ts=Number(lock?.lockedAt),marketAt=Number(lock?.marketAt);
 if(body?.ok!==true||body?.model!=='DEEPSEEK_5M_V1'||
    body?.providerModel!=='deepseek-flash'||body?.readOnly!==true||
    body?.orders!==false||body?.productionIntegration!==false)
   return {ok:false,reason:'UNTRUSTED_DEEPSEEK_SOURCE'};
 if(!lock||lock.model!=='DEEPSEEK_5M_V1'||lock.status!=='LOCKED'||
    lock.round!==round||body.round!==round||
    !['UP','DOWN'].includes(lock.direction)||entry?.direction!==lock.direction||
    entry?.modelVersion!=='DEEPSEEK_5M_V1')
   return {ok:false,reason:'NO_CURRENT_ROUND_DEEPSEEK_LOCK'};
 if(!Number.isSafeInteger(ts)||!Number.isSafeInteger(marketAt)||
    ts<round||ts>=round+285000||marketAt<round||marketAt>ts||
    ts-marketAt>40000||ts>now+250||now-ts>45000||
    body.generatedAt!==ts||body.expiryAt!==round+285000||
    now>=body.expiryAt)
   return {ok:false,reason:'DEEPSEEK_MARKET_OR_SIGNAL_EXPIRED'};
 return {ok:true,round,direction:lock.direction,lockedAt:ts,
   marketAt,score:Number.isFinite(Number(lock.score))?Number(lock.score):null};
}
"""

def patch_choice(s):
 s=once(s,"export const SELECTIVE8_MODEL='SELECTIVE_V2_30S_CURRENT_ROUND_V2';",
        "export const SELECTIVE8_MODEL='DEEPSEEK_5M_V1';","choice-production-id")
 s=one_regex(s,r"export const ORDER_SIGNAL_MODELS=Object.freeze\(\[\s*\{id:SELECTIVE8_MODEL,name:'[^']*'\}\s*\]\);",
               "export const ORDER_SIGNAL_MODELS=Object.freeze([{id:SELECTIVE8_MODEL,name:'DeepSeek 5分钟生产信号'}]);",
               "one-active-production-model")
 s=once(s,"if(saved.model!==SELECTIVE8_MODEL){",
        "if(saved.model!==SELECTIVE8_MODEL){","choice-migration-fence") if False else s
 if 'export function validateDeepSeekProductionLive(' in s:
  raise RuntimeError('DEEPSEEK_VALIDATOR_ALREADY_INSTALLED')
 return s+'\n'+VALIDATOR

def patch_policy(s):
 s=once(s,"export const ORDER_DIRECTION_POLICY='SOURCE_SIDE_3WAY_V4';",
        "export const ORDER_DIRECTION_POLICY='DEEPSEEK_5M_SOURCE_SIDE_V1';","new-direction-policy")
 s=once(s,"export const PRIMARY_SOURCE='SELECTIVE_V2_FAST8_PRIMARY';",
        "export const PRIMARY_SOURCE='DEEPSEEK_5M_V1';","only-deepseek-source")
 s=once(s,"export const ORDER_SOURCES=[PRIMARY_SOURCE,RESCUE_SOURCE,LOW_CONFIDENCE_SOURCE];",
        "export const ORDER_SOURCES=[PRIMARY_SOURCE];","single-source-policy")
 marker="    return applyDirectionSettings(JSON.parse(raw));"
 insert="""    // Atomic one-time migration preserves the former PRIMARY UP/DOWN choices.
    // All other legacy source choices become archived history, never active.
    let current=JSON.parse(raw);
    if(!current?.modes?.[PRIMARY_SOURCE]||Object.keys(current.modes).length!==1){
      const oldModes=current?.modes?.['SELECTIVE_V2_FAST8_PRIMARY'];
      if(!oldModes||!['UP','DOWN'].every(side=>['FORWARD','INVERSE','OFF'].includes(oldModes[side])))
        throw Error('DEEPSEEK_DIRECTION_MIGRATION_REQUIRES_LEGACY_PRIMARY');
      const updated={modes:{[PRIMARY_SOURCE]:{UP:oldModes.UP,DOWN:oldModes.DOWN}},
        revision:crypto.randomUUID(),updatedAt:new Date().toISOString(),
        effectiveAfterRound:Math.floor(Date.now()/300000)*300000};
      const result=await db.eval(CAS_SCRIPT,{keys:[ORDER_MODE_REDIS_KEY],
        arguments:[raw,JSON.stringify(updated)]});
      if(result!=='OK')throw Error('DEEPSEEK_DIRECTION_MIGRATION_CONFLICT');
      raw=JSON.stringify(updated);
    }
"""
 s=once(s,marker,insert+marker,'single-source-migration')
 return s

def patch_trade(s):
 s=once(s,"const SELECTIVE8_LOCAL_URL='http://127.0.0.1:13002/api/production-signal';",
        "const SELECTIVE8_LOCAL_URL='http://127.0.0.1:13029/signal';",
        "deepseek-only-production-url")
 s=once(s,"validateSelective8ProductionLive,RSI_INPUT_VERSION",
        "validateSelective8ProductionLive,validateDeepSeekProductionLive,RSI_INPUT_VERSION",
        "new-model-validation-import")
 a=s.index("  if(choice.model!==SELECTIVE8_MODEL)return null;",s.index('async function getSignal('))
 b=s.index("  if(choice.model===EDGE_MODEL){",a)
 old=s[a:b]
 if old.count("if(choice.model===SELECTIVE8_MODEL)")!=1:
  raise RuntimeError('UNEXPECTED_TRADE_SIGNAL_BRANCH')
 substitute="""  if(choice.model!==SELECTIVE8_MODEL)return null;
  try{
    const response=await fetch(SELECTIVE8_LOCAL_URL,{cache:'no-store',
      signal:AbortSignal.timeout(2500),headers:{accept:'application/json'}});
    if(!response.ok)return null;
    const verified=validateDeepSeekProductionLive(await response.json());
    if(!verified.ok)return null;
    return {
      round:verified.round,status:'LOCKED',direction:verified.direction,
      rawDirection:verified.direction,randomFlipApplied:false,
      model:SIGNAL_MODEL_NAME,upstreamModel:SELECTIVE8_MODEL,
      source:'DEEPSEEK_5M_V1',generatedAt:verified.lockedAt,
      lockedAt:verified.lockedAt,marketAt:verified.marketAt,
      score:verified.score,confidence:null,modelProbability:null,
      frozen:true,executionEligible:true,inputVersion:SELECTIVE8_MODEL,
      qualityGate:'DEEPSEEK_REAL_MARKET_UNCALIBRATED',
      signalId:SIGNAL_MODEL_NAME+':'+verified.round+':DEEPSEEK_5M_V1:'+verified.lockedAt+':'+verified.direction,
      transport:'aliyun_deepseek_5m_readonly_signal'
    };
  }catch{return null}
"""
 s=s[:a]+substitute+s[b:]
 s=once(s,"if(signalOverride && choice.model!==SELECTIVE8_MODEL)return;",
        "if(signalOverride)return; // retired V2 WebSocket/Redis cannot submit an order",
        "retire-prior-model-push")
 return s

def patch_wrapper(s):
 s=once(s,"const SELECTIVE30_ORDER_DEADLINE_MS = 30000;",
        "const SELECTIVE30_ORDER_DEADLINE_MS = 90000;",
        "extend-deepseek-order-window")
 s=s.replace("30秒策略本轮第30秒订单提交窗口已截止，未发送下单请求",
             "DeepSeek本轮第90秒订单提交窗口已截止，未发送下单请求")
 return s

def patch_panel(s):
 s=one_regex(s,r"var sources=\[\s*\{id:'SELECTIVE_V2_FAST8_PRIMARY'.*?\];",
   "var sources=[{id:'DEEPSEEK_5M_V1',name:'DeepSeek 5分钟生产信号',modes:{UP:'OFF',DOWN:'OFF'}}];",
   "panel-one-source")
 s=once(s,"Object.keys(modes).length!==3","Object.keys(modes).length!==1",
        "panel-single-direction-source")
 marker="  var raw=Array.isArray(j.activeSignalModels)?j.activeSignalModels:[];"
 s=once(s,marker,
   "  var raw=[{id:'DEEPSEEK_5M_V1',source:'DEEPSEEK_5M_V1',name:'DeepSeek 5分钟生产信号',active:true}];",
   "frontend-active-model")
 # The former V2/Edge results remain accessible in official archives, never
 # represented as DeepSeek model performance.
 s=once(s," async function loadLegacy(){",
   """ async function loadLegacy(){
 if(chosenOrderModel==='DEEPSEEK_5M_V1'||globalThis.__orderModelStatsSelection==='DEEPSEEK_5M_V1'){
   var title=e('rsAccuracy'),meta=e('rsMeta'),rows=e('rsRows');
   if(title)title.textContent='DeepSeek 统计待积累';
   if(meta)meta.textContent='旧版 Selective/Edge 胜率已退役，不混入 DeepSeek 新样本；新模型需按币安官方结算单独统计。';
   if(rows)rows.innerHTML='<tr><td colspan="8" style="padding:10px 6px">当前仅使用 DeepSeek 生产信号；旧模型记录已归档，不能当作 DeepSeek 命中记录。</td></tr>';
   return;
 }
""","exclude-retired-performance")
 s=s.replace("等待本轮8秒有效锁定","等待本轮 DeepSeek 实时锁定")
 return s

PATCHERS={'choice':patch_choice,'policy':patch_policy,'trade':patch_trade,'wrapper':patch_wrapper,'panel':patch_panel}

def main():
 if os.geteuid()!=0:raise RuntimeError('ROOT_REQUIRED')
 assert os.path.isfile(NODE)
 for name in ['zl-prediction-trade','zl-prediction-v2','zl-prediction-v3',
              'zl-prediction-redis','zl-prediction-deepseek5','zl-futures-bot-paper']:
  if service(name)!='active':raise RuntimeError('REQUIRED_SERVICE_INACTIVE:'+name)
 model=get(13029,'/api/status')
 if model.get('model')!=MODEL or model.get('configured') is not True or model.get('realOrderEnabled') is not False:
  raise RuntimeError('DEEPSEEK_NOT_READY')
 raw=get(13029,'/signal')
 if raw.get('model')!=MODEL or raw.get('readOnly') is not True or raw.get('orders') is not False:
  raise RuntimeError('DEEPSEEK_SIGNAL_NOT_VERIFIED')
 current=get(13001,'/api/order-signal-model')
 if current.get('model')==MODEL and [x.get('id') for x in current.get('models',[])]==[MODEL]:
  print('DEEPSEEK_ALREADY_SELECTED=true');return
 if current.get('model')!='SELECTIVE_V2_30S_CURRENT_ROUND_V2':
  raise RuntimeError('UNKNOWN_OLD_PRODUCTION_MODEL')
 before_modes=get(13001,'/api/direction-mode')
 assert before_modes.get('ready') is True
 assert before_modes.get('modes',{}).get('SELECTIVE_V2_FAST8_PRIMARY')
 originals={name:p.read_text() for name,p in FILES.items()}
 if MODEL in originals['choice'] or 'validateDeepSeekProductionLive' in originals['choice']:
  raise RuntimeError('PARTIAL_DEEPSEEK_DEPLOYMENT')
 patches={name:PATCHERS[name](src) for name,src in originals.items()}
 with tempfile.TemporaryDirectory(prefix='zl-deepseek-cutover-') as temp:
  for name,s in patches.items():
   path=pathlib.Path(temp)/(name+'.mjs');path.write_text(s)
   run(NODE,'--check',str(path))
  assert "ORDER_SOURCES=[PRIMARY_SOURCE];" in patches['policy']
  assert "response=await fetch(SELECTIVE8_LOCAL_URL" in patches['trade']
  assert "if(signalOverride)return;" in patches['trade']
  assert "validateDeepSeekProductionLive" in patches['trade']
  assert "90000" in patches['wrapper']
  print('DEEPSEEK_OFFLINE_SYNTAX_AND_ROUTE_TEST_PASSED=true',flush=True)
  if os.environ.get('DEEPSEEK_CUTOVER_DRY_RUN')=='1':
   print('DEEPSEEK_CUTOVER_DRY_RUN_PASSED=true',flush=True)
   return
  archive=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')
  backup=archive/('deepseek-prod-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  for name,p in FILES.items():shutil.copy2(p,backup/(name+'.mjs'))
  print('DEEPSEEK_OLD_MODELS_BACKED_UP=true',flush=True)
  installed=[]
  try:
   for name,p in FILES.items():
    st=p.stat();tempfile=p.with_name(p.name+'.deepseek-pending')
    tempfile.write_text(patches[name])
    os.chown(tempfile,st.st_uid,st.st_gid)
    os.chmod(tempfile,st.st_mode&0o777)
    os.replace(tempfile,p)
    installed.append(name)
   run('systemctl','restart','zl-prediction-trade.service')
   # Startup migration atomically invalidates all old pending-order revisions
   # and preserves the primary UP/DOWN owner choices.
   ready=False; new_choice=None;new_modes=None
   for _ in range(35):
    time.sleep(2)
    try:
     new_choice=get(13001,'/api/order-signal-model')
     new_modes=get(13001,'/api/direction-mode')
     if(new_choice.get('ready') and new_choice.get('model')==MODEL and
        [a.get('id') for a in new_choice.get('models',[])]==[MODEL] and
        list(new_modes.get('modes',{}))==[MODEL] and new_modes.get('ready') and
        new_modes['modes'][MODEL]==before_modes['modes']['SELECTIVE_V2_FAST8_PRIMARY']):
      ready=True;break
    except Exception:pass
   if not ready:raise RuntimeError('LIVE_ROUTE_OR_DIRECTION_VERIFICATION_FAILED')
   after=get(13001,'/api/status')
   if(after.get('orderSignalModel')!=MODEL):
    raise RuntimeError('LIVE_STATUS_STILL_OLD_MODEL')
   if service('zl-futures-bot-paper')!='active' or service('zl-prediction-deepseek5')!='active':
    raise RuntimeError('UNEXPECTED_OTHER_SERVICE_CHANGED')
   print('DEEPSEEK_PRODUCTION_ONLY_MODEL=true')
   print('DEEPSEEK_PRODUCTION_SELECTOR',new_choice.get('model'))
   print('DEEPSEEK_PRODUCTION_AVAILABLE_IDS',[x['id'] for x in new_choice['models']])
   print('DEEPSEEK_PRODUCTION_DIRECTION_SOURCE',list(new_modes['modes']))
   print('DEEPSEEK_ORIGINAL_PRIMARY_MODES_PRESERVED=true')
   print('DEEPSEEK_OLD_MODELS_RETIRED_FROM_TRADE_ROUTER=true')
   print('DEEPSEEK_BINANCE_HISTORY_PRESERVED=true')
   print('DEEPSEEK_FUTURES_UNTOUCHED=true')
  except BaseException:
   for name in installed:shutil.copy2(backup/(name+'.mjs'),FILES[name])
   subprocess.run(['systemctl','restart','zl-prediction-trade.service'],timeout=90)
   # The Redis selector and direction config remain in new-source mode if migrated;
   # Never restart an old source with a live order enabled; it will fail closed.
   print('DEEPSEEK_CUTOVER_ROLLBACK_FILES_ATTEMPTED=true',flush=True)
   raise

if __name__=='__main__':
 try:main()
 except Exception as e:
  print('DEEPSEEK_CUTOVER_FAILED',type(e).__name__,str(e)[:240])
  sys.exit(1)

#!/usr/bin/env python3
"""Guarded in-place production latency release (NO new orders).
Patch exact existing deployed sources, never overwrite newer sell state journal.
1) non-overlapping, completion-paced risk poll with minimum 300ms start interval
2) independent Redis choice + direction revalidation in parallel before BUY quote.
Preserve all order, retry, finality checks, params and source model selection.
"""
import hashlib,json,os,pathlib,re,shutil,subprocess,sys,tempfile,time,urllib.request
from datetime import datetime,timezone

BASE=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
RISK=BASE/'risk-worker.mjs'
BUY=BASE/'wrapper.mjs'
NODE='/opt/zl-prediction-node/bin/node'
RISK_UNIT='zl-prediction-risk-exits.service'
BUY_UNIT='zl-prediction-trade.service'
RISK_SHA='73a8d348f4049d4582ee9a1e083813f9957926f953a10f8248772e9d97c8c171'
BUY_SHA='c445bf23b2217c96a937b17a43e6093c76bf32ef5603995317cfca3e30147a57'
OLD_RISK="""setInterval(tick, POLL_MS);
void tick();
"""
NEW_RISK="""// Completion-paced polling: do not lose the next poll just because a
// previous network request crossed a fixed setInterval deadline. Keep the
// same minimum configured POLL_MS between starts; never overlap ticks.
async function runPacedRiskTick(){
  const started=Date.now();
  try{ await tick(); }
  catch(err){ log('risk_scheduler_exception',{error:String(err?.message||err)}); }
  finally{
    const elapsed=Date.now()-started;
    health.lastTickRuntimeMs=elapsed;
    setTimeout(runPacedRiskTick,Math.max(15,POLL_MS-elapsed));
  }
}
log('risk_scheduler_started',{mode:'COMPLETION_PACED_NON_OVERLAPPING',
  minStartIntervalMs:POLL_MS,sellJournalPreserved:true});
void runPacedRiskTick();
"""
OLD_BUY="""  try { await refreshModelSelection(); }
  catch(err){pendingAction=null;return {status:503,body:{ok:false,error:'下单信号选择配置不可用'}};}
  if (!selectedSignalMatches(p)) {
    pendingAction=null;
    return {status:409,body:{ok:false,error:'下单信号源已经切换，旧订单已失效'}};
  }
  if (!enabled || !directionSettingsSnapshot().ready) {
    return {status:409,body:{ok:false,error:'跟随已停止或方向配置未就绪'}};
  }
  try { await refreshDirectionSettings(); }
  catch(err){pendingAction=null;return {status:503,body:{ok:false,error:'方向配置读取失败，已取消旧订单'}};}
"""
NEW_BUY="""  // Both reads are independent Redis lookups. Parallelize network waits,
  // but retain every original model, direction and order state validation.
  try { await Promise.all([refreshModelSelection(),refreshDirectionSettings()]); }
  catch(err){pendingAction=null;return {status:503,body:{ok:false,error:'下单信号选择或方向配置不可用'}};}
  if (!selectedSignalMatches(p)) {
    pendingAction=null;
    return {status:409,body:{ok:false,error:'下单信号源已经切换，旧订单已失效'}};
  }
  if (!enabled || !directionSettingsSnapshot().ready) {
    return {status:409,body:{ok:false,error:'跟随已停止或方向配置未就绪'}};
  }
"""
def cmd(*args,timeout=65):
 return subprocess.run(args,check=True,timeout=timeout,capture_output=True,text=True)
def read_json(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=10) as r:
  return json.load(r)
def sha(data):return hashlib.sha256(data).hexdigest()
def unique_replace(original,old,new,tag):
 if original.count(old)!=1:raise RuntimeError(tag+'_ANCHOR_MISMATCH_'+str(original.count(old)))
 return original.replace(old,new,1)
def atomic(path,data):
 st=path.stat()
 fd,temp=tempfile.mkstemp(dir=str(path.parent),prefix='.speed-')
 try:
  with os.fdopen(fd,'wb') as f:f.write(data)
  os.chmod(temp,st.st_mode&0o777);os.chown(temp,st.st_uid,st.st_gid)
  os.replace(temp,path)
 finally:
  if os.path.exists(temp):os.unlink(temp)
def check_readiness():
 trade=read_json('/api/status')
 risk=read_json('/api/risk-control')
 return trade,risk
def guard_pending(trade):
 x=trade.get('pendingAction') or {}
 if isinstance(x,dict) and x.get('state') in (
  'QUOTING','SUBMITTING','SUBMISSION_UNKNOWN','SUBMITTED_PENDING_CONFIRMATION',
  'RECONCILIATION_REQUIRED'):
  raise RuntimeError('UNRESOLVED_BUY_ORDER_DEPLOY_REJECTED')
def main():
 if os.geteuid()!=0:raise RuntimeError('ROOT_REQUIRED')
 if len(sys.argv)!=2 or not re.fullmatch(r'[0-9a-f]{40}',sys.argv[1]):
  raise RuntimeError('PINNED_COMMIT_REQUIRED')
 if any(not p.is_file() for p in [RISK,BUY]):raise RuntimeError('LIVE_CODE_MISSING')
 for unit in [RISK_UNIT,BUY_UNIT]:
  if cmd('systemctl','is-active',unit).stdout.strip()!='active':
   raise RuntimeError('SERVICE_NOT_READY_'+unit)
 oldrisk=RISK.read_bytes()
 oldbuy=BUY.read_bytes()
 if sha(oldrisk)!=RISK_SHA or sha(oldbuy)!=BUY_SHA:
  raise RuntimeError('LIVE_SOURCE_CHANGED_ABORT_WITHOUT_MODIFICATION_'+
    sha(oldrisk)[:12]+'_'+sha(oldbuy)[:12])
 risktext=oldrisk.decode('utf8')
 buytext=oldbuy.decode('utf8')
 for anchor in ('risk_sell_journal_ready','risk_sell_finality_pending',
                'risk_sell_final_failed_retry_scheduled','risk_sell_submitted',
                'const POLL_MS = Math.max(300','stateBlocksSell('):
  if anchor not in risktext:raise RuntimeError('SELL_PROTECTION_MISSING_'+anchor[:25])
 if 'getFreshQuote(p._internal)' not in buytext or \
    'pendingOrderMatchesProduction(p,current)' not in buytext or \
    'const [current, freshQuote] = await Promise.all([' not in buytext:
  raise RuntimeError('BUY_ATOMIC_ORDER_GUARDS_MISSING')
 updatedrisk=unique_replace(risktext,OLD_RISK,NEW_RISK,'SELL')
 updatedbuy=unique_replace(buytext,OLD_BUY,NEW_BUY,'BUY')
 with tempfile.TemporaryDirectory(prefix='zl-speed-release-') as temp:
  tmp=pathlib.Path(temp)
  (tmp/'risk-worker.mjs').write_text(updatedrisk)
  (tmp/'wrapper.mjs').write_text(updatedbuy)
  # Validate syntax without loading Node deps or accessing credentials.
  for name in ('risk-worker.mjs','wrapper.mjs'):
   cmd(NODE,'--check',str(tmp/name),timeout=35)
  # Deploy only after the opening trade window, avoiding a needless outage
  # while the new round is likely placing a BUY order.
  now=int(time.time()*1000);elapsed=now%300000
  if elapsed<25000:time.sleep((25000-elapsed)/1000)
  elif elapsed>270000:time.sleep((325000-elapsed)/1000)
  prevtrade,prevrisk=check_readiness()
  guard_pending(prevtrade)
  if prevrisk.get('ok') is not True or prevrisk.get('execution',{}).get('ready') is not True:
   raise RuntimeError('RISK_CONFIG_UNAVAILABLE_ABORT')
  expected_risk={k:prevrisk.get(k) for k in
    ('takeProfitEnabled','takeProfitPercent','stopLossEnabled','stopLossPercent')}
  expected_trade={k:prevtrade.get(k) for k in
    ('enabled','orderSignalModel')}
  # No config parameters, keys, wallets, orders, journal or model changed.
  backup=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/(
    'order-risk-speed-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  shutil.copy2(RISK,backup/RISK.name)
  shutil.copy2(BUY,backup/BUY.name)
  patched=False
  try:
   atomic(RISK,updatedrisk.encode('utf8'))
   atomic(BUY,updatedbuy.encode('utf8'))
   patched=True
   # Deliberately retain the original worker journal and its existing
   # systemd restart semantics, and do not touch Binance order endpoints.
   cmd('systemctl','restart',RISK_UNIT,timeout=75)
   cmd('systemctl','restart',BUY_UNIT,timeout=75)
   good=False
   for _ in range(35):
    time.sleep(1)
    try:
     trade,risk=check_readiness()
     if (all(risk.get(k)==v for k,v in expected_risk.items()) and
         all(trade.get(k)==v for k,v in expected_trade.items()) and
         risk.get('execution',{}).get('ready') is True and
         risk.get('execution',{}).get('workerRunning') is True and
         risk.get('execution',{}).get('configApplied') is True and
         risk.get('persistenceHealthy') is True and
         all(cmd('systemctl','is-active',x).stdout.strip()=='active' for x in (RISK_UNIT,BUY_UNIT))):
      good=True;break
    except Exception:pass
   if not good:raise RuntimeError('POSTDEPLOY_RISK_OR_TRADE_CONFIG_UNHEALTHY')
   # Confirm new Node risk worker actually started, not just that files changed.
   logtext=cmd('journalctl','-u',RISK_UNIT,'--since','-2 minutes','--no-pager','-o','cat').stdout
   if 'risk_scheduler_started' not in logtext or 'risk_sell_journal_ready' not in logtext:
    raise RuntimeError('PERSISTENT_SELL_JOURNAL_OR_NEW_WORKER_NOT_STARTED')
   print('SPEED_RELEASE_COMPLETED=true',flush=True)
   print('SPEED_SELL_SCHEDULER=COMPLETION_PACED_MIN_300MS',flush=True)
   print('SPEED_BUY_INDEPENDENT_CONFIGURATION_VALIDATION=PARALLEL',flush=True)
   print('SPEED_ORDER_FINALITY_AND_IDEMPOTENCY=UNCHANGED',flush=True)
   print('SPEED_RISK_CONFIG_UNCHANGED='+json.dumps(expected_risk),flush=True)
   print('SPEED_TRADE_CONFIG_UNCHANGED='+json.dumps(expected_trade),flush=True)
   print('SPEED_BACKUP='+str(backup),flush=True)
  except BaseException:
   print('SPEED_ROLLBACK_START=true',flush=True)
   if patched:
    shutil.copy2(backup/RISK.name,RISK)
    shutil.copy2(backup/BUY.name,BUY)
   for unit in (RISK_UNIT,BUY_UNIT):
    try:subprocess.run(['systemctl','restart',unit],timeout=90,capture_output=True)
    except Exception:pass
   print('SPEED_ROLLBACK_ATTEMPTED=true',flush=True)
   raise
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('SPEED_RELEASE_FAILED',type(e).__name__,str(e)[:260],flush=True)
  sys.exit(1)

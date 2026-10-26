#!/usr/bin/env python3
"""UI + authenticated atomic Redis CAS FAST5 forward/inverse control.
No orders initiated, signal calculation untouched, winrate ledger unaffected.
Owner chooses mode in browser. Both UP and DOWN change together NEXT ROUND.
"""
import os,sys,re,json,pathlib,subprocess,tempfile,urllib.request,shutil,time
from datetime import datetime,timezone
ROOT=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic')
INDEX=ROOT/'index.mjs'
POLICY=ROOT/'order-direction-policy.mjs'
UI=ROOT/'fast5-dashboard-inject.mjs'
MODEL='FAST5_SPOT_MOMENTUM_V1'
VERSION='FAST5_PREWARM120_5S_V4'
NODE='/opt/zl-prediction-node/bin/node'
IMPORT_OLD="refreshDirectionSettings,setDirectionMode,directionSettingsSnapshot"
IMPORT_NEW="refreshDirectionSettings,setDirectionMode,setFast5BothDirectionModes,directionSettingsSnapshot"
POLICY_ANCHOR="export function orderDirectionForProduction(direction,source=null){"
ENDPOINT_ANCHOR="  if (req.method === 'GET' && url.pathname === '/api/direction-mode') {"
CAS_FUNCTION=r"""
// Atomic two-side FAST5 forward/inverse selector. Uses the same Redis
// authority, revision/CAS and effectiveAfterRound as the existing controls.
// No writes are made when reading status; no implicit default is selected.
export async function setFast5BothDirectionModes(mode,expectedRevision,effectiveAfterRound=null){
 if(!['FORWARD','INVERSE'].includes(mode))throw Error('INVALID_MODE');
 if(ORDER_SOURCES.length!==1||PRIMARY_SOURCE!=='FAST5_SPOT_MOMENTUM_V1')
  throw Error('FAST5_IS_NOT_UNIQUE_DIRECTION_SOURCE');
 if(typeof expectedRevision!=='string'||!expectedRevision)throw Error('INVALID_EXPECTED_REVISION');
 if(effectiveAfterRound!==null&&(!Number.isSafeInteger(effectiveAfterRound)||effectiveAfterRound<0))
  throw Error('INVALID_EFFECTIVE_ROUND');
 if(writing)throw Error('DIRECTION_UPDATE_IN_PROGRESS');
 writing=true;
 try{
  const db=await client();
  const raw=await db.get(ORDER_MODE_REDIS_KEY);
  if(!raw)throw Error('DIRECTION_CONFIGURATION_MISSING');
  const saved=JSON.parse(raw);
  applyDirectionSettings(saved);
  if(saved.revision!==expectedRevision)throw Error('DIRECTION_REVISION_CONFLICT');
  if(saved.modes[PRIMARY_SOURCE]?.UP===mode&&saved.modes[PRIMARY_SOURCE]?.DOWN===mode)
   return {changed:false,...directionSettingsSnapshot()};
  const updated={
   modes:{...saved.modes,[PRIMARY_SOURCE]:{UP:mode,DOWN:mode}},
   revision:crypto.randomUUID(),updatedAt:new Date().toISOString(),effectiveAfterRound};
  const outcome=await db.eval(CAS_SCRIPT,{
   keys:[ORDER_MODE_REDIS_KEY],arguments:[raw,JSON.stringify(updated)]
  });
  if(outcome!=='OK')throw Error(outcome==='CONFLICT'?'DIRECTION_REVISION_CONFLICT':'DIRECTION_CONFIGURATION_MISSING');
  return {changed:true,...applyDirectionSettings(updated)};
 }catch(err){
  if(!String(err?.message||err).includes('DIRECTION_REVISION_CONFLICT')&&
     !String(err?.message||err).startsWith('INVALID_'))invalidateDirectionSettings();
  throw err;
 }finally{writing=false}
}
"""
ROUTE=r"""
  // FAST5 only: authenticated, atomic forward/inverse choice for both sides.
  if (req.method === 'POST' && url.pathname === '/api/fast5-direction-mode') {
    const body=await readBody(req);
    if(process.env.ZL_OUTER_AUTH_ONLY!=='true'||!pinOK(null,req))
      return send(res,401,{ok:false,error:'请从已登录的同源前台保存方向设置'});
    if(modelSelectionSnapshot().model!=='FAST5_SPOT_MOMENTUM_V1')
      return send(res,409,{ok:false,error:'当前生产信号不是FAST5，不能修改该开关'});
    if(['SUBMITTING','QUOTING'].includes(pendingAction?.state))
      return send(res,409,{ok:false,error:'订单正在提交或报价，本轮暂不可修改方向'});
    try{
      const data=await setFast5BothDirectionModes(
        body.mode,body.expectedRevision,currentRoundMs());
      if(data.changed){
        pendingAction=null;
        startAfterRound=currentRoundMs();
        lastPrepareAttemptAt=0;
      }
      console.log(JSON.stringify({event:'fast5_atomic_direction_mode_saved',
        mode:body.mode,revision:data.revision,changed:data.changed,
        at:new Date().toISOString(),effectiveFrom:'NEXT_ROUND'}));
      return send(res,200,{ok:true,...data,effectiveFrom:'NEXT_ROUND'});
    }catch(err){
      const m=String(err?.message||err);
      return send(res,/INVALID_/.test(m)?400:
        /CONFLICT|IN_PROGRESS|FAST5_IS_NOT/.test(m)?409:503,{ok:false,error:m});
    }
  }
"""
def run(*args,timeout=80):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=timeout)
def get(url):
 with urllib.request.urlopen('http://127.0.0.1:13001'+url,timeout=9) as r:return json.load(r)
def atomic(path,data):
 st=path.stat()
 fd,tmp=tempfile.mkstemp(dir=str(path.parent),prefix='.fast5-direction-')
 try:
  with os.fdopen(fd,'wb') as f:f.write(data)
  os.chmod(tmp,st.st_mode&0o777);os.chown(tmp,st.st_uid,st.st_gid)
  os.replace(tmp,path)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def main():
 if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch('[a-f0-9]{40}',sys.argv[1]):
  raise RuntimeError('INVALID_DEPLOY_AUTH_OR_PINNED_SHA')
 commit=sys.argv[1]
 for p in (INDEX,POLICY,UI):
  if not p.is_file():raise RuntimeError('MISSING_LIVE_FILE_'+p.name)
 trade=get('/api/status');signal=get('/api/fast5-live-status');dirs=get('/api/direction-mode')
 if trade.get('enabled') is not False:raise RuntimeError('AUTO_FOLLOW_ENABLED_DEPLOY_ABORT')
 if trade.get('orderSignalModel')!=MODEL or signal.get('strategyVersion')!=VERSION:
  raise RuntimeError('FAST5_V4_ROUTE_NOT_READY')
 if dirs.get('ready') is not True or MODEL not in (dirs.get('modes') or {}):
  raise RuntimeError('FAST5_DIRECTION_CONFIG_UNAVAILABLE')
 ix=INDEX.read_text();policy=POLICY.read_text();old_ui=UI.read_text()
 if (ix.count(IMPORT_OLD)!=1 or ix.count(ENDPOINT_ANCHOR)!=1 or
     policy.count(POLICY_ANCHOR)!=1 or 'setFast5BothDirectionModes' in policy or
     '/api/fast5-direction-mode' in ix):
  raise RuntimeError('BACKEND_SOURCE_DRIFT')
 if ("export const ORDER_SOURCES=[PRIMARY_SOURCE]" not in policy or
     "export const PRIMARY_SOURCE='FAST5_SPOT_MOMENTUM_V1'" not in policy or
     "const CAS_SCRIPT=" not in policy or "async function client()" not in policy):
  raise RuntimeError('EXISTING_FAST5_ATOMIC_REDIS_POLICY_NOT_READY')
 if 'FAST5 独立统计面板' not in old_ui or '/api/fast5-round-stats' not in old_ui:
  raise RuntimeError('STATS_PANEL_MUST_BE_PRESERVED')
 patched_index=ix.replace(IMPORT_OLD,IMPORT_NEW,1)
 patched_index=patched_index.replace(ENDPOINT_ANCHOR,ROUTE+ENDPOINT_ANCHOR,1)
 patched_policy=policy.replace(POLICY_ANCHOR,CAS_FUNCTION+'\n'+POLICY_ANCHOR,1)
 with tempfile.TemporaryDirectory(prefix='fast5-direction-release-') as tempdir:
  work=pathlib.Path(tempdir)
  url='https://raw.githubusercontent.com/zhoujunejune/pikpakzl/'+commit+'/prediction-bot-v1/fast5-dashboard-inject.mjs'
  with urllib.request.urlopen(url,timeout=40) as response:ui_data=response.read()
  for name,data in [('index.mjs',patched_index.encode()),('order-direction-policy.mjs',patched_policy.encode()),('fast5-dashboard-inject.mjs',ui_data)]:
   p=work/name;p.write_bytes(data);run(NODE,'--check',str(p))
  u=ui_data.decode('utf8')
  for expected in ['zlF5Forward','zlF5Inverse','/api/fast5-direction-mode',
     '/api/fast5-round-stats','FAST5 独立统计面板']:
   if expected not in u:raise RuntimeError('NEW_UI_MISSING_'+expected)
  for expected in ['pendingOrderMatchesProduction','mappedOrderSignal','refreshDirectionSettings','setDirectionMode']:
   if expected not in patched_policy and expected!='refreshDirectionSettings':raise RuntimeError('EXISTING_ORDER_GUARDS_MISSING')
  if get('/api/status').get('enabled') is not False:
   raise RuntimeError('FOLLOW_CHANGED_DURING_PREPARE')
  backup=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/(
   'fast5-direction-mode-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  for p in (INDEX,POLICY,UI):shutil.copy2(p,backup/p.name)
  try:
   for p,data in ((INDEX,patched_index.encode()),(POLICY,patched_policy.encode()),(UI,ui_data)):
    atomic(p,data)
   run('systemctl','restart','zl-prediction-trade.service',timeout=95)
   ok=False
   for _ in range(35):
    time.sleep(1)
    try:
     d=get('/api/direction-mode');t=get('/api/status')
     stats=get('/api/fast5-round-stats')
     html=urllib.request.urlopen('http://127.0.0.1:13001/',timeout=8).read().decode('utf8','replace')
     if (d.get('ready') is True and
         d.get('modes',{}).get(MODEL)==dirs.get('modes',{}).get(MODEL) and
         d.get('revision')==dirs.get('revision') and
         t.get('enabled') is False and t.get('orderSignalModel')==MODEL and
         stats.get('schema')=='FAST5_INDEPENDENT_OFFICIAL_ROUND_LEDGER_V1' and
         'id="zlF5Forward"' in html and 'id="zlF5Inverse"' in html and
         '/api/fast5-direction-mode' in html and
         '/api/fast5-round-stats' in html):
      ok=True;break
    except Exception:pass
   if not ok:raise RuntimeError('FAST5_SWITCH_POSTDEPLOY_NOT_READY')
   print('FAST5_DIRECTION_UI_DEPLOYED=true',flush=True)
   print('FAST5_DIRECTION_ATOMIC_API_INSTALLED=true',flush=True)
   print('FAST5_DIRECTION_PERSISTENT_REDIS_UNCHANGED=true',flush=True)
   print('FAST5_DIRECTION_MODE='+json.dumps(d.get('modes',{}).get(MODEL)),flush=True)
   print('FAST5_DIRECTION_NEXT_ROUND_ONLY=true',flush=True)
   print('FAST5_DIRECTION_STATS_PRESERVED=true',flush=True)
   print('FAST5_DIRECTION_AUTOFOLLOW_OFF=true',flush=True)
   print('FAST5_DIRECTION_BACKUP='+str(backup),flush=True)
  except BaseException:
   for p in (INDEX,POLICY,UI):shutil.copy2(backup/p.name,p)
   subprocess.run(['systemctl','restart','zl-prediction-trade.service'],timeout=85)
   print('FAST5_DIRECTION_ROLLBACK_ATTEMPTED=true',flush=True)
   raise
if __name__=='__main__':
 try:main()
 except Exception as exc:
  print('FAST5_DIRECTION_DEPLOY_ERROR',type(exc).__name__,str(exc)[:230],flush=True)
  sys.exit(1)

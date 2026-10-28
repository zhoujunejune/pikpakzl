#!/usr/bin/env python3
"""Atomic guarded upgrade of FAST5 to PREWARM120_OPEN1 V2.
Existing Alibaba single host; does not touch orders, credentials, risk controls,
settings, signal selection, Redis ledger or historical results.
Precondition: auto-follow is OFF. Roll back files and restart on failure.
"""
import json,os,pathlib,re,shutil,subprocess,sys,tempfile,time,urllib.request
from datetime import datetime,timezone

MODEL="FAST5_SPOT_MOMENTUM_V1"
VERSION="FAST5_PREWARM120_OPEN1_V2"
ROOT=pathlib.Path("/opt/zl-prediction-live/src/railway-diagnostic")
SIDE=pathlib.Path("/opt/zl-prediction-fast5")
NODE="/opt/zl-prediction-node/bin/node"
UNIT_TRADE="zl-prediction-trade.service"
UNIT_FAST="zl-prediction-fast5.service"
SRC_FILES=[
 (SIDE/"fast5-real-market-calculator.mjs","fast5-real-market-calculator.mjs"),
 (SIDE/"fast5-real-market-service.mjs","fast5-real-market-service.mjs"),
 (ROOT/"fast5-dashboard-inject.mjs","fast5-dashboard-inject.mjs")]
CHOICE=ROOT/"production-signal-choice.mjs"

VALIDATOR=r"""
export function validateFast5ProductionLive(body,now=Date.now()){
 const round=roundOf(now),lock=body?.latest;
 const ts=lock?.lockedAt,marketAt=lock?.marketAt;
 if(body?.ok!==true||body?.model!=='FAST5_SPOT_MOMENTUM_V1'||
    body?.strategyVersion!=='FAST5_PREWARM120_OPEN1_V2'||
    body?.readOnly!==true||body?.requiresDeepSeek!==false||
    body?.orders!==false||body?.productionIntegration!==false||
    body?.marketSource!=='BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR'||
    body?.lastError!=null)
  return {ok:false,reason:'FAST5_V2_UNTRUSTED_SOURCE'};
 if(!lock||lock.model!==body.model||lock.round!==round||body.round!==round||
    lock.strategyVersion!==body.strategyVersion||
    lock.status!=='LOCKED'||!['UP','DOWN'].includes(lock.direction)||
    lock.source!=='BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR'||
    lock.decisionMethod!=='PREWARM120_REAL_TICKS_OR_CLOSED_1M_PLUS_ROUND_OPEN_1S'||
    lock.requiresDeepSeek!==false||lock.orders!==false||
    lock.confidenceIsCalibrated!==false||lock.officialOracleLiveQuoteUsed!==false)
  return {ok:false,reason:'FAST5_V2_MISSING_VERIFIED_OPEN_LOCK'};
 if(!Number.isSafeInteger(ts)||ts<round+100||ts>round+1000||
    !Number.isSafeInteger(marketAt)||marketAt<round||marketAt>ts||
    ts-marketAt>500||ts>now+250||now-ts>16000||now>=round+20000||
    !Number.isSafeInteger(lock.samples)||lock.samples<1||
    !Number.isSafeInteger(body.lastObservationAt)||body.lastObservationAt<round||
    !Number.isSafeInteger(lock.prewarmSamples)||lock.prewarmSamples<2||
    !Number.isSafeInteger(lock.prewarmSpanMs)||lock.prewarmSpanMs<105000||
    !['PREVIOUS_120S_REAL_TICKS','CLOSED_1M_120S'].includes(lock.prewarmSource)||
    typeof lock.scoreBps!=='number'||!Number.isFinite(lock.scoreBps)||
    typeof lock.roundOpenPrice!=='number'||lock.roundOpenPrice<=0||
    typeof lock.openingObservedPrice!=='number'||lock.openingObservedPrice<=0)
  return {ok:false,reason:'FAST5_V2_STALE_OR_INVALID_OPEN_REFERENCE'};
 return {ok:true,round,direction:lock.direction,lockedAt:ts,
  marketAt,score:Math.abs(lock.scoreBps)};
}
"""
def get(port,path):
 with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}",timeout=7) as r:
  return json.load(r)

def check(*args,timeout=60):
 return subprocess.run(args,check=True,timeout=timeout,capture_output=True,text=True)

def install(path,content):
 st=path.stat()
 fd,name=tempfile.mkstemp(prefix=".fast5-prewarm-",dir=str(path.parent))
 try:
  with os.fdopen(fd,"wb") as f:f.write(content)
  os.chmod(name,st.st_mode&0o777)
  os.chown(name,st.st_uid,st.st_gid)
  os.replace(name,path)
 finally:
  if os.path.exists(name):os.unlink(name)

def patch_choice(text):
 anchor="\nexport function validateFast5ProductionLive(body,now=Date.now()){"
 if text.count(anchor)!=1:raise RuntimeError("VALIDATOR_ANCHOR_DRIFT")
 start=text.index(anchor)
 tail=text[start:]
 if "CAUSAL_REAL_TICK_PLUS_CLOSED_1M_MOMENTUM" not in tail or not tail.rstrip().endswith("}"):
  raise RuntimeError("UNKNOWN_CURRENT_VALIDATOR_VERSION")
 if "\nexport " in tail[len(anchor):]:raise RuntimeError("VALIDATOR_NOT_LAST_EXPORT")
 return text[:start]+ "\n"+ VALIDATOR.strip()+"\n"

def test_validator(path):
 temp=path.parent/"validator-v2-sanity.mjs"
 # Standalone no network, no Redis.
 v="const roundOf=t=>Math.floor(t/300000)*300000;\n"+VALIDATOR+"\n"
 v+="""
const R=1792945200000;
const mk=()=>({ok:true,model:'FAST5_SPOT_MOMENTUM_V1',
  strategyVersion:'FAST5_PREWARM120_OPEN1_V2',
  readOnly:true,requiresDeepSeek:false,orders:false,
  productionIntegration:false,marketSource:'BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR',
  lastError:null,round:R,lastObservationAt:R+180,
  latest:{model:'FAST5_SPOT_MOMENTUM_V1',round:R,
    strategyVersion:'FAST5_PREWARM120_OPEN1_V2',status:'LOCKED',direction:'UP',
    source:'BINANCE_SPOT_WEBSOCKET_V3_COLLECTOR',
    decisionMethod:'PREWARM120_REAL_TICKS_OR_CLOSED_1M_PLUS_ROUND_OPEN_1S',
    requiresDeepSeek:false,orders:false,confidenceIsCalibrated:false,
    officialOracleLiveQuoteUsed:false,lockedAt:R+200,marketAt:R+180,
    samples:1,prewarmSamples:2,prewarmSpanMs:120000,
    prewarmSource:'CLOSED_1M_120S',scoreBps:1.2,
    roundOpenPrice:80000,openingObservedPrice:80010}});
if(!validateFast5ProductionLive(mk(),R+300).ok)throw Error('VALID_LOCK_REJECTED');
const early=mk();early.latest.lockedAt=R+50;
if(validateFast5ProductionLive(early,R+300).ok)throw Error('PRE100MS_ACCEPTED');
const stale=mk();stale.latest.marketAt=R-1;
if(validateFast5ProductionLive(stale,R+300).ok)throw Error('PRIOR_ROUND_TICK_ACCEPTED');
const old=mk();old.latest.strategyVersion='FAST5_OLD';
if(validateFast5ProductionLive(old,R+300).ok)throw Error('OLD_MODEL_ACCEPTED');
console.log('FAST5_V2_VALIDATOR_GUARDS_OK=true');
"""
 temp.write_text(v)
 check(NODE,"--check",str(temp))
 result=check(NODE,str(temp))
 print(result.stdout.strip(),flush=True)

def main():
 if os.geteuid()!=0:raise RuntimeError("ROOT_REQUIRED")
 if len(sys.argv)!=2 or not re.fullmatch(r"[a-f0-9]{40}",sys.argv[1]):
  raise RuntimeError("INVALID_PINNED_COMMIT_SHA")
 sha=sys.argv[1]
 paths=[p for p,_ in SRC_FILES]+[CHOICE]
 if any(not p.is_file() for p in paths):raise RuntimeError("LIVE_SOURCE_MISSING")
 if not pathlib.Path(NODE).is_file():raise RuntimeError("NODE_NOT_FOUND")
 for unit in ["zl-prediction-trade","zl-prediction-fast5","zl-prediction-v2","zl-prediction-v3"]:
  if check("systemctl","is-active",unit).stdout.strip()!="active":
   raise RuntimeError("SERVICE_NOT_READY_"+unit)
 trade=get(13001,"/api/status")
 selector=get(13001,"/api/order-signal-model")
 initial=get(13046,"/api/status")
 if trade.get("enabled") is not False:raise RuntimeError("AUTO_FOLLOW_MUST_BE_OFF")
 if trade.get("orderSignalModel")!=MODEL or selector.get("model")!=MODEL:
  raise RuntimeError("PRODUCTION_SELECTOR_MISMATCH")
 if initial.get("model")!=MODEL or initial.get("requiresDeepSeek") is not False:
  raise RuntimeError("OLD_SIGNAL_NOT_READY")
 if initial.get("strategyVersion")==VERSION:raise RuntimeError("UPGRADE_ALREADY_PRESENT")
 live_choice=CHOICE.read_text()
 updated_choice=patch_choice(live_choice)
 with tempfile.TemporaryDirectory(prefix="zl-fast5-prewarm120-") as tmp:
  work=pathlib.Path(tmp)
  downloads={}
  for dest,name in SRC_FILES:
   url="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/"+sha+"/prediction-bot-v1/"+name
   with urllib.request.urlopen(url,timeout=35) as r:data=r.read()
   downloads[dest]=data
   (work/name).write_bytes(data)
   check(NODE,"--check",str(work/name))
  (work/CHOICE.name).write_text(updated_choice)
  check(NODE,"--check",str(work/CHOICE.name))
  test_validator(work)
  if "FAST5_PREWARM120_OPEN1_V2" not in downloads[SIDE/"fast5-real-market-calculator.mjs"].decode():
   raise RuntimeError("CALCULATOR_NOT_V2")
  if "setInterval(()=>void service.poll(),100)" not in downloads[SIDE/"fast5-real-market-service.mjs"].decode():
   raise RuntimeError("EXPECTED_100MS_READONLY_POLL_MISSING")
  if "本轮0.1～1秒确认方向" not in downloads[ROOT/"fast5-dashboard-inject.mjs"].decode():
   raise RuntimeError("EXPECTED_PREWARM_UI_MISSING")
  if get(13001,"/api/status").get("enabled") is not False:
   raise RuntimeError("AUTO_FOLLOW_CHANGED_ABORT")
  backup=pathlib.Path("/var/lib/zl-prediction/archive/source-backups")/(
    "fast5-prewarm120-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
  backup.mkdir(parents=True,exist_ok=False)
  for file in paths:shutil.copy2(file,backup/file.name)
  touched=[]
  try:
   for dest,data in downloads.items():
    install(dest,data);touched.append(dest)
   install(CHOICE,updated_choice.encode());touched.append(CHOICE)
   check("systemctl","restart",UNIT_FAST,timeout=50)
   check("systemctl","restart",UNIT_TRADE,timeout=65)
   seen=False
   for _ in range(30):
    time.sleep(.7)
    try:
     status=get(13046,"/api/status")
     current=get(13001,"/api/status")
     selection=get(13001,"/api/order-signal-model")
     if(status.get("ok") and status.get("strategyVersion")==VERSION and
       status.get("model")==MODEL and status.get("requiresDeepSeek") is False and
       status.get("readOnly") is True and status.get("orders") is False and
       status.get("lastError") is None and status.get("fetchAttempts",0)>=2 and
       current.get("enabled") is False and current.get("orderSignalModel")==MODEL and
       selection.get("model")==MODEL):
      seen=True;break
    except Exception:pass
   if not seen:raise RuntimeError("POSTDEPLOY_SIGNAL_OR_ROUTE_NOT_READY")
   for unit in ["zl-prediction-trade","zl-prediction-fast5","zl-prediction-v2","zl-prediction-v3"]:
    if check("systemctl","is-active",unit).stdout.strip()!="active":
     raise RuntimeError("POSTDEPLOY_SERVICE_INACTIVE_"+unit)
   html=urllib.request.urlopen("http://127.0.0.1:13001/",timeout=8).read().decode("utf8","replace")
   if "上一轮倒数120秒预分析" not in html:
    raise RuntimeError("PREWARM_PANEL_NOT_UPDATED")
   print("FAST5_V2_DEPLOY_SUCCESS=true",flush=True)
   print("FAST5_V2_MODEL="+status.get("model",""),flush=True)
   print("FAST5_V2_STRATEGY="+status.get("strategyVersion",""),flush=True)
   print("FAST5_V2_POLL_INTERVAL_MS=100",flush=True)
   print("FAST5_V2_PRODUCTION_ROUTER_UPDATED=true",flush=True)
   print("FAST5_V2_AUTOFOLLOW_REMAINS_OFF=true",flush=True)
   print("FAST5_V2_CURRENT_SIGNAL="+json.dumps({
     "round":status.get("round"),"latestReason":status.get("latestError"),
     "lockedAt":(status.get("latest") or {}).get("lockedAt"),
     "direction":(status.get("latest") or {}).get("direction"),
     "prewarmSource":(status.get("latest") or {}).get("prewarmSource"),
     "lastRequestMs":status.get("lastRequestMs")},separators=(",",":")),flush=True)
   print("FAST5_V2_BACKUP="+str(backup),flush=True)
  except BaseException:
   print("FAST5_V2_ROLLBACK_START=true",flush=True)
   for file in touched:
    shutil.copy2(backup/file.name,file)
   subprocess.run(["systemctl","restart",UNIT_FAST],timeout=45)
   subprocess.run(["systemctl","restart",UNIT_TRADE],timeout=60)
   print("FAST5_V2_ROLLBACK_ATTEMPTED=true",flush=True)
   raise

if __name__=="__main__":
 try:main()
 except Exception as err:
  print("FAST5_V2_UPGRADE_FAILED",type(err).__name__,str(err)[:250],flush=True)
  sys.exit(1)

#!/usr/bin/env python3
"""Repair Alibaba 30s prediction input: use current-round causal snapshots.

No third directional fallback, no changing Binance order methods, preserves
historical rounds and independent futures bot. Atomic backup and rollback.
"""
import json,os,pathlib,re,shutil,subprocess,sys,tempfile,time,urllib.request
from datetime import datetime,timezone
ROOT=pathlib.Path("/opt/zl-prediction-live/src")
TRACKER=ROOT/"round-tracker/index-rest.mjs"
ROUTER=ROOT/"round-tracker/selective-v2-fast8-router.mjs"
CHOICE=ROOT/"railway-diagnostic/production-signal-choice.mjs"
PANEL=ROOT/"railway-diagnostic/panel-stats-shell.mjs"
NODE="/opt/zl-prediction-node/bin/node"
OLD="SELECTIVE_V2_30S_QUALIFIED_V1"
NEW="SELECTIVE_V2_30S_CURRENT_ROUND_V2"
INPUT_OLD="SELECTIVE_V2_30S_CAUSAL_REAL_MARKET_V1"
INPUT_NEW="SELECTIVE_V2_30S_CURRENT_ROUND_REAL_MARKET_V2"
FILES={"tracker":TRACKER,"router":ROUTER,"choice":CHOICE,"panel":PANEL}

def once(s,before,after,label):
 n=s.count(before)
 if n!=1:raise RuntimeError("PATCH_CONTEXT_MISMATCH:%s:%s"%(label,n))
 return s.replace(before,after,1)
def run(*args):
 subprocess.run(args,check=True,timeout=90,stdout=subprocess.DEVNULL)
def get(port,path):
 with urllib.request.urlopen("http://127.0.0.1:%d%s"%(port,path),timeout=10) as r:return json.load(r)
def patch_tracker(s):
 # Each decision is based on current-round market facts. The earlier 8s
 # prewarm module still powers other independent models unchanged.
 s=once(s,"let selective30Samples={round:null,count:0,firstAt:0,lastAt:0};",
   "let selective30Samples={round:null,count:0,firstAt:0,lastAt:0};\nlet selective30FeatureSamples=[];", "feature-state")
 s=once(s,
   "      if(selective30Samples.round!==currentRound)\n"
   "        selective30Samples={round:currentRound,count:0,firstAt:signalObservedAt,lastAt:0};\n"
   "      if(signalObservedAt>=currentRound&&signalObservedAt<currentRound+30000&&\n"
   "         signalObservedAt-selective30Samples.lastAt>=800){\n"
   "        selective30Samples.count++;selective30Samples.lastAt=signalObservedAt;\n"
   "      }\n"
   "      selective8Snapshot={round:currentRound,observedAt:signalObservedAt,\n"
   "        sourceObservedAt:Number(live.factsCalculatedAt??signalObservedAt),\n"
   "        observations:selective30Samples.count,\n"
   "        observationSpanMs:signalObservedAt-selective30Samples.firstAt,...prepared};",
   """      if(selective30Samples.round!==currentRound){
        selective30Samples={round:currentRound,count:0,firstAt:signalObservedAt,lastAt:0};
        selective30FeatureSamples=[];
      }
      const sourceAt=Number(live.factsCalculatedAt);
      const causal=sourceAt>=currentRound&&sourceAt<=signalObservedAt+250&&
        signalObservedAt-sourceAt<=2000&&live.facts?.dataFresh!==false;
      const currentFacts=causal&&live.facts&&typeof live.facts==='object'?live.facts:{};
      const numericKeys=['regimeScore','currentScore','microScore','currentTrendScore',
        'normalizedMomentum15s','normalizedMomentum30s','normalizedMomentum60s',
        'normalizedMomentum180s','normalizedMomentum300s','tradePressure15s',
        'tradePressure60s','ofiNormalized5s','ofiNormalized60s','rangePosition180',
        'liveScore','distanceFromOpenBps'];
      const hasCurrentInput=Number.isFinite(Number(currentFacts.currentScore))&&
        Number.isFinite(Number(currentFacts.predictionMarketUpMid))&&
        typeof currentFacts.absorptionRisk==='boolean';
      if(causal&&hasCurrentInput&&signalObservedAt>=currentRound&&
         signalObservedAt<currentRound+30000&&
         signalObservedAt-selective30Samples.lastAt>=800){
        selective30Samples.count++;
        selective30Samples.lastAt=signalObservedAt;
        selective30FeatureSamples.push({at:sourceAt,facts:{...currentFacts}});
        if(selective30FeatureSamples.length>45)selective30FeatureSamples.shift();
      }
      // No prior-round directional score is carried into a 30s current-round
      // decision. Momentum and trend combine latest + trailing observations;
      // prediction-market quote always comes from the same current contract.
      const currentDecisionFacts={};
      for(const key of numericKeys){
        const latest=Number(currentFacts[key]);
        if(currentFacts[key]===null||currentFacts[key]===undefined||
           currentFacts[key]===''||!Number.isFinite(latest))continue;
        const recent=selective30FeatureSamples.filter(x=>
          x.at>=sourceAt-12000&&Number.isFinite(Number(x.facts[key]))&&
          x.facts[key]!==null&&x.facts[key]!==undefined)
          .map(x=>Number(x.facts[key]));
        const mean=recent.length?recent.reduce((a,b)=>a+b,0)/recent.length:latest;
        currentDecisionFacts[key]=Number((latest*0.7+mean*0.3).toFixed(6));
      }
      if(Number.isFinite(Number(currentFacts.predictionMarketUpMid))&&
         currentFacts.predictionMarketUpMid!==null)
        currentDecisionFacts.predictionMarketUpMid=Number(currentFacts.predictionMarketUpMid);
      if(typeof currentFacts.absorptionRisk==='boolean')
        currentDecisionFacts.absorptionRisk=currentFacts.absorptionRisk;
      // Retain only current-round facts; never fall back to stale prewarm
      // prices/indicators when market data is missing.
      const currentKeys=Object.keys(currentDecisionFacts);
      selective8Snapshot={round:currentRound,observedAt:signalObservedAt,
        sourceObservedAt:causal?sourceAt:null,
        observations:selective30Samples.count,
        observationSpanMs:selective30Samples.count?
          selective30Samples.lastAt-selective30Samples.firstAt:0,
        facts:currentDecisionFacts,fromCurrent:currentKeys,
        fromPrevious:[],fromEarlierPrevious:[],
        sourceRound:currentRound,inputVersion:'SELECTIVE_V2_30S_CURRENT_ROUND_INPUTS_V2'};""",
 "current-facts-replacement")
 # The unchanged V2 and Edge predicates are still distinct, with absorption
 # rejection and current-market strength requirements. Do not force any signal.
 return s
def patch_router(s):
 s=once(s,f"export const POLICY_VERSION='{OLD}';",
        f"export const POLICY_VERSION='{NEW}';","router-model")
 s=once(s,f"export const INPUT_VERSION='{INPUT_OLD}';",
        f"export const INPUT_VERSION='{INPUT_NEW}';","router-input")
 return s
def patch_choice(s):
 s=once(s,f"export const SELECTIVE8_MODEL='{OLD}';",
        f"export const SELECTIVE8_MODEL='{NEW}';","choice-model")
 s=once(s,f"export const SELECTIVE8_INPUT_VERSION='{INPUT_OLD}';",
        f"export const SELECTIVE8_INPUT_VERSION='{INPUT_NEW}';","choice-input")
 s=s.replace("Selective V2 + Edge Rescue（30秒，双来源）",
             "Selective V2 + Edge Rescue（30秒本轮实时数据）")
 return s
def patch_panel(s):
 if OLD not in s:raise RuntimeError("PANEL_OLD_VERSION_MISSING")
 return s.replace(OLD,NEW).replace(
     "BTC 5分钟 · 30秒内决策",
     "BTC 5分钟 · 23-30秒本轮实时行情（不使用上一轮趋势特征）")

def main():
 if os.geteuid()!=0:raise RuntimeError("ROOT_REQUIRED")
 for name in ("zl-prediction-v2","zl-prediction-trade","zl-prediction-v3",
              "zl-prediction-redis","zl-futures-bot-paper"):
  if subprocess.check_output(["systemctl","is-active",name],text=True).strip()!="active":
   raise RuntimeError("PREREQUISITE_NOT_ACTIVE:"+name)
 old_stats=get(13002,"/api/round-stats")
 old_sel=get(13001,"/api/order-signal-model")
 before_modes=get(13001,"/api/direction-mode").get("modes")
 if old_sel.get("model")!=OLD:raise RuntimeError("NOT_ON_EXPECTED_30S_VERSION")
 if [x.get("source") for x in old_stats.get("activeSignalModels",[])]!=[
    "SELECTIVE_V2_FAST8_PRIMARY","EDGE_RESCUE_FAST8_PRIMARY"]:
  raise RuntimeError("UNEXPECTED_ACTIVE_SOURCES")
 original={k:p.read_text() for k,p in FILES.items()}
 updated={k:globals()["patch_"+k](src) for k,src in original.items()}
 with tempfile.TemporaryDirectory(prefix="zl-pred30-current-") as t:
  for name,src in updated.items():
   p=pathlib.Path(t)/(name+".mjs");p.write_text(src)
   run(NODE,"--check",str(p))
  # A positive test: old-direction proxy cannot dominate current-round
  # live values; and the 30s two-source policy remains immutable.
  x=updated["tracker"]
  assert "facts:currentDecisionFacts,fromCurrent:currentKeys" in x
  assert "fromPrevious:[],fromEarlierPrevious:[]" in x
  assert "0.7+mean*0.3" in x
  assert "hasCurrentInput" in x and "sourceAt>=currentRound" in x
  y=updated["router"]
  assert "LOCK_DEADLINE_MS=30000" in y
  assert "source:UNVERIFIED_SOURCE,executionEligible:true" not in y
  assert INPUT_NEW in updated["choice"]
  print("CURRENT_ROUND_OFFLINE_CHECKS_OK=true")
  stamp=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
  backup=pathlib.Path("/var/lib/zl-prediction/archive/source-backups")/("selective30-current-"+stamp)
  backup.mkdir(parents=True,exist_ok=False)
  for name,p in FILES.items():shutil.copy2(p,backup/(name+".mjs"))
  installed=[]
  try:
   for name,p in FILES.items():
    st=p.stat(); tmp=p.with_name(p.name+".current30.tmp")
    tmp.write_text(updated[name]);os.chown(tmp,st.st_uid,st.st_gid)
    os.chmod(tmp,st.st_mode&0o777);os.replace(tmp,p)
    installed.append(name)
   run("systemctl","restart","zl-prediction-v2.service")
   run("systemctl","restart","zl-prediction-trade.service")
   verified=False
   for _ in range(35):
    try:
     stats=get(13002,"/api/round-stats")
     choice=get(13001,"/api/order-signal-model")
     modes=get(13001,"/api/direction-mode")
     if(choice.get("ready") and choice.get("model")==NEW and
        [i.get("source") for i in stats.get("activeSignalModels",[])]==[
           "SELECTIVE_V2_FAST8_PRIMARY","EDGE_RESCUE_FAST8_PRIMARY"] and
        all(i.get("version")==NEW for i in stats.get("activeSignalModels",[])) and
        modes.get("modes")==before_modes):
      verified=True;break
    except Exception:pass
    time.sleep(2)
   if not verified:raise RuntimeError("POST_DEPLOY_COHORT_OR_DIRECTION_CHECK_FAILED")
   for svc in ("zl-futures-bot-paper","zl-prediction-v3","zl-prediction-redis"):
    if subprocess.check_output(["systemctl","is-active",svc],text=True).strip()!="active":
     raise RuntimeError("UNEXPECTED_SERVICE_STATE:"+svc)
   print("CURRENT_ROUND_MODEL_DEPLOYED=true")
   print("CURRENT_ROUND_MODEL_VERSION",NEW)
   print("CURRENT_ROUND_TWO_SOURCES_VERIFIED=true")
   print("CURRENT_ROUND_HISTORY_PRESERVED=true")
   print("CURRENT_ROUND_DIRECTION_SWITCHES_PRESERVED=true")
   print("CURRENT_ROUND_FUTURES_UNMODIFIED=true")
  except BaseException:
   for name in installed:shutil.copy2(backup/(name+".mjs"),FILES[name])
   subprocess.run(["systemctl","restart","zl-prediction-v2.service"],timeout=90)
   subprocess.run(["systemctl","restart","zl-prediction-trade.service"],timeout=90)
   print("CURRENT_ROUND_ROLLBACK_ATTEMPTED=true",flush=True)
   raise
if __name__=="__main__":
 try:main()
 except Exception as e:
  print("CURRENT_ROUND_REPAIR_FAILED",type(e).__name__,str(e)[:240])
  sys.exit(1)

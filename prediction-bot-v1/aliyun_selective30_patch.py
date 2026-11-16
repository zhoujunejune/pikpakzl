#!/usr/bin/env python3
"""Targeted Aliyun Selective V2 30s two-source migration.

Edits only the deployed prediction V2 router/trade control/UI modules.
Preserves history, Redis direction modes, exchange credentials and futures services.
Fail closed on unknown code, validate before restart, rollback on any failed probe.
"""
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import json
import time
from datetime import datetime, timezone

V = pathlib.Path("/opt/zl-prediction-live/src/round-tracker")
B = pathlib.Path("/opt/zl-prediction-live/src/railway-diagnostic")
NODE = "/opt/zl-prediction-node/bin/node"
NEW = "SELECTIVE_V2_30S_QUALIFIED_V1"
INPUT = "SELECTIVE_V2_30S_CAUSAL_REAL_MARKET_V1"
OLD = "SELECTIVE_V2_FAST8_PREWARM_V1"
SOURCES = ["SELECTIVE_V2_FAST8_PRIMARY", "EDGE_RESCUE_FAST8_PRIMARY"]
FILES = {
    "router": V / "selective-v2-fast8-router.mjs",
    "tracker": V / "index-rest.mjs",
    "choice": B / "production-signal-choice.mjs",
    "trade": B / "index.mjs",
    "panel": B / "panel-stats-shell.mjs",
}

def once(s, old, new, label):
    n = s.count(old)
    if n != 1:
        raise RuntimeError(f"PATCH_CONTEXT_MISMATCH:{label}:found={n}")
    return s.replace(old, new, 1)

def patch_router(s):
    s = once(s, "export const POLICY_VERSION='SELECTIVE_V2_FAST8_PREWARM_V1';",
        f"export const POLICY_VERSION='{NEW}';", "router-version")
    s = once(s, "export const LOCK_DEADLINE_MS=8000;",
        "export const LOCK_DEADLINE_MS=30000;\nexport const DECISION_START_MS=23000;\nexport const MIN_OBSERVATIONS=5;\nexport const MIN_OBSERVATION_SPAN_MS=12000;", "deadline")
    s = once(s, "// Reserve ~1 second for signal transport and panel receipt before T+8s.\nexport const FALLBACK_COMMIT_MS=7000;",
        "// The 30s policy never manufactures a weak fallback direction.", "legacy-timer")
    s = once(s, "export const INPUT_VERSION='SELECTIVE_V2_FAST8_PRIOR_REAL_MARKET_V1';",
        f"export const INPUT_VERSION='{INPUT}';", "input-version")
    s = once(s, "  previousRoundFeatureCount=0,currentRoundFeatureCount=0,\n  sourceRound=null,previousInputVersion=null}={}){",
        "  previousRoundFeatureCount=0,currentRoundFeatureCount=0,\n  sourceRound=null,previousInputVersion=null,\n  observations=0,observationSpanMs=0,observedAt=null}={}){", "args")
    s = once(s, "reason:'EIGHT_SECOND_DEADLINE_EXPIRED',executionEligible:false",
        "reason:'THIRTY_SECOND_DEADLINE_NO_SIGNAL',executionEligible:false", "expiration")
    s = once(s, "status:'DATA_UNAVAILABLE',\n      reason:'THIRTY_SECOND_DEADLINE_NO_SIGNAL'",
        "status:'NO_SIGNAL',\n      reason:'THIRTY_SECOND_DEADLINE_NO_SIGNAL'", "no-signal")
    s = once(s,
        "  if(!base) return { ...common,\n    status:elapsedMs>=FALLBACK_COMMIT_MS?'DATA_UNAVAILABLE':'PENDING',\n    reason:'NO_REAL_DIRECTION_FEATURE',signal:null};",
        "  if(!base)return {...common,status:'PENDING',signal:null,reason:'NO_REAL_DIRECTION_FEATURE'};\n"
        "  if(elapsedMs<DECISION_START_MS||observations<MIN_OBSERVATIONS||\n"
        "     observationSpanMs<MIN_OBSERVATION_SPAN_MS||\n"
        "     !Number.isFinite(observedAt)||observedAt<round||observedAt>now+250||\n"
        "     now-observedAt>3000)\n"
        "    return {...common,status:'PENDING',signal:null,reason:'COLLECTING_FRESH_CURRENT_ROUND_DATA'};",
        "observation-gate")
    s = once(s, "  if(elapsedMs<FALLBACK_COMMIT_MS)\n    return {...common,status:'PENDING',signal:null,reason:'AWAITING_QUALIFIED_DIRECTION',evidence};\n  // User-authorized: every real-market UP/DOWN direction is order-eligible.\n  // Preserve the weak-signal label; never invent confidence or a market value.\n  return {...common,status:'LOCKED',direction:base.direction,\n    source:UNVERIFIED_SOURCE,executionEligible:true,\n    fallbackUsed:true,fallbackReason:'UNVERIFIED_REAL_MARKET_DIRECTION',\n    score:null,confidence:null,evidence};",
        "  // No third fallback source: an unqualified V2 and Edge pair is NO_SIGNAL.\n"
        "  return {...common,status:'PENDING',signal:null,\n"
        "    reason:'NO_QUALIFIED_V2_OR_EDGE_SIGNAL',evidence};",
        "fallback-disabled")
    return s

def patch_tracker(s):
    s = once(s, "let selective8Snapshot = null;",
        "let selective8Snapshot = null;\nlet selective30Samples={round:null,count:0,firstAt:0,lastAt:0};",
        "tracker-observer")
    s = once(s,
        "      const prepared = vip75Frozen8Probe.prepareFeatures(Number(live.round),live.facts);\n"
        "      selective8Snapshot = {round:Number(live.round),observedAt:signalObservedAt,...prepared};\n"
        "      if (Date.now() < Number(live.round)+8000 &&",
        "      const prepared = vip75Frozen8Probe.prepareFeatures(Number(live.round),live.facts);\n"
        "      const currentRound=Number(live.round);\n"
        "      if(selective30Samples.round!==currentRound)\n"
        "        selective30Samples={round:currentRound,count:0,firstAt:signalObservedAt,lastAt:0};\n"
        "      if(signalObservedAt>=currentRound&&signalObservedAt<currentRound+30000&&\n"
        "         signalObservedAt-selective30Samples.lastAt>=800){\n"
        "        selective30Samples.count++;selective30Samples.lastAt=signalObservedAt;\n"
        "      }\n"
        "      selective8Snapshot={round:currentRound,observedAt:signalObservedAt,\n"
        "        sourceObservedAt:Number(live.factsCalculatedAt??signalObservedAt),\n"
        "        observations:selective30Samples.count,\n"
        "        observationSpanMs:signalObservedAt-selective30Samples.firstAt,...prepared};\n"
        "      if (Date.now() < currentRound+30000 &&",
        "tracker-observe")
    s = once(s,
        "    previousInputVersion:sample?.inputVersion??null,\n    quality:(direction,facts,delayMs,excludeRound)=>\n      evaluateSelectiveQualityV2(direction,facts,delayMs,excludeRound),\n    edge:(direction,facts,delayMs,score)=>\n      selectiveV2EdgeRescueCandidateDecision(direction,facts,delayMs,score),",
        "    previousInputVersion:sample?.inputVersion??null,\n"
        "    observations:sample?.observations??0,\n"
        "    observationSpanMs:sample?.observationSpanMs??0,\n"
        "    observedAt:sample?.sourceObservedAt??null,\n"
        "    quality:(direction,facts,delayMs,excludeRound)=>{\n"
        "      const q=evaluateSelectiveQualityV2(direction,facts,delayMs,excludeRound);\n"
        "      const reasons=(q?.reasons||[]).filter(x=>x!=='LOCK_DELAY_ABOVE_ADAPTIVE_MAX');\n"
        "      // Historical <=22s timing restriction does not apply to new 30s cohort.\n"
        "      return {...q,reasons,pass:reasons.length===0};\n"
        "    },\n"
        "    edge:(direction,facts,delayMs,score)=>{\n"
        "      const e=selectiveV2EdgeRescueCandidateDecision(direction,facts,delayMs,score);\n"
        "      const reasons=(e?.reasons||[]).filter(x=>x!=='DELAY_ABOVE_EDGE_MAX');\n"
        "      return {...e,reasons,pass:reasons.length===0};\n"
        "    },",
        "tracker-two-qualified-gates")
    s = once(s, "status:routed.fallbackUsed===true?'LOW_CONFIDENCE_TRADE_ELIGIBLE':'QUALIFIED_8S',",
        "status:'QUALIFIED_30S',", "tracker-signal-provenance")
    s = once(s,
        "          {id:SELECTIVE8_VERSION,name:'Selective V2（8秒主策略）',\n"
        "            source:'SELECTIVE_V2_FAST8_PRIMARY',version:SELECTIVE8_VERSION,active:true},\n"
        "          {id:SELECTIVE8_VERSION,name:'Edge Rescue（8秒兜底）',\n"
        "            source:'EDGE_RESCUE_FAST8_PRIMARY',version:SELECTIVE8_VERSION,active:true},\n"
        "          {id:SELECTIVE8_VERSION,name:'行情方向兜底（8秒）',\n"
        "            source:'SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION',\n"
        "            version:SELECTIVE8_VERSION,active:true},",
        "          {id:SELECTIVE8_VERSION,name:'Selective V2（30秒主策略）',\n"
        "            source:'SELECTIVE_V2_FAST8_PRIMARY',version:SELECTIVE8_VERSION,active:true},\n"
        "          {id:SELECTIVE8_VERSION,name:'Edge Rescue（30秒补救）',\n"
        "            source:'EDGE_RESCUE_FAST8_PRIMARY',version:SELECTIVE8_VERSION,active:true},",
        "tracker-active-catalog")
    return s

def patch_choice(s):
    if s.count(f"export const SELECTIVE8_MODEL='{OLD}';")!=1:
        raise RuntimeError("ACTIVE_PINNED_TRADE_MODEL_UNKNOWN")
    s=s.replace(OLD,NEW).replace("SELECTIVE_V2_FAST8_PRIOR_REAL_MARKET_V1", INPUT)
    s = once(s,
        " 'EDGE_RESCUE_FAST8_PRIMARY',\n 'SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION'",
        " 'EDGE_RESCUE_FAST8_PRIMARY'", "trade-source-allowlist")
    s=s.replace("Selective V2 + Edge Rescue + 行情方向兜底（8秒）",
                "Selective V2 + Edge Rescue（30秒，双来源）")
    s=once(s,"lockedAt<round||lockedAt>=round+8000||",
              "lockedAt<round+23000||lockedAt>=round+30000||","trade-lock-window")
    s=once(s,
        " const isFallback=live.source==='SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION';\n"
        " if(Boolean(live.fallbackUsed)!==isFallback||\n"
        "   (isFallback&&live.fallbackReason!=='UNVERIFIED_REAL_MARKET_DIRECTION'))\n"
        "   return {ok:false,reason:'FALLBACK_PROVENANCE_MISMATCH'};",
        " if(live.fallbackUsed===true||live.fallbackReason!=null)\n"
        "   return {ok:false,reason:'FALLBACK_NOT_ALLOWED_IN_30S_POLICY'};",
        "trade-block-fallback")
    s=once(s,"    fallbackUsed:isFallback,executionEligible:true,",
              "    fallbackUsed:false,executionEligible:true,","trade-eligibility")
    return s

def patch_trade(s):
    s=s.replace("    // The user-selected source is the exact original V2 3-tier immutable\n"
                "    // 8-second route (Selective, Edge Rescue, real-market fallback).",
                "    // New 30s route uses qualified Selective V2 or Edge Rescue ONLY.")
    s=s.replace("        qualityGate:validated.fallbackUsed?\n"
                "          'UNVERIFIED_REAL_MARKET_DIRECTION':'QUALIFIED_SELECTIVE8',",
                "        qualityGate:'QUALIFIED_SELECTIVE30',")
    s=s.replace("transport:'aliyun_v2_selective_8sec_locked_source'",
                "transport:'aliyun_v2_selective_30sec_qualified_source'")
    return s

def patch_panel(s):
    if OLD not in s:raise RuntimeError("UI_OLD_MODEL_MISSING")
    s=s.replace(OLD,NEW)
    s=s.replace("Selective V2（8秒主策略）","Selective V2（30秒主策略）")
    s=s.replace("Edge Rescue（8秒兜底）","Edge Rescue（30秒补救）")
    s=s.replace("Selective V2（8秒）","Selective V2（30秒）")
    s=s.replace("Edge Rescue（8秒）","Edge Rescue（30秒）")
    s=s.replace("BTC 5分钟 · 8秒截止", "BTC 5分钟 · 30秒内决策")
    s=s.replace("当前生产信号模型 · 8秒版","当前生产信号模型 · 30秒版")
    # The third side-mode control disappears from the page; historical rows
    # are not deleted, and no data is erased from Redis or official archives.
    s,n=re.subn(
      r",?\s*\{id:'SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION',name:'低置信度行情兜底',modes:\{UP:'OFF',DOWN:'OFF'\}\}",
      "",s)
    if n!=1:raise RuntimeError(f"UI_THIRD_MODE_CONTROL_MISMATCH:{n}")
    return s

PATCHES={"router":patch_router,"tracker":patch_tracker,
         "choice":patch_choice,"trade":patch_trade,"panel":patch_panel}

def get(port,route):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{route}", timeout=12) as r:
        return json.load(r)

def run(*args):
    subprocess.run(args,check=True,timeout=90,stdout=subprocess.DEVNULL)

def node_test_router(file):
    code = r"""
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {routeSelectiveV2Fast8:r,POLICY_VERSION,LOCK_DEADLINE_MS}=
  await import(pathToFileURL(process.argv[1]).href);
assert.equal(POLICY_VERSION,'SELECTIVE_V2_30S_QUALIFIED_V1');
assert.equal(LOCK_DEADLINE_MS,30000);
const t=1800000000000;
const f={currentScore:.83,liveScore:.73,predictionMarketUpMid:.58,absorptionRisk:false};
const x=(offset,opts={})=>r({round:t,now:t+offset,facts:f,
  currentRoundFeatureCount:6,observations:12,observationSpanMs:18000,
  observedAt:t+offset-100,quality:()=>({pass:true}),edge:()=>({pass:true}),...opts});
assert.equal(x(8000).status,'PENDING');
assert.equal(x(22000).status,'PENDING');
assert.equal(x(23900).source,'SELECTIVE_V2_FAST8_PRIMARY');
assert.equal(x(29000,{quality:()=>({pass:false,reasons:['LOW']}),edge:()=>({pass:true})}).source,'EDGE_RESCUE_FAST8_PRIMARY');
assert.equal(x(29000,{quality:()=>({pass:false}),edge:()=>({pass:false})}).status,'PENDING');
assert.equal(x(30000).status,'NO_SIGNAL');
assert.equal(x(25000,{observations:1}).status,'PENDING');
assert.equal(x(25000,{observedAt:t+17000}).status,'PENDING');
console.log('30S_ROUTE_2_SOURCES_NO_FALLBACK_TEST_OK');
"""
    run(NODE,"--input-type=module","-e",code,str(file))

def main():
    if os.geteuid()!=0:raise RuntimeError("ROOT_REQUIRED")
    if not os.path.isfile(NODE):raise RuntimeError("NODE_NOT_FOUND")
    for name in ["zl-prediction-v2","zl-prediction-trade","zl-prediction-v3",
                 "zl-prediction-redis","zl-futures-bot-paper"]:
        state=subprocess.check_output(["systemctl","is-active",name],text=True).strip()
        if state!="active":raise RuntimeError("SERVICE_NOT_ACTIVE:"+name)
    original={}
    for name,p in FILES.items(): original[name]=p.read_text()
    if NEW in original["router"]:
        if all(NEW in original[x] for x in ("choice","panel")):
            print("SELECTIVE30_ALREADY_APPLIED=true");return
        raise RuntimeError("PARTIAL_NEW_MODEL_STATE")
    oldstats=get(13002,"/api/round-stats")
    if oldstats.get("productionSignalSourceMode")!="SELECTIVE_V2_FAST8":
        raise RuntimeError("UNEXPECTED_LIVE_ROUTING_MODE")
    if len(oldstats.get("activeSignalModels") or [])!=3:
        raise RuntimeError("CURRENT_ACTIVE_MODELS_NOT_THREE")
    previous_direction=get(13001,"/api/direction-mode").get("modes")
    newfiles={name:PATCHES[name](src) for name,src in original.items()}
    with tempfile.TemporaryDirectory(prefix="zl-selective30-") as directory:
        tmp=pathlib.Path(directory)
        for name,src in newfiles.items():
            p=tmp/(name+".mjs");p.write_text(src)
            run(NODE,"--check",str(p))
        node_test_router(tmp/"router.mjs")
        print("SELECTIVE30_OFFLINE_PATCH_TESTS_PASSED=true")
        stamp=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backups=pathlib.Path("/var/lib/zl-prediction/archive/source-backups")/("selective30-"+stamp)
        backups.mkdir(parents=True, exist_ok=False)
        for name,p in FILES.items():
            shutil.copy2(p,backups/(name+".mjs"))
        print("SELECTIVE30_BACKUP_READY=true")
        installed=[]
        try:
            for name,p in FILES.items():
                stat=p.stat()
                staged=p.with_name(p.name+".selective30.tmp")
                staged.write_text(newfiles[name])
                os.chown(staged,stat.st_uid,stat.st_gid)
                os.chmod(staged,stat.st_mode & 0o777)
                os.replace(staged,p)
                installed.append(name)
            run("systemctl","restart","zl-prediction-v2.service")
            run("systemctl","restart","zl-prediction-trade.service")
            ready=False
            for _ in range(35):
                try:
                    v=get(13002,"/api/round-stats")
                    chosen=get(13001,"/api/order-signal-model")
                    directions=get(13001,"/api/direction-mode")
                    sources=[x.get("source") for x in v.get("activeSignalModels",[])]
                    if (v.get("ok") is True and sources==SOURCES and
                        chosen.get("ready") is True and chosen.get("model")==NEW and
                        directions.get("modes")==previous_direction):
                        ready=True;break
                except Exception:pass
                time.sleep(2)
            if not ready:raise RuntimeError("LIVE_TWO_SOURCE_OR_DIRECTION_PROBE_FAILED")
            for service in ["zl-prediction-v3","zl-prediction-redis","zl-futures-bot-paper"]:
                if subprocess.check_output(["systemctl","is-active",service],text=True).strip()!="active":
                    raise RuntimeError("ISOLATED_SERVICE_CHANGED:"+service)
            print("SELECTIVE30_DEPLOYED=true")
            print("SELECTIVE30_ACTIVE_SOURCES="+",".join(sources))
            print("SELECTIVE30_ORDER_MODEL="+chosen.get("model",""))
            print("SELECTIVE30_DIRECTION_SETTINGS_PRESERVED=true")
            print("SELECTIVE30_HISTORICAL_ROUNDS_PRESERVED=true")
            print("SELECTIVE30_FUTURES_UNCHANGED=true")
        except Exception:
            for name in installed:
                shutil.copy2(backups/(name+".mjs"),FILES[name])
            subprocess.run(["systemctl","restart","zl-prediction-v2.service"],timeout=90)
            subprocess.run(["systemctl","restart","zl-prediction-trade.service"],timeout=90)
            print("SELECTIVE30_AUTOMATIC_ROLLBACK_COMPLETED=true",flush=True)
            raise

if __name__=="__main__":
    try:main()
    except Exception as exc:
        print("SELECTIVE30_FAILED",type(exc).__name__,str(exc)[:250],flush=True)
        sys.exit(1)

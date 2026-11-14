#!/usr/bin/env python3
"""Guarded EVENT10-only V30 verified-trend-resumption frequency restoration signal-only deployment on existing Aliyun host.
Does NOT touch five-minute bots, futures bots, Caddy, credentials or live orders.
"""
import base64
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone

ROOT=pathlib.Path("/opt/zl-event10")
UNIT="zl-event10-deepseek"
NODE="/opt/zl-prediction-node/bin/node"
# Persistent last-in-order systemd EnvironmentFile override. Never touch the API key file.
MODEL_ENV=pathlib.Path("/etc/zl-event10/ai-model-flash.env")
MODEL_DROPIN=pathlib.Path("/etc/systemd/system/zl-event10-deepseek.service.d/99-zl-ai-flash.conf")
LEGACY_VERSIONS={"EVENT10_LONG_REGIME_REQUALIFY_V29_20261114","EVENT10_CONFLICT_EDGE_REENTRY_V28_20261113","EVENT10_EMA_DECAY_REENTRY_V27_20261113","EVENT10_EMA_921_ENTRY_V26_20261113","EVENT10_MULTI_HORIZON_ENTRY_V25_20261113","EVENT10_PRICE_ACTION_V24_20261113","EVENT10_REVERSAL_AWARE_10M_V23_20261113","EVENT10_MULTI_TF_SUPERTREND_V22_20261112","EVENT10_LIVE_INDEX_3_PER_10M_V21_20261112","EVENT10_ENTRY_POSITION_V20_20261111","EVENT10_PURE_RULE_V19_20261107","EVENT10_AI_REQUIRED_LEARNING_V18_20261106","EVENT10_AI_FEEDBACK_V17_20261106","EVENT10_EMA5_DIRECTION_V16_20261106","EVENT10_PACED_MOMENTUM_V15_20261106","EVENT10_FAST_MOMENTUM_V14_20261105","EVENT10_QUALITY_FILTER_V13_20261105","EVENT10_DUAL_EMA_FREQUENCY_V12_20261105","EVENT10_TIERED_V11_20261105","EVENT10_FREQUENCY_V10_20261104","EVENT10_TARGETED_MOMENTUM_V9_20261104","EVENT10_BALANCED_SIGNAL_V8_20261103","EVENT10_REVERSAL_GUARD_V7_20261103","EVENT10_FRESH_NONOVERLAP_V6_20261103","EVENT10_TREND_CONFIRMED_V5_20261103","EVENT10_HYBRID_3PH_V4_FRESH_20261102","EVENT10_HYBRID_3PH_V4_20261102","EVENT10_FREQ_2M_TREND_V3_20261102","EVENT10_BALANCED_TREND_5M_V2_20261102","EVENT10_SELECTIVE_TREND_V1_20261102","EVENT10_FORCED_CONTRARIAN_12M_V1_20261101","EVENT10_SIGNAL_TPLUS10_INDEX_V3_20261031","EVENT10_LATE_INDEX_LEAD_RETRACE_V2_20261030","EVENT10_PURE_EMA_VOLUME_DEPTH_RSI_V1_20261029","EVENT10_HIGH_SELECTIVITY_6GATES_V1_20261031","EVENT10_FREQ_OPTIMIZED_6GATES_V2_20261101","EVENT10_FREQ_OPTIMIZED_LIVE_6GATES_V3_20261101"}
TARGET="EVENT10_VERIFIED_RESUMPTION_V30_20261114"
URL="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/"
FILES=("pure-signal.mjs","multi-timeframe-trend.mjs","pure-signal-v19.mjs","manual-engine.mjs","v7-reversal-review.mjs","panel.html","v23-reversal-quality.test.mjs","v7-reversal-review.test.mjs","readonly-candles.mjs","server.mjs","alert-watch.test.mjs")
OTHER_UNITS=("zl-prediction-trade","zl-prediction-v2","zl-prediction-v3","zl-prediction-guardian-analysis","zl-prediction-fast5","zl-prediction-fast5-stats","zl-prediction-risk-exits","zl-prediction-redis","zl-prediction-official-reference","zl-prediction-ui-visibility","zl-futures-bot-paper","zl-event10-trade-stream","caddy")

def cmd(*args, timeout=75):
    return subprocess.run(args,check=True,capture_output=True,text=True,timeout=timeout).stdout.strip()

def fetch_local(p):
    with urllib.request.urlopen("http://127.0.0.1:13020"+p,timeout=5) as r:
        return r.read(2500000)

def status():
    return json.loads(fetch_local("/api/status"))

def pid(unit):
    return cmd("systemctl","show","-p","MainPID","--value",unit)

def validate_state(s,version):
    active=s.get("active")
    if active:
        expiry=active.get("expiresAt")
        # The new engine explicitly settles old V3 index-proxy sessions.
        # Keep the active session; never cut over near its 600s deadline.
        if (active.get("decisionReviewVersion") not in (LEGACY_VERSIONS | {TARGET}) or
            not isinstance(expiry,(int,float)) or
            expiry-time.time()*1000 < 25000):
            return False
    return (s.get("configured") is True and
        s.get("decisionReviewVersion")==version and
        s.get("autoTradingEnabled") is False and
        s.get("executionAvailable") is False and
        s.get("busyStart") is False and s.get("busySettle") is False)

def atomic_install(target,data):
    old=target.stat()
    fd,tmp=tempfile.mkstemp(prefix=".event10-hs-",dir=str(ROOT))
    try:
        with os.fdopen(fd,"wb") as f:f.write(data)
        os.chmod(tmp,old.st_mode & 0o777)
        os.chown(tmp,old.st_uid,old.st_gid)
        os.replace(tmp,target)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def main():
    if os.geteuid()!=0 or len(sys.argv)!=2 or len(sys.argv[1])!=40 or \
       any(c not in "0123456789abcdef" for c in sys.argv[1]):
        raise RuntimeError("ROOT_AND_PINNED_COMMIT_SHA_REQUIRED")
    sha=sys.argv[1]
    if not ROOT.is_dir() or not pathlib.Path(NODE).is_file():
        raise RuntimeError("EVENT10_EXISTING_INSTALL_MISSING")
    if cmd("systemctl","is-active",UNIT)!="active":
        raise RuntimeError("EVENT10_SERVICE_NOT_ACTIVE")
    if not all((ROOT/f).is_file() for f in ("server.mjs","manual-engine.mjs","pure-signal.mjs","panel.html")):
        raise RuntimeError("EVENT10_REQUIRED_LIVE_FILES_MISSING")
    before=status()
    if not any(validate_state(before,version) for version in (LEGACY_VERSIONS | {TARGET})):
        raise RuntimeError("EVENT10_LIVE_VERSION_UNEXPECTED_OR_ACTIVE_SIGNAL_ABORT")
    history=json.loads(fetch_local("/api/history"))
    if not history.get("ok") or not isinstance(history.get("records"),list):
        raise RuntimeError("EVENT10_HISTORY_UNREADABLE")
    old_count=(sum(1 for h in history["records"] if
                  (h.get("strategyVersion") or h.get("decisionReviewVersion"))==TARGET)
               if before.get("decisionReviewVersion")==TARGET else 0)
    other_pids={u:pid(u) for u in OTHER_UNITS}
    # Intentionally stopped unrelated services are valid; do not start them.
    # Their exact pre-deploy states are compared again after deployment.
    print("EVENT10_HS_OTHER_SERVICE_SNAPSHOT_RECORDED=true",flush=True)
    with tempfile.TemporaryDirectory(prefix="event10-hs-stage-") as staging:
        folder=pathlib.Path(staging)
        # Bring unchanged dependencies into staging, never overwrite them live.
        for name in ("server.mjs","market-enrichment.mjs","price-structure.mjs",
                     "chinese-display.mjs"):
            shutil.copy2(ROOT/name,folder/name)
        data={}
        for name in FILES:
            with urllib.request.urlopen(URL+sha+"/event10-bot/"+name,timeout=35) as r:
                data[name]=r.read()
            (folder/name).write_bytes(data[name])
        if TARGET not in data["pure-signal.mjs"].decode() or \
           TARGET not in data["panel.html"].decode():
            raise RuntimeError("PINNED_ARTIFACT_VERSION_MISMATCH")
        for name in ("server.mjs","manual-engine.mjs","pure-signal.mjs","multi-timeframe-trend.mjs","readonly-candles.mjs"):
            cmd(NODE,"--check",str(folder/name))
        cmd(NODE,"--test",str(folder/"v23-reversal-quality.test.mjs"),str(folder/"alert-watch.test.mjs"),timeout=110)
        print("EVENT10_HS_TESTS_PASSED=true",flush=True)
        if not validate_state(status(),before.get("decisionReviewVersion")):
            raise RuntimeError("EVENT10_PREDEPLOY_STATE_CHANGED")
        backup=pathlib.Path("/var/lib/zl-event10")/(
            "late-index-backup-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
        backup.mkdir(parents=True,exist_ok=False)
        existing_files=[name for name in FILES if (ROOT/name).is_file()]
        for name in existing_files:shutil.copy2(ROOT/name,backup/name)
        changed=[]
        # Rollback both code AND the isolated model override on any failed cutover.
        override_backups={}
        for name in (MODEL_ENV,MODEL_DROPIN):
            override_backups[name]=(name.read_bytes(),name.stat().st_mode & 0o777) if name.exists() else None
        try:
            for name in FILES:
                if (ROOT/name).is_file():
                    atomic_install(ROOT/name,data[name])
                else:
                    # New imported modules must inherit the readable owner/group
                    # and permission bits of existing JavaScript modules.
                    # A root-owned 0640 file is unreadable by the service user.
                    template=(ROOT/"pure-signal.mjs").stat()
                    (ROOT/name).write_bytes(data[name])
                    os.chown(ROOT/name,template.st_uid,template.st_gid)
                    os.chmod(ROOT/name,template.st_mode & 0o777)
                changed.append(name)
            # Do not edit existing model credentials, environment, or other
            # robot services. V19 imports no AI module and calls no LLM API.
            cmd("systemctl","restart",UNIT,timeout=45)
            ready=False
            for _ in range(20):
                time.sleep(1)
                try:
                    snap=status()
                    if snap.get("decisionReviewVersion")==TARGET and \
                       snap.get("aiReviewConfigured") is False and \
                       snap.get("aiMandatory") is False and \
                       snap.get("providerModel")=="PURE_SIGNAL_V30_VERIFIED_RESUMPTION" and \
                       snap.get("aiReviewModel") is None and \
                       snap.get("thinkingMode")=="disabled" and \
                       snap.get("modelCalls")==0 and \
                       snap.get("maxSignalsPerTenMinutes")==3 and \
                       snap.get("minDuplicateSameDirectionMs")==120000 and \
                       snap.get("requiresNewCompleted2mBarForRepeat") is True and \
                       snap.get("multiTimeframeIntervals")==["1m","2m","5m","10m","15m","30m"] and \
                       snap.get("autoIntervalMs")==12000 and \
                       snap.get("autoTradingEnabled") is False and \
                       snap.get("executionAvailable") is False:
                        ready=True
                        break
                except Exception:
                    pass
            if not ready:raise RuntimeError("EVENT10_NEW_VERSION_NOT_SERVING")
            live_pid=pid(UNIT)
            if not live_pid.isdecimal() or int(live_pid)<=0:
                raise RuntimeError("EVENT10_FLASH_PID_NOT_RUNNING")
            print("EVENT10_PURE_RULE_RUNTIME_NO_AI=true",flush=True)
            # Guarded hot cutover preserves existing active legacy signal IDs
            # and leaves their own T+600 proxy settlement with the new engine.
            if before.get("active") and before.get("decisionReviewVersion")==TARGET:
                prior=before["active"]
                resumed=status().get("active")
                if not resumed or resumed.get("id")!=prior.get("id") or \
                   resumed.get("expiresAt")!=prior.get("expiresAt"):
                    raise RuntimeError("PREEXISTING_ACTIVE_SIGNAL_NOT_PRESERVED")
            # Historical V4 pending sessions remain on disk for their own T+600 settlement,
            # but are no longer surfaced in the fresh version history or stats.
            after=json.loads(fetch_local("/api/history"))
            if not after.get("ok") or len(after.get("records",[]))<old_count:
                raise RuntimeError("EVENT10_HISTORY_COUNT_DECREASED")
            if other_pids!={u:pid(u) for u in OTHER_UNITS}:
                raise RuntimeError("NON_EVENT10_SERVICE_RESTARTED")
            print("EVENT10_HS_DEPLOY_SUCCEEDED=true",flush=True)
            print("EVENT10_HS_STRATEGY_VERSION="+TARGET,flush=True)
            print("EVENT10_HS_AI_KEY_CONFIGURED="+str(status().get("aiReviewConfigured")),flush=True)
            print("EVENT10_HS_MODEL_CALLS="+str(status().get("modelCalls")),flush=True)
            print("EVENT10_HS_RULE_ONLY=true",flush=True)
            # Verify both new alert-only read APIs on loopback after restart.
            watch=json.loads(fetch_local("/api/watch"))
            alert_health=json.loads(fetch_local("/api/alert-health"))
            if watch.get("ok") is not True or watch.get("version")!=TARGET or \
               alert_health.get("ok") is not True:
                raise RuntimeError("EVENT10_ALERT_ENDPOINTS_UNAVAILABLE")
            print("EVENT10_HS_ALERT_WATCH_OK=true",flush=True)
            print("EVENT10_HS_ALERT_RECEIPTS_OK=true",flush=True)

            print("EVENT10_HS_AI_MODEL="+str(status().get("aiReviewModel")),flush=True)
            print("EVENT10_HS_AI_REQUIRED="+str(status().get("aiMandatory")),flush=True)
            print("EVENT10_HS_AI_THINKING_MODE="+str(status().get("thinkingMode")),flush=True)
            print("EVENT10_HS_AI_REASONING_EFFORT="+str(status().get("reasoningEffort")),flush=True)
            print("EVENT10_HS_HISTORY_PRESERVED="+str(len(after["records"])),flush=True)
            print("EVENT10_HS_NO_REAL_ORDER_API=true",flush=True)
            print("EVENT10_HS_V30_DUPLICATE_POLICY=NEW_2M_BAR_AND_120S",flush=True)
            print("EVENT10_HS_OTHER_SERVICE_PIDS_UNCHANGED=true",flush=True)
            print("EVENT10_HS_BACKUP="+str(backup),flush=True)
            try:
                probe=json.loads(fetch_local("/api/data-health"))
                av=probe.get("availability") or {}
                for name in ("indexQuote","indexKlines","orderBook","aggressiveFlow"):
                    print("EVENT10_HS_"+name.upper()+"="+
                      ("AVAILABLE" if av.get(name,{}).get("available") else
                       str(av.get(name,{}).get("error","UNAVAILABLE"))),flush=True)
            except Exception as e:
                print("EVENT10_HS_DATA_PROBE_UNVERIFIED="+type(e).__name__,flush=True)
        except BaseException:
            for target,snapshot in override_backups.items():
                if snapshot is None:
                    target.unlink(missing_ok=True)
                else:
                    contents,mode=snapshot
                    target.write_bytes(contents)
                    os.chmod(target,mode)
            subprocess.run(["systemctl","daemon-reload"],capture_output=True,timeout=45)
            for name in changed:
                if name in existing_files:
                    shutil.copy2(backup/name,ROOT/name)
                else:
                    (ROOT/name).unlink(missing_ok=True)
            subprocess.run(["systemctl","restart",UNIT],capture_output=True,timeout=50)
            print("EVENT10_HS_ROLLBACK_ATTEMPTED=true",flush=True)
            raise

if __name__=="__main__":
    try:main()
    except BaseException as e:
        print("EVENT10_HS_DEPLOY_FAILED="+type(e).__name__+":"+str(e)[:220],flush=True)
        sys.exit(1)

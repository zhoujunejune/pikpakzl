#!/usr/bin/env python3
"""Guarded EVENT10-only high-selectivity six-gate strategy deployment on existing Aliyun host.
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
LEGACY_VERSIONS={"EVENT10_SIGNAL_TPLUS10_INDEX_V3_20261031","EVENT10_LATE_INDEX_LEAD_RETRACE_V2_20261030","EVENT10_PURE_EMA_VOLUME_DEPTH_RSI_V1_20261029"}
TARGET="EVENT10_HIGH_SELECTIVITY_6GATES_V1_20261031"
URL="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/"
FILES=("pure-signal.mjs","manual-engine.mjs","panel.html","high-selectivity.test.mjs")
OTHER_UNITS=("zl-prediction-trade","zl-futures-bot-paper","zl-event10-trade-stream","caddy")

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
        if (active.get("decisionReviewVersion") not in LEGACY_VERSIONS or
            not isinstance(expiry,(int,float)) or
            expiry-time.time()*1000 < 180000):
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
    if not any(validate_state(before,version) for version in LEGACY_VERSIONS):
        raise RuntimeError("EVENT10_LIVE_VERSION_UNEXPECTED_OR_ACTIVE_SIGNAL_ABORT")
    history=json.loads(fetch_local("/api/history"))
    if not history.get("ok") or not isinstance(history.get("records"),list):
        raise RuntimeError("EVENT10_HISTORY_UNREADABLE")
    old_count=len(history["records"])
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
        for name in ("server.mjs","manual-engine.mjs","pure-signal.mjs"):
            cmd(NODE,"--check",str(folder/name))
        cmd(NODE,"--test",str(folder/"high-selectivity.test.mjs"),timeout=110)
        print("EVENT10_HS_TESTS_PASSED=true",flush=True)
        if not validate_state(status(),before.get("decisionReviewVersion")):
            raise RuntimeError("EVENT10_PREDEPLOY_STATE_CHANGED")
        backup=pathlib.Path("/var/lib/zl-event10")/(
            "late-index-backup-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
        backup.mkdir(parents=True,exist_ok=False)
        existing_files=[name for name in FILES if (ROOT/name).is_file()]
        for name in existing_files:shutil.copy2(ROOT/name,backup/name)
        changed=[]
        try:
            for name in FILES:
                if (ROOT/name).is_file():
                    atomic_install(ROOT/name,data[name])
                else:
                    (ROOT/name).write_bytes(data[name])
                    os.chmod(ROOT/name,0o640)
                changed.append(name)
            cmd("systemctl","restart",UNIT,timeout=45)
            ready=False
            for _ in range(20):
                time.sleep(1)
                try:
                    snap=status()
                    if snap.get("decisionReviewVersion")==TARGET and \
                       snap.get("providerModel")=="PURE_SIGNAL_SIX_GATES_V1" and \
                       snap.get("autoTradingEnabled") is False and \
                       snap.get("executionAvailable") is False:
                        ready=True
                        break
                except Exception:
                    pass
            if not ready:raise RuntimeError("EVENT10_NEW_VERSION_NOT_SERVING")
            # Guarded hot cutover preserves existing active legacy signal IDs
            # and leaves their own T+600 proxy settlement with the new engine.
            if before.get("active"):
                prior=before["active"]
                resumed=status().get("active")
                if not resumed or resumed.get("id")!=prior.get("id") or \
                   resumed.get("expiresAt")!=prior.get("expiresAt"):
                    raise RuntimeError("PREEXISTING_ACTIVE_SIGNAL_NOT_PRESERVED")
            after=json.loads(fetch_local("/api/history"))
            if not after.get("ok") or len(after.get("records",[]))<old_count:
                raise RuntimeError("EVENT10_HISTORY_COUNT_DECREASED")
            if other_pids!={u:pid(u) for u in OTHER_UNITS}:
                raise RuntimeError("NON_EVENT10_SERVICE_RESTARTED")
            print("EVENT10_HS_DEPLOY_SUCCEEDED=true",flush=True)
            print("EVENT10_HS_STRATEGY_VERSION="+TARGET,flush=True)
            print("EVENT10_HS_HISTORY_PRESERVED="+str(len(after["records"])),flush=True)
            print("EVENT10_HS_NO_REAL_ORDER_API=true",flush=True)
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

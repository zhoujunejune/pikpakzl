#!/usr/bin/env python3
"""EVENT10 UI and HTTP projection only; protect the live V6 analysis engine."""
import hashlib,json,os,pathlib,shutil,subprocess,sys,tempfile,time,urllib.request
from datetime import datetime,timezone

ROOT=pathlib.Path("/opt/zl-event10")
UNIT="zl-event10-deepseek"
EXPECTED={"panel.html":"43c8e5dd9caacf28","server.mjs":"cedd5b0b1b11fb04"}
MODEL_ENGINE_HASH="a302fbdc996492f7"
VERSION="EVENT10_AI_PRICE_STRUCTURE_V6_20261024"
REPO="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/"
NODE="/opt/zl-prediction-node/bin/node"
FILES=("panel.html","server.mjs")

def run(*args):
    return subprocess.run(args,check=True,capture_output=True,text=True,timeout=70).stdout.strip()
def fetch(uri):
    with urllib.request.urlopen("http://127.0.0.1:13020"+uri,timeout=8) as r:
        return r.read(2000000)
def state():
    return json.loads(fetch("/api/status"))
def digest(data):
    return hashlib.sha256(data).hexdigest()[:16]
def pid(unit):
    return run("systemctl","show","-p","MainPID","--value",unit)
def atomic_replace(target,data):
    info=target.stat()
    fd,name=tempfile.mkstemp(prefix=".event10-perf-",dir=str(target.parent))
    try:
        with os.fdopen(fd,"wb") as f:f.write(data)
        os.chmod(name,info.st_mode & 0o777)
        os.chown(name,info.st_uid,info.st_gid)
        os.replace(name,target)
    finally:
        if os.path.exists(name):os.unlink(name)
def safe(pre):
    return (pre.get("configured") is True and not pre.get("active") and
            pre.get("busyStart") is False and pre.get("busySettle") is False and
            pre.get("decisionReviewVersion")==VERSION and
            pre.get("autoTradingEnabled") is False and
            pre.get("executionAvailable") is False)
def verify(pre,count):
    now=state()
    if not safe(now) or now.get("providerModel")!=pre.get("providerModel"):
        raise RuntimeError("MODEL_OR_RUNTIME_STATE_CHANGED")
    page=fetch("/").decode("utf8")
    if not all(x in page for x in ('api/history-lite','setInterval(refreshHistory,30000)',
                    'id="quickConfidence"','AI主观置信度','lastDetailFingerprint')):
        raise RuntimeError("NEW_DISPLAY_MARKERS_MISSING")
    full=json.loads(fetch("/api/history"))
    lite=json.loads(fetch("/api/history-lite"))
    if not full.get("ok") or not lite.get("ok"):raise RuntimeError("HISTORY_API_UNAVAILABLE")
    if len(full["records"])!=len(lite["records"]) or len(full["records"])<count:
        raise RuntimeError("FULL_HISTORY_NOT_PRESERVED")
    if any("compactEvidence" in x or "enrichment" in x or "analysisArguments" in x
           for x in lite["records"]):raise RuntimeError("LITE_HISTORY_CONTAINS_HEAVY_EVIDENCE")
    if len(lite["records"]) and len(json.dumps(lite))>=len(json.dumps(full)):
        raise RuntimeError("COMPACT_HISTORY_NOT_SMALLER")
    if run("systemctl","is-active",UNIT)!="active":raise RuntimeError("EVENT10_INACTIVE")
    print("EVENT10_PERF_HISTORY_BYTES_BEFORE="+str(len(json.dumps(full).encode("utf8"))),flush=True)
    print("EVENT10_PERF_HISTORY_LITE_BYTES="+str(len(json.dumps(lite).encode("utf8"))),flush=True)
    print("EVENT10_PERF_HISTORY_RECORDS_PRESERVED="+str(len(full["records"])),flush=True)

def main():
    if os.geteuid()!=0 or len(sys.argv)!=2 or len(sys.argv[1])!=40 or any(c not in "0123456789abcdef" for c in sys.argv[1]):
        raise RuntimeError("ROOT_AND_PINNED_SHA_REQUIRED")
    sha=sys.argv[1]
    if any(digest((ROOT/name).read_bytes())!=expected for name,expected in EXPECTED.items()):
        raise RuntimeError("LIVE_DISPLAY_BASELINE_CHANGED_ABORT")
    if digest((ROOT/"manual-engine.mjs").read_bytes())!=MODEL_ENGINE_HASH:
        raise RuntimeError("LIVE_V6_ENGINE_BASELINE_CHANGED_ABORT")
    pre=state()
    if not safe(pre):raise RuntimeError("EVENT10_ACTIVE_OR_WRONG_MODEL_ABORT")
    full=json.loads(fetch("/api/history"))
    if not full.get("ok") or not isinstance(full.get("records"),list):raise RuntimeError("HISTORY_BASELINE_UNREADABLE")
    oldcount=len(full["records"])
    others=("zl-prediction-trade","zl-futures-bot-paper","zl-event10-trade-stream","caddy")
    other_pids={u:pid(u) for u in others}
    if any(p in ("0","") for p in other_pids.values()):raise RuntimeError("OTHER_SERVICES_NOT_READY")
    with tempfile.TemporaryDirectory(prefix="zl-event10-perf-stage-") as folder:
        new={}
        for name in FILES:
            with urllib.request.urlopen(REPO+sha+"/event10-bot/"+name,timeout=40) as r:
                new[name]=r.read()
            (pathlib.Path(folder)/name).write_bytes(new[name])
        run(NODE,"--check",str(pathlib.Path(folder)/"server.mjs"))
        html=new["panel.html"].decode("utf8")
        code=new["server.mjs"].decode("utf8")
        if not all(x in html for x in ("api/history-lite","setInterval(refreshHistory,30000)",
                "id=\"quickConfidence\"","lastDetailFingerprint")):
            raise RuntimeError("STAGED_UI_INVALID")
        if 'pathname==="/api/history-lite"' not in code or 'pathname==="/api/history"' not in code:
            raise RuntimeError("STAGED_API_INVALID")
        if not safe(state()):raise RuntimeError("EVENT10_STATE_CHANGED_BEFORE_DEPLOY")
        backup=pathlib.Path("/var/lib/zl-event10")/("perf-backup-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
        backup.mkdir(parents=True,exist_ok=False)
        for name in FILES:shutil.copy2(ROOT/name,backup/name)
        modified=False
        try:
            for name in FILES:atomic_replace(ROOT/name,new[name])
            modified=True
            # Only EVENT10 HTTP service: no market collector or other robot restart.
            run("systemctl","restart",UNIT)
            for _ in range(24):
                time.sleep(1)
                try:
                    verify(pre,oldcount)
                    break
                except Exception:
                    if _==23:raise
            if digest((ROOT/"manual-engine.mjs").read_bytes())!=MODEL_ENGINE_HASH:
                raise RuntimeError("V6_MODEL_FILE_CHANGED")
            if {u:pid(u) for u in others}!=other_pids:
                raise RuntimeError("NON_EVENT10_SERVICE_PID_CHANGED")
            print("EVENT10_PERF_DEPLOY_SUCCEEDED=true",flush=True)
            print("EVENT10_PERF_V6_ENGINE_UNCHANGED=true",flush=True)
            print("EVENT10_PERF_COLLECTOR_AND_OTHER_BOTS_UNCHANGED=true",flush=True)
            print("EVENT10_PERF_BACKUP="+str(backup),flush=True)
        except BaseException:
            if modified:
                for name in FILES:shutil.copy2(backup/name,ROOT/name)
                subprocess.run(["systemctl","restart",UNIT],timeout=70)
                print("EVENT10_PERF_ROLLBACK_ATTEMPTED=true",flush=True)
            raise

if __name__=="__main__":
    try:main()
    except Exception as exc:
        print("EVENT10_PERF_DEPLOY_FAILED="+type(exc).__name__+":"+str(exc)[:160],flush=True)
        sys.exit(1)

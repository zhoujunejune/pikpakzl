#!/usr/bin/env python3
"""EVENT10 V2 UI-only repair; do not alter rules, signal ledger or other bots."""
import hashlib,json,os,pathlib,re,shutil,subprocess,sys,tempfile,time,urllib.request
from datetime import datetime,timezone
ROOT=pathlib.Path("/opt/zl-event10")
UNIT="zl-event10-deepseek"
VERSION="EVENT10_LATE_INDEX_LEAD_RETRACE_V2_20261030"
NODE="/opt/zl-prediction-node/bin/node"
PANEL=ROOT/"panel.html"
OTHERS=("zl-prediction-trade","zl-futures-bot-paper","zl-event10-trade-stream","caddy")
def cmd(*args,timeout=45):
    return subprocess.run(args,check=True,capture_output=True,text=True,timeout=timeout).stdout.strip()
def local(path):
    with urllib.request.urlopen("http://127.0.0.1:13020"+path,timeout=6) as r:
        return r.read(2300000)
def state():return json.loads(local("/api/status"))
def pid(unit):return cmd("systemctl","show","-p","MainPID","--value",unit)
def checksum(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    if os.geteuid()!=0 or len(sys.argv)!=2 or not re.fullmatch(r"[0-9a-f]{40}",sys.argv[1]):
        raise RuntimeError("ROOT_AND_PINNED_COMMIT_REQUIRED")
    if not PANEL.is_file() or not (ROOT/"server.mjs").is_file() or not (ROOT/"manual-engine.mjs").is_file():
        raise RuntimeError("EXISTING_EVENT10_SERVICE_FILES_MISSING")
    if cmd("systemctl","is-active",UNIT)!="active":raise RuntimeError("EVENT10_NOT_ACTIVE")
    before=state()
    if before.get("decisionReviewVersion")!=VERSION or before.get("providerModel")!="PURE_LATE_INDEX_REFERENCE_V2":
        raise RuntimeError("EVENT10_V2_NOT_CURRENT_ABORT")
    if before.get("active") or before.get("busyStart") or before.get("busySettle"):
        raise RuntimeError("EVENT10_BUSY_OR_SIGNAL_ACTIVE_ABORT")
    if before.get("autoTradingEnabled") is not False or before.get("executionAvailable") is not False:
        raise RuntimeError("EVENT10_ORDER_DISABLED_INVARIANT_FAILED")
    oldhist=json.loads(local("/api/history"))
    if not oldhist.get("ok") or not isinstance(oldhist.get("records"),list):
        raise RuntimeError("EVENT10_HISTORY_UNREADABLE")
    oldcount=len(oldhist["records"])
    main_hash=checksum(ROOT/"manual-engine.mjs")
    signal_hash=checksum(ROOT/"pure-signal.mjs")
    server_hash=checksum(ROOT/"server.mjs")
    other_pids={u:pid(u) for u in OTHERS}
    url="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/"+sys.argv[1]+"/event10-bot/panel.html"
    with urllib.request.urlopen(url,timeout=35) as r:new_panel=r.read()
    content=new_panel.decode("utf8")
    required=("isCurrentStrategyRecord","EVENT10_LATE_INDEX_LEAD_RETRACE_V2_20261030",
              "旧版Higher/Lower保留在历史记录中","id=\"immediatePrediction\"")
    if not all(mark in content for mark in required):raise RuntimeError("NEW_PANEL_MISSING_VERSION_FILTER")
    match=re.search(r"<script>([\s\S]*?)</script>",content)
    if not match:raise RuntimeError("INLINE_SCRIPT_MISSING")
    with tempfile.TemporaryDirectory(prefix="event10-v2-ui-check-") as folder:
        p=pathlib.Path(folder)/"panel-check.js"
        p.write_text(match.group(1))
        cmd(NODE,"--check",str(p))
    if state().get("active") or state().get("busyStart") or state().get("busySettle"):
        raise RuntimeError("EVENT10_BECAME_ACTIVE_ABORT")
    backup=pathlib.Path("/var/lib/zl-event10")/(
        "v2-panel-backup-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    backup.mkdir(parents=True,exist_ok=False)
    shutil.copy2(PANEL,backup/"panel.html")
    replaced=False
    try:
        info=PANEL.stat()
        fd,tmp=tempfile.mkstemp(prefix=".event10-v2-panel-",dir=str(ROOT))
        with os.fdopen(fd,"wb") as f:f.write(new_panel)
        os.chmod(tmp,info.st_mode&0o777);os.chown(tmp,info.st_uid,info.st_gid)
        os.replace(tmp,PANEL)
        replaced=True
        cmd("systemctl","restart",UNIT,timeout=45)
        for attempt in range(20):
            time.sleep(1)
            try:
                after=state()
                page=local("/").decode("utf8")
                if (after.get("decisionReviewVersion")==VERSION and
                   after.get("autoTradingEnabled") is False and
                   after.get("executionAvailable") is False and
                   all(k in page for k in required)):
                    break
            except Exception:pass
        else:raise RuntimeError("EVENT10_NEW_PANEL_NOT_SERVING")
        if checksum(ROOT/"manual-engine.mjs")!=main_hash or checksum(ROOT/"pure-signal.mjs")!=signal_hash or checksum(ROOT/"server.mjs")!=server_hash:
            raise RuntimeError("EVENT10_RULE_OR_SERVER_CHANGED")
        if {u:pid(u) for u in OTHERS}!=other_pids:raise RuntimeError("OTHER_SERVICE_PID_CHANGED")
        newhist=json.loads(local("/api/history"))
        if not newhist.get("ok") or len(newhist.get("records",[]))<oldcount:
            raise RuntimeError("HISTORY_COUNT_DECREASED")
        print("EVENT10_V2_PANEL_FIX_SUCCEEDED=true",flush=True)
        print("EVENT10_V2_PANEL_LEGACY_FILTER_ACTIVE=true",flush=True)
        print("EVENT10_V2_RULE_AND_SERVER_HASHES_UNCHANGED=true",flush=True)
        print("EVENT10_V2_OTHER_BOTS_UNCHANGED=true",flush=True)
        print("EVENT10_V2_HISTORY_RECORDS="+str(len(newhist["records"])),flush=True)
        print("EVENT10_V2_BACKUP="+str(backup),flush=True)
    except BaseException:
        if replaced:
            shutil.copy2(backup/"panel.html",PANEL)
            subprocess.run(["systemctl","restart",UNIT],capture_output=True,timeout=50)
            print("EVENT10_V2_PANEL_ROLLBACK_ATTEMPTED=true",flush=True)
        raise
if __name__=="__main__":
    try:main()
    except BaseException as e:
        print("EVENT10_V2_PANEL_FIX_FAILED="+type(e).__name__+":"+str(e)[:180],flush=True)
        sys.exit(1)

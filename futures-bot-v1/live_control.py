"""Owner-controlled live order switch; OFF on first install and on every restart."""
import json
import os
from pathlib import Path
from threading import RLock

PATH=Path(os.environ.get("LIVE_CONTROL_FILE","/var/lib/zl-futures-bot/live-control.json"))
LOCK=RLock()

def read():
    with LOCK:
        if not PATH.exists():
            return {"enabled":False,"revision":0}
        value=json.loads(PATH.read_text(encoding="utf8"))
        if (not isinstance(value,dict) or type(value.get("enabled")) is not bool
                or type(value.get("revision")) is not int or value["revision"]<0):
            raise ValueError("Invalid live control ledger; live trading remains disabled")
        return value

def save_enabled(flag):
    if type(flag) is not bool:
        raise ValueError("Live switch requires explicit boolean")
    with LOCK:
        old=read()
        new={"enabled":flag,"revision":old["revision"]+1}
        PATH.parent.mkdir(parents=True,exist_ok=True)
        tmp=PATH.with_name(PATH.name+".tmp")
        with tmp.open("w",encoding="utf8") as f:
            json.dump(new,f)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp,0o600)
        os.replace(tmp,PATH)
        return new

def disarm_at_startup():
    # A service restart or deployment must never silently re-enable market orders.
    return save_enabled(False)

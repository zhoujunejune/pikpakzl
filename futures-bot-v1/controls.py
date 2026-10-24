"""Durable, strictly paper-only control settings (separate from trade journal).

The control file uses atomic replace to avoid racing with bot state writes.
Never exposes real-order toggles or secret management.
"""
import json
import os
import pathlib
import tempfile

CONTROL_FILE=pathlib.Path(os.getenv("CONTROL_FILE", "/var/lib/zl-futures-bot/control.json"))
DEFAULT={"entry_enabled":True,"emergency_stop":False,"leverage":10,
         "risk_fraction":0.015,"max_margin_fraction":0.15}
def validate(item):
    if not isinstance(item,dict):raise ValueError("control must be object")
    if set(item)!=set(DEFAULT):raise ValueError("invalid control keys")
    if not isinstance(item["entry_enabled"],bool) or not isinstance(item["emergency_stop"],bool):
        raise ValueError("invalid switches")
    if not isinstance(item["leverage"],int) or isinstance(item["leverage"],bool) or item["leverage"] not in (1,2,3,5,10,15,20):
        raise ValueError("invalid leverage")
    if not isinstance(item["risk_fraction"],(int,float)) or isinstance(item["risk_fraction"],bool) or not .001<=item["risk_fraction"]<=.02:
        raise ValueError("invalid risk fraction")
    if not isinstance(item["max_margin_fraction"],(int,float)) or isinstance(item["max_margin_fraction"],bool) or not .02<=item["max_margin_fraction"]<=.20:
        raise ValueError("invalid margin fraction")
    return item
def read_control():
    try:
        return validate(json.loads(CONTROL_FILE.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return dict(DEFAULT)
    # Deliberately do not replace corrupt config with defaults: callers must halt.
def save_control(c):
    validate(c)
    CONTROL_FILE.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(prefix=".control-",dir=str(CONTROL_FILE.parent))
    try:
        with os.fdopen(fd,"w",encoding="utf-8") as f:
            json.dump(c,f,separators=(",",":"))
            f.flush()
            os.fsync(f.fileno())
        os.chmod(name,0o600)
        os.replace(name,CONTROL_FILE)
    finally:
        try:os.unlink(name)
        except FileNotFoundError:pass
def change(action,payload=None):
    if action not in ("pause","resume","emergency_stop","set_params"):
        raise ValueError("unknown action")
    current=read_control()
    if action=="pause":
        current["entry_enabled"]=False
    elif action=="resume":
        if current["emergency_stop"]:
            raise ValueError("Emergency stop is latched; service operator must review and clear it")
        current["entry_enabled"]=True
    elif action=="emergency_stop":
        current["emergency_stop"]=True
        current["entry_enabled"]=False
    else:
        if not isinstance(payload,dict) or set(payload)!={"leverage","risk_fraction","max_margin_fraction"}:
            raise ValueError("only leverage, risk_fraction and max_margin_fraction may be edited")
        if current["emergency_stop"]:raise ValueError("emergency stop is latched")
        current.update(payload)
    save_control(current)
    return current

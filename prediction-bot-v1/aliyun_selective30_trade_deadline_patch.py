#!/usr/bin/env python3
"""Production-only repair: qualified Selective V2/Edge 30s trading cutoff.

No simulated orders, no exchange POST, no changes to model probabilities,
direction policies, historical rounds, Redis, Binance API keys or futures bot.
The GitHub workflow captures/restores the user's exact control state.
"""
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

MODEL="SELECTIVE_V2_30S_CURRENT_ROUND_V2"
ROOT=pathlib.Path("/opt/zl-prediction-live/src/railway-diagnostic")
WRAPPER=ROOT/"wrapper.mjs"
CHOICE=ROOT/"production-signal-choice.mjs"
NODE="/opt/zl-prediction-node/bin/node"
SERVICES=("zl-prediction-trade","zl-prediction-v2","zl-prediction-v3",
          "zl-prediction-redis","zl-futures-bot-paper")

def exactly(s,old,new,label):
    hits=s.count(old)
    if hits!=1:
        raise RuntimeError("DEADLINE_PATCH_CONTEXT_MISMATCH:"+label+":"+str(hits))
    return s.replace(old,new,1)

def change(s):
    s=exactly(s,
        "const ORDER_SUBMIT_DEADLINE_MS = 15000; // BASELINE/NOVICE remain unchanged.",
        "const ORDER_SUBMIT_DEADLINE_MS = 15000; // BASELINE/NOVICE remain unchanged.\n"
        "const SELECTIVE30_ORDER_DEADLINE_MS = 30000; // New qualified Selective V2 + Edge 30-second policy only.",
        "deadline-def")
    s=exactly(s,
        """function orderSubmitWindowOpen(round, now = Date.now(), model = null) {
  const start = Number(round);
  const cutoff = model === DYNAMIC_MODEL ? DYNAMIC_ORDER_DEADLINE_MS :
    model === EDGE_MODEL ? EDGE_ORDER_DEADLINE_MS : ORDER_SUBMIT_DEADLINE_MS;
  return Number.isSafeInteger(start) && start > 0 && now >= start && now < start + cutoff;
}""",
        """function orderSubmitDeadlineForModel(model) {
  return model === SELECTIVE8_MODEL ? SELECTIVE30_ORDER_DEADLINE_MS :
    model === DYNAMIC_MODEL ? DYNAMIC_ORDER_DEADLINE_MS :
    model === EDGE_MODEL ? EDGE_ORDER_DEADLINE_MS : ORDER_SUBMIT_DEADLINE_MS;
}
function orderSubmitWindowOpen(round, now = Date.now(), model = null) {
  const start = Number(round);
  const cutoff = orderSubmitDeadlineForModel(model);
  return Number.isSafeInteger(start) && start > 0 && now >= start && now < start + cutoff;
}""",
        "window-selector")
    s=exactly(s,
        """  p.error = p?.signalModelChoice===DYNAMIC_MODEL
    ? '动态模型本轮交易窗口已截止，未发送下单请求'
    : p?.signalModelChoice===EDGE_MODEL ? 'EDGE模型前8秒入场窗口已截止，未发送下单请求'
    : '本轮第15秒订单提交窗口已截止，未发送下单请求';""",
        """  p.error = p?.signalModelChoice===SELECTIVE8_MODEL
    ? '30秒策略本轮第30秒订单提交窗口已截止，未发送下单请求'
    : p?.signalModelChoice===DYNAMIC_MODEL ? '动态模型本轮交易窗口已截止，未发送下单请求'
    : p?.signalModelChoice===EDGE_MODEL ? 'EDGE模型前8秒入场窗口已截止，未发送下单请求'
    : '本轮第15秒订单提交窗口已截止，未发送下单请求';""",
        "error-label")
    s=exactly(s,
        """    round:p.round, elapsedMs, deadlineMs:p?.signalModelChoice===DYNAMIC_MODEL
      ?DYNAMIC_ORDER_DEADLINE_MS:p?.signalModelChoice===EDGE_MODEL
        ?EDGE_ORDER_DEADLINE_MS:ORDER_SUBMIT_DEADLINE_MS, stage }));""",
        """    round:p.round, elapsedMs, deadlineMs:orderSubmitDeadlineForModel(p?.signalModelChoice), stage }));""",
        "deadline-log")
    return s

def call(cmd):
    subprocess.run(cmd,check=True,timeout=75,stdout=subprocess.DEVNULL)

def read(path,port=13001):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}",timeout=12) as r:
        return json.loads(r.read(3000000))

def ready():
    return all(subprocess.check_output(["systemctl","is-active",x],text=True).strip()=="active" for x in SERVICES)

def main():
    if os.geteuid()!=0:raise RuntimeError("ROOT_REQUIRED")
    if not ready():raise RuntimeError("DEPENDENT_SERVICE_NOT_ACTIVE")
    if MODEL not in CHOICE.read_text():raise RuntimeError("ACTIVE_CHOICE_SOURCE_NOT_30S")
    choice=read("/api/order-signal-model")
    if not choice.get("ready") or choice.get("model")!=MODEL:
        raise RuntimeError("SELECTIVE30_NOT_CURRENTLY_SELECTED")
    data=read("/api/status")
    if data.get("orderSignalModel")!=MODEL:
        raise RuntimeError("STATUS_MODEL_NOT_CURRENTLY_SELECTED")
    # No restart during an in-flight irreversible money transfer.
    for _ in range(15):
        if (data.get("pendingAction") or {}).get("state") not in ("QUOTING","SUBMITTING",
                         "SUBMITTED_PENDING_CONFIRMATION","SUBMISSION_UNKNOWN"):
            break
        time.sleep(1)
        data=read("/api/status")
    else:
        raise RuntimeError("ACTIVE_OR_AMBIGUOUS_ORDER_IN_PROGRESS_NO_RESTART")
    original=WRAPPER.read_text()
    if "SELECTIVE30_ORDER_DEADLINE_MS = 30000" in original:
        if "model === SELECTIVE8_MODEL ? SELECTIVE30_ORDER_DEADLINE_MS" in original:
            print("SELECTIVE30_TRADE_DEADLINE_ALREADY_30S=true")
            return
        raise RuntimeError("PARTIAL_SELECTIVE30_WINDOW_PATCH")
    edited=change(original)
    if "const ORDER_SUBMIT_DEADLINE_MS = 15000" not in edited:
        raise RuntimeError("OTHER_MODEL_DEADLINE_CHANGED")
    if edited.count("orderSubmitWindowOpen(") < 4:
        raise RuntimeError("ORDER_SUBMIT_WINDOW_GUARDS_MISSING")
    if edited.count("rejectExpiredOrderWindow(") < 3:
        raise RuntimeError("PLACE_ORDER_GUARDS_MISSING")
    if "SELECTIVE30_ORDER_DEADLINE_MS = 30000" not in edited:
        raise RuntimeError("SELECTIVE_DEADLINE_NOT_CHANGED")
    with tempfile.TemporaryDirectory(prefix="zl-order30-") as tmpdir:
        candidate=pathlib.Path(tmpdir)/"wrapper.mjs"
        candidate.write_text(edited)
        # Syntax check only, deliberately no simulated exchange order or trade.
        call([NODE,"--check",str(candidate)])
    stamp=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup=pathlib.Path("/var/lib/zl-prediction/archive/source-backups")/("selective30-trade-"+stamp)
    backup.mkdir(parents=True,exist_ok=False)
    shutil.copy2(WRAPPER,backup/"wrapper.mjs")
    st=WRAPPER.stat()
    staged=WRAPPER.with_name("wrapper.mjs.order30.tmp")
    try:
        staged.write_text(edited)
        os.chown(staged,st.st_uid,st.st_gid)
        os.chmod(staged,st.st_mode & 0o777)
        os.replace(staged,WRAPPER)
        call(["systemctl","restart","zl-prediction-trade.service"])
        good=False
        for _ in range(35):
            try:
                health=read("/healthz")
                selected=read("/api/order-signal-model")
                if (ready() and health.get("ok") is True and
                    selected.get("ready") is True and selected.get("model")==MODEL and
                    health.get("autoConfirmEnabled") is True and
                    health.get("orderSignalModel")==MODEL):
                    good=True
                    break
            except Exception:
                pass
            time.sleep(2)
        if not good:raise RuntimeError("POST_RESTART_TRADE_HEALTH_FAILED")
        if WRAPPER.read_text()!=edited:raise RuntimeError("DEPLOYED_CODE_MISMATCH")
        print("SELECTIVE30_TRADE_DEADLINE_30000MS_DEPLOYED=true")
        print("SELECTIVE30_TRADE_STOP_AT_T30_STRICT=true")
        print("SELECTIVE30_OTHER_MODEL_DEADLINES_UNCHANGED=true")
        print("SELECTIVE30_SIGNAL_MODEL_UNCHANGED="+MODEL)
        print("SELECTIVE30_AUTOCONFIRM_CONFIGURED=true")
        print("SELECTIVE30_FUTURES_AND_PREDICTION_SOURCES_UNCHANGED=true")
        print("SELECTIVE30_NO_SIMULATED_ORDERS=true")
        print("SELECTIVE30_FOLLOW_SWITCH_REQUIRES_RESTORE_AFTER_SERVICE_RESTART=true")
    except BaseException:
        shutil.copy2(backup/"wrapper.mjs",WRAPPER)
        subprocess.run(["systemctl","restart","zl-prediction-trade.service"],timeout=75)
        print("SELECTIVE30_TRADE_AUTOMATIC_ROLLBACK_ATTEMPTED=true")
        raise

if __name__=="__main__":
    try:
        main()
    except Exception as ex:
        print("SELECTIVE30_TRADE_DEPLOY_FAILED",type(ex).__name__,str(ex)[:230])
        sys.exit(1)

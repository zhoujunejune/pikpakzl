#!/usr/bin/env python3
"""Presentation-only FAST5 repair: remove stale DeepSeek card and proxy local GET state.
No order, model, mode, amount, TP/SL, ledger or external service changes.
"""
import json,os,pathlib,re,shutil,subprocess,sys,tempfile,time,urllib.request
from datetime import datetime,timezone

MODEL="FAST5_SPOT_MOMENTUM_V1"
ROOT=pathlib.Path("/opt/zl-prediction-live/src/railway-diagnostic")
PANEL=ROOT/"panel-stats-shell.mjs"
CARD=ROOT/"fast5-dashboard-inject.mjs"
NODE="/opt/zl-prediction-node/bin/node"

def get(port,path):
 with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}",timeout=7) as r:return json.load(r)
def run(*args):
 subprocess.run(args,check=True,timeout=80,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
def atomic(path,content,reference=None):
 ref=reference or path
 st=ref.stat()
 fd,tmp=tempfile.mkstemp(prefix=".fast5-ui-",dir=str(path.parent))
 try:
  with os.fdopen(fd,"wb") as f:f.write(content)
  os.chmod(tmp,st.st_mode&0o777)
  os.chown(tmp,st.st_uid,st.st_gid)
  os.replace(tmp,path)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)

def patch_panel(src):
 # Preserve historical AI40 stats endpoint; update ONLY the presentation injector.
 import_pattern=r"^import \{([^}]+)\} from './ai40-dashboard-inject\.mjs';$"
 match=re.search(import_pattern,src,re.M)
 if not match:raise RuntimeError("EXPECTED_OLD_HTML_INJECT_IMPORT_MISSING")
 symbols=[s.strip() for s in match.group(1).split(",")]
 if set(symbols)!={"injectAi40Dashboard","statsFromFiles"}:
  raise RuntimeError("OLD_IMPORT_SYMBOLS_CHANGED")
 src=src[:match.start()]+(
  "import {statsFromFiles} from './ai40-dashboard-inject.mjs';\n"
  "import {injectFast5Dashboard} from './fast5-dashboard-inject.mjs';"
 )+src[match.end():]
 old="function injectStats(html) { return injectAi40Dashboard(html); }"
 if src.count(old)!=1:raise RuntimeError("HTML_INJECTION_DRIFT")
 src=src.replace(old,"function injectStats(html) { return injectFast5Dashboard(html); }")
 old="  if (req.method === 'GET' && url.pathname === '/api/ai40-round-stats') {"
 if src.count(old)!=1:raise RuntimeError("STATUS_ROUTE_ANCHOR_CHANGED")
 new="""  // Production FAST5 signal state only; this endpoint never changes trade settings.
  if (req.method === 'GET' && url.pathname === '/api/fast5-live-status') {
    void fetch('http://127.0.0.1:13046/api/status',
      {headers:{accept:'application/json'},signal:AbortSignal.timeout(1300)})
      .then(async response=>{
        if(!response.ok)throw Error('FAST5_HTTP_'+response.status);
        const data=await response.json();
        if(data?.ok!==true||data?.model!=='FAST5_SPOT_MOMENTUM_V1'||
           data?.readOnly!==true||data?.orders!==false||data?.requiresDeepSeek!==false)
          throw Error('FAST5_WRONG_PRODUCTION_SOURCE');
        res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        res.end(JSON.stringify(data));
      }).catch(error=>{
        if(res.headersSent)return;
        res.writeHead(503,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        res.end(JSON.stringify({ok:false,error:'FAST5_SIGNAL_SERVICE_UNAVAILABLE'}));
      });
    return;
  }
"""
 return src.replace(old,new+old,1)

def main():
 if os.geteuid()!=0:raise RuntimeError("AUTHORIZED_SERVICE_IDENTITY_REQUIRED")
 if len(sys.argv)!=2 or not re.fullmatch(r"[0-9a-f]{40}",sys.argv[1]):
  raise RuntimeError("INVALID_GITHUB_SHA")
 sha=sys.argv[1]
 if CARD.exists():raise RuntimeError("FAST5_UI_ALREADY_INSTALLED")
 for svc in ["zl-prediction-trade","zl-prediction-fast5","zl-prediction-v2","zl-prediction-v3","zl-futures-bot-paper"]:
  if subprocess.check_output(["systemctl","is-active",svc],text=True).strip()!="active":
   raise RuntimeError("SERVICE_NOT_ACTIVE_"+svc)
 trade=get(13001,"/api/status")
 selection=get(13001,"/api/order-signal-model")
 signal=get(13046,"/api/status")
 if trade.get("enabled") is not False:raise RuntimeError("AUTO_FOLLOW_ON_ABORT")
 if trade.get("orderSignalModel")!=MODEL or selection.get("model")!=MODEL:
  raise RuntimeError("FAST5_PRODUCTION_SELECTION_NOT_CONFIRMED")
 if signal.get("model")!=MODEL or signal.get("readOnly") is not True or signal.get("orders") is not False:
  raise RuntimeError("FAST5_SOURCE_NOT_READY")
 text=PANEL.read_text()
 if "fast5-live-status" in text:raise RuntimeError("FAST5_UI_ROUTE_ALREADY_INSTALLED")
 replacement=patch_panel(text)
 with tempfile.TemporaryDirectory(prefix="zl-fast5-ui-") as tmp:
  d=pathlib.Path(tmp)
  source_url="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/"+sha+"/prediction-bot-v1/fast5-dashboard-inject.mjs"
  with urllib.request.urlopen(source_url,timeout=30) as r:module=r.read()
  (d/"fast5-dashboard-inject.mjs").write_bytes(module)
  (d/"panel-stats-shell.mjs").write_text(replacement)
  for filename in ["fast5-dashboard-inject.mjs","panel-stats-shell.mjs"]:
   run(NODE,"--check",str(d/filename))
  assert "id=\"zlFast5Card\"" in module.decode()
  assert "id=\"zlDeepSeek40Card\"" not in module.decode()
  assert "/api/fast5-live-status" in module.decode()
  if get(13001,"/api/status").get("enabled") is not False:
   raise RuntimeError("AUTO_FOLLOW_CHANGED_ABORT")
  backup=pathlib.Path("/var/lib/zl-prediction/archive/source-backups")/("fast5-ui-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
  backup.mkdir(parents=True,exist_ok=False)
  shutil.copy2(PANEL,backup/PANEL.name)
  installed=False
  try:
   atomic(CARD,module,reference=PANEL)
   installed=True
   atomic(PANEL,replacement.encode())
   run("systemctl","restart","zl-prediction-trade.service")
   deadline=time.monotonic()+45
   ready=False
   while time.monotonic()<deadline:
    time.sleep(1.3)
    try:
     page=urllib.request.urlopen("http://127.0.0.1:13001/",timeout=6).read().decode("utf8","replace")
     state=get(13001,"/api/fast5-live-status")
     current=get(13001,"/api/status")
     if(page.count('id="zlFast5Card"')==1 and
        "id=\"zlDeepSeek40Card\"" not in page and
        "DeepSeek 40秒方案" not in page and
        "/api/fast5-live-status" in page and
        "id=\"riskControlsCard\"" in page and
        "id=\"tradeInputsCard\"" in page and
        state.get("ok") is True and state.get("model")==MODEL and
        state.get("readOnly") is True and
        current.get("enabled") is False and
        current.get("orderSignalModel")==MODEL):
      ready=True
      print("FAST5_UI_ACTIVE_MODEL",state.get("model"),flush=True)
      print("FAST5_UI_CURRENT_SIGNAL",json.dumps({
       "round":state.get("round"),
       "direction":(state.get("latest") or {}).get("direction"),
       "lockedAt":(state.get("latest") or {}).get("lockedAt"),
       "lastFetchAt":state.get("lastFetchAt"),
       "error":state.get("lastError"),
      }),flush=True)
      break
    except Exception:pass
   if not ready:raise RuntimeError("LIVE_FAST5_FRONTEND_OR_CONTROLS_NOT_VERIFIED")
   for svc in ["zl-prediction-trade","zl-prediction-fast5","zl-prediction-v2","zl-prediction-v3","zl-futures-bot-paper"]:
    if subprocess.check_output(["systemctl","is-active",svc],text=True).strip()!="active":
     raise RuntimeError("POST_UI_SERVICE_BAD_"+svc)
   print("FAST5_FRONTEND_OLD_DEEPSEEK_CARD_REMOVED=true",flush=True)
   print("FAST5_FRONTEND_LIVE_FAST5_SIGNAL_VISIBLE=true",flush=True)
   print("FAST5_TRADE_TP_SL_MODULES_UNMODIFIED=true",flush=True)
   print("FAST5_AUTO_FOLLOW_REMAINS_OFF=true",flush=True)
   print("FAST5_UI_BACKUP="+str(backup),flush=True)
  except BaseException:
   shutil.copy2(backup/PANEL.name,PANEL)
   if installed: CARD.unlink(missing_ok=True)
   subprocess.run(["systemctl","restart","zl-prediction-trade.service"],timeout=70)
   print("FAST5_UI_ROLLBACK_ATTEMPTED=true",flush=True)
   raise

if __name__=="__main__":
 try:main()
 except Exception as exc:
  print("FAST5_UI_REPAIR_FAILED",type(exc).__name__,str(exc)[:260],flush=True)
  sys.exit(1)

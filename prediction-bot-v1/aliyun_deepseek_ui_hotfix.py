#!/usr/bin/env python3
"""Safe narrow hotfix for stale Selective V2 stats on the live DeepSeek-only Alibaba panel.

Preserve unrelated server-local trading code. Patch only HTML labels, client-side
presentation and source gating from reviewed GitHub panel source; no API secret
or order-side setting changes. Dry-run before write; snapshot and rollback.
"""
import os,sys,subprocess,tempfile,pathlib,shutil,json,time,urllib.request
from datetime import datetime,timezone

LIVE=pathlib.Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
NODE='/opt/zl-prediction-node/bin/node'
SERVICE='zl-prediction-trade.service'

def exactly(s,needle,replacement,key):
 n=s.count(needle)
 if n!=1:raise ValueError('HOTFIX_CONTEXT_'+key+'_COUNT_'+str(n))
 return s.replace(needle,replacement,1)

def between(s,a,b,label):
 left=s.find(a);right=s.find(b,left+len(a)) if left>=0 else -1
 if left<0 or right<0:raise ValueError('HOTFIX_DONOR_MISSING_'+label)
 return s[left:right]

def patch(original,donor):
 if 'async function renderDeepSeekRoundStats()' in original:
  raise ValueError('DEEPSEEK_PANEL_ALREADY_PATCHED')
 changes=[
  ('<div class="k">每轮判断与真实结果</div>',
   '<div class="k">DeepSeek 每轮预测与官方结算 · 独立统计</div>','TITLE'),
  ('仅统计新版RSI(14)直接输出方向与币安预测市场官方结算的准确率；实际订单盈亏另行统计。',
   '仅统计 DEEPSEEK_5M_V1 自身预测与币安官方结算；旧 Selective V2 不混入。','DESCRIPTION')
 ]
 out=original
 for a,b,k in changes:
  if k=='DESCRIPTION' and a not in out:
   print('DEEPSEEK_UI_DESCRIPTION_TEXT_DIFFERS_SKIP_SAFE=true',flush=True)
   continue
  out=exactly(out,a,b,k)
 # The panel loads several independent client scripts with functions named load().
 # Restrict both changes to their exact unique signatures to avoid touching trade logic.
 donorHelper=between(donor,"async function renderDeepSeekRoundStats(){",
   "async function load(){\n try{\n  var r=await fetch('/api/order-signal-model?",'HELPER')
 donorGate=between(donor,"async function load(){\n try{\n  var r=await fetch('/api/order-signal-model?",
   " // The following historical renderers are retired from the DeepSeek view.",'ROUND_GATE')
 # Locate the stats load() by its enclosing client script instead of relying on
 # a comment that differs across deployed panel revisions.
 anchor=out.find('const statsScript =')
 if anchor<0:raise ValueError('HOTFIX_MISSING_STATS_SCRIPT')
 pos=out.find('async function load(){',anchor)
 if pos<0:raise ValueError('HOTFIX_MISSING_STATS_LOADER')
 out=out[:pos]+donorHelper+donorGate+out[pos+len('async function load(){'):]
 # The policy client script also has a load() function; only update that one.
 donorPolicy=between(donor,
   "async function load(){\n if(!e('signalPolicyCard'))return;\n try{\n  var r=await fetch('/api/order-signal-model?",
   " // Legacy model registry intentionally not used for production status.",'POLICY_GATE')
 anchor=out.find('const policyScript =')
 if anchor<0:raise ValueError('HOTFIX_MISSING_POLICY_SCRIPT')
 pos=out.find('async function load(){',anchor)
 if pos<0:raise ValueError('HOTFIX_MISSING_POLICY_LOADER')
 out=out[:pos]+donorPolicy+out[pos+len('async function load(){'):]
 # Optional legacy model-selection summary, if present in this panel revision.
 statsMarker="async function loadOrderModelStats(){\n if(!e('orderSignalModelStats'))return;\n try{"
 if statsMarker in out:
  statsTail=between(donor,statsMarker,
   "  var endpoint=chosenOrderModel==='EDGE_5M_V1'?",'MODEL_STATS')
  out=exactly(out,statsMarker,statsTail,'SELECTED_MODEL_STATS')
 nameMarker="function chosenModelName(model){\n return model==="
 if nameMarker in out:
  out=exactly(out,nameMarker,
   "function chosenModelName(model){\n if(model==='DEEPSEEK_5M_V1')return 'DeepSeek 5分钟 AI 深度思考';\n return model===",
   'MODEL_NAME')
 if 'renderDeepSeekRoundStats()' not in out or 'DeepSeek 每轮预测与官方结算' not in out:
  raise RuntimeError('HOTFIX_RESULT_INVALID')
 return out

def load_json(port,route):
 with urllib.request.urlopen('http://127.0.0.1:%s%s'%(port,route),timeout=8) as r:return json.load(r)

def main():
 if os.geteuid()!=0:raise RuntimeError('ROOT_REQUIRED')
 import argparse
 parser=argparse.ArgumentParser();parser.add_argument('--donor',required=True);parser.add_argument('--dry-run',action='store_true');args=parser.parse_args()
 assert LIVE.is_file() and pathlib.Path(args.donor).is_file()
 assert subprocess.check_output(['systemctl','is-active',SERVICE],text=True).strip()=='active'
 prod=load_json(13001,'/api/order-signal-model')
 assert prod.get('model')=='DEEPSEEK_5M_V1'
 ai=load_json(13029,'/api/history?limit=3')
 assert ai.get('ok') is True and ai.get('model')=='DEEPSEEK_5M_V1'
 old=LIVE.read_text()
 new=patch(old,pathlib.Path(args.donor).read_text())
 with tempfile.TemporaryDirectory(prefix='zl-deepseek-ui-') as t:
  local=pathlib.Path(t)/LIVE.name;local.write_text(new)
  subprocess.run([NODE,'--check',str(local)],check=True,timeout=30)
  print('DEEPSEEK_UI_STATIC_CHECK_PASSED=true',flush=True)
  print('DEEPSEEK_UI_WAS_LEGACY=true',flush=True)
  if args.dry_run:
   print('DEEPSEEK_UI_DRY_RUN_PASSED=true',flush=True);return
  backup=pathlib.Path('/var/lib/zl-prediction/archive/source-backups')/('deepseek-ui-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.mkdir(parents=True,exist_ok=False)
  shutil.copy2(LIVE,backup/LIVE.name)
  st=LIVE.stat()
  pending=LIVE.with_name(LIVE.name+'.deepseek-ui.tmp')
  pending.write_text(new)
  os.chown(pending,st.st_uid,st.st_gid);os.chmod(pending,st.st_mode & 0o777)
  os.replace(pending,LIVE)
  try:
   subprocess.run(['systemctl','restart',SERVICE],check=True,timeout=90,stdout=subprocess.DEVNULL)
   healthy=False
   for _ in range(25):
    time.sleep(2)
    try:
     model=load_json(13001,'/api/order-signal-model')
     if model.get('model')=='DEEPSEEK_5M_V1':
      healthy=True;break
    except Exception:pass
   if not healthy:raise RuntimeError('PANEL_RESTART_OR_MODEL_NOT_READY')
   if subprocess.check_output(['systemctl','is-active','zl-futures-bot-paper'],text=True).strip()!='active':
    raise RuntimeError('FUTURES_SERVICE_UNEXPECTEDLY_INACTIVE')
   print('DEEPSEEK_UI_INSTALLED=true',flush=True)
   print('DEEPSEEK_UI_PRODUCTION_MODEL=DEEPSEEK_5M_V1',flush=True)
   print('DEEPSEEK_UI_OLD_MODEL_STATS_REMOVED=true',flush=True)
   print('DEEPSEEK_UI_FUTURES_UNCHANGED=true',flush=True)
  except Exception:
   shutil.copy2(backup/LIVE.name,LIVE)
   subprocess.run(['systemctl','restart',SERVICE],timeout=90)
   print('DEEPSEEK_UI_ROLLED_BACK=true',flush=True)
   raise
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('DEEPSEEK_UI_ERROR',type(e).__name__,str(e)[:220])
  sys.exit(1)

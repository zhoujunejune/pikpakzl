#!/usr/bin/env python3
"""Remove obsolete Guardian dynamic-exit UI only. Never alter order/risk execution."""
import os,sys,re,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
BASE=/opt/zl-prediction-live/src/railway-diagnostic
PANEL="$BASE/guardian-main-dashboard.mjs"
NODE=/opt/zl-prediction-node/bin/node
BACK=/var/backups/guardian5-ui-cleanup-$(date -u +%Y%m%dT%H%M%SZ)-$$
WORK=$(mktemp -d /tmp/guardian5-ui-cleanup.XXXXXXXX)
changed=0
success=0
cleanup(){
 if test "$changed" = 1 && test "$success" = 0;then
  cp -p "$BACK/guardian-main-dashboard.mjs" "$PANEL"
  systemctl restart zl-prediction-trade || true
  echo GUARDIAN_UI_CLEANUP_ROLLBACK_DONE=true
 fi
 rm -rf "$WORK"
}
trap cleanup EXIT
test -r "$PANEL" && test -x "$NODE"
systemctl is-active --quiet zl-prediction-trade
systemctl is-active --quiet zl-prediction-risk-exits

check_idle(){
python3 - <<'PY'
import urllib.request,json,sys
try:
 with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=5) as f:s=json.load(f)
except Exception as e:print('GUARDIAN_UI_STATUS_UNAVAILABLE',type(e).__name__);sys.exit(10)
if s.get('ok') is not True or s.get('enabled') is not False or s.get('pendingAction'):
 print('GUARDIAN_UI_ACTIVE_TRADE_ABORT');sys.exit(11)
if s.get('orderSignalModel')!='ZL_GUARDIAN_5M_V1':
 print('GUARDIAN_UI_DIFFERENT_MODEL_ABORT');sys.exit(12)
print('GUARDIAN_UI_IDLE_VERIFIED=true')
PY
}
check_idle
mkdir -p -m 0700 "$BACK"
cp -p "$PANEL" "$BACK/guardian-main-dashboard.mjs"
python3 - "$PANEL" "$WORK/patched.mjs" <<'PY'
import pathlib,re,sys
src=pathlib.Path(sys.argv[1]).read_text()
def remove_exact(text):
 global src
 if src.count(text)!=1:raise ValueError('UNEXPECTED_UI_CARD_COUNT:'+text[:48])
 src=src.replace(text,'',1)
remove_exact(' <div class="kv"><div class="k">动态移动止盈</div><div class="v" id="zlGDynamicTP">核验中</div></div>\n')
remove_exact(' <div class="kv"><div class="k">动态止损</div><div class="v" id="zlGDynamicSL">核验中</div></div>\n')
remove_exact(' <div class="kv"><div class="k">风控平仓执行验证</div><div class="v" id="zlGRiskExec">核验中</div></div>\n')
start=src.find('<div class="kv" id="zlGuardianRiskSwitchCard"')
if start<0:raise ValueError('DYNAMIC_CONTROL_CARD_NOT_FOUND')
depth=0
end=None
for m in re.finditer(r'</?div\b[^>]*>',src[start:]):
 tag=m.group()
 depth+= -1 if tag.startswith('</') else 1
 if depth==0:
  end=start+m.end()
  break
if end is None:raise ValueError('DYNAMIC_CONTROL_CARD_UNBALANCED')
src=src[:start]+src[end:]
remove_exact(' var loading=false,riskBusy=false;\n')
anchor=' var guardianToggle='
start=src.find(anchor)
end=src.find(' async function load(){',start)
if start<0 or end<0 or end-start>5500:
 raise ValueError('DYNAMIC_JS_BLOCK_MARKERS_UNEXPECTED')
src=src[:start]+' var loading=false;\n'+src[end:]
old="get('/api/risk-control').catch(function(){return null}),get('/api/guardian-dynamic-risk').catch(function(){return null})"
assert src.count(old)==1,'DYNAMIC_GET_UNEXPECTED'
src=src.replace(old,"get('/api/risk-control').catch(function(){return null})",1)
remove_exact('guardianRisk=result[3]')
# The preceding variable declaration leaves a comma; remove it conservatively.
src=src.replace('risk=result[2],;','risk=result[2];')
remove_exact('   if(!riskBusy)renderToggle(guardianRisk);\n')
src=src.replace('   // Real Worker state comes only from the dedicated control endpoint.\n','')
src=src.replace('动态止盈止损执行仍未接通','固定止盈止损执行仍待核验')
src=src.replace('GUARDIAN 动态平仓成功的证明','实际SELL成交的证明')
for unwanted in ('动态移动止盈','动态止损','专属动态风控','动态止盈止损',
 'zlGuardianRiskSwitchCard','zlGDynamicTP','zlGDynamicSL',
 'guardian-dynamic-risk','zlGuardianToggleRisk','guardianToggle','riskBusy'):
 if unwanted in src:raise ValueError('OBSOLETE_DYNAMIC_WIDGET_REMAINS:'+unwanted)
for required in ('id="zlGFixedTP"','id="zlGFixedSL"','id="zlGCount"','id="zlGAccuracy"','id="zlGRiskPersistence"'):
 if required not in src:raise ValueError('FIXED_OR_STATS_CARD_MISSING:'+required)
pathlib.Path(sys.argv[2]).write_text(src)
print('GUARDIAN_UI_SURGICAL_PATCH_VALID=true')
PY
"$NODE" --check "$WORK/patched.mjs"
check_idle
changed=1
cp "$WORK/patched.mjs" "$PANEL"
chown --reference="$BACK/guardian-main-dashboard.mjs" "$PANEL"
chmod --reference="$BACK/guardian-main-dashboard.mjs" "$PANEL"
"$NODE" --check "$PANEL"
check_idle
systemctl restart zl-prediction-trade
ready=0
for i in $(seq 1 20);do
 if systemctl is-active --quiet zl-prediction-trade &&
    curl -fsS --max-time 4 http://127.0.0.1:13001/ -o "$WORK/page.html" &&
    curl -fsS --max-time 4 http://127.0.0.1:13001/api/status -o "$WORK/status.json";then
  if python3 - "$WORK/page.html" "$WORK/status.json" <<'PY'
import pathlib,sys,json
html=pathlib.Path(sys.argv[1]).read_text()
stat=json.load(open(sys.argv[2]))
for marker in ('动态移动止盈','动态止损','GUARDIAN 专属动态风控',
 'zlGuardianRiskSwitchCard','zlGDynamicTP','zlGDynamicSL','guardian-dynamic-risk'):
 assert marker not in html,('OLD_DYNAMIC_UI_STILL_PRESENT',marker)
for marker in ('id="zlGFixedTP"','id="zlGFixedSL"','id="zlGCount"','id="zlGAccuracy"'):
 assert marker in html,('FIXED_UI_MISSING',marker)
assert stat.get('ok') and stat.get('enabled') is False and not stat.get('pendingAction')
assert stat.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1'
print('GUARDIAN_FIXED_UI_LIVE_HTML_VERIFIED=true')
PY
  then ready=1;break;fi
 fi
 sleep 2
done
test "$ready" = 1
systemctl is-active --quiet zl-prediction-risk-exits
check_idle
success=1
echo GUARDIAN_DYNAMIC_FRONTEND_REMOVED=true
echo GUARDIAN_FIXED_TP_SL_PRESERVED=true
echo GUARDIAN_ONLY_UI_CHANGED=true
echo GUARDIAN_UI_BACKUP="$BACK"
"""
def main():
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[0-9a-f]{40}',os.getenv('GITHUB_SHA','')):
  print('GUARDIAN_UI_DEPLOY_WRONG_BRANCH');return 2
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 inv=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  name='guardian-ui-remove-retired-dynamic-widget',type='RunShellScript',
  command_content=SCRIPT,working_user='root',timeout=160)).body.invoke_id
 for _ in range(95):
  time.sleep(2)
  r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:out='OUTPUT_NOT_UTF8'
   print('GUARDIAN_UI_DEPLOY_RESULT',r.invocation_status,r.exit_code)
   print(out[-7000:])
   return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 and 'GUARDIAN_DYNAMIC_FRONTEND_REMOVED=true' in out else 5
 print('GUARDIAN_UI_DEPLOY_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

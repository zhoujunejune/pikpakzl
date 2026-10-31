#!/usr/bin/env python3
"""Replace retired FAST5 frontend widget with GUARDIAN on the existing production site."""
import os,sys,re,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
NODE=/opt/zl-prediction-node/bin/node
BASE=/opt/zl-prediction-live/src/railway-diagnostic
PANEL=$BASE/panel-stats-shell.mjs
DEST=$BASE/guardian-main-dashboard.mjs
systemctl is-active --quiet zl-prediction-guardian-analysis
systemctl is-active --quiet zl-prediction-trade
systemctl is-active --quiet zl-prediction-risk-exits
python3 - <<'PY'
import urllib.request,json
def get(port,route):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,route),timeout=7) as f:return json.load(f)
s=get(13001,'/api/status')
g=get(13049,'/api/status')
assert s.get('ok') and s.get('enabled') is False,'LIVE_TRADING_MUST_REMAIN_OFF'
assert not s.get('pendingAction'),'PENDING_ORDER'
assert s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1' and s.get('orderSignalModelReady') is True
assert g.get('ok') and g.get('model')=='ZL_GUARDIAN_5M_V1'
assert g.get('productionIntegration') is False and g.get('orders') is False
print('GUARDIAN_MAIN_UI_PREFLIGHT_OK=true')
PY
STAGE=$(mktemp -d /tmp/zl-guardian-ui-XXXXXX)
BACK=/var/backups/zl-guardian-main-ui-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 700 "$BACK"
trap 'rm -rf "$STAGE"' EXIT
curl -fsSL --retry 3 --max-time 35 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/railway-diagnostic/guardian-main-dashboard.mjs" -o "$STAGE/guardian-main-dashboard.mjs"
"$NODE" --check "$STAGE/guardian-main-dashboard.mjs"
cp -p "$PANEL" "$BACK/panel.before"
old_widget=0
if test -f "$DEST";then old_widget=1;cp -p "$DEST" "$BACK/widget.before";fi
restore(){
 echo GUARDIAN_MAIN_UI_ROLLBACK_STARTED=true
 cp -p "$BACK/panel.before" "$PANEL"
 if test "$old_widget" = 1;then cp -p "$BACK/widget.before" "$DEST";else rm -f "$DEST";fi
 systemctl restart zl-prediction-trade >/dev/null 2>&1 || true
 echo GUARDIAN_MAIN_UI_ROLLBACK_DONE=true
}
trap restore ERR
python3 - <<'PY'
from pathlib import Path
import os
p=Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
s=p.read_text()
s=s.replace('GUARDIAN · 影子策略','GUARDIAN · 生产策略')
old="import {injectFast5Dashboard} from './fast5-dashboard-inject.mjs';"
new="import {injectGuardianMainDashboard} from './guardian-main-dashboard.mjs';"
oldcall='html=injectFast5Dashboard(html);'
newcall='html=injectGuardianMainDashboard(html);'
if s.count(new)==1 and s.count(newcall)==1:
 print('GUARDIAN_MAIN_UI_ALREADY_WIRED=true')
else:
 assert s.count(old)==1 and s.count(oldcall)==1,'FAST5_WIDGET_HOOK_NOT_UNIQUE'
 s=s.replace(old,new,1).replace(oldcall,newcall,1)
assert s.count(new)==1 and s.count(newcall)==1
tmp=p.with_name(p.name+'.guardian-ui.stage')
tmp.write_text(s);os.chmod(tmp,p.stat().st_mode&0o777);os.chown(tmp,p.stat().st_uid,p.stat().st_gid)
os.replace(tmp,p)
print('GUARDIAN_MAIN_UI_LEGACY_FAST5_INJECTION_REMOVED=true')
PY
cp -p "$STAGE/guardian-main-dashboard.mjs" "$DEST"
chown "$(stat -c %u "$PANEL")":"$(stat -c %g "$PANEL")" "$DEST"
chmod 0644 "$DEST"
"$NODE" --check "$PANEL"
"$NODE" --check "$DEST"
systemctl restart zl-prediction-trade
ready=no
for i in $(seq 1 45);do
 if curl -fsS --max-time 5 http://127.0.0.1:13001/ -o "$STAGE/main.html" 2>/dev/null &&
    curl -fsS --max-time 5 http://127.0.0.1:13001/api/status -o "$STAGE/status.json" 2>/dev/null;then
  if python3 - "$STAGE/main.html" "$STAGE/status.json" <<'PY'
import sys,json
h=open(sys.argv[1]).read()
s=json.load(open(sys.argv[2]))
assert 'id="zlGuardianMain"' in h and 'guardian/api/status' in h
assert 'id="zlFast5Card"' not in h and 'FAST5生产状态暂无法读取' not in h
assert s.get('ok') and s.get('enabled') is False
assert s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1' and s.get('orderSignalModelReady') is True
assert s.get('orderSignal') is None
PY
  then ready=yes;break;fi
 fi
 sleep 2
done
test "$ready" = yes
systemctl is-active --quiet zl-prediction-guardian-analysis
systemctl is-active --quiet zl-prediction-trade
systemctl is-active --quiet zl-prediction-risk-exits
echo GUARDIAN_MAIN_DASHBOARD_DEPLOYED=true
echo GUARDIAN_OLD_FAST5_CARD_REMOVED=true
echo GUARDIAN_NO_LIVE_ORDERS=true
echo GUARDIAN_UI_BACKUP="$BACK"
trap - ERR
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch(r'[0-9a-f]{40}',sha):
  print('GUARDIAN_BAD_REVISION');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  name='guardian-five-minute-main-ui',type='RunShellScript',
  command_content=SCRIPT.replace('COMMIT_SHA',sha),
  working_user='root',timeout=180)).body.invoke_id
 for _ in range(95):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output or '')
   print('GUARDIAN_UI_REMOTE',r.invocation_status,'EXIT',r.exit_code)
   print(o[-9500:])
   return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 and 'GUARDIAN_MAIN_DASHBOARD_DEPLOYED=true' in o else 5
 print('GUARDIAN_UI_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

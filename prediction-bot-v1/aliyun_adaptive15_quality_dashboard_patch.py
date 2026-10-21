#!/usr/bin/env python3
"""Guarded display-only quality label patch to existing prediction dashboard."""
import base64,os,re,time,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='feat/adaptive15-deferred-wait-learning-pnl-20261021'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
node=/opt/zl-prediction-node/bin/node
panel=/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs
test -x "$node" && test -f "$panel"
for u in zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$u")" = active || exit 11
done
python3 - <<'PY'
import urllib.request,json
def get(port,route):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}{route}',timeout=6) as r:return json.load(r)
t=get(13001,'/api/status');m=get(13029,'/api/status')
if t.get('enabled') is not False:raise SystemExit('AUTO_FOLLOW_ON_SKIP_UI')
if m.get('decisionWindowEndMs',0)-m.get('round',0)!=15000:raise SystemExit('WRONG_PROVIDER')
if (m.get('strategyQuality') or {}).get('economics',{}).get('available') is not False:
 raise SystemExit('UNEXPECTED_PROFIT_SOURCE')
print('PANEL_QUALITY_SAFETY_PREFLIGHT=true')
PY
back=/var/lib/zl-prediction/archive/source-backups/deepseek-quality-panel-COMMIT_SHA
mkdir -p "$back"
cp -p "$panel" "$back/panel-stats-shell.mjs"
tmp=$(mktemp /tmp/zl-quality-panel-XXXXXXXX.mjs)
trap 'rm -f "$tmp"' EXIT
python3 - "$panel" "$tmp" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]);out=Path(sys.argv[2]);s=p.read_text()
anchor='   var currentRound=Math.floor(Date.now()/300000)*300000;'
if s.count(anchor)!=1 or 'DEEPSEEK_QUALITY_VISIBLE_V1' in s:
 raise SystemExit('UNEXPECTED_UI_CONTEXT_ABORT')
insert='''   // DEEPSEEK_QUALITY_VISIBLE_V1: do not conflate settled direction hit rate with net return.
   var q=status.strategyQuality||{},qs=q.signal||{},qe=q.economics||{},qa=q.errors||{};
   var newN=Number.isSafeInteger(qs.officiallySettled)?qs.officiallySettled:0;
   var notes=' · 新策略质量样本 '+newN+' 条（自本次升级起）；';
   notes+='真实净收益：'+(qe.available===true&&Number.isFinite(qe.realizedNetPnl)?
     String(qe.realizedNetPnl)+' '+String(qe.currency||''):'未核验，无法计算');
   var misses=Array.isArray(qa.patterns)?qa.patterns.slice(0,2):[];
   if(misses.length&&newN>=10)
     notes+='；失误线索（非确定原因） '+misses.map(function(x){return String(x.tag)+' '+x.count}).join('、');
   var metaNode=e('rsMeta');if(metaNode)metaNode.textContent+=notes;
'''
out.write_text(s.replace(anchor,insert+anchor,1))
print('PANEL_QUALITY_STATISTICS_SEPARATED=true')
PY
"$node" --check "$tmp"
restore(){
 echo 'PANEL_QUALITY_ROLLBACK_TRIGGERED=true'
 cp -p "$back/panel-stats-shell.mjs" "$panel"
 systemctl restart zl-prediction-trade.service || true
}
trap restore ERR
python3 - <<'PY'
import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:s=json.load(r)
if s.get('enabled') is not False:raise SystemExit('FOLLOW_CHANGED_ABORT')
PY
install -m 0644 "$tmp" "$panel.tmp"
chown --reference="$panel" "$panel.tmp"
chmod --reference="$panel" "$panel.tmp"
mv -f "$panel.tmp" "$panel"
systemctl restart zl-prediction-trade.service
for _ in $(seq 1 15);do
 if curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o /dev/null 2>/dev/null;then break;fi
 sleep 1
done
python3 - <<'PY'
from pathlib import Path
import urllib.request,json
p=Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
assert p.read_text().count('DEEPSEEK_QUALITY_VISIBLE_V1')==1
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:s=json.load(r)
assert s.get('enabled') is False
with urllib.request.urlopen('http://127.0.0.1:13029/api/status',timeout=7) as r:m=json.load(r)
assert m.get('noSignalAfterDeadline') is True
print('PANEL_QUALITY_RENDER_SOURCE_ACTIVE=true')
print('PANEL_AUTO_FOLLOW_STILL_OFF=true')
PY
for u in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$u")" = active || exit 22
done
echo 'PANEL_PREDICTION_AND_FUTURES_UNCHANGED=true'
trap - ERR
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   name='zl-prediction-quality-ui-summary-followoff',type='RunShellScript',working_user='root',
   command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=145)).body.invoke_id
 for _ in range(75):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:out=''
   print('QUALITY_PANEL_REMOTE_EXIT',r.exit_code,'STATUS',r.invocation_status)
   print(out[-3000:])
   return 0 if int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':sys.exit(main())

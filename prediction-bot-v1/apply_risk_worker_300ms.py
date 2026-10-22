#!/usr/bin/env python3
"""Apply exactly one polling-value change on a quiet risk-worker and verify restart."""
import os,re,base64,time,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/risk-exit-300ms-20261023'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
UNIT=zl-prediction-risk-exits.service
FILE=/opt/zl-prediction-live/src/railway-diagnostic/risk-worker.mjs
NODE=/opt/zl-prediction-node/bin/node
test "$(systemctl is-active "$UNIT")" = active
test -f "$FILE" && test -x "$NODE"
python3 - <<'PY'
import json,urllib.request,subprocess
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=7) as r:return json.load(r)
c=get('/api/risk-control');t=get('/api/status')
e=c.get('execution') or {}
assert c.get('takeProfitEnabled') is True and c.get('takeProfitPercent')==35
assert c.get('stopLossEnabled') is True and c.get('stopLossPercent')==70
assert c.get('persistenceHealthy') is True
assert e.get('workerRunning') is True and e.get('configApplied') is True
assert t.get('enabled') is False,'OWNER_FOLLOW_ACTIVE_NO_RESTART'
j=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
 '--since','30 seconds ago','--no-pager','-o','cat'],capture_output=True,text=True,timeout=8).stdout
danger={'risk_check','risk_triggered','risk_sell_submitted','risk_sell_unknown',
 'risk_sell_failed','risk_sell_exception','risk_sell_quote_failed'}
for line in j.splitlines():
 try:event=json.loads(line).get('event')
 except:continue
 assert event not in danger,'ACTIVE_POSITION_OR_SELL_NO_RESTART'
print('TP300_PRECHECK_QUIET_AND_USER_SETTINGS_OK=true')
PY
dir=/var/lib/zl-prediction/archive/source-backups
mkdir -p "$dir"
backup="$dir/risk-poll300-COMMIT_SHA"
test ! -e "$backup"
mkdir -p "$backup"
cp -p "$FILE" "$backup/old-worker.mjs"
rollback(){
 echo 'TP300_ROLLBACK_STARTED=true'
 cp -p "$backup/old-worker.mjs" "$FILE"
 systemctl restart "$UNIT" || true
}
trap rollback ERR
python3 - "$FILE" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]);s=p.read_text()
a='process.env.AUTO_TAKE_PROFIT_POLL_MS || 500));'
b='process.env.AUTO_TAKE_PROFIT_POLL_MS || 300));'
assert s.count(a)==1,'RISK_WORKER_LIVE_DRIFT'
assert 'Math.max(300, Number(process.env.AUTO_RISK_POLL_MS' in s
p.write_text(s.replace(a,b))
print('TP300_ONLY_ONE_DEFAULT_POLL_VALUE_CHANGED=true')
PY
"$NODE" --check "$FILE"
systemctl restart "$UNIT"
python3 - <<'PY'
import json,urllib.request,subprocess,time
for _ in range(40):
 try:
  with urllib.request.urlopen('http://127.0.0.1:13001/api/risk-control',timeout=5) as r:c=json.load(r)
  e=c.get('execution') or {}
  logs=subprocess.run(['journalctl','-u','zl-prediction-risk-exits.service',
   '--since','2 minutes ago','-o','cat','--no-pager','-n','130'],
   capture_output=True,text=True,timeout=6).stdout
  started=[]
  for line in logs.splitlines():
   try:
    x=json.loads(line)
    if x.get('event')=='risk_worker_started':started.append(x)
   except:pass
  if started and started[-1].get('pollMs')==300 and e.get('workerRunning') is True and \
    e.get('configApplied') is True and c.get('persistenceHealthy') is True:break
 except Exception:pass
 time.sleep(1)
else:raise RuntimeError('TP300_NEW_WORKER_FAILED_HEALTH_CHECK')
assert c.get('takeProfitPercent')==35 and c.get('stopLossPercent')==70
assert c.get('takeProfitEnabled') is True and c.get('stopLossEnabled') is True
assert started[-1].get('retryMs')==2500
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=8) as r:t=json.load(r)
assert t.get('enabled') is False
print('TP300_WORKER_POLL_MS=',started[-1]['pollMs'])
print('TP300_TP35_SL70_STILL_ACTIVE=true')
print('TP300_FOLLOW_SWITCH_UNCHANGED=true')
print('TP300_DEPLOYED_AND_HEALTHY=true')
PY
trap - ERR
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 req=sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
 name='zl-tpsl-300ms-quiet-period-update',type='RunShellScript',working_user='root',
 command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=150)
 result=c.run_command(req).body.invoke_id
 for _ in range(90):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=result)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('TP300_CLOUD_RESULT',r.invocation_status,'EXIT',r.exit_code)
   print(o[-7500:])
   return 0 if int(r.exit_code)==0 else 5
 return 6
if __name__=='__main__':sys.exit(main())

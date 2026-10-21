#!/usr/bin/env python3
"""Rollback-protected bounded opening-price correction HOTFIX.

Edits only the new FAST10 helper file; does not touch original DeepSeek engine,
official learner data, trade order router, or futures bot.
"""
import os,base64,time,re,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='feat/deepseek-prewarm-fast10-20261021'
OLD_SHA='0ec9c33064d9a69c29005fa0bbdbf3c74c7f03c8'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" = 0
p=/opt/zl-prediction-live/deepseek5/deepseek-fast10-shadow-core.mjs
node=/opt/zl-prediction-node/bin/node
test -f "$p" && test -x "$node"
python3 - <<'PY'
import json,urllib.request
def get(port,path):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=7) as r:return json.load(r)
s=get(13001,'/api/status')
d=get(13029,'/api/status')
if s.get('enabled') is not False:raise SystemExit('FOLLOW_ON_ABORT')
if d.get('model')!='DEEPSEEK_5M_V1' or d.get('decisionWindowEndMs')-d.get('round')!=10000:
 raise SystemExit('FAST10_NOT_ACTIVE_ABORT')
print('HOTFIX_FOLLOW_OFF=true')
PY
work=$(mktemp -d /tmp/zl-fast10-openfix-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/OLD_SHA/prediction-bot-v1/deepseek-fast10-shadow-core.mjs" -o "$work/expected.old.mjs"
cmp -s "$p" "$work/expected.old.mjs" || { echo 'UNEXPECTED_RUNNING_CORE_ABORT';exit 11; }
curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/deepseek-fast10-shadow-core.mjs" -o "$work/new.mjs"
"$node" --check "$work/new.mjs"
cp -p "$p" "$work/backup.original.mjs"
restore(){
 echo 'FAST10_OPEN_PRICE_HOTFIX_ROLLBACK=true'
 cp -p "$work/backup.original.mjs" "$p"
 systemctl restart zl-prediction-deepseek5.service || true
}
trap restore ERR
install -m 0640 -o zl-pred -g zl-pred "$work/new.mjs" "$p.tmp"
mv -f "$p.tmp" "$p"
systemctl restart zl-prediction-deepseek5.service
for i in $(seq 1 15);do
 if curl -fsS --max-time 2 http://127.0.0.1:13029/api/status -o "$work/status" 2>/dev/null;then break;fi
 sleep 1
done
test -s "$work/status"
python3 - "$work/status" <<'PY'
import json,sys,urllib.request
s=json.load(open(sys.argv[1]))
assert s.get('model')=='DEEPSEEK_5M_V1'
assert s.get('decisionWindowEndMs')-s.get('round')==10000
assert s.get('realOrderEnabled') is False
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=6) as r:trade=json.load(r)
assert trade.get('enabled') is False
print('FAST10_BOUNDED_ROUND_OPEN_CORRECTION_ACTIVE=true')
print('FAST10_FOLLOW_REMAINS_OFF=true')
print('FAST10_LEARNING_SAMPLES',(s.get('learning') or {}).get('allOfficialSamples'))
PY
for u in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$u")" = active || exit 22
done
echo 'FAST10_HOTFIX_PRESERVED_ALL_OTHER_UNITS=true'
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[0-9a-f]{40}',sha):
  print('FAST10_HOTFIX_WRONG_REF');return 2
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
    access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
    region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 invoke=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
    instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='zl-fast10-bounded-round-open-hotfix',
    type='RunShellScript',working_user='root',
    command_content=REMOTE.replace('COMMIT_SHA',sha).replace('OLD_SHA',OLD_SHA),timeout=130)).body.invoke_id
 for _ in range(75):
  time.sleep(2)
  x=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
     instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=invoke)).body.invocation_result
  if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=x.output or ''
   try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
   except Exception:pass
   print('FAST10_HOTFIX_REMOTE_EXIT',x.exit_code,str(x.invocation_status))
   print(raw[-4000:])
   return 0 if int(x.exit_code)==0 else 5
 print('FAST10_HOTFIX_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

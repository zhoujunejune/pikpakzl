#!/usr/bin/env python3
"""Single-file production provider reporting/case-reason hotfix; follow OFF only."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='feat/deepseek-adaptive15-experience-20261021'
SOURCE_SHA='2a1f3496cdc2eeb7988dc7b757383874c8686f40'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
p=/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs
node=/opt/zl-prediction-node/bin/node
test -f "$p" && test -x "$node"
python3 - <<'PY'
import urllib.request,json
def read(port,url):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}'+url,timeout=8) as r:return json.load(r)
trade=read(13001,'/api/status')
s=read(13029,'/api/status')
if trade.get('enabled') is not False:raise SystemExit('FOLLOW_ACTIVE_NO_HOTFIX')
if s.get('decisionWindowEndMs',0)-s.get('round',0)!=15000:raise SystemExit('ADAPTIVE15_NOT_LIVE')
print('ADAPTIVE15_BEFORE_HOTFIX_SAMPLES',(s.get('learning') or {}).get('allOfficialSamples'))
PY
work=$(mktemp -d /tmp/zl-adaptive15-auditfix-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 2 --max-time 20 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/SOURCE_SHA/prediction-bot-v1/deepseek-adaptive15-production-adapter.mjs" -o "$work/expected.old"
cmp -s "$p" "$work/expected.old" || { echo 'ADAPTIVE15_ACTIVE_SOURCE_MISMATCH_ABORT';exit 12; }
curl -fsSL --retry 2 --max-time 20 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/deepseek-adaptive15-production-adapter.mjs" -o "$work/new"
"$node" --check "$work/new"
cp -p "$p" "$work/original"
restore(){
 echo 'ADAPTIVE15_REPORTING_HOTFIX_ROLLBACK=true'
 cp -p "$work/original" "$p"
 systemctl restart zl-prediction-deepseek5.service || true
}
trap restore ERR
install -m 0640 -o zl-pred -g zl-pred "$work/new" "$p.new"
mv -f "$p.new" "$p"
systemctl restart zl-prediction-deepseek5.service
for i in $(seq 1 15);do
 if curl -fsS --max-time 2 http://127.0.0.1:13029/api/status -o "$work/current" 2>/dev/null;then break;fi
 sleep 1
done
test -s "$work/current"
python3 - "$work/current" <<'PY'
import json,sys,urllib.request
s=json.load(open(sys.argv[1]))
assert s['model']=='DEEPSEEK_5M_V1'
assert s['decisionWindowEndMs']-s['round']==15000
assert 'analysisTargetRound' in s
assert 'analysisFirstDirection' in s
assert 'analysisReviewDirection' in s
assert 'analysisModelCalls' in s
assert s['realOrderEnabled'] is False
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:t=json.load(r)
assert t.get('enabled') is False
print('ADAPTIVE15_TWO_PASS_AUDIT_FIELDS_AVAILABLE=true')
print('ADAPTIVE15_FOLLOW_STILL_OFF=true')
print('ADAPTIVE15_POST_HOTFIX_SAMPLES',(s.get('learning') or {}).get('allOfficialSamples'))
PY
for u in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$u")" = active || exit 13
done
echo 'ADAPTIVE15_HOTFIX_DID_NOT_TOUCH_TRADER_OR_FUTURES=true'
trap - ERR
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch(r'[a-f0-9]{40}',sha):
  print('ADAPTIVE15_AUDIT_HOTFIX_WRONG_REF');return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  name='zl-adaptive15-two-review-visibility-followoff-hotfix',type='RunShellScript',
  working_user='root',command_content=REMOTE.replace('COMMIT_SHA',sha).replace('SOURCE_SHA',SOURCE_SHA),
  timeout=135)).body.invoke_id
 for _ in range(75):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=r.output or ''
   try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
   except Exception:pass
   print('ADAPTIVE15_REPORTING_HOTFIX_EXIT',r.exit_code,'STATUS',r.invocation_status)
   print(raw[-4500:])
   return 0 if int(r.exit_code)==0 else 5
 print('ADAPTIVE15_REPORTING_HOTFIX_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

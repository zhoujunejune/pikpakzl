import os,sys,time,base64,re
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
cd /opt/zl-prediction-live/src/railway-diagnostic
node=/opt/zl-prediction-node/bin/node
for module in shadow-breakout20-dashboard.mjs novice-mix-core.mjs novice-mix-shadow.mjs postflip-official-stats.mjs;do
 if test ! -s "$module";then
  curl -fsSL --max-time 40 --retry 3 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/SHA/railway-diagnostic/$module" -o "/tmp/$module"
  "$node" --check "/tmp/$module"
  install -o zl-pred -g zl-pred -m 0644 "/tmp/$module" "$module"
  rm -f "/tmp/$module"
  echo "RECOVERED_IMPORT $module"
 fi
done
"$node" --check panel-stats-shell.mjs
systemctl reset-failed zl-prediction-trade || true
systemctl restart zl-prediction-trade
for i in $(seq 1 40);do
 if curl -fsS --max-time 4 http://127.0.0.1:13001/api/order-signal-model >/tmp/deepseek-select.json;then
   if python3 - <<'PY'
import json
s=json.load(open('/tmp/deepseek-select.json'))
assert s['model']=='DEEPSEEK_5M_V1' and [m['id'] for m in s['models']]==['DEEPSEEK_5M_V1']
PY
   then
    echo 'DEEPSEEK_PRODUCTION_PANEL_RECOVERED=true'
    echo 'DEEPSEEK_PRODUCTION_MODEL=DEEPSEEK_5M_V1'
    test "$(systemctl is-active zl-futures-bot-paper)" = active
    test "$(systemctl is-active zl-prediction-deepseek5)" = active
    echo 'DEEPSEEK_OTHER_BOTS_UNTOUCHED=true'
    exit 0
   fi
 fi
 sleep 2
done
echo 'DEEPSEEK_PANEL_STILL_FAILED=true'
journalctl -u zl-prediction-trade -o cat --no-pager -n 20 |
 grep -E 'ERR_|Cannot find|Error|SyntaxError|MODULE' |
 tail -10 | cut -c 1-200 || true
exit 3
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if not re.fullmatch('[a-f0-9]{40}',sha):return 4
 cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cli.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='zl-restore-panel-static-imports',type='RunShellScript',working_user='root',command_content=REMOTE.replace('/SHA/','/'+sha+'/'),timeout=240)).body.invoke_id
 for _ in range(80):
  time.sleep(3)
  x=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:output=base64.b64decode(x.output or '',validate=True).decode('utf8','replace')
   except Exception:output=x.output or ''
   print('RECOVERY_STATUS',x.invocation_status,'EXIT',x.exit_code)
   print(output[-4500:]);return 0 if int(x.exit_code)==0 and str(x.invocation_status)=='Success' else 5
 return 6
if __name__=='__main__':sys.exit(main())

#!/usr/bin/env python3
"""Remove the owner-selected standalone breakout20 card and backend from Alibaba.

Preserves the official production BASELINE model and settlement ledger,
real-order settings, EDGE, DYNAMIC, futures and credential storage.
"""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REGION="ap-southeast-1"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
PRED_SHA="f624279f17126a4e41e9703a15adf604d9997ceb"
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
umask 027
DIR=/opt/zl-prediction-live/src/railway-diagnostic
FILE="$DIR/panel-stats-shell.mjs"
BACKUP=/var/lib/zl-prediction/archive
test -f "$FILE" && test -d "$BACKUP"
test -x /opt/zl-prediction-node/bin/node
test "$(systemctl is-active zl-prediction-v2)" = active
test "$(systemctl is-active zl-prediction-v3)" = active
test "$(systemctl is-active zl-prediction-redis)" = active
test "$(systemctl is-active zl-futures-bot-paper)" = active
test "$(systemctl is-active zl-prediction-native-models)" = active
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl --fail --silent --show-error --location --retry 3 --max-time 40 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/PRED_SHA/railway-diagnostic/panel-stats-shell.mjs" \
 --output "$TMP/panel-stats-shell.mjs"
/opt/zl-prediction-node/bin/node --check "$TMP/panel-stats-shell.mjs"
# Important: official baseline settlement and the separate EDGE/DYNAMIC pages
# are shared components; do not remove or alter their production services.
if grep -Eq 'shadowCard|shadowScript|proxyShadowStatus|/api/shadow-breakout20/status' "$TMP/panel-stats-shell.mjs";then
 echo "RETIRED_BREAKOUT_MODULE_STILL_REFERENCED";exit 12
fi
if ! grep -Fq '/api/postflip-official-stats' "$TMP/panel-stats-shell.mjs" ||
   ! grep -Fq '/api/shadow-breakout20/edge-5m' "$TMP/panel-stats-shell.mjs" ||
   ! grep -Fq '/api/shadow-breakout20/dynamic-entry' "$TMP/panel-stats-shell.mjs";then
 echo "REQUIRED_PRODUCTION_STATS_MISSING";exit 13
fi
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP/source-backups/$STAMP"
cp -p "$FILE" "$BACKUP/source-backups/$STAMP/panel-stats-shell.mjs"
if [ -f "$DIR/shadow-breakout20-dashboard.mjs" ];then
 mv "$DIR/shadow-breakout20-dashboard.mjs" "$BACKUP/source-backups/$STAMP/shadow-breakout20-dashboard.mjs.retired"
fi
install -o zl-pred -g zl-pred -m 0644 "$TMP/panel-stats-shell.mjs" "$FILE"
echo "RETIRE_BREAKOUT_SOURCE_APPLIED=true"
if ! systemctl restart zl-prediction-trade.service;then
 echo "RETIRE_TRADE_RESTART_FAILED_RESTORING_BACKUP"
 cp -p "$BACKUP/source-backups/$STAMP/panel-stats-shell.mjs" "$FILE"
 if [ -f "$BACKUP/source-backups/$STAMP/shadow-breakout20-dashboard.mjs.retired" ];then
  cp -p "$BACKUP/source-backups/$STAMP/shadow-breakout20-dashboard.mjs.retired" "$DIR/shadow-breakout20-dashboard.mjs"
 fi
 systemctl restart zl-prediction-trade.service || true
 exit 14
fi
READY=no
for i in $(seq 1 25);do
 CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:13001/healthz || true)
 if [ "$CODE" = 200 ];then READY=yes;break;fi
 sleep 2
done
if [ "$READY" != yes ];then
 echo "RETIRE_TRADE_HEALTH_FAILED_RESTORING_BACKUP"
 cp -p "$BACKUP/source-backups/$STAMP/panel-stats-shell.mjs" "$FILE"
 if [ -f "$BACKUP/source-backups/$STAMP/shadow-breakout20-dashboard.mjs.retired" ];then
  cp -p "$BACKUP/source-backups/$STAMP/shadow-breakout20-dashboard.mjs.retired" "$DIR/shadow-breakout20-dashboard.mjs"
 fi
 systemctl restart zl-prediction-trade.service || true
 exit 15
fi
python3 - <<'PY'
import urllib.request,json
base="http://127.0.0.1:13001"
with urllib.request.urlopen(base+"/",timeout=10) as r:
    html=r.read(300000).decode('utf8','replace')
assert '<html' in html.lower()
assert 'breakout20ShadowCard' not in html
assert 'b20SelectedModel' not in html
print('RETIRE_BREAKOUT_HTML_ABSENT=true')
for route in ('/api/shadow-breakout20/edge-5m',
              '/api/shadow-breakout20/dynamic-entry',
              '/api/postflip-official-stats?model=BREAKOUT20_RSI_MACD_RANGE_V1',
              '/api/round-stats'):
    with urllib.request.urlopen(base+route,timeout=12) as r:
        data=json.load(r)
    assert data.get('ok') is True, route
    print('RETIRE_PRESERVED_API',route.split('?')[0],'ok=true')
try:
    urllib.request.urlopen(base+'/api/shadow-breakout20/status',timeout=10)
    raise AssertionError('RETIRED_ENDPOINT_STILL_ACCEPTED')
except urllib.error.HTTPError as e:
    assert e.code in (404,410),e.code
print('RETIRE_OLD_ENDPOINT_NOT_FOUND=true')
PY
test "$(systemctl is-active zl-futures-bot-paper)" = active
test "$(systemctl is-active zl-prediction-native-models)" = active
test "$(systemctl is-active zl-prediction-v2)" = active
test "$(systemctl is-active zl-prediction-v3)" = active
echo "RETIRE_BREAKOUT_SUCCESS=true"
echo "RETIRE_TRADE_ORDERS_UNCHANGED=true"
""".replace("PRED_SHA",PRED_SHA)
def main():
 if os.getenv("GITHUB_REF_NAME")!="feature/zl-futures-bot-v1":
  print("RETIRE_WRONG_BRANCH");return 2
 key=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
 secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
 if not key or not secret:
  print("RETIRE_MISSING_ALIBABA_SECRETS");return 3
 cli=Client(api.Config(access_key_id=key,access_key_secret=secret,endpoint="swas.ap-southeast-1.aliyuncs.com",region_id=REGION))
 try:
  out=cli.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
   name="zl-retire-breakout20-ui-backend",type="RunShellScript",command_content=SCRIPT,
   working_user="root",timeout=360))
  for i in range(95):
   time.sleep(4)
   r=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=out.body.invoke_id)).body.invocation_result
   if not r:continue
   status=str(r.invocation_status)
   if status in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
    raw=r.output or ""
    try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
    except:pass
    print("RETIRE_DEPLOY_STATUS",status)
    print("RETIRE_DEPLOY_EXIT",r.exit_code)
    print("RETIRE_DEPLOY_LOG",raw[-5500:])
    return 0 if status=="Success" and int(r.exit_code)==0 else 4
 except Exception as e:
  print("RETIRE_DEPLOY_ERROR",type(e).__name__);return 5
 print("RETIRE_DEPLOY_TIMEOUT");return 6
if __name__=="__main__":sys.exit(main())

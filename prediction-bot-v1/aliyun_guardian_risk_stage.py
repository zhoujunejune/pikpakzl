#!/usr/bin/env python3
"""Deploy default-off Guardian dynamic SELL worker only when Binance has no ongoing position."""
import os,sys,re,base64,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
BASE=/opt/zl-prediction-live/src/railway-diagnostic
NODE=/opt/zl-prediction-node/bin/node
SHA=__TARGET_SHA__
OLD=d616a726aea5d9e5f75c2a53db9647d63e617837
STAGE=$(mktemp -d /tmp/guardian-risk-stage-XXXXXX)
BACK=/var/backups/guardian-risk-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 700 "$BACK"
trap 'rm -rf "$STAGE"' EXIT
systemctl is-active --quiet zl-prediction-risk-exits
systemctl is-active --quiet zl-prediction-trade
systemctl is-active --quiet zl-prediction-guardian-analysis
! systemctl show zl-prediction-risk-exits -p Environment | grep -q 'GUARDIAN_DYNAMIC_EXIT_ENABLED=true'
MAIN=$(systemctl show zl-prediction-risk-exits -p MainPID --value)
PID=$(pgrep -P "$MAIN" -f 'risk-worker.mjs' | head -n 1)
test -n "$PID"
RISK_PID="$PID" python3 - <<'PY'
import os,json,time,hmac,hashlib,urllib.parse,urllib.request
pid=os.environ['RISK_PID']
e=dict(pair.split(b'=',1) for pair in open('/proc/'+pid+'/environ','rb').read().split(b'\0') if b'=' in pair)
def val(k):return e.get(k.encode(),b'').decode()
key,secret=val('BINANCE_PREDICTION_API_KEY'),val('BINANCE_PREDICTION_API_SECRET')
assert key and secret,'RISK_AUTH_ENV_UNAVAILABLE'
def get(route,params={}):
 p={**params,'timestamp':str(int(time.time()*1000)),'recvWindow':'5000'}
 raw=urllib.parse.urlencode(p)
 sig=hmac.new(secret.encode(),raw.encode(),hashlib.sha256).hexdigest()
 request=urllib.request.Request('https://api.binance.com'+route+'?'+raw+'&signature='+sig,
  headers={'X-MBX-APIKEY':key})
 with urllib.request.urlopen(request,timeout=9) as f:
  data=json.load(f)
 assert isinstance(data,dict),'UNTRUSTED_BINANCE_RESPONSE'
 return data
address=val('BINANCE_PREDICTION_WALLET_ADDRESS')
if not address:
 wallets=get('/sapi/v1/w3w/wallet/prediction/wallet/list').get('wallets')
 assert isinstance(wallets,list) and wallets,'BINANCE_WALLET_NOT_VERIFIED'
 address=str(wallets[0].get('walletAddress') or '')
assert address,'WALLET_ADDRESS_UNAVAILABLE'
positions=get('/sapi/v1/w3w/wallet/prediction/position/list',
 {'walletAddress':address,'tab':'ONGOING','offset':0,'limit':100}).get('positions')
assert isinstance(positions,list),'ONGOING_POSITION_DATA_INVALID'
assert len(positions)<100,'PAGINATION_NEEDS_EXHAUSTIVE_CHECK'
open_positions=[x for x in positions if str(x.get('positionStatus','OPEN')).upper()=='OPEN']
print('GUARDIAN_BINANCE_ONGOING_POSITIONS',len(open_positions))
assert not open_positions,'EXISTING_POSITION_RISK_WORKER_RESTART_ABORT'
print('GUARDIAN_NO_OPEN_POSITION_CONFIRMED=true')
PY
python3 - <<'PY'
import json,urllib.request
def get(port,route):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,route),timeout=8) as r:return json.load(r)
s=get(13001,'/api/status')
g=get(13049,'/api/status')
assert s.get('ok') and s.get('enabled') is False,'LIVE_FOLLOW_ON_ABORT'
assert not s.get('pendingAction'),'PENDING_ORDER_ABORT'
assert s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1'
assert g.get('automaticTradeEligibility',{}).get('eligible') is False
print('GUARDIAN_RISK_STAGING_PREFLIGHT=true')
PY
for f in risk-worker.mjs risk-runner.mjs guardian-risk-integration.mjs guardian-dynamic-exit.mjs;do
 curl -fsSL --retry 2 --max-time 25 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$SHA/railway-diagnostic/$f" -o "$STAGE/$f"
 "$NODE" --check "$STAGE/$f"
done
for f in risk-worker.mjs risk-runner.mjs;do
 curl -fsSL --retry 2 --max-time 25 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$OLD/railway-diagnostic/$f" -o "$STAGE/$f.old"
 if ! cmp -s "$STAGE/$f.old" "$BASE/$f";then
  echo "GUARDIAN_RISK_SOURCE_DRIFT_ABORT=$f"
  diff -u "$STAGE/$f.old" "$BASE/$f" | head -n 75 || true
  exit 31
 fi
done
for f in risk-worker.mjs risk-runner.mjs guardian-risk-integration.mjs guardian-dynamic-exit.mjs;do
 if test -f "$BASE/$f";then cp -p "$BASE/$f" "$BACK/$f";else touch "$BACK/$f.absent";fi
done
rollback(){
 echo GUARDIAN_RISK_ROLLBACK_STARTED=true
 for f in risk-worker.mjs risk-runner.mjs guardian-risk-integration.mjs guardian-dynamic-exit.mjs;do
  if test -f "$BACK/$f";then cp -p "$BACK/$f" "$BASE/$f"
  elif test -f "$BACK/$f.absent";then rm -f "$BASE/$f";fi
 done
 systemctl restart zl-prediction-risk-exits >/dev/null 2>&1 || true
 echo GUARDIAN_RISK_ROLLBACK_COMPLETE=true
}
trap rollback ERR
for f in risk-worker.mjs risk-runner.mjs guardian-risk-integration.mjs guardian-dynamic-exit.mjs;do
 cp "$STAGE/$f" "$BASE/$f"
 chown "$(stat -c %u "$BACK/risk-worker.mjs")":"$(stat -c %g "$BACK/risk-worker.mjs")" "$BASE/$f"
 chmod 0644 "$BASE/$f"
done
systemctl restart zl-prediction-risk-exits
ready=no
for i in $(seq 1 25);do
 if systemctl is-active --quiet zl-prediction-risk-exits &&
    curl -fsS --max-time 4 http://127.0.0.1:13001/api/risk-control -o "$STAGE/risk.json" 2>/dev/null;then
  if python3 - "$STAGE/risk.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
assert s.get('ok') and s.get('persistenceHealthy') is True
PY
  then ready=yes;break;fi
 fi
 sleep 2
done
test "$ready" = yes
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=6) as r:s=json.load(r)
assert s.get('ok') and s.get('enabled') is False
assert not s.get('pendingAction') and s.get('orderSignal') is None
print('GUARDIAN_TRADE_STILL_OFF=true')
PY
systemctl is-active --quiet zl-prediction-trade
systemctl is-active --quiet zl-prediction-risk-exits
echo GUARDIAN_RISK_CODE_STAGED_ON_ALIBABA=true
echo GUARDIAN_DYNAMIC_EXIT_DEFAULT_OFF=true
echo GUARDIAN_RISK_BACKUP="$BACK"
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
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',name='guardian-risk-code-stage',
  type='RunShellScript',command_content=SCRIPT.replace('__TARGET_SHA__',sha),
  working_user='root',timeout=180)).body.invoke_id
 for _ in range(95):
  time.sleep(2)
  d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(d.output or '')
   print('GUARDIAN_RISK_REMOTE',d.invocation_status,'EXIT',d.exit_code)
   print(o[-9500:])
   return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'GUARDIAN_RISK_CODE_STAGED_ON_ALIBABA=true' in o else 5
 print('GUARDIAN_RISK_STAGE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

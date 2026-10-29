#!/usr/bin/env python3
"""Deploy PIN/site-auth gated Guardian switch to existing Alibaba, fail closed.
No BUY/SELL API writes; no live risk approval; no unrelated Worker replacement.
"""
import os,sys,re,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

BASE_SHA='16350d9faa9046224702f82a5c8f34f6cc1d9f68'
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
ROOT=/opt/zl-prediction-live/src/railway-diagnostic
NODE=/opt/zl-prediction-node/bin/node
SHA=__TARGET_SHA__
BASE_SHA=__BASE_SHA__
STAGE=$(mktemp -d /tmp/guardian-dynamic-toggle-XXXXXX)
BACK=/var/backups/guardian-dynamic-toggle-$(date -u +%Y%m%dT%H%M%SZ)-$$
trap 'rm -rf "$STAGE"' EXIT
exec 9>/tmp/guardian-dynamic-toggle-deploy.lock
flock -n 9
test -x "$NODE"
for unit in zl-prediction-trade zl-prediction-risk-exits zl-prediction-guardian-analysis;do
 systemctl is-active --quiet "$unit"
done
python3 - <<'PY'
import json,urllib.request
def get(port,route):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,route),timeout=7) as r:return json.load(r)
trade=get(13001,'/api/status')
risk=get(13001,'/api/risk-control')
guardian=get(13049,'/api/status')
assert trade.get('ok') and trade.get('enabled') is False,'LIVE_FOLLOW_ACTIVE_ABORT'
assert not trade.get('pendingAction'),'PENDING_BUY_ABORT'
assert trade.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1','MODEL_CHANGED_ABORT'
assert risk.get('ok') and risk.get('persistenceHealthy') is True,'REDIS_UNHEALTHY_ABORT'
assert guardian.get('ok') and guardian.get('model')=='ZL_GUARDIAN_5M_V1'
assert guardian.get('automaticTradeEligibility',{}).get('eligible') is False,'LIVE_ELIGIBILITY_CHANGE_REVIEW'
print('GUARDIAN_TOGGLE_PREFLIGHT_SAFE=true')
PY
# Check EVERY ongoing Binance prediction position before risk-worker restart.
RISK_PID=$(pgrep -f '/opt/zl-prediction-node/bin/node risk-worker.mjs' | head -n 1)
test -n "$RISK_PID"
RISK_PID="$RISK_PID" python3 - <<'PY'
import json,os,time,hmac,hashlib,urllib.parse,urllib.request
pid=os.environ['RISK_PID']
env=dict(k.split(b'=',1) for k in open('/proc/'+pid+'/environ','rb').read().split(b'\0') if b'=' in k)
def v(k):return env.get(k.encode(),b'').decode()
key,secret=v('BINANCE_PREDICTION_API_KEY'),v('BINANCE_PREDICTION_API_SECRET')
assert key and secret,'BINANCE_READONLY_ACCESS_REQUIRED'
def get(path,args={}):
 p={**args,'timestamp':str(int(time.time()*1000)),'recvWindow':'5000'}
 query=urllib.parse.urlencode(p)
 sig=hmac.new(secret.encode(),query.encode(),hashlib.sha256).hexdigest()
 req=urllib.request.Request('https://api.binance.com'+path+'?'+query+'&signature='+sig,headers={'X-MBX-APIKEY':key})
 with urllib.request.urlopen(req,timeout=9) as r:return json.load(r)
wallet=v('BINANCE_PREDICTION_WALLET_ADDRESS')
if not wallet:
 row=get('/sapi/v1/w3w/wallet/prediction/wallet/list').get('wallets')
 assert isinstance(row,list) and len(row)==1,'AMBIGUOUS_WALLET_REQUIRES_REVIEW'
 wallet=row[0].get('walletAddress')
assert wallet,'WALLET_MISSING'
positions=get('/sapi/v1/w3w/wallet/prediction/position/list',{'walletAddress':wallet,'tab':'ONGOING','offset':0,'limit':100}).get('positions')
assert isinstance(positions,list) and len(positions)<100,'INVALID_OR_PAGINATED_POSITIONS'
active=[p for p in positions if str(p.get('positionStatus','OPEN')).upper()=='OPEN']
print('GUARDIAN_TOGGLE_ONGOING_POSITIONS',len(active))
assert not active,'OPEN_POSITION_RESTART_ABORT'
PY
mkdir -p "$STAGE/base" "$STAGE/new" "$STAGE/out"
for f in control-shell.mjs risk-config-storage.mjs risk-runner.mjs;do
 curl -fsSL --retry 2 --max-time 30 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$BASE_SHA/railway-diagnostic/$f" -o "$STAGE/base/$f"
 curl -fsSL --retry 2 --max-time 30 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$SHA/railway-diagnostic/$f" -o "$STAGE/new/$f"
done
curl -fsSL --retry 2 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$SHA/prediction-bot-v1/guardian_toggle_overlay.py" -o "$STAGE/guardian_toggle_overlay.py"
curl -fsSL --retry 2 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$SHA/railway-diagnostic/guardian-main-dashboard.mjs" -o "$STAGE/out/guardian-main-dashboard.mjs"
python3 - "$STAGE" "$ROOT" <<'PY'
import sys,hashlib
from pathlib import Path
stage=Path(sys.argv[1]);prod=Path(sys.argv[2])
sys.path.insert(0,str(stage))
from guardian_toggle_overlay import transform_files
# Dashboard was independently verified identical to the GitHub base.
p=prod/'guardian-main-dashboard.mjs'
data=p.read_bytes()
blob=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
assert blob=='1c6a2998710a13fb707e3bbccfb0f130d15530fe','LIVE_DASHBOARD_CHANGED_ABORT'
print('GUARDIAN_TOGGLE_OVERLAY',transform_files(stage/'base',stage/'new',prod,stage/'out'))
PY
for f in control-shell.mjs risk-config-storage.mjs risk-runner.mjs guardian-main-dashboard.mjs;do
 "$NODE" --check "$STAGE/out/$f"
done
python3 - "$STAGE/out" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
c=(p/'control-shell.mjs').read_text()
r=(p/'risk-runner.mjs').read_text()
g=(p/'guardian-main-dashboard.mjs').read_text()
assert 'x-zl-verified-login' in c,'LIVE_LOGIN_AUTH_MUST_SURVIVE'
assert 'function riskExecutionStatus' in c,'LIVE_RISK_HEALTH_MUST_SURVIVE'
assert 'guardianRiskToggleStatus' in c and "pinOK(body.pin, req)" in c
assert 'guardianOpenExposure' in r and 'GUARDIAN_UI_APPROVED' in r
assert 'zlGRiskToggleButton' in g and 'zlGuardianToggleRisk' in g
assert '/api/guardian-dynamic-risk' in c
print('GUARDIAN_TOGGLE_SECURITY_ANCHORS_PASSED=true')
PY
mkdir -p -m 700 "$BACK"
for f in control-shell.mjs risk-config-storage.mjs risk-runner.mjs guardian-main-dashboard.mjs;do cp -p "$ROOT/$f" "$BACK/$f";done
rollback(){
 echo GUARDIAN_TOGGLE_ROLLBACK_STARTED=true
 for f in control-shell.mjs risk-config-storage.mjs risk-runner.mjs guardian-main-dashboard.mjs;do cp -p "$BACK/$f" "$ROOT/$f";done
 systemctl restart zl-prediction-trade >/dev/null 2>&1 || true
 systemctl restart zl-prediction-risk-exits >/dev/null 2>&1 || true
 echo GUARDIAN_TOGGLE_ROLLBACK_DONE=true
}
trap rollback ERR
for f in control-shell.mjs risk-config-storage.mjs risk-runner.mjs guardian-main-dashboard.mjs;do
 install -m 0644 -o "$(stat -c %u "$BACK/$f")" -g "$(stat -c %g "$BACK/$f")" "$STAGE/out/$f" "$ROOT/$f"
done
systemctl restart zl-prediction-risk-exits
systemctl restart zl-prediction-trade
ready=no
for i in $(seq 1 40);do
 if systemctl is-active --quiet zl-prediction-risk-exits &&
    systemctl is-active --quiet zl-prediction-trade &&
    curl -fsS --max-time 4 http://127.0.0.1:13001/api/guardian-dynamic-risk -o "$STAGE/toggle.json" 2>/dev/null &&
    curl -fsS --max-time 4 http://127.0.0.1:13001/api/status -o "$STAGE/status.json" 2>/dev/null &&
    curl -fsS --max-time 4 http://127.0.0.1:13001/ -o "$STAGE/main.html" 2>/dev/null;then
  if python3 - "$STAGE/toggle.json" "$STAGE/status.json" "$STAGE/main.html" <<'PY'
import sys,json
toggle=json.load(open(sys.argv[1]))
trade=json.load(open(sys.argv[2]))
html=open(sys.argv[3]).read()
assert toggle.get('ok') and toggle.get('requestedEnabled') is False
assert toggle.get('effectiveEnabled') is False and toggle.get('canEnable') is False
assert trade.get('ok') and trade.get('enabled') is False
assert not trade.get('pendingAction')
assert 'id="zlGRiskToggleButton"' in html
assert 'guardian-dynamic-risk' in html
print('GUARDIAN_TOGGLE_REAL_UI_VISIBLE=true')
print('GUARDIAN_DYNAMIC_RISK_SAFELY_OFF=true')
PY
  then ready=yes;break;fi
 fi
 sleep 2
done
test "$ready" = yes
python3 - <<'PY'
import json,urllib.request,urllib.error
req=urllib.request.Request('http://127.0.0.1:13001/api/guardian-dynamic-risk',
  data=b'{"enabled":true}',headers={'Content-Type':'application/json'},method='POST')
try:
 with urllib.request.urlopen(req,timeout=5) as r:
  raise AssertionError('UNAUTHENTICATED_GUARDIAN_TOGGLE_ACCEPTED')
except urllib.error.HTTPError as e:
 assert e.code in (401,403),'UNAUTHENTICATED_GUARDIAN_TOGGLE_MUST_REJECT'
print('GUARDIAN_TOGGLE_UNAUTHENTICATED_WRITE_REJECTED=true')
PY
echo GUARDIAN_TOGGLE_UI_DEPLOYED=true
echo GUARDIAN_TOGGLE_LIVE_TRADING_STILL_OFF=true
echo GUARDIAN_TOGGLE_BACKUP="$BACK"
sha256sum "$ROOT"/guardian-main-dashboard.mjs "$ROOT"/control-shell.mjs
trap - ERR
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/guardian-dynamic-risk-ui-toggle' or not re.fullmatch('[0-9a-f]{40}',sha):
  print('GUARDIAN_TOGGLE_BAD_BRANCH');return 2
 cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 inv=cli.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  name='guardian-dynamic-toggle-safety-gated-stage',type='RunShellScript',
  command_content=SCRIPT.replace('__TARGET_SHA__',sha).replace('__BASE_SHA__',BASE_SHA),
  working_user='root',timeout=240)).body.invoke_id
 for _ in range(125):
  time.sleep(2)
  status=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if status and str(status.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(status.output or '',validate=True).decode('utf8','replace')
   except Exception:out=str(status.output or '')
   print('GUARDIAN_TOGGLE_REMOTE',status.invocation_status,'EXIT',status.exit_code)
   print(out[-14500:])
   return 0 if str(status.invocation_status)=='Success' and int(status.exit_code)==0 and 'GUARDIAN_TOGGLE_UI_DEPLOYED=true' in out else 5
 print('GUARDIAN_TOGGLE_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

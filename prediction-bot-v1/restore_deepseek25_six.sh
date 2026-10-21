#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
app=/opt/zl-prediction-live/deepseek5
trade=/opt/zl-prediction-live/src/railway-diagnostic
node=/opt/zl-prediction-node/bin/node
backup=/var/lib/zl-prediction/archive/source-backups/deepseek-single9-5cc34e017520f4eaa114c0c9ddba6656a328eb6e
base=7d982bb65a0aba0c977db90167ffcdada16e7184
files="deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs deepseek-adaptive15-quality-store.mjs deepseek-adaptive15-error-attribution.mjs"
test -x "$node" && test -d "$backup"
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper zl-deepseek-shadow-online zl-deepseek-shadow15-online;do
 test "$(systemctl is-active "$svc")" = active || { echo "ROLLBACK_BLOCKED_SERVICE_DOWN=$svc";exit 10; }
done
python3 - <<'PY'
import urllib.request,json
def g(p,e):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(p,e),timeout=7) as r:return json.load(r)
a=g(13029,'/api/status');t=g(13001,'/api/status');c=g(13001,'/api/order-signal-model')
assert a.get('providerModel')=='deepseek-flash'
assert a.get('decisionWindowEndMs')-a.get('round')==9000
assert a.get('maxCallsPerRound')==1
assert t.get('enabled') is False,'FOLLOW_ON_ABORT'
assert c.get('model')=='DEEPSEEK_5M_V1'
print('ROLLBACK_PRECHECK_CURRENT_9S=true')
print('ROLLBACK_FOLLOW_BEFORE=false')
print('ROLLBACK_OFFICIAL_BEFORE',(a.get('learning') or {}).get('allOfficialSamples'))
print('ROLLBACK_WAIT_BEFORE',a.get('recordedWaitRounds'))
PY
tmp=$(mktemp -d /tmp/zl-back25-XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/curr"
for name in $files;do
 test -s "$backup/$name"
 curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$base/prediction-bot-v1/$name" -o "$tmp/$name"
 cmp -s "$backup/$name" "$tmp/$name" || { echo "BACKUP_NOT_BASELINE=$name";exit 15; }
 "$node" --check "$backup/$name"
 cp -p "$app/$name" "$tmp/curr/$name"
done
for name in production-signal-choice.mjs panel-stats-shell.mjs;do
 test -s "$backup/$name"
 "$node" --check "$backup/$name"
 cp -p "$trade/$name" "$tmp/curr/$name"
done
python3 - "$backup" "$trade" <<'PY'
from pathlib import Path
import sys
bak,live=map(Path,sys.argv[1:])
v=(bak/'production-signal-choice.mjs').read_text()
p=(bak/'panel-stats-shell.mjs').read_text()
cv=(live/'production-signal-choice.mjs').read_text()
cp=(live/'panel-stats-shell.mjs').read_text()
assert v.count('ts<round||ts>=round+25000||now>=round+25000||marketAt<round||marketAt>ts||')==1
assert p.count('var expired=Date.now()>=currentRound+25000;')==1
assert cv.count('ts<round||ts>=round+9000||now>=round+9000||marketAt<round||marketAt>ts||')==1
assert cp.count('var expired=Date.now()>=currentRound+9000;')==1
assert 'const SELECTIVE30_ORDER_DEADLINE_MS = 30000;' in (live/'wrapper.mjs').read_text()
print('ROLLBACK_BACKUP_VALIDATOR_UI_VERIFIED=true')
PY
recover9(){
 echo 'ROLLBACK_RESTORE_9S_ON_ERROR=true'
 for name in $files;do cp -p "$tmp/curr/$name" "$app/$name";done
 for name in production-signal-choice.mjs panel-stats-shell.mjs;do cp -p "$tmp/curr/$name" "$trade/$name";done
 systemctl restart zl-prediction-deepseek5.service zl-prediction-trade.service || true
}
trap recover9 ERR
python3 - <<'PY'
import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:x=json.load(r)
assert x.get('enabled') is False,'FOLLOW_ON_ABORT'
PY
for name in $files;do cp -p "$backup/$name" "$app/$name";done
for name in production-signal-choice.mjs panel-stats-shell.mjs;do cp -p "$backup/$name" "$trade/$name";done
systemctl restart zl-prediction-deepseek5.service zl-prediction-trade.service
for i in $(seq 1 25);do
 if curl -fsS --max-time 3 http://127.0.0.1:13029/api/status -o "$tmp/status.json" 2>/dev/null &&
 curl -fsS --max-time 3 http://127.0.0.1:13001/api/status -o "$tmp/trade.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$tmp/status.json" && test -s "$tmp/trade.json"
python3 - "$tmp/status.json" "$tmp/trade.json" <<'PY'
import sys,json
a=json.load(open(sys.argv[1]));t=json.load(open(sys.argv[2]))
assert a.get('providerModel')=='deepseek-flash'
assert a.get('decisionWindowEndMs')-a.get('round')==25000
assert a.get('strictLockDeadlineMs')-a.get('round')==25000
assert a.get('maxCallsPerRound')==6
assert a.get('preRoundMaxCalls')==2
assert a.get('currentRoundMaxCalls')==4
assert a.get('analysisCountLimit')=='PRE2_LIVE4_TOTAL6'
assert a.get('noSignalAfterDeadline') is True
assert t.get('enabled') is False
print('ROLLBACK_PRODUCTION_25S=true')
print('ROLLBACK_MAX_CALLS=6')
print('ROLLBACK_PRE_CALLS=2')
print('ROLLBACK_LIVE_CALLS=4')
print('ROLLBACK_FOLLOW_AFTER=false')
print('ROLLBACK_OFFICIAL_AFTER',(a.get('learning') or {}).get('allOfficialSamples'))
print('ROLLBACK_WAIT_AFTER',a.get('recordedWaitRounds'))
PY
"$node" --input-type=module - <<'NODE'
import {validateDeepSeekProductionLive} from '/opt/zl-prediction-live/src/railway-diagnostic/production-signal-choice.mjs';
const r=1800000300000;
function s(t){return {ok:true,model:'DEEPSEEK_5M_V1',round:r,
 readOnly:true,orders:false,productionIntegration:false,providerModel:'deepseek-flash',
 generatedAt:r+t,expiryAt:r+270000,latest:{model:'DEEPSEEK_5M_V1',round:r,
 status:'LOCKED',direction:'UP',lockedAt:r+t,marketAt:r+t-200,
 entry:{direction:'UP',modelVersion:'DEEPSEEK_5M_V1'}}};}
if(!validateDeepSeekProductionLive(s(20000),r+21000).ok)throw Error('20S_SIGNAL_REJECTED');
if(validateDeepSeekProductionLive(s(20000),r+25000).ok)throw Error('25S_FETCH_ACCEPTED');
if(validateDeepSeekProductionLive(s(25000),r+26000).ok)throw Error('25S_LOCK_ACCEPTED');
console.log('ROLLBACK_TRADER_20S_ACCEPT_25S_REJECT=true');
NODE
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper zl-deepseek-shadow-online zl-deepseek-shadow15-online;do test "$(systemctl is-active "$svc")" = active;done
echo 'ROLLBACK_ALL_SERVICES_ACTIVE=true'
trap - ERR

#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" = 0
app=/opt/zl-prediction-live/deepseek5
trade=/opt/zl-prediction-live/src/railway-diagnostic
node=/opt/zl-prediction-node/bin/node
test -x "$node"
for s in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper zl-deepseek-shadow-online zl-deepseek-shadow15-online;do test "$(systemctl is-active "$s")" = active;done
python3 - <<'PY'
import json,urllib.request
def g(p,u):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(p,u),timeout=7) as r:return json.load(r)
a=g(13029,'/api/status');t=g(13001,'/api/status');c=g(13001,'/api/order-signal-model')
assert a.get('providerModel')=='deepseek-flash' and a.get('maxCallsPerRound')==6
assert a.get('decisionWindowEndMs')-a.get('round')==25000
assert t.get('enabled') is False and c.get('model')=='DEEPSEEK_5M_V1'
print('PRECHECK_FOLLOW_OFF=true')
print('HISTORY_BEFORE',a.get('learning',{}).get('allOfficialSamples'),a.get('recordedWaitRounds'))
PY
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/new"
names="deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs deepseek-adaptive15-production-adapter.mjs deepseek-adaptive15-quality-store.mjs deepseek-adaptive15-error-attribution.mjs"
for name in $names;do
 curl -fsSL --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$BASE_SHA/prediction-bot-v1/$name" > "$tmp/$name"
 cmp -s "$tmp/$name" "$app/$name" || { echo "SOURCE_DRIFT=$name";exit 15; }
 curl -fsSL --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$TARGET_SHA/prediction-bot-v1/$name" > "$tmp/new/$name"
 "$node" --check "$tmp/new/$name"
done
python3 - "$trade" "$tmp/new" <<'PY'
from pathlib import Path
import sys
base,out=map(Path,sys.argv[1:])
v=(base/'production-signal-choice.mjs').read_text()
old='ts<round||ts>=round+25000||now>=round+25000||marketAt<round||marketAt>ts||'
assert v.count(old)==1
(out/'production-signal-choice.mjs').write_text(v.replace(old,'ts<round||ts>=round+9000||now>=round+9000||marketAt<round||marketAt>ts||'))
p=(base/'panel-stats-shell.mjs').read_text()
assert p.count('var expired=Date.now()>=currentRound+25000;')==1
p=p.replace('var expired=Date.now()>=currentRound+25000;','var expired=Date.now()>=currentRound+9000;')
p=p.replace("x.reason==='DEADLINE_25S_EXPIRED'||x.timedOut?'（25秒超时WAIT）'","x.reason==='DEADLINE_9S_EXPIRED'||x.timedOut?'（9秒超时WAIT）'")
(out/'panel-stats-shell.mjs').write_text(p)
assert 'const SELECTIVE30_ORDER_DEADLINE_MS = 30000;' in (base/'wrapper.mjs').read_text()
PY
"$node" --check "$tmp/new/production-signal-choice.mjs"
"$node" --check "$tmp/new/panel-stats-shell.mjs"
backup="/var/lib/zl-prediction/archive/source-backups/deepseek-single9-$TARGET_SHA"
mkdir -p "$backup"
for name in $names;do cp -p "$app/$name" "$backup/$name";done
for name in production-signal-choice.mjs panel-stats-shell.mjs;do cp -p "$trade/$name" "$backup/$name";done
rollback(){
 echo 'SINGLE9_ROLLBACK=true'
 for name in $names;do cp -p "$backup/$name" "$app/$name";done
 for name in production-signal-choice.mjs panel-stats-shell.mjs;do cp -p "$backup/$name" "$trade/$name";done
 systemctl restart zl-prediction-deepseek5 zl-prediction-trade || true
}
trap rollback ERR
python3 - <<'PY'
import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:t=json.load(r)
assert t.get('enabled') is False
PY
for name in $names;do cp -p "$tmp/new/$name" "$app/$name";done
for name in production-signal-choice.mjs panel-stats-shell.mjs;do cp -p "$tmp/new/$name" "$trade/$name";done
systemctl restart zl-prediction-deepseek5 zl-prediction-trade
for i in $(seq 1 25);do
 if curl -fsS --max-time 3 http://127.0.0.1:13029/api/status > "$tmp/s" 2>/dev/null;then break;fi
 sleep 2
done
python3 - "$tmp/s" <<'PY'
import json,sys,urllib.request
s=json.load(open(sys.argv[1]))
assert s['decisionWindowEndMs']-s['round']==9000
assert s['maxCallsPerRound']==1 and s['preRoundMaxCalls']==0 and s['currentRoundMaxCalls']==1
assert s['providerModel']=='deepseek-flash' and s['noSignalAfterDeadline'] is True
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:t=json.load(r)
assert t.get('enabled') is False
print('SINGLE9_CONFIG_ACTIVE=true')
print('FOLLOW_STILL_OFF=true')
print('HISTORY_AFTER',s.get('learning',{}).get('allOfficialSamples'),s.get('recordedWaitRounds'))
PY
for s in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper zl-deepseek-shadow-online zl-deepseek-shadow15-online;do test "$(systemctl is-active "$s")" = active;done
echo ALL_SERVICES_ACTIVE=true
trap - ERR

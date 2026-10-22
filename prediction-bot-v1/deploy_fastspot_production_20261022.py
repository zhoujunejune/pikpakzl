#!/usr/bin/env python3
"""Guarded production deploy of uncached BTC price feed. No order mutation."""
import os,re,time,base64,sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH='fix/fast-feed-and-trigger-20261022'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
NODE=/opt/zl-prediction-node/bin/node
IDX=/opt/zl-prediction-live/src/fast-signal-engine/index.mjs
SPOT=/opt/zl-prediction-live/src/fast-signal-engine/shadow-market-readonly.mjs
AI=/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs
test "$(id -u)" = 0 && test -x "$NODE" && test -f "$IDX" && test -f "$SPOT" && test -f "$AI"
for unit in zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-prediction-risk-exits zl-deepseek-results-display-only zl-futures-bot-paper;do
 test "$(systemctl is-active "$unit")" = active || { echo "FASTSPOT_REQUIRED_SERVICE_DOWN=$unit";exit 3; }
done
W=$(mktemp -d /tmp/fastspot-zl-XXXXXXXX)
trap 'rm -rf "$W"' EXIT
python3 - "$W" <<'PY'
from pathlib import Path
import json,urllib.request,sys
w=Path(sys.argv[1])
def get(port,path):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=7) as r:return json.load(r)
m=get(13029,'/api/status')
t=get(13001,'/api/status')
selection=get(13001,'/api/order-signal-model')
assert m.get('decisionRule')=='DEEPSEEK_100MS_THEN_CURRENT_ROUND_PRICE_FALLBACK'
assert m.get('decisionWindowEndMs',0)-m.get('round',0)==100
assert t.get('enabled') is False,'FOLLOW_ON_ABORT'
assert not (t.get('pendingAction') or {}).get('state') in ('QUOTING','SUBMITTING','SUBMISSION_UNKNOWN')
assert selection.get('model')=='DEEPSEEK_5M_V1'
idx=Path('/opt/zl-prediction-live/src/fast-signal-engine/index.mjs').read_text()
spot=Path('/opt/zl-prediction-live/src/fast-signal-engine/shadow-market-readonly.mjs').read_text()
ai=Path('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-production-adapter.mjs').read_text()
assert idx.count("  // Shadow-only public OHLCV read endpoint. This path cannot control prediction or trading.")==1
assert "url.pathname==='/api/shadow-market-fast'" not in idx
assert 'const breakout20ReadonlyFeed = createReadOnlyMarketFeed' in idx
assert '  function spot() {' in spot and '    async read() {' in spot
assert 'readSpot() {' not in spot
assert spot.count('const CACHE_MS = 1800;')==1
assert ai.count("const FEED='http://127.0.0.1:13003/api/shadow-market-data';")==1
assert ai.count("const AI_LIMIT_MS=100;")==1
w.joinpath('before.json').write_text(json.dumps({'follow':False,'model':selection['model']}))
print('FASTSPOT_SOURCE_PREFLIGHT_SUCCESS=true')
PY
cp -p "$IDX" "$W/index.mjs"
cp -p "$SPOT" "$W/shadow-market-readonly.mjs"
cp -p "$AI" "$W/model.mjs"
python3 - "$W" <<'PY'
from pathlib import Path
import sys
w=Path(sys.argv[1])
idx=w/'index.mjs'
s=idx.read_text()
needle="  // Shadow-only public OHLCV read endpoint. This path cannot control prediction or trading."
assert s.count(needle)==1
patch="""  // Uncached in-process real BTC price and five-minute open; read-only.
  // Does not request OHLCV/Klines, create signals, or submit orders.
  if (req.method==='GET' && url.pathname==='/api/shadow-market-fast') {
    const data=breakout20ReadonlyFeed.readSpot();
    res.writeHead(data.ok?200:503,{'content-type':'application/json; charset=utf-8'});
    return res.end(JSON.stringify(data));
  }

"""
idx.write_text(s.replace(needle,patch+needle))
spot=w/'shadow-market-readonly.mjs'
s=spot.read_text()
needle='  return {\n    async read() {'
assert s.count(needle)==1,'SPOT_READER_ANCHOR_CHANGED'
patch="""  return {
    // Live in-memory snapshot, no 1800ms cache or Binance Klines request.
    readSpot() {
      try {
        const latest=spot();
        if(!Number.isSafeInteger(latest.roundStartMs)||latest.roundStartMs<=0||
           !(latest.roundOpenPrice>0)||!(latest.lastPrice>0))
          throw Error('CURRENT_ROUND_OPEN_UNAVAILABLE');
        return {ok:true,schemaVersion:1,readOnly:true,symbol:SYMBOL,
          generatedAtMs:now(),source:'EXISTING_LIVE_BINANCE_SPOT_SNAPSHOT_NO_KLINES',latest};
      }catch(e){
        return {ok:false,readOnly:true,symbol:SYMBOL,latest:null,
          error:errorMessage(e),generatedAtMs:now()};
      }
    },
    async read() {"""
spot.write_text(s.replace(needle,patch))
ai=w/'model.mjs';s=ai.read_text()
needle="const FEED='http://127.0.0.1:13003/api/shadow-market-data';"
assert s.count(needle)==1
ai.write_text(s.replace(needle,"const FEED='http://127.0.0.1:13003/api/shadow-market-fast';"))
print('FASTSPOT_EXACT_RUNTIME_PATCHES_CREATED=true')
PY
"$NODE" --check "$W/index.mjs"
"$NODE" --check "$W/shadow-market-readonly.mjs"
"$NODE" --check "$W/model.mjs"
# The owner might have supplied an explicit old URL override.
python3 - <<'PY'
from pathlib import Path
for p in Path('/proc').glob('[0-9]*/cmdline'):
 try:
  if b'deepseek-adaptive15-production-adapter.mjs' not in p.read_bytes():continue
  env=(p.parent/'environ').read_bytes().split(b'\0')
  for v in env:
   if v.startswith(b'ADAPTIVE15_MARKET_URL=') and b'/api/shadow-market-data' in v:
    raise SystemExit('FASTSPOT_OLD_FEED_OVERRIDE_NO_CHANGE')
 except PermissionError:continue
print('FASTSPOT_ENV_OVERRIDE_SAFE=true')
PY
python3 - <<'PY'
import time,urllib.request,json
for i in range(150):
 age=int(time.time()*1000)%300000
 if 40000<=age<=225000:
  with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as r:t=json.load(r)
  assert t.get('enabled') is False,'FOLLOW_TURNED_ON_ABORT'
  print('FASTSPOT_SAFE_ROUND_MS',age);break
 time.sleep(1)
else:raise SystemExit('NO_SAFE_ROUND_NO_CHANGES')
PY
BACKUP=/var/lib/zl-prediction/archive/source-backups/fastspot-COMMIT_SHA
test ! -e "$BACKUP"
mkdir -p "$BACKUP"
cp -p "$IDX" "$BACKUP/old-index.mjs"
cp -p "$SPOT" "$BACKUP/old-spot.mjs"
cp -p "$AI" "$BACKUP/old-ai.mjs"
rollback(){
 echo FASTSPOT_ROLLBACK_TRIGGERED=true
 cp -p "$BACKUP/old-index.mjs" "$IDX" || true
 cp -p "$BACKUP/old-spot.mjs" "$SPOT" || true
 cp -p "$BACKUP/old-ai.mjs" "$AI" || true
 systemctl restart zl-prediction-v3.service || true
 systemctl restart zl-prediction-deepseek5.service || true
}
trap rollback ERR
chown --reference="$IDX" "$W/index.mjs";chmod --reference="$IDX" "$W/index.mjs"
chown --reference="$SPOT" "$W/shadow-market-readonly.mjs";chmod --reference="$SPOT" "$W/shadow-market-readonly.mjs"
chown --reference="$AI" "$W/model.mjs";chmod --reference="$AI" "$W/model.mjs"
cp -p "$W/index.mjs" "$IDX"
cp -p "$W/shadow-market-readonly.mjs" "$SPOT"
cp -p "$W/model.mjs" "$AI"
systemctl restart zl-prediction-v3.service
python3 - <<'PY'
import urllib.request,json,time
for i in range(105):
 try:
  with urllib.request.urlopen('http://127.0.0.1:13003/api/shadow-market-fast',timeout=3) as r:x=json.load(r)
  if x.get('ok') is True and x.get('readOnly') is True and x.get('source')=='EXISTING_LIVE_BINANCE_SPOT_SNAPSHOT_NO_KLINES':
   p=x.get('latest') or {}
   assert p.get('roundOpenPrice',0)>0 and p.get('lastPrice',0)>0
   print('FASTSPOT_LIVE_SPOT_HEALTHY=true')
   print('FASTSPOT_LIVE_SPOT_EVENT_LAG_MS',p.get('ageMs'));break
 except Exception:pass
 time.sleep(1)
else:raise SystemExit('FASTSPOT_NO_VALID_MARKET_ROLLBACK')
PY
systemctl restart zl-prediction-deepseek5.service
python3 - <<'PY'
import urllib.request,json,time,subprocess
def get(port,path):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=8) as r:return json.load(r)
for i in range(35):
 try:
  ai=get(13029,'/api/status')
  if ai.get('decisionRule')=='DEEPSEEK_100MS_THEN_CURRENT_ROUND_PRICE_FALLBACK':break
 except Exception:pass
 time.sleep(1)
else:raise SystemExit('FASTSPOT_AI_NOT_READY_ROLLBACK')
assert ai.get('decisionWindowEndMs',0)-ai.get('round',0)==100
spot=get(13003,'/api/shadow-market-fast')
assert spot.get('ok') is True and spot.get('readOnly') is True
assert spot.get('source')=='EXISTING_LIVE_BINANCE_SPOT_SNAPSHOT_NO_KLINES'
t=get(13001,'/api/status')
assert t.get('enabled') is False
assert get(13001,'/api/order-signal-model').get('model')=='DEEPSEEK_5M_V1'
for unit in ('zl-prediction-v3.service','zl-prediction-deepseek5.service',
 'zl-prediction-trade.service','zl-prediction-risk-exits.service',
 'zl-deepseek-results-display-only.service','zl-futures-bot-paper.service'):
 assert subprocess.run(['systemctl','is-active','--quiet',unit]).returncode==0,unit
print('FASTSPOT_PRODUCTION_UNCACHED_FEED_AND_AI_SUCCESS=true')
print('FASTSPOT_FOLLOW_REMAINED_OFF=true')
print('FASTSPOT_TRADE_RISK_FUTURES_UNTOUCHED=true')
PY
echo "FASTSPOT_BACKUP_DIR=$BACKUP"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[0-9a-f]{40}',sha):return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,name='zl-fastspot-market-guarded-deploy',type='RunShellScript',working_user='root',command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=285)).body.invoke_id
 for _ in range(155):
  time.sleep(2)
  r=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:o=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:o=str(r.output)
   print('FASTSPOT_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(o[-10000:])
   return 0 if int(r.exit_code)==0 else 5
 print('FASTSPOT_RESULT_UNKNOWN');return 6
if __name__=='__main__':sys.exit(main())

#!/usr/bin/env python3
"""Guarded, reversible Alibaba prediction quote latency optimization.
Quote is NOT an order. Never retry a real place-order request, and never
restart while the owner follows or a live intent can be in flight.
"""
import os, re, time, base64, sys
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

BRANCH = "fix/quote-speed-guarded-20261023"
INSTANCE = "b67374069bb3457ba6a3a2ede9305d3f"

REMOTE = r"""#!/bin/bash
set -Eeuo pipefail
NODE=/opt/zl-prediction-node/bin/node
DIR=/opt/zl-prediction-live/src/railway-diagnostic
IDX=$DIR/index.mjs
WRAPPER=$DIR/wrapper.mjs
test -x "$NODE" && test -f "$IDX" && test -f "$WRAPPER"
for unit in zl-prediction-trade zl-prediction-deepseek5 zl-prediction-v3 zl-prediction-risk-exits; do
  test "$(systemctl is-active "$unit")" = active || { echo "QUOTE_SPEED_REQUIRED_SERVICE_DOWN=$unit"; exit 3; }
done

WORK=$(mktemp -d "$DIR/.quote-speed-test-XXXXXXXX")
trap 'rm -rf "$WORK"' EXIT
cp -p "$IDX" "$WORK/index.mjs"
cp -p "$WRAPPER" "$WORK/wrapper.mjs"

python3 - "$WORK" <<'PY'
from pathlib import Path
import sys,json
w=Path(sys.argv[1]); p=w/'index.mjs'; s=p.read_text()
if 'ZL_QUOTE_SPEED_20261023' in s:
 raise SystemExit('QUOTE_SPEED_ALREADY_INSTALLED_NO_CHANGE')

# Patch ONLY the signed quote call, not the real order placement.
start=s.index('async function signedPost(path, bodyObj = {}) {')
end=s.index('\nfunction roundToMs(',start)
sub=s[start:end]
assert sub.count('signal: AbortSignal.timeout(12000),')==1
assert sub.count("network: true, error: e?.message || 'NETWORK_ERROR'")==1
sub=sub.replace('async function signedPost(path, bodyObj = {}) {',
  '''async function signedPost(path, bodyObj = {}, options = {}) {
  const timeoutMs = Math.min(12000, Math.max(500, Number(options.timeoutMs || 12000)));''')
sub=sub.replace('signal: AbortSignal.timeout(12000),',
                'signal: AbortSignal.timeout(timeoutMs),')
sub=sub.replace("network: true, error: e?.message || 'NETWORK_ERROR'",
  "network: true, timeout: ['TimeoutError','AbortError'].includes(e?.name), error: e?.message || 'NETWORK_ERROR'")
s=s[:start]+sub+s[end:]

start=s.index('async function getFreshQuote(intent) {')
end=s.index('\nfunction publicPending()',start)
sub=s[start:end]
old="const quoteCall = await signedPost('/sapi/v1/w3w/wallet/prediction/trade/get-quote', quoteBody);"
assert sub.count(old)==1
new='''let quoteCall = await signedPost('/sapi/v1/w3w/wallet/prediction/trade/get-quote',
    quoteBody, {timeoutMs: 2400});
  // ZL_QUOTE_SPEED_20261023: only the non-money-moving QUOTE may retry.
  // Never retry on HTTP 418/429/451, explicit rejection or unknown order result.
  if (!quoteCall.ok && quoteCall.network && quoteCall.timeout &&
      enabled && pendingAction && !submittedRounds.has(String(pendingAction.round)) &&
      Date.now() < Number(pendingAction.round) + 10000) {
    console.log(JSON.stringify({event:'quote_transport_timeout_retry',
      round:pendingAction.round, stage:'quote_only', elapsedMs:Date.now()-startedAt}));
    quoteCall = await signedPost('/sapi/v1/w3w/wallet/prediction/trade/get-quote',
      quoteBody, {timeoutMs: 1600});
  }'''
sub=sub.replace(old,new)
s=s[:start]+sub+s[end:]

marker='setInterval(() => refreshLastOrderStatus(false), 2500);'
assert s.count(marker)==1
warm='''// ZL_QUOTE_SPEED_20261023: one public Binance time ping before each new round.
// Reuse the shared Node fetch connection; no credentials, quote or order request.
let lastQuoteWarmRound=0;
setInterval(()=>{
  if(!enabled||!tradeAmountText)return;
  const now=Date.now();
  const next=Math.floor(now/300000)*300000+300000;
  const before=next-now;
  if(before<1000||before>1500||lastQuoteWarmRound===next)return;
  lastQuoteWarmRound=next;
  void fetch(API+'/api/v3/time',{cache:'no-store',signal:AbortSignal.timeout(850)})
    .then(async r=>{await r.arrayBuffer();if(!r.ok)throw Error('HTTP_'+r.status);})
    .then(()=>console.log(JSON.stringify({event:'quote_connection_prepared',round:next})))
    .catch(e=>console.log(JSON.stringify({event:'quote_connection_prewarm_failed',
      round:next,reason:String(e?.name||'NETWORK').slice(0,35)})));
},200);
'''
s=s.replace(marker,marker+'\n'+warm)
p.write_text(s)

# Wrapper must generate the complete production backend with the modified base,
# but must not import/run it in the throwaway test directory.
wr=w/'wrapper.mjs'; t=wr.read_text()
needle='await import(generatedModuleUrl.href);'
assert t.count(needle)==1
wr.write_text(t.replace(needle,"console.log('QUOTE_SPEED_GENERATED_SYNTAX_ONLY=true');"))
print('QUOTE_SPEED_SAFE_PATCH_APPLIED_IN_STAGING=true')
PY
"$NODE" --check "$WORK/index.mjs"
"$NODE" --check "$WORK/wrapper.mjs"
(cd "$WORK" && "$NODE" "$WORK/wrapper.mjs")
"$NODE" --check "$WORK/trade-control-fixed.mjs"
echo "QUOTE_SPEED_GENERATED_MODULE_COMPILES=true"

python3 - <<'PY'
import json,urllib.request,subprocess
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=8) as r:return json.load(r)
a=get('/api/status'); selection=get('/api/order-signal-model')
print('QUOTE_SPEED_PRODUCTION_PREFLIGHT',json.dumps({
 'serviceHealthy':a.get('ok'), 'followEnabled':a.get('enabled'),
 'model':selection.get('model'),
 'pendingState':(a.get('pendingAction') or {}).get('state')}))
# Restarting erases in-memory following state. Never switch it on behalf of user.
assert a.get('ok') is True and a.get('enabled') is False,'OWNER_FOLLOW_ON_NO_RESTART'
assert selection.get('model')=='DEEPSEEK_5M_V1','MODEL_CHANGED_NO_RESTART'
assert (a.get('pendingAction') or {}).get('state') not in (
 'QUOTING','SUBMITTING','SUBMISSION_UNKNOWN'),'ORDER_IN_FLIGHT_NO_RESTART'
print('QUOTE_SPEED_GUARDED_RESTART_PERMITTED=true')
PY

python3 - <<'PY'
import json,time,urllib.request
# Never restart at the beginning or end of a five-minute prediction round.
for i in range(180):
 ms=int(time.time()*1000)%300000
 if 40000 <= ms <= 225000:
  with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=8) as r:
   s=json.load(r)
  assert s.get('enabled') is False,'OWNER_FOLLOW_TURNED_ON_NO_RESTART'
  assert (s.get('pendingAction') or {}).get('state') not in (
   'QUOTING','SUBMITTING','SUBMISSION_UNKNOWN'),'ORDER_IN_FLIGHT_NO_RESTART'
  print('QUOTE_SPEED_SAFE_RESTART_ROUND_MS',ms); break
 time.sleep(1)
else:raise SystemExit('QUOTE_SPEED_NO_SAFE_WINDOW_NO_CHANGE')
PY

BACKUP=/var/lib/zl-prediction/archive/source-backups/quote-speed-COMMIT_SHA
test ! -e "$BACKUP"
mkdir -p "$BACKUP"
cp -p "$IDX" "$BACKUP/old-index.mjs"
rollback(){
 echo 'QUOTE_SPEED_ROLLBACK_TRIGGERED=true'
 cp -p "$BACKUP/old-index.mjs" "$IDX" || true
 systemctl restart zl-prediction-trade.service || true
}
trap rollback ERR
chown --reference="$IDX" "$WORK/index.mjs"
chmod --reference="$IDX" "$WORK/index.mjs"
cp -p "$WORK/index.mjs" "$IDX"
systemctl restart zl-prediction-trade.service
python3 - <<'PY'
import json,urllib.request,time,subprocess
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:13001'+path,timeout=8) as r:return json.load(r)
for i in range(35):
 try:
  t=get('/api/status')
  if t.get('ok') is True:break
 except Exception:pass
 time.sleep(1)
else:raise SystemExit('QUOTE_SPEED_TRADE_NOT_HEALTHY_ROLLBACK')
assert t.get('enabled') is False
assert get('/api/order-signal-model').get('model')=='DEEPSEEK_5M_V1'
assert t.get('autoConfirmEnabled') is True
assert subprocess.run(['systemctl','is-active','--quiet',
 'zl-prediction-risk-exits.service']).returncode==0
assert subprocess.run(['systemctl','is-active','--quiet',
 'zl-prediction-deepseek5.service']).returncode==0
print('QUOTE_SPEED_PRODUCTION_PATCH_HEALTHY=true')
print('QUOTE_SPEED_REAL_ORDER_GUARDS_UNCHANGED=true')
print('QUOTE_SPEED_PRODUCTION_SUCCESS=true')
PY
trap - ERR
echo "QUOTE_SPEED_BACKUP=$BACKUP"
"""

def main():
    sha=os.getenv('GITHUB_SHA','')
    if os.getenv('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[a-f0-9]{40}',sha):
        print('QUOTE_SPEED_INVALID_BRANCH_OR_COMMIT'); return 2
    client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
      access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
      region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
    inv=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
      name='zl-quote-speed-guarded-deploy',type='RunShellScript',working_user='root',
      command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=280)).body.invoke_id
    for _ in range(145):
        time.sleep(2)
        result=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
          region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
        if result and str(result.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
            try:output=base64.b64decode(result.output or '',validate=True).decode('utf8','replace')
            except Exception:output=str(result.output)
            print('QUOTE_SPEED_REMOTE_STATUS',result.invocation_status,'EXIT',result.exit_code)
            print(output[-15000:])
            return 0 if int(result.exit_code)==0 else 5
    print('QUOTE_SPEED_REMOTE_UNCONFIRMED');return 6

if __name__=='__main__':sys.exit(main())

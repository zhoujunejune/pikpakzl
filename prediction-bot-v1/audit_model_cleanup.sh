#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import os,json,collections,subprocess,pathlib,urllib.request
print('PRUNE_AUDIT_V2_SERVICE',subprocess.getoutput('systemctl is-active zl-prediction-v2'))
print('PRUNE_AUDIT_NATIVE_SERVICE',subprocess.getoutput('systemctl is-active zl-prediction-native-models'))
data=pathlib.Path('/var/lib/zl-prediction')
for base in [data/'rounds',data/'archive']:
 if base.exists():
  for p in sorted(base.rglob('*')):
   if not p.is_file() or len(p.parts)>len(base.parts)+4:continue
   print('PRUNE_AUDIT_FILE',str(p.relative_to(data)),p.stat().st_size)
hist=data/'rounds/round-history.json'
if hist.exists():
 try:
  root=json.loads(hist.read_text())
  print('PRUNE_AUDIT_HISTORY_TYPE',type(root).__name__)
  if isinstance(root,dict):
   print('PRUNE_AUDIT_HISTORY_TOP_KEYS',sorted(root)[:45])
   for key in ['rounds','records','items']:
    x=root.get(key)
    if x is not None:
     print('PRUNE_AUDIT_HISTORY_LIST',key,type(x).__name__,len(x))
     if isinstance(x,list) and x:
      print('PRUNE_AUDIT_ROW_TOP_KEYS',sorted(x[-1])[:150])
  elif isinstance(root,list):
   print('PRUNE_AUDIT_HISTORY_LIST_COUNT',len(root))
   if root:print('PRUNE_AUDIT_ROW_TOP_KEYS',sorted(root[-1])[:150])
 except Exception as e:print('PRUNE_AUDIT_HISTORY_ERROR',type(e).__name__)
try:
 with urllib.request.urlopen('http://127.0.0.1:13002/api/round-stats',timeout=12) as r:j=json.load(r)
 print('PRUNE_AUDIT_RECORD_COUNT',len(j.get('records') or []))
 print('PRUNE_AUDIT_MODEL_COUNTS',collections.Counter(str(x.get('productionModel')) for x in j.get('records') or []))
 print('PRUNE_AUDIT_SOURCE_COUNTS',collections.Counter(str(x.get('productionSource')) for x in j.get('records') or []))
 print('PRUNE_AUDIT_MODE',j.get('productionSignalSourceMode'))
except Exception as e:print('PRUNE_AUDIT_V2_FAILED',type(e).__name__)
try:
 pw=(pathlib.Path('/etc/zl-prediction/redis-auth')).read_text().strip()
 args=['redis-cli','-h','127.0.0.1','-p','6385','--scan','--pattern','*']
 env=os.environ.copy();env['REDISCLI_AUTH']=pw
 p=subprocess.run(args,capture_output=True,text=True,env=env,timeout=20)
 if p.returncode!=0:raise RuntimeError('redis scan failed')
 names=p.stdout.splitlines()
 print('PRUNE_AUDIT_REDIS_TOTAL_KEYS',len(names))
 counts=collections.Counter(n.split(':')[0] if ':' in n else n[:50] for n in names)
 print('PRUNE_AUDIT_REDIS_PREFIXES',counts)
except Exception as e:print('PRUNE_AUDIT_REDIS_ERROR',type(e).__name__)
PY

echo "PRUNE_FINAL_VERIFICATION_BEGIN"
test ! -f /etc/systemd/system/zl-prediction-native-models.service
for name in local-model-host.mjs edge-5m-service.mjs dynamic-entry-shadow.mjs dynamic-entry-shadow-core.mjs novice-mix-shadow.mjs postflip-official-stats.mjs shadow-breakout20-dashboard.mjs;do
 test ! -f "/opt/zl-prediction-live/src/railway-diagnostic/$name" || exit 21
done
test ! -f /var/lib/zl-prediction/archive/edge-cloudflare-last-public-snapshot.json
test ! -f /var/lib/zl-prediction/archive/breakout20-cloudflare-last-public-snapshot.json
python3 - <<'PY'
import os,json,pathlib,subprocess,urllib.request,urllib.error
from collections import Counter
root=pathlib.Path('/var/lib/zl-prediction/rounds')
rows=json.loads((root/'round-history.json').read_text())
MODEL='SELECTIVE_V2_FAST8_PREWARM_V1'
assert len(rows)>0
for row in rows:
 assert row.get('productionModel') in (None,MODEL)
 assert not any(k.startswith(('shadow','lockQuality','preLock','adaptiveGate')) for k in row)
 assert not any(k in row for k in ('calibrationComponents','calibrationMethod','calibrationReady','calibrationSamples',
 'baseDirectionRescueV2','selectiveV2NoBaseShadow','selectiveV2HighPrecisionShadow'))
print('PRUNE_FINAL_ACTIVE_LEDGER_ROWS',len(rows),'onlyModel',MODEL)
for file in (root/'round-history.json.archive').glob('v6-rounds-*.jsonl'):
 lines=[json.loads(line) for line in file.read_text().splitlines() if line.strip()]
 assert all(x.get('productionModel') in (None,MODEL) and not any(k.startswith('shadow') for k in x) for x in lines)
 print('PRUNE_FINAL_ARCHIVE',file.name,'rows',len(lines))
with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=12) as response:
 model=json.load(response)
assert model.get('model')==MODEL and len(model.get('models') or [])==1
print('PRUNE_FINAL_ORDER_MODEL_FIXED',MODEL)
pw=pathlib.Path('/etc/zl-prediction/redis-auth').read_text().strip()
env=os.environ.copy();env['REDISCLI_AUTH']=pw
for pattern in ('shadow:*','breakout20:*'):
 result=subprocess.run(['redis-cli','-h','127.0.0.1','-p','6385','--scan','--pattern',pattern],
   capture_output=True,text=True,env=env,timeout=15)
 assert result.returncode==0 and not result.stdout.strip(),pattern
 print('PRUNE_FINAL_REDIS_NAMESPACE_EMPTY',pattern)
print('PRUNE_FINAL_NO_INDEPENDENT_MODELS=true')
PY

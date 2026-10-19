#!/bin/bash
set -Eeuo pipefail
umask 027
test "$(id -u)" -eq 0
test -n "$PRED_CLEANUP_SHA"
[[ "$PRED_CLEANUP_SHA" =~ ^[0-9a-f]{40}$ ]]
B=/opt/zl-prediction-live/src/railway-diagnostic
V=/opt/zl-prediction-live/src/round-tracker
D=/var/lib/zl-prediction
NODE=/opt/zl-prediction-node/bin/node
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-redis zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$svc")" = active
done
T=$(mktemp -d)
OK=no
restore(){
 rc=$?
 if [ "$OK" != yes ];then
  echo "MODEL_CLEANUP_ROLLBACK exit=$rc"
  test ! -f "$T/panel.old" || cp -p "$T/panel.old" "$B/panel-stats-shell.mjs"
  test ! -f "$T/v2.old" || cp -p "$T/v2.old" "$V/index-rest.mjs"
  test ! -d "$T/rounds.old" || cp -a "$T/rounds.old/." "$D/rounds/"
  systemctl restart zl-prediction-v2 || true
  systemctl restart zl-prediction-trade || true
  test ! -f /etc/systemd/system/zl-prediction-native-models.service || systemctl enable --now zl-prediction-native-models || true
 fi
 rm -rf "$T"
}
trap restore EXIT
ROOT="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$PRED_CLEANUP_SHA"
curl -fsSL --retry 3 "$ROOT/railway-diagnostic/panel-stats-shell.mjs" -o "$T/panel.new"
curl -fsSL --retry 3 "$ROOT/round-tracker/index-rest.mjs" -o "$T/v2.new"
"$NODE" --check "$T/panel.new"
"$NODE" --check "$T/v2.new"
grep -Fq "MODEL_RETIRED" "$T/panel.new"
grep -Fq "LEGACY_SIGNAL_MODEL_RETIRED" "$T/v2.new"
grep -Fq "map(onlyActiveModelRow)" "$T/v2.new"
cp -p "$B/panel-stats-shell.mjs" "$T/panel.old"
cp -p "$V/index-rest.mjs" "$T/v2.old"
cp -a "$D/rounds" "$T/rounds.old"
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13002/api/round-stats',timeout=12) as r:v=json.load(r)
with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=12) as r:c=json.load(r)
assert v.get('productionSignalSourceMode')=='SELECTIVE_V2_FAST8'
assert c.get('model')=='SELECTIVE_V2_FAST8_PREWARM_V1'
assert c.get('ready') is True
print('CLEANUP_MODEL_PRECHECK=true')
PY
systemctl stop zl-prediction-trade
systemctl stop zl-prediction-v2
systemctl stop zl-prediction-native-models || true
python3 - <<'PY'
import json,os,pathlib,stat
root=pathlib.Path('/var/lib/zl-prediction/rounds')
ID='SELECTIVE_V2_FAST8_PREWARM_V1'
valid={'SELECTIVE_V2_FAST8_PRIMARY','EDGE_RESCUE_FAST8_PRIMARY','SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION'}
retire={'lockQualityShadow','adaptiveGateShadow','preLockAdaptiveShadow',
 'baseDirectionRescueV2','selectiveV2NoBaseShadow','selectiveV2NoBaseContest',
 'selectiveV2HighPrecisionShadow','v3NoBase15sShadow','v3NoBase20sShadow',
 'v3TrendBandForward','calibrationComponents','calibrationMethod',
 'calibrationReady','calibrationSamples'}
def keep(r):
 if not isinstance(r,dict):return False
 if r.get('productionModel')==ID:return r.get('productionSource') in valid
 return r.get('productionModel') is None and r.get('productionPrediction') in (None,'WAIT')
def clean(r):
 return {k:v for k,v in r.items() if k not in retire and not k.startswith(('shadow','lockQuality','preLock','adaptiveGate'))}
def write(path,body):
 st=path.stat();tmp=path.with_name(path.name+'.tmp-current-model')
 with open(tmp,'w') as f:
  f.write(body);f.flush();os.fsync(f.fileno())
 os.chown(tmp,st.st_uid,st.st_gid);os.chmod(tmp,stat.S_IMODE(st.st_mode));os.replace(tmp,path)
f=root/'round-history.json'
rows=json.loads(f.read_text())
assert isinstance(rows,list)
kept=[clean(x) for x in rows if keep(x)]
assert any(x.get('productionModel')==ID for x in kept)
write(f,json.dumps(kept,separators=(',',':')))
print('CLEANUP_V2_ROWS_BEFORE',len(rows),'AFTER',len(kept))
for p in sorted((root/'round-history.json.archive').glob('v6-rounds-*.jsonl')):
 old=[];new=[]
 for line in p.read_text().splitlines():
  if not line.strip():continue
  try:r=json.loads(line)
  except ValueError:continue
  old.append(r)
  if keep(r):new.append(clean(r))
 write(p,''.join(json.dumps(r,separators=(',',':'))+'\n' for r in new))
 print('CLEANUP_ARCHIVE',p.name,'BEFORE',len(old),'AFTER',len(new))
PY
install -o zl-pred -g zl-pred -m 0644 "$T/v2.new" "$V/index-rest.mjs"
install -o zl-pred -g zl-pred -m 0644 "$T/panel.new" "$B/panel-stats-shell.mjs"
systemctl start zl-prediction-v2
v2_ok=no
for i in $(seq 1 28);do
 code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:13002/api/round-stats || true)
 if [ "$code" = 200 ];then v2_ok=yes;break;fi
 sleep 2
done
test "$v2_ok" = yes
systemctl start zl-prediction-trade
panel_ok=no
for i in $(seq 1 28);do
 code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:13001/healthz || true)
 if [ "$code" = 200 ];then panel_ok=yes;break;fi
 sleep 2
done
test "$panel_ok" = yes
python3 - <<'PY'
import json,urllib.request,urllib.error
def get(port,path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=12) as r:
   return r.status,r.read()
 except urllib.error.HTTPError as e:return e.code,e.read()
c,data=get(13001,'/api/order-signal-model');v=json.loads(data)
assert c==200 and v.get('model')=='SELECTIVE_V2_FAST8_PREWARM_V1'
assert len(v.get('models',[]))==1
c,page=get(13001,'/')
assert c==200 and b'orderSignalModelSelect' in page and b'orderSignalModelSave' in page
assert b'id="edgeIndependentCard"' not in page and b'id="waitVisibilityCard"' not in page
print('CLEANUP_CURRENT_SELECTOR_AND_UI_OK=true')
for p in ('/api/shadow-breakout20/edge-5m','/api/shadow-breakout20/dynamic-entry',
'/api/shadow-breakout20/novice-mix','/api/postflip-official-stats','/api/training-status'):
 c,_=get(13001,p)
 assert c==410,(p,c)
 print('CLEANUP_RETIRED_PANEL_ENDPOINT',p,c)
for p in ('/api/shadow-stats','/api/fast8-stats','/api/training-status','/api/breakout20-official-accuracy'):
 c,_=get(13002,p)
 assert c==410,(p,c)
 print('CLEANUP_RETIRED_V2_ENDPOINT',p,c)
c,data=get(13002,'/api/round-stats');j=json.loads(data)
assert c==200 and j.get('productionSignalSourceMode')=='SELECTIVE_V2_FAST8'
assert all(r.get('productionModel') in (None,'SELECTIVE_V2_FAST8_PREWARM_V1') for r in j.get('records',[]))
print('CLEANUP_OFFICIAL_LEDGER_RETAINED',len(j.get('records',[])))
PY
# The code and histories are live and verified; only now erase old independent
# model data (without removing trade-control, Binance signals or wallet keys).
systemctl disable zl-prediction-native-models.service || true
rm -f /etc/systemd/system/zl-prediction-native-models.service
systemctl daemon-reload
for name in edge-cloudflare-last-public-snapshot.json breakout20-cloudflare-last-public-snapshot.json;do
 rm -f "$D/archive/$name"
done
for f in local-model-host.mjs edge-5m-service.mjs dynamic-entry-shadow.mjs dynamic-entry-shadow-core.mjs novice-mix-shadow.mjs postflip-official-stats.mjs shadow-breakout20-dashboard.mjs;do
 rm -f "$B/$f"
 find "$D/archive/source-backups" -type f -name "$f" -delete 2>/dev/null || true
 find "$D/archive/source-backups" -type f -name "$f.retired" -delete 2>/dev/null || true
done
python3 - <<'PY'
import os,subprocess
passwd=open('/etc/zl-prediction/redis-auth').read().strip()
env=os.environ.copy();env['REDISCLI_AUTH']=passwd
def cli(*args):
 r=subprocess.run(['redis-cli','-h','127.0.0.1','-p','6385','--raw',*args],
                  env=env,capture_output=True,text=True,timeout=15)
 if r.returncode:raise RuntimeError('REDIS_CALL_FAILED')
 return r.stdout.strip()
total=0
for pattern in ('shadow:*','breakout20:*'):
 scan=subprocess.run(['redis-cli','-h','127.0.0.1','-p','6385','--scan','--pattern',pattern],
                     env=env,capture_output=True,text=True,timeout=18)
 assert scan.returncode==0
 keys=scan.stdout.splitlines()
 for key in keys:
  if key.startswith(('shadow:','breakout20:')):
   cli('UNLINK',key);total+=1
 print('CLEANUP_REDIS_MODEL_PATTERN',pattern,'removed',len(keys))
print('CLEANUP_REDIS_RETIRED_TOTAL_REMOVED',total)
PY
test "$(systemctl is-active zl-futures-bot-paper)" = active
test "$(systemctl is-active zl-prediction-v2)" = active
test "$(systemctl is-active zl-prediction-v3)" = active
test "$(systemctl is-active zl-prediction-trade)" = active
echo 'CLEANUP_INACTIVE_MODEL_CODE_AND_STATS_REMOVED=true'
echo 'CLEANUP_KEEP_EXPANDABLE_MODEL_DROPDOWN=true'
echo 'CLEANUP_TRADE_API_ORDERS_MAPPING_UNMODIFIED=true'
OK=yes

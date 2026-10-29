#!/usr/bin/env python3
"""Safely repair shared Guardian SELL state and arm its monitor (not auto BUY).
No new BUY/SELL orders; no claim that real SELL execution has been tested.
"""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
BASE=/opt/zl-prediction-live/src/railway-diagnostic
NODE=/opt/zl-prediction-node/bin/node
SHA=__TARGET_SHA__
BASE_SHA=9c4c1fed52f453ac0ee28b0427051b6321727745
STAGE=$(mktemp -d /tmp/guardian-sell-activate-XXXXXXXX)
BACK=/var/backups/guardian-sell-activate-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 0700 "$BACK"
trap 'rm -rf "$STAGE"' EXIT
exec 9>/tmp/guardian-sell-activate.lock
flock -n 9
test "$(id -u)" -eq 0
test -x "$NODE"
for unit in zl-prediction-risk-exits zl-prediction-trade zl-prediction-guardian-analysis;do
 systemctl is-active --quiet "$unit"
done
python3 - <<'PY'
import urllib.request,json,subprocess
def get(port,url):
 with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,url),timeout=7) as r:return json.load(r)
t=get(13001,'/api/status')
r=get(13001,'/api/risk-control')
assert t.get('ok') and t.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1'
assert not t.get('pendingAction'),'GUARDIAN_PENDING_ORDER_ABORT'
assert r.get('ok') and r.get('persistenceHealthy') is True,'REDIS_RISK_CONFIG_UNAVAILABLE'
for unit in ('zl-prediction-trade','zl-prediction-risk-exits'):
 v=subprocess.run(['systemctl','show',unit,'-p','User','-p','ReadWritePaths'],text=True,capture_output=True).stdout
 assert 'User=zl-pred' in v and '/var/lib/zl-prediction/rounds' in v,'RUNTIME_WRITABLE_PATH_UNVERIFIED'
print('GUARDIAN_MONITOR_PREFLIGHT=true')
PY
# Exchange read-only position check before touching a risk worker. Fail closed.
RISK_PID=$(systemctl show zl-prediction-trade -p MainPID --value)
test "$RISK_PID" -gt 0
RISK_PID="$RISK_PID" python3 - <<'PY'
import os,json,time,hmac,hashlib,urllib.parse,urllib.request
e=dict(pair.split(b'=',1) for pair in open('/proc/'+os.environ['RISK_PID']+'/environ','rb').read().split(b'\0') if b'=' in pair)
def v(n):return e.get(n.encode(),b'').decode()
key,secret=v('BINANCE_PREDICTION_API_KEY'),v('BINANCE_PREDICTION_API_SECRET')
assert key and secret,'BINANCE_READONLY_AUTH_UNAVAILABLE'
def get(route,params={}):
 q={**params,'timestamp':str(int(time.time()*1000)),'recvWindow':'5000'}
 raw=urllib.parse.urlencode(q)
 sig=hmac.new(secret.encode(),raw.encode(),hashlib.sha256).hexdigest()
 req=urllib.request.Request('https://api.binance.com'+route+'?'+raw+'&signature='+sig,headers={'X-MBX-APIKEY':key})
 with urllib.request.urlopen(req,timeout=9) as x:data=json.load(x)
 assert isinstance(data,dict),'UNTRUSTED_BINANCE_DATA'
 return data
wallet=v('BINANCE_PREDICTION_WALLET_ADDRESS')
if not wallet:
 wallets=get('/sapi/v1/w3w/wallet/prediction/wallet/list').get('wallets')
 assert isinstance(wallets,list) and len(wallets)==1,'WALLET_AMBIGUOUS'
 wallet=str(wallets[0].get('walletAddress') or '')
assert wallet,'WALLET_MISSING'
positions=get('/sapi/v1/w3w/wallet/prediction/position/list',
 {'walletAddress':wallet,'tab':'ONGOING','offset':0,'limit':100}).get('positions')
assert isinstance(positions,list) and len(positions)<100,'POSITION_RESULT_INCOMPLETE'
active=[p for p in positions if str(p.get('positionStatus','OPEN')).upper()=='OPEN']
print('GUARDIAN_MONITOR_OPEN_POSITIONS',len(active))
assert not active,'LIVE_POSITION_PREVENTS_SERVICE_RESTART'
PY

# Verify original production files before replacement. Only two specific modules
# are replaced; advanced trade/risk code is overlaid with exact matching hunks.
mkdir -p "$STAGE/base" "$STAGE/new" "$STAGE/out"
for f in guardian-live-bridge.mjs guardian-risk-integration.mjs control-shell.mjs risk-runner.mjs wrapper.mjs guardian-main-dashboard.mjs;do
 curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$SHA/railway-diagnostic/$f" -o "$STAGE/new/$f"
 "$NODE" --check "$STAGE/new/$f"
done
for f in control-shell.mjs risk-runner.mjs wrapper.mjs guardian-main-dashboard.mjs;do
 curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$BASE_SHA/railway-diagnostic/$f" -o "$STAGE/base/$f"
done
curl -fsSL --retry 2 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$SHA/prediction-bot-v1/guardian_sell_patch.py" -o "$STAGE/guardian_sell_patch.py"
python3 - "$BASE" "$STAGE" <<'PY'
import hashlib,sys,pathlib
live=pathlib.Path(sys.argv[1]);st=pathlib.Path(sys.argv[2])
sys.path.insert(0,str(st))
from guardian_sell_patch import overlay
expected={'guardian-live-bridge.mjs':'d4f29577e0ef217408d15583a43845427a13b701',
 'guardian-risk-integration.mjs':'7782bc88dcccae3ad32f95be3afa2041124a742e'}
for name,sha in expected.items():
 raw=(live/name).read_bytes()
 digest=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
 assert digest==sha,'SHARED_MODULE_PRODUCTION_CHANGED:'+name
 (st/'out'/name).write_bytes((st/'new'/name).read_bytes())
for name in ('control-shell.mjs','risk-runner.mjs','wrapper.mjs','guardian-main-dashboard.mjs'):
 patched=overlay((st/'base'/name).read_text(),(st/'new'/name).read_text(),(live/name).read_text(),name)
 (st/'out'/name).write_text(patched)
print('GUARDIAN_MONITOR_PRODUCTION_OVERLAY_SAFE=true')
PY
for f in guardian-live-bridge.mjs guardian-risk-integration.mjs control-shell.mjs risk-runner.mjs wrapper.mjs guardian-main-dashboard.mjs;do
 "$NODE" --check "$STAGE/out/$f"
 cp -p "$BASE/$f" "$BACK/$f"
done
mkdir -p "$BACK/systemd"
for name in zl-prediction-trade zl-prediction-risk-exits;do
 d="/etc/systemd/system/$name.service.d"
 test ! -e "$d/guardian-monitor-arm.conf"
done
test ! -e /var/lib/zl-prediction/rounds/guardian5/guardian-live-orders.json
test ! -e /var/lib/zl-prediction/guardian5/guardian-live-orders.json
test -f /var/lib/zl-prediction/rounds/risk-control.json
cp -p /var/lib/zl-prediction/rounds/risk-control.json "$BACK/config-before.json"
install -d -o zl-pred -g zl-pred -m 0750 /var/lib/zl-prediction/rounds/guardian5
CHANGED=no
rollback(){
 set +e
 echo GUARDIAN_MONITOR_ROLLBACK_STARTED=true
 if test -f "$BACK/config-before.json";then
  python3 - "$BACK" restore <<'PY' >/dev/null 2>&1
import os,pwd,json,subprocess,sys
pid=subprocess.check_output(['systemctl','show','zl-prediction-risk-exits','-p','MainPID','--value'],text=True).strip()
if not pid.isdigit() or int(pid)<=0:sys.exit(2)
env=dict((a.decode(),b.decode()) for a,b in (row.split(b'=',1) for row in open('/proc/'+pid+'/environ','rb').read().split(b'\0') if b'=' in row))
payload=open(sys.argv[1]+'/config-before.json').read()
cmd=["/opt/zl-prediction-node/bin/node","--input-type=module","-e","import fs from 'node:fs';const m=await import('file:///opt/zl-prediction-live/src/railway-diagnostic/risk-config-storage.mjs');await m.persistRiskConfig(JSON.parse(fs.readFileSync(0,'utf8')));await m.closeRiskStorage();"]
user=pwd.getpwnam('zl-pred')
subprocess.run(cmd,input=payload,text=True,env=env,cwd='/opt/zl-prediction-live/src/railway-diagnostic',user=user.pw_uid,group=user.pw_gid,timeout=20)
PY
 fi
 for f in guardian-live-bridge.mjs guardian-risk-integration.mjs control-shell.mjs risk-runner.mjs wrapper.mjs guardian-main-dashboard.mjs;do
  cp -p "$BACK/$f" "$BASE/$f"
 done
 for unit in zl-prediction-trade zl-prediction-risk-exits;do
  rm -f "/etc/systemd/system/$unit.service.d/guardian-monitor-arm.conf"
 done
 systemctl daemon-reload
 systemctl restart zl-prediction-risk-exits
 systemctl restart zl-prediction-trade
 echo GUARDIAN_MONITOR_ROLLBACK_COMPLETED=true
}
trap rollback ERR
CHANGED=yes
for f in guardian-live-bridge.mjs guardian-risk-integration.mjs control-shell.mjs risk-runner.mjs wrapper.mjs guardian-main-dashboard.mjs;do
 install -o zl-pred -g zl-pred -m 0644 "$STAGE/out/$f" "$BASE/$f"
done
for unit in zl-prediction-trade zl-prediction-risk-exits;do
 d="/etc/systemd/system/$unit.service.d"
 mkdir -p "$d"
 printf '[Service]\nEnvironment=GUARDIAN_MONITOR_ARM_ALLOWED=true\n' > "$d/guardian-monitor-arm.conf"
 chmod 0644 "$d/guardian-monitor-arm.conf"
done
systemctl daemon-reload
systemctl restart zl-prediction-risk-exits
systemctl restart zl-prediction-trade

# Activate ONLY the existing GUI Guardian risk preference in Redis. Other TP/SL
# settings are retained, and the original config is backed up for rollback.
python3 - "$BACK" enable <<'PY'
import os,pwd,sys,json,subprocess,pathlib
backup=pathlib.Path(sys.argv[1])
pid=subprocess.check_output(['systemctl','show','zl-prediction-risk-exits','-p','MainPID','--value'],text=True).strip()
assert pid.isdigit() and int(pid)>0,'RISK_CONTROLLER_NOT_RUNNING'
env=dict((a.decode(),b.decode()) for a,b in (row.split(b'=',1) for row in pathlib.Path('/proc/'+pid+'/environ').read_bytes().split(b'\0') if b'=' in row))
assert env.get('RISK_CONTROL_FILE') and env.get('SIGNAL_REDIS_URL'),'RISK_PERSISTENCE_CONFIG_MISSING'
node=r"""import fs from 'node:fs';
const m=await import('file:///opt/zl-prediction-live/src/railway-diagnostic/risk-config-storage.mjs');
await m.hydrateRiskConfig();
const file=process.env.RISK_CONTROL_FILE;
const old=JSON.parse(fs.readFileSync(file,'utf8'));
if(typeof old.guardianDynamicEnabled!=='boolean')throw Error('BAD_OLD_RISK_CONFIG');
const next={...old,guardianDynamicEnabled:true,updatedAt:new Date().toISOString()};
const result=await m.persistRiskConfig(next);
await m.closeRiskStorage();
if(result.guardianDynamicEnabled!==true)throw Error('PERSISTENCE_DID_NOT_APPLY');
process.stdout.write(JSON.stringify(old));
"""
user=pwd.getpwnam('zl-pred')
p=subprocess.run(['/opt/zl-prediction-node/bin/node','--input-type=module','-e',node],
 capture_output=True,text=True,env=env,cwd='/opt/zl-prediction-live/src/railway-diagnostic',
 user=user.pw_uid,group=user.pw_gid,timeout=22)
assert p.returncode==0,'GUARDIAN_MONITOR_PERSIST_FAILED'
before=json.loads(p.stdout)
backup.joinpath('config-before.json').write_text(json.dumps(before))
print('GUARDIAN_MONITOR_CONFIG_ENABLED=true')
PY
ready=no
for i in $(seq 1 35);do
 if systemctl is-active --quiet zl-prediction-risk-exits &&
    systemctl is-active --quiet zl-prediction-trade &&
    curl -fsS --max-time 3 http://127.0.0.1:13001/api/guardian-dynamic-risk -o "$STAGE/status.json" 2>/dev/null;then
   if python3 - "$STAGE/status.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
assert s.get('ok') and s.get('requestedEnabled') is True
assert s.get('effectiveEnabled') is True
assert s.get('workerRunning') is True and s.get('canEnable') is True
assert s.get('approvalVerified') is False
print('GUARDIAN_MONITOR_HEARTBEAT_CONFIRMED=true')
print('GUARDIAN_REAL_SELL_FILL_STILL_UNVERIFIED=true')
PY
   then ready=yes;break;fi
 fi
 sleep 2
done
test "$ready" = yes
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as f:t=json.load(f)
assert t.get('ok') and t.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1'
assert not t.get('pendingAction')
print('GUARDIAN_TRADE_FOLLOWING_AFTER_RESTART',t.get('enabled'))
print('GUARDIAN_DONT_CLAIM_LIVE_SELL_CONFIRMED=true')
PY
echo GUARDIAN_MONITOR_PRODUCTION_ACTIVATED=true
echo GUARDIAN_MONITOR_BACKUP="$BACK"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/guardian-sell-runtime-fix' or not re.fullmatch('[0-9a-f]{40}',sha):
  print('GUARDIAN_MONITOR_BAD_REVISION');return 2
 c=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
   access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
   endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 inv=c.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
    name='guardian-sell-monitor-activation',type='RunShellScript',
    command_content=SCRIPT.replace('__TARGET_SHA__',sha),working_user='root',timeout=240)).body.invoke_id
 for _ in range(135):
  time.sleep(2)
  d=c.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
     instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if d and str(d.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:output=base64.b64decode(d.output or '',validate=True).decode('utf8','replace')
   except Exception:output=str(d.output or '')
   print('GUARDIAN_MONITOR_REMOTE',d.invocation_status,'EXIT',d.exit_code)
   print(output[-18000:])
   return 0 if str(d.invocation_status)=='Success' and int(d.exit_code)==0 and 'GUARDIAN_MONITOR_PRODUCTION_ACTIVATED=true' in output else 5
 print('GUARDIAN_MONITOR_COMMAND_TIMEOUT')
 return 6
if __name__=='__main__':sys.exit(main())

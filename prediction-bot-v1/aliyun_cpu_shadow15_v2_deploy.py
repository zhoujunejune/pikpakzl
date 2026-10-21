#!/usr/bin/env python3
"""Deploy NEW, separately versioned CPU shadow15 V2 on Alibaba SWAS.
Never restarts or changes existing DeepSeek, old 13041 model, trade or futures.
"""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
BRANCH="feat/cpu-online-shadow15-v2-20261021"
INSTANCE="b67374069bb3457ba6a3a2ede9305d3f"
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
target=/opt/zl-prediction-live/deepseek-shadow15-online
data=/var/lib/zl-prediction/deepseek-shadow15-online
unit=/etc/systemd/system/zl-deepseek-shadow15-online.service
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper zl-deepseek-shadow-online;do
 test "$(systemctl is-active "$svc")" = active || { echo "DEPENDENCY_NOT_ACTIVE=$svc";exit 10; }
done
# Existing small SWAS machine has ~1.58GB, no GPU/swap. Require safe headroom.
avail=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
test "$avail" -gt 350000 || { echo "INSUFFICIENT_MEMORY_KB=$avail";exit 11; }
test ! -e "$target" && test ! -e "$data" && test ! -e "$unit" ||
  { echo "NEW_SHADOW_ALREADY_INSTALLED_ABORT";exit 12; }
if ss -H -tln '( sport = :13044 )' | grep -q .;then
 echo "PORT_13044_OCCUPIED_ABORT";exit 13
fi
stage=$(mktemp -d /tmp/zl-shadow15-v2-XXXXXXXX)
trap 'rm -rf "$stage"' EXIT
for name in deepseek_online_shadow15_v2.py test_deepseek_online_shadow15_v2.py;do
 curl -fsSL --retry 2 --max-time 30 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/$name" \
 -o "$stage/$name"
 python3 -m py_compile "$stage/$name"
done
echo 'SHADOW15_V2_TESTS_BEGIN=true'
PYTHONPATH="$stage" python3 -m unittest discover -s "$stage" -p 'test_deepseek_online_shadow15_v2.py' -v
rollback(){
 echo 'SHADOW15_V2_INSTALL_ROLLBACK=true'
 systemctl disable --now zl-deepseek-shadow15-online.service >/dev/null 2>&1 || true
 rm -f "$unit"
 rm -rf "$target" "$data"
 systemctl daemon-reload
}
trap rollback ERR
install -d -o zl-pred -g zl-pred -m 0750 "$target" "$data"
install -o zl-pred -g zl-pred -m 0640 "$stage/deepseek_online_shadow15_v2.py" "$target/deepseek_online_shadow15_v2.py"
cat > "$stage/unit" <<'EOF'
[Unit]
Description=ZL CPU 5m +8..15s online learner V2 SHADOW ONLY / no trades
After=network-online.target zl-prediction-v2.service zl-prediction-v3.service
Wants=network-online.target
[Service]
Type=simple
User=zl-pred
Group=zl-pred
WorkingDirectory=/opt/zl-prediction-live/deepseek-shadow15-online
ExecStart=/usr/bin/python3 /opt/zl-prediction-live/deepseek-shadow15-online/deepseek_online_shadow15_v2.py
Restart=on-failure
RestartSec=10
CPUQuota=10%
MemoryMax=96M
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/zl-prediction/deepseek-shadow15-online
IPAddressDeny=any
IPAddressAllow=localhost
[Install]
WantedBy=multi-user.target
EOF
install -m 0644 "$stage/unit" "$unit"
systemctl daemon-reload
systemctl enable --now zl-deepseek-shadow15-online.service >/dev/null
for i in $(seq 1 16);do
 if curl -fsS --max-time 2 http://127.0.0.1:13044/api/status -o "$stage/status.json" 2>/dev/null;then break;fi
 sleep 1
done
test -s "$stage/status.json"
python3 - "$stage/status.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
assert s.get('ok') is True
assert s.get('model')=='ZL_ONLINE_LOGISTIC_SHADOW15_V2'
assert s.get('mode')=='SHADOW_TRAIN_ONLY'
assert s.get('captureWindowMs')==[8000,15000]
assert s.get('productionSignalDeadlineMs')==15000
assert s.get('trainableWeights')==14
assert s.get('orders') is False and s.get('productionModelUnchanged') is True
print('CPU_SHADOW15_V2_DEPLOYED=true')
print('CPU_SHADOW15_V2_PORT_LOOPBACK=13044')
print('CPU_SHADOW15_V2_TRAINING_SAMPLE_COUNT',s['settledTrained'])
print('CPU_SHADOW15_V2_TRAINABLE_WEIGHTS',s['trainableWeights'])
print('CPU_SHADOW15_V2_NO_PRODUCTION_ORDERS=true')
PY
python3 - <<'PY'
import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:13029/api/status',timeout=8) as r:p=json.load(r)
with urllib.request.urlopen('http://127.0.0.1:13041/api/status',timeout=8) as r:old=json.load(r)
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=8) as r:t=json.load(r)
assert p.get('model')=='DEEPSEEK_5M_V1'
assert p.get('decisionWindowEndMs',0)-p.get('round',0)==15000
assert p.get('noSignalAfterDeadline') is True
assert old.get('model')=='ZL_ONLINE_LOGISTIC_SHADOW_V1'
print('CPU_SHADOW15_V2_OLD_TRAINER_UNTOUCHED=true')
print('CPU_SHADOW15_V2_PRODUCTION_AI_UNCHANGED=true')
print('CPU_SHADOW15_V2_REAL_FOLLOW_ENABLED',t.get('enabled'))
PY
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper zl-deepseek-shadow-online zl-deepseek-shadow15-online;do
 test "$(systemctl is-active "$svc")" = active || exit 24
done
echo 'CPU_SHADOW15_V2_ALL_OTHER_SERVICES_ACTIVE=true'
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch('[0-9a-f]{40}',sha):
  print('CPU_SHADOW15_V2_WRONG_GITHUB_REF');return 2
 cl=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cl.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
  name='zl-cpu-shadow15-v2-isolated-setup',type='RunShellScript',
  working_user='root',command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=180)).body.invoke_id
 for _ in range(93):
  time.sleep(2)
  r=cl.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
    instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   out=r.output or ''
   try:out=base64.b64decode(out,validate=True).decode('utf8','replace')
   except Exception:pass
   print('CPU_SHADOW15_V2_REMOTE_EXIT',r.exit_code,str(r.invocation_status))
   print(out[-7400:])
   return 0 if int(r.exit_code)==0 else 5
 print('CPU_SHADOW15_V2_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

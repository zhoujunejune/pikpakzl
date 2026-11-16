#!/usr/bin/env python3
"""Deploy an isolated shadow training unit on Alibaba SWAS. No exchange writes."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
echo SHADOW_DEPLOY_PHASE=preflight
test "$(id -u)" -eq 0
for unit in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$unit")" = active
done
test -x /usr/bin/python3
id zl-pred >/dev/null
if ss -H -tln '( sport = :13041 )' | grep -q .;then
 test "$(systemctl is-active zl-deepseek-shadow-online.service || true)" = active || {
  echo SHADOW_PORT_OWNED_BY_OTHER_PROCESS=true;exit 12;
 }
fi
stage=$(mktemp -d /tmp/zl-online-shadow-XXXXXX)
trap 'rm -rf "$stage"' EXIT
for n in deepseek_online_shadow.py test_deepseek_online_shadow.py;do
 curl -fsSL --retry 3 --max-time 30 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/$n" -o "$stage/$n"
 /usr/bin/python3 -m py_compile "$stage/$n"
done
echo SHADOW_DEPLOY_PHASE=tests
/usr/bin/python3 -m unittest discover -s "$stage" -p test_deepseek_online_shadow.py -v
target=/opt/zl-prediction-live/deepseek-shadow-online
data=/var/lib/zl-prediction/deepseek-shadow-online
install -d -m 0750 -o zl-pred -g zl-pred "$target" "$data"
old=false
if test -f "$target/deepseek_online_shadow.py";then
 old=true
 cp -p "$target/deepseek_online_shadow.py" "$stage/previous.py"
fi
install -o zl-pred -g zl-pred -m 0640 "$stage/deepseek_online_shadow.py" "$target/deepseek_online_shadow.py"
cat > "$stage/unit" <<'EOF'
[Unit]
Description=ZL independent BTC 5m online learning shadow (no exchange orders)
After=network-online.target zl-prediction-v3.service zl-prediction-v2.service
Wants=network-online.target
[Service]
Type=simple
User=zl-pred
Group=zl-pred
WorkingDirectory=/opt/zl-prediction-live/deepseek-shadow-online
ExecStart=/usr/bin/python3 /opt/zl-prediction-live/deepseek-shadow-online/deepseek_online_shadow.py
Restart=on-failure
RestartSec=7
MemoryMax=128M
CPUQuota=20%
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/zl-prediction/deepseek-shadow-online
IPAddressDeny=any
IPAddressAllow=localhost
[Install]
WantedBy=multi-user.target
EOF
if test -f /etc/systemd/system/zl-deepseek-shadow-online.service;then
 cp -p /etc/systemd/system/zl-deepseek-shadow-online.service "$stage/old.unit"
fi
install -m 0644 "$stage/unit" /etc/systemd/system/zl-deepseek-shadow-online.service
recover(){
 echo SHADOW_DEPLOY_ROLLBACK=true
 if test "$old" = true;then
  cp -p "$stage/previous.py" "$target/deepseek_online_shadow.py"
 else
  systemctl stop zl-deepseek-shadow-online.service >/dev/null 2>&1 || true
  systemctl disable zl-deepseek-shadow-online.service >/dev/null 2>&1 || true
 fi
 if test -f "$stage/old.unit";then
  cp -p "$stage/old.unit" /etc/systemd/system/zl-deepseek-shadow-online.service
 else
  rm -f /etc/systemd/system/zl-deepseek-shadow-online.service
 fi
 systemctl daemon-reload
 if test "$old" = true;then systemctl restart zl-deepseek-shadow-online.service >/dev/null 2>&1 || true;fi
}
trap recover ERR
systemctl daemon-reload
systemctl enable zl-deepseek-shadow-online.service >/dev/null
systemctl restart zl-deepseek-shadow-online.service
echo SHADOW_DEPLOY_PHASE=verify
for i in $(seq 1 20);do
 if curl -fsS --max-time 3 http://127.0.0.1:13041/api/status -o "$stage/check.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$stage/check.json"
/usr/bin/python3 - "$stage/check.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d['ok'] and d['mode']=='SHADOW_TRAIN_ONLY'
assert d['orders'] is False and d['productionModelUnchanged'] is True
assert d['trainableWeights']==14 and d['model']=='ZL_ONLINE_LOGISTIC_SHADOW_V1'
print('SHADOW_AUTOTRAIN_SERVICE_OK=true',flush=True)
print('SHADOW_TRAINED_SAMPLES',d['settledTrained'],flush=True)
print('SHADOW_CAUSAL_OBSERVATIONS',d['observations'],flush=True)
print('SHADOW_EXPECTS_NEW_SETTLEMENTS=true',flush=True)
PY
for unit in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$unit")" = active
done
echo SHADOW_PRODUCTION_AND_FUTURES_UNCHANGED=true
echo SHADOW_LOCAL_ONLY_PORT=13041
trap - ERR
"""
def main():
 sha=os.environ.get("GITHUB_SHA","")
 if os.environ.get("GITHUB_REF_NAME")!="feature/zl-futures-bot-v1" or not re.fullmatch(r"[0-9a-f]{40}",sha):
  print("SHADOW_WRONG_SOURCE");return 2
 cli=Client(api.Config(access_key_id=os.environ["ALIBABA_CLOUD_ACCESS_KEY_ID"],
  access_key_secret=os.environ["ALIBABA_CLOUD_ACCESS_KEY_SECRET"],
  endpoint="swas.ap-southeast-1.aliyuncs.com",region_id="ap-southeast-1"))
 inv=cli.run_command(sw.RunCommandRequest(region_id="ap-southeast-1",
  instance_id="b67374069bb3457ba6a3a2ede9305d3f",
  name="zl-isolated-online-shadow-no-trades",type="RunShellScript",
  command_content=SCRIPT.replace("COMMIT_SHA",sha),working_user="root",timeout=190)).body.invoke_id
 for _ in range(90):
  time.sleep(2)
  r=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id="ap-southeast-1",instance_id="b67374069bb3457ba6a3a2ede9305d3f",
   invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ("Success","Failed","Aborted","ExecutionTimeout","ExitCodeNonzero"):
   raw=r.output or ""
   try:raw=base64.b64decode(raw,validate=True).decode("utf8","replace")
   except Exception:pass
   print("SHADOW_DEPLOY_REMOTE",r.invocation_status,"EXIT",r.exit_code)
   print(raw[-6800:])
   return 0 if str(r.invocation_status)=="Success" and int(r.exit_code)==0 else 5
 print("SHADOW_DEPLOY_TIMEOUT");return 6
if __name__=="__main__":sys.exit(main())

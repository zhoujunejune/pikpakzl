#!/usr/bin/env python3
"""Install an entirely separate, no-orders, AI-disabled FAST10 monitor on existing SWAS.

Does not replace production engine, change router, restart existing units, or call
paid inference APIs. All fetched source is pinned to the invoking Git commit.
"""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REGION='ap-southeast-1'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
BRANCH='feat/deepseek-prewarm-fast10-20261021'
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
for s in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$s")" = active || { echo "REQUIRED_PROD_SERVICE_NOT_ACTIVE=$s";exit 17; }
done
if test -e /etc/systemd/system/zl-deepseek-fast10-shadow.service;then
 echo 'FAST10_SHADOW_UNIT_ALREADY_EXISTS=abort';exit 18
fi
if ss -H -tln '( sport = :13042 )'|grep -q .;then
 echo 'FAST10_SHADOW_PORT_BUSY=abort';exit 19
fi
test "$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)" -gt 150000 || {
 echo 'FAST10_SHADOW_INSUFFICIENT_MEMORY=abort';exit 20;
}
NODE=/opt/zl-prediction-node/bin/node
test -x "$NODE"
work=$(mktemp -d /tmp/zl-fast10-isolated-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
for f in deepseek-fast10-shadow-core.mjs deepseek-fast10-shadow-runner.mjs deepseek-5m-features.mjs;do
 curl -fsSL --retry 2 --max-time 20 \
  "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/$f" -o "$work/$f"
 "$NODE" --check "$work/$f"
done
target=/opt/zl-prediction-live/deepseek-fast10-shadow
if test -e "$target";then echo 'FAST10_SHADOW_DIR_EXISTS=abort';exit 21;fi
install -d -m 0750 -o zl-pred -g zl-pred "$target"
for f in deepseek-fast10-shadow-core.mjs deepseek-fast10-shadow-runner.mjs deepseek-5m-features.mjs;do
 install -m 0640 -o zl-pred -g zl-pred "$work/$f" "$target/$f"
done
cat > "$work/unit" <<'EOF'
[Unit]
Description=ZL DeepSeek FAST10 prewarm shadow MONITOR ONLY (AI disabled, no orders)
After=network-online.target zl-prediction-v3.service
Wants=network-online.target
[Service]
Type=simple
User=zl-pred
Group=zl-pred
WorkingDirectory=/opt/zl-prediction-live/deepseek-fast10-shadow
Environment=NODE_ENV=production
Environment=FAST10_SHADOW_ENABLE_AI=0
Environment=FAST10_SHADOW_PORT=13042
Environment=FAST10_MARKET_URL=http://127.0.0.1:13003/api/shadow-market-data
ExecStart=/opt/zl-prediction-node/bin/node /opt/zl-prediction-live/deepseek-fast10-shadow/deepseek-fast10-shadow-runner.mjs
Restart=on-failure
RestartSec=10
MemoryMax=96M
CPUQuota=10%
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
IPAddressDeny=any
IPAddressAllow=localhost
[Install]
WantedBy=multi-user.target
EOF
cleanup(){
 echo 'FAST10_SHADOW_DEPLOY_ABORT_CLEANUP=true'
 systemctl stop zl-deepseek-fast10-shadow.service >/dev/null 2>&1 || true
 systemctl disable zl-deepseek-fast10-shadow.service >/dev/null 2>&1 || true
 rm -f /etc/systemd/system/zl-deepseek-fast10-shadow.service
 rm -rf /opt/zl-prediction-live/deepseek-fast10-shadow
 systemctl daemon-reload
}
trap cleanup ERR
install -m 0644 "$work/unit" /etc/systemd/system/zl-deepseek-fast10-shadow.service
systemctl daemon-reload
systemctl enable --now zl-deepseek-fast10-shadow.service >/dev/null
for i in $(seq 1 15);do
 if curl -fsS --max-time 2 http://127.0.0.1:13042/api/status -o "$work/status" 2>/dev/null;then break;fi
 sleep 1
done
test -s "$work/status"
python3 - "$work/status" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
assert s['ok'] is True and s['mode']=='SHADOW_NO_ORDERS'
assert s['model']=='DEEPSEEK_PREWARM_FAST10_SHADOW_V1'
assert s['orders'] is False and s['productionIntegration'] is False
assert s['aiEnabled'] is False and s['apiKeyConfigured'] is False
print('FAST10_SHADOW_LOADED=true')
print('FAST10_SHADOW_PORT_LOOPBACK=13042')
print('FAST10_SHADOW_AI_PAID_CALLS=DISABLED')
print('FAST10_SHADOW_ORDERS=NONE')
PY
for s in zl-prediction-v2 zl-prediction-v3 zl-prediction-deepseek5 zl-prediction-trade zl-futures-bot-paper;do
 test "$(systemctl is-active "$s")" = active || exit 27
done
test "$(systemctl is-active zl-deepseek-fast10-shadow.service)" = active
echo 'PRODUCTION_AND_FUTURES_UNCHANGED=true'
trap - ERR
"""
def main():
    sha=os.environ.get('GITHUB_SHA','')
    if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch(r'[a-f0-9]{40}',sha):
        print('FAST10_SHADOW_INVALID_SOURCE_REF');return 2
    client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
       access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
       endpoint='swas.ap-southeast-1.aliyuncs.com',region_id=REGION))
    inv=client.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
       name='zl-fast10-no-order-shadow-install',type='RunShellScript',
       working_user='root',command_content=SCRIPT.replace('COMMIT_SHA',sha),timeout=135)).body.invoke_id
    for _ in range(70):
        time.sleep(2)
        r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
          region_id=REGION,instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
        if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
            raw=r.output or ''
            try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
            except Exception:pass
            print(raw[-4200:])
            return 0 if int(r.exit_code)==0 else 5
    print('FAST10_SHADOW_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

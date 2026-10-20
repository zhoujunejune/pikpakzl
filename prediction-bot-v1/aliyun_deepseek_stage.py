#!/usr/bin/env python3
"""Stage an isolated DeepSeek 5-minute signal server using preauthorized Alibaba SWAS Cloud Assistant.

No exchange orders, no prediction production edits, no API-secret transport.
Never modifies the original Qwen service or the futures service.
"""
import base64
import os
import re
import sys
import time

from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

REGION='ap-southeast-1'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'

SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-trade zl-futures-bot-paper; do
  test "$(systemctl is-active "$svc")" = active
done
if ss -H -tln '( sport = :13029 )' | grep -q .; then
 echo 'DEEPSEEK_STAGE_TARGET_PORT_OCCUPIED=true'
 exit 9
fi
NODE=/opt/zl-prediction-node/bin/node
test -x "$NODE"
WORK=$(mktemp -d /tmp/zl-deepseek5-stage.XXXXXXXX)
trap 'rm -rf "$WORK"' EXIT
curl -fsSL --retry 3 --max-time 30 \
 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/deepseek-5m-engine.mjs" \
 -o "$WORK/deepseek-5m-engine.mjs"
"$NODE" --check "$WORK/deepseek-5m-engine.mjs"
install -d -o zl-pred -g zl-pred -m 0750 /opt/zl-prediction-live/deepseek5 /var/lib/zl-prediction/deepseek5
if test -f /opt/zl-prediction-live/deepseek5/deepseek-5m-engine.mjs; then
  mkdir -p /var/lib/zl-prediction/archive/source-backups/deepseek5
  cp -p /opt/zl-prediction-live/deepseek5/deepseek-5m-engine.mjs \
   /var/lib/zl-prediction/archive/source-backups/deepseek5/deepseek-5m-engine-before-stage.mjs
fi
install -o zl-pred -g zl-pred -m 0644 "$WORK/deepseek-5m-engine.mjs" \
 /opt/zl-prediction-live/deepseek5/deepseek-5m-engine.mjs
if ! test -e /etc/zl-prediction/deepseek5.env; then
 cat > /etc/zl-prediction/deepseek5.env <<'EOF'
LLM_SERVICE_PORT=13029
LLM_MARKET_URL=http://127.0.0.1:13003/api/shadow-market-data
LLM_STATE_FILE=/var/lib/zl-prediction/deepseek5/signal.json
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions
EOF
fi
python3 - <<'PY'
from pathlib import Path
import os,tempfile
p=Path('/etc/zl-prediction/deepseek5.env')
original=p.read_text()
if '\\n' in original:
 original=original.replace('\\n','\n')
lines=[x for x in original.splitlines() if not x.startswith('LLM_SERVICE_PORT=')]
lines.append('LLM_SERVICE_PORT=13029')
fd,tmp=tempfile.mkstemp(dir=str(p.parent),prefix='.deepseek-env-')
try:
 with os.fdopen(fd,'w') as f:f.write('\n'.join(lines)+'\n')
 os.chmod(tmp,0o600)
 os.replace(tmp,p)
finally:
 if os.path.exists(tmp):os.remove(tmp)
PY
test ! -L /etc/zl-prediction/deepseek5.env
chown root:root /etc/zl-prediction/deepseek5.env
chmod 0600 /etc/zl-prediction/deepseek5.env
cat > /etc/systemd/system/zl-prediction-deepseek5.service <<'EOF'
[Unit]
Description=ZL DeepSeek 5m isolated read-only signal service (no exchange orders)
After=network-online.target zl-prediction-v3.service
Wants=network-online.target zl-prediction-v3.service
[Service]
Type=simple
User=zl-pred
Group=zl-pred
Environment=NODE_ENV=production
EnvironmentFile=/etc/zl-prediction/deepseek5.env
ExecStart=/opt/zl-prediction-node/bin/node /opt/zl-prediction-live/deepseek5/deepseek-5m-engine.mjs
Restart=on-failure
RestartSec=7
MemoryMax=180M
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/zl-prediction/deepseek5
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable zl-prediction-deepseek5.service
systemctl restart zl-prediction-deepseek5.service
for i in $(seq 1 18); do
 if curl -fsS --max-time 3 http://127.0.0.1:13029/healthz -o "$WORK/health.json"; then break;fi
 sleep 2
done
test -s "$WORK/health.json"
python3 - <<'PY'
import json,urllib.request,subprocess
def get(port,url):
 with urllib.request.urlopen('http://127.0.0.1:'+str(port)+url,timeout=8) as r:return json.load(r)
data=get(13029,'/api/status')
assert data['ok'] is True and data['model']=='DEEPSEEK_5M_V1'
assert data['realOrderEnabled'] is False and data['tradeIntegration'] is False
print('DEEPSEEK_STAGE_ALI_SERVICE_ACTIVE',subprocess.check_output(['systemctl','is-active','zl-prediction-deepseek5'],text=True).strip())
print('DEEPSEEK_STAGE_PROVIDER',data['providerModel'])
print('DEEPSEEK_STAGE_CONFIGURED',data['configured'])
print('DEEPSEEK_STAGE_ORDER_ENABLED',data['realOrderEnabled'])
choice=get(13001,'/api/order-signal-model')
print('DEEPSEEK_STAGE_PRODUCTION_MODEL_UNCHANGED',choice.get('model'))
assert choice.get('model')!='DEEPSEEK_5M_V1'
for name in ('zl-prediction-trade','zl-prediction-v2','zl-futures-bot-paper'):
 assert subprocess.check_output(['systemctl','is-active',name],text=True).strip()=='active'
print('DEEPSEEK_STAGE_PRODUCTION_SERVICES_STILL_ACTIVE=true')
PY
echo 'DEEPSEEK_STAGE_COMPLETED=true'
"""

def main():
    sha=os.environ.get('GITHUB_SHA','')
    if os.environ.get('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch(r'[a-f0-9]{40}',sha):
        print('DEEPSEEK_STAGE_WRONG_REF');return 2
    key=os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_ID','')
    secret=os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET','')
    if not key or not secret:
        print('DEEPSEEK_STAGE_ALIBABA_AUTH_MISSING');return 3
    client=Client(api.Config(access_key_id=key,access_key_secret=secret,region_id=REGION,
           endpoint='swas.ap-southeast-1.aliyuncs.com'))
    try:
        r=client.run_command(sw.RunCommandRequest(
            region_id=REGION,instance_id=INSTANCE,
            name='zl-stage-deepseek5-readonly-no-orders',
            type='RunShellScript',working_user='root',
            command_content=SCRIPT.replace('COMMIT_SHA',sha),timeout=180))
        invoke=r.body.invoke_id
        for _ in range(75):
            time.sleep(3)
            x=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
                region_id=REGION,instance_id=INSTANCE,invoke_id=invoke)).body.invocation_result
            if x and str(x.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
                raw=x.output or ''
                try:raw=base64.b64decode(raw,validate=True).decode('utf-8','replace')
                except Exception:pass
                print('DEEPSEEK_STAGE_REMOTE_STATUS',str(x.invocation_status),'EXIT',x.exit_code)
                print(raw[-4500:])
                return 0 if str(x.invocation_status)=='Success' and int(x.exit_code)==0 else 5
        print('DEEPSEEK_STAGE_TIMEOUT');return 6
    except Exception as e:
        print('DEEPSEEK_STAGE_EXCEPTION',type(e).__name__)
        return 7

if __name__=='__main__':
    sys.exit(main())

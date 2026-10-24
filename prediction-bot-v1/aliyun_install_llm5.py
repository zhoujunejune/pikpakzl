#!/usr/bin/env python3
"""Install isolated read-only Qwen signal service through preauthorized SWAS Cloud Assistant."""
import base64,os,re,time,sys
REGION='ap-southeast-1';INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
def main():
 sha=os.getenv('GITHUB_SHA','');branch=os.getenv('GITHUB_REF_NAME','')
 if branch!='feature/zl-futures-bot-v1' or not re.fullmatch('[a-f0-9]{40}',sha):print('LLM_INSTALL_WRONG_REF');return 2
 key=os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID');secret=os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET')
 if not key or not secret:print('LLM_INSTALL_ALI_AUTH_MISSING');return 3
 from alibabacloud_swas_open20200601.client import Client
 from alibabacloud_swas_open20200601 import models as sw
 from alibabacloud_tea_openapi import models as api
 client=Client(api.Config(access_key_id=key,access_key_secret=secret,endpoint='swas.ap-southeast-1.aliyuncs.com',region_id=REGION))
 cmd=r'''#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" = 0
test "$(systemctl is-active zl-prediction-trade)" = active
test "$(systemctl is-active zl-prediction-v3)" = active
test "$(systemctl is-active zl-futures-bot-paper)" = active
NODE=/opt/zl-prediction-node/bin/node
test -x "$NODE"
TMP=$(mktemp --suffix=.mjs)
trap 'rm -f "$TMP"' EXIT
curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/zhoujunejune/pikpakzl/REV/prediction-bot-v1/llm-5m-engine.mjs -o "$TMP"
"$NODE" --check "$TMP"
mkdir -p /opt/zl-prediction-live/llm5 /var/lib/zl-prediction/llm5
chown zl-pred:zl-pred /opt/zl-prediction-live/llm5 /var/lib/zl-prediction/llm5
if test -f /opt/zl-prediction-live/llm5/llm-5m-engine.mjs;then
 mkdir -p /var/lib/zl-prediction/archive/source-backups/llm5
 cp -p /opt/zl-prediction-live/llm5/llm-5m-engine.mjs /var/lib/zl-prediction/archive/source-backups/llm5/llm-5m-engine-before-update.mjs
fi
install -o zl-pred -g zl-pred -m 0644 "$TMP" /opt/zl-prediction-live/llm5/llm-5m-engine.mjs
if ! test -f /etc/zl-prediction/llm5.env;then
 cat > /etc/zl-prediction/llm5.env <<'EOF'
LLM_SERVICE_PORT=13018
LLM_MARKET_URL=http://127.0.0.1:13003/api/shadow-market-data
LLM_STATE_FILE=/var/lib/zl-prediction/llm5/signal.json
QWEN_MODEL=qwen-flash
QWEN_API_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions
# Add DASHSCOPE_API_KEY using a private secure server-side configuration channel.
EOF
fi
chown root:root /etc/zl-prediction/llm5.env
chmod 0600 /etc/zl-prediction/llm5.env
cat > /etc/systemd/system/zl-prediction-llm5.service <<'EOF'
[Unit]
Description=ZL Qwen five-minute independent market signal source (no orders)
After=network-online.target zl-prediction-v3.service
Wants=network-online.target zl-prediction-v3.service
[Service]
Type=simple
User=zl-pred
Group=zl-pred
Environment=NODE_ENV=production
EnvironmentFile=/etc/zl-prediction/llm5.env
ExecStart=/opt/zl-prediction-node/bin/node /opt/zl-prediction-live/llm5/llm-5m-engine.mjs
Restart=on-failure
RestartSec=6
MemoryMax=140M
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/zl-prediction/llm5
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable zl-prediction-llm5.service
systemctl restart zl-prediction-llm5.service
ready=no
for n in $(seq 1 12);do
 code=$(curl --max-time 4 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:13018/healthz || true)
 if test "$code" = 200;then ready=yes;break;fi
 sleep 2
done
test "$ready" = yes
python3 - <<'PY'
from pathlib import Path
import subprocess,shutil,datetime
p=Path('/etc/caddy/Caddyfile')
src=p.read_text()
host='prediction.47-237-188-69.sslip.io {'
assert src.count('\n'+host)==1,'PRED_CADDY_HOST_UNEXPECTED'
start=src.index('\n'+host)+1
end=src.index('\n}\n',start)
block=src[start:end]
assert 'basic_auth {' in block,'AUTH_GATE_MISSING'
route='  handle_path /llm/* {\n    reverse_proxy 127.0.0.1:13018\n  }\n'
if route not in block:
 assert 'handle_path /llm/' not in block,'LLM_ROUTE_UNKNOWN'
 marker='  handle {\n    reverse_proxy 127.0.0.1:13001'
 assert block.count(marker)==1,'NO_EXACT_PRED_DEFAULT_PROXY'
 new=block.replace(marker,route+marker,1)
 stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
 backup=Path('/var/lib/zl-prediction/archive/source-backups')/('llm5-caddy-'+stamp+'.bak')
 shutil.copy2(p,backup)
 p.write_text(src[:start]+new+src[end:])
 if subprocess.run(['caddy','validate','--config',str(p)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0:
  shutil.copy2(backup,p)
  raise RuntimeError('INVALID_CADDY_ROLLED_BACK')
 if subprocess.run(['systemctl','reload','caddy']).returncode!=0:
  shutil.copy2(backup,p)
  subprocess.run(['systemctl','reload','caddy'])
  raise RuntimeError('RELOAD_FAILED_ROLLED_BACK')
 print('LLM_CADDY_ROUTE_CHANGED=true')
else:print('LLM_CADDY_ROUTE_ALREADY_PRESENT=true')
PY
code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve prediction.47-237-188-69.sslip.io:443:127.0.0.1 https://prediction.47-237-188-69.sslip.io/llm/ || true)
test "$code" = 401
echo "LLM_AUTH_GATE_HTTP=401"
echo "LLM_LOCAL_STATUS_HTTP=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:13018/api/status)"
echo "LLM_CONFIGURED=$(curl -fsS http://127.0.0.1:13018/api/status | python3 -c 'import json,sys;print(str(json.load(sys.stdin).get("configured")).lower())')"
echo "LLM_SERVICE_ACTIVE=$(systemctl is-active zl-prediction-llm5)"
echo "PREDICTION_MAIN_ACTIVE=$(systemctl is-active zl-prediction-trade)"
echo "FUTURES_ACTIVE=$(systemctl is-active zl-futures-bot-paper)"
echo "LLM_REAL_ORDER_ENABLED=false"
echo "LLM_INSTALL_COMPLETE=true"
'''.replace('REV',sha)
 try:
  inv=client.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,name='zl-install-llm5-signal-no-orders',type='RunShellScript',command_content=cmd,working_user='root',timeout=220)).body.invoke_id
  print('LLM_INSTALL_COMMAND_ACCEPTED=true')
  for _ in range(55):
   time.sleep(4)
   r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
   if not r:continue
   status=str(r.invocation_status)
   if status in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    raw=r.output or ''
    try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
    except Exception:pass
    print('LLM_INSTALL_RESULT',status,'EXIT',r.exit_code)
    print(raw[-7000:])
    return 0 if status=='Success' and int(r.exit_code)==0 else 4
 except Exception as e:print('LLM_INSTALL_API_ERROR',type(e).__name__);return 5
 return 6
if __name__=='__main__':sys.exit(main())

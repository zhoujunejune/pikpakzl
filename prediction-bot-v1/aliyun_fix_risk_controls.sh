#!/bin/bash
# Alibaba-only fix: recover Redis-authoritative prediction TP/SL configuration
# and start its independent monitor IDLE. Never submit an order or enable TP/SL.
set -Eeuo pipefail
umask 027
test "$(id -u)" -eq 0
test -n "$RISK_SOURCE_SHA"
[[ "$RISK_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
BASE=/opt/zl-prediction-live/src/railway-diagnostic
NODE=/opt/zl-prediction-node/bin/node
CONF=/etc/zl-prediction/panel.env
CONFIG=/var/lib/zl-prediction/rounds/risk-control.json
STATE=/var/lib/zl-prediction/rounds/risk-runtime-status.json
WORKER=/var/lib/zl-prediction/rounds/risk-worker-health.json
UNIT=/etc/systemd/system/zl-prediction-risk-exits.service
test -d "$BASE" && test -x "$NODE" && test -d /var/lib/zl-prediction/rounds
for s in zl-prediction-trade zl-prediction-v2 zl-prediction-v3 zl-prediction-redis zl-futures-bot-paper;do
 test "$(systemctl is-active "$s")" = active
done
grep -Fxq 'ZL_OUTER_AUTH_ONLY=true' "$CONF"
grep -Fxq 'ZL_PUBLIC_ORIGIN=https://prediction.47-237-188-69.sslip.io' "$CONF"
python3 - <<'PY'
import json,subprocess,os,pathlib
env=os.environ.copy()
env['REDISCLI_AUTH']=pathlib.Path('/etc/zl-prediction/redis-auth').read_text().strip()
cmd=['redis-cli','-h','127.0.0.1','-p','6385','--raw','GET','trade-control:risk-config:v1']
r=subprocess.run(cmd,env=env,text=True,capture_output=True,timeout=14)
assert r.returncode==0
data=json.loads(r.stdout)
assert data.get('takeProfitEnabled') is False and data.get('stopLossEnabled') is False, 'RISK_CONFIG_ENABLED_ABORT_TO_AVOID_UNEXPECTED_SELL'
assert all(1<=float(data.get(k,0))<=100 for k in ['takeProfitPercent','stopLossPercent'])
assert data.get('updatedAt')
print('RISK_DEPLOY_EXISTING_USER_CONFIG_SAFE_AND_DISABLED=true')
PY
TEMP=$(mktemp -d)
READY=no
cleanup(){
 code=$?
 if [ "$READY" != yes ];then
  echo "RISK_DEPLOY_ROLLBACK exit=$code"
  systemctl stop zl-prediction-risk-exits.service >/dev/null 2>&1 || true
  for f in index.mjs control-shell.mjs risk-config-storage.mjs risk-runner.mjs risk-worker.mjs;do
   if [ -f "$TEMP/old/$f" ];then cp -p "$TEMP/old/$f" "$BASE/$f";fi
  done
  if [ -f "$TEMP/old-panel.env" ];then cp -p "$TEMP/old-panel.env" "$CONF";fi
  if [ -f "$TEMP/old-unit" ];then cp -p "$TEMP/old-unit" "$UNIT";else rm -f "$UNIT";fi
  systemctl daemon-reload
  systemctl restart zl-prediction-trade || true
 fi
 rm -rf "$TEMP"
}
trap cleanup EXIT
ROOT="https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$RISK_SOURCE_SHA/railway-diagnostic"
mkdir -p "$TEMP/old"
for f in index.mjs control-shell.mjs risk-config-storage.mjs risk-runner.mjs risk-worker.mjs;do
 curl -fsSL --retry 3 --max-time 32 "$ROOT/$f" -o "$TEMP/$f"
 "$NODE" --check "$TEMP/$f"
 test -f "$BASE/$f" && cp -p "$BASE/$f" "$TEMP/old/$f"
done
grep -Fq '网页登录 · 自动跟随 / 每轮一次' "$TEMP/index.mjs"
grep -Fq 'RISK_CONFIG_FILE as RISK_CONTROL_FILE' "$TEMP/control-shell.mjs"
grep -Fq 'process.env.RISK_CONTROL_FILE' "$TEMP/risk-config-storage.mjs"
grep -Fq 'RISK_CONFIG_FILE as CONTROL_FILE' "$TEMP/risk-runner.mjs"
grep -Fq 'process.env.RISK_WORKER_HEALTH_FILE' "$TEMP/risk-worker.mjs"
cp -p "$CONF" "$TEMP/old-panel.env"
if [ -f "$UNIT" ];then cp -p "$UNIT" "$TEMP/old-unit";fi
mkdir -p /var/lib/zl-prediction/archive/source-backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "/var/lib/zl-prediction/archive/source-backups/$STAMP"
for f in index.mjs control-shell.mjs risk-config-storage.mjs risk-runner.mjs risk-worker.mjs;do
 cp -p "$BASE/$f" "/var/lib/zl-prediction/archive/source-backups/$STAMP/$f"
 install -o zl-pred -g zl-pred -m 0644 "$TEMP/$f" "$BASE/$f"
done
python3 - <<'PY'
from pathlib import Path
p=Path('/etc/zl-prediction/panel.env')
current=p.read_text()
updates={'RISK_CONTROL_FILE':'/var/lib/zl-prediction/rounds/risk-control.json',
 'RISK_STATUS_FILE':'/var/lib/zl-prediction/rounds/risk-runtime-status.json',
 'RISK_WORKER_HEALTH_FILE':'/var/lib/zl-prediction/rounds/risk-worker-health.json'}
lines=[l for l in current.splitlines() if l.split('=',1)[0] not in updates]
p.write_text('\n'.join(lines+[k+'='+v for k,v in updates.items()])+'\n')
p.chmod(0o640)
PY
cat > "$UNIT" <<'EOF'
[Unit]
Description=ZL Binance Prediction independent TP SL monitor (idle unless owner enabled)
After=network-online.target zl-prediction-redis.service zl-prediction-trade.service
Requires=zl-prediction-redis.service
Wants=zl-prediction-trade.service
[Service]
Type=simple
User=zl-pred
Group=zl-pred
WorkingDirectory=/opt/zl-prediction-live/src/railway-diagnostic
Environment=PATH=/opt/zl-prediction-node/bin:/usr/bin:/bin
Environment=NODE_ENV=production
EnvironmentFile=/etc/zl-prediction/redis.env
EnvironmentFile=/etc/zl-prediction/panel.env
EnvironmentFile=/etc/zl-prediction/trading.env
ExecStart=/opt/zl-prediction-node/bin/node risk-runner.mjs
Restart=on-failure
RestartSec=6
MemoryMax=320M
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/zl-prediction/rounds
LimitNOFILE=8192
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
if ! systemctl restart zl-prediction-trade;then exit 21;fi
for i in $(seq 1 26);do
 code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:13001/healthz || true)
 if [ "$code" = 200 ];then break;fi
 sleep 2
done
test "$(systemctl is-active zl-prediction-trade)" = active
systemctl enable --now zl-prediction-risk-exits.service
test "$(systemctl is-active zl-prediction-risk-exits.service)" = active
READY_LOCAL=no
for i in $(seq 1 26);do
 if python3 - <<'PY' >/dev/null 2>&1
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/risk-control',timeout=7) as r:j=json.load(r)
assert j.get('persistenceHealthy') is True and j.get('persistenceRestored') is True
assert j.get('source')=='redis'
assert j.get('execution',{}).get('ready') is True
assert j.get('execution',{}).get('enabled') is False
assert j.get('execution',{}).get('workerRunning') is False
assert j.get('takeProfitEnabled') is False and j.get('stopLossEnabled') is False
PY
 then READY_LOCAL=yes;break;fi
 sleep 2
done
test "$READY_LOCAL" = yes
python3 - <<'PY'
import json,urllib.request,os
with urllib.request.urlopen('http://127.0.0.1:13001/api/risk-control',timeout=12) as r:j=json.load(r)
print('RISK_DEPLOY_REDIS_HEALTHY',j.get('persistenceHealthy'))
print('RISK_DEPLOY_SETTINGS_RESTORED',j.get('persistenceRestored'))
print('RISK_DEPLOY_MONITOR_IDLE',j.get('execution',{}).get('ready') and not j.get('execution',{}).get('enabled'))
print('RISK_DEPLOY_CONFIG',json.dumps({k:j.get(k) for k in ('takeProfitEnabled','takeProfitPercent','stopLossEnabled','stopLossPercent')}))
from pathlib import Path
assert Path('/var/lib/zl-prediction/rounds/risk-control.json').exists()
with urllib.request.urlopen('http://127.0.0.1:13001/',timeout=10) as r:html=r.read(400000).decode('utf8','replace')
assert 'PIN控制 · 自动跟随' not in html
assert '网页登录 · 自动跟随' in html
assert '自动止盈止损' in html
print('RISK_DEPLOY_UI_LABEL_AND_CONTROLS_FIXED=true')
with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=10) as r:model=json.load(r)
assert model.get('model')=='SELECTIVE_V2_FAST8_PREWARM_V1'
print('RISK_DEPLOY_MODEL_PRESERVED=true')
PY
for svc in zl-prediction-v2 zl-prediction-v3 zl-prediction-trade zl-prediction-redis zl-futures-bot-paper zl-prediction-risk-exits;do
 test "$(systemctl is-active "$svc")" = active
done
READY=yes
echo 'RISK_DEPLOY_FULL_SUCCESS=true'
echo 'RISK_DEPLOY_NO_SELL_AND_NO_AUTOTRADE_SWITCH_MODIFICATION=true'

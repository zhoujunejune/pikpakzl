#!/usr/bin/env python3
"""Production guard: create isolated read-only Binance oracle-start adapter;
update only DeepSeek prompt input if auto-follow is explicitly OFF."""
import os,re,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

BRANCH='feat/deepseek40-45s-ai-only-prod-20261025'
INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
REMOTE=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
app=/opt/zl-prediction-live/deepseek5
node=/opt/zl-prediction-node/bin/node
core="$app/deepseek-adaptive15-core.mjs"
runner="$app/deepseek-adaptive15-runner.mjs"
side_dir=/opt/zl-prediction-official-reference
helper="$side_dir/official-prediction-reference.mjs"
unit=/etc/systemd/system/zl-prediction-official-reference.service
for u in zl-prediction-deepseek5 zl-prediction-trade zl-prediction-v2 zl-prediction-v3 zl-futures-bot-paper;do
 test "$(systemctl is-active "$u")" = active || { echo "ORACLE_ABORT_INACTIVE_SERVICE=$u";exit 11; }
done
test -x "$node" && test -f "$core" && test -f "$runner"
test ! -e "$helper" && test ! -e "$unit" && test ! -e "$side_dir" || { echo 'ORACLE_ALREADY_PRESENT_ABORT=true';exit 13; }
test -f /var/lib/zl-exchange-api/prediction/binance.env
test "$(stat -c %a /opt)" = 755 || { echo 'ORACLE_OPT_BASE_PERMISSIONS_UNEXPECTED=true';exit 12; }
python3 - <<'PY'
import urllib.request,json
def get(port,route):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}{route}',timeout=7) as u:return json.load(u)
t=get(13001,'/api/status');a=get(13029,'/api/status')
assert t.get('enabled') is False,'AUTO_FOLLOW_IS_ON_REFUSE_SERVICE_RESTART'
assert t.get('orderSignalModel')=='DEEPSEEK_5M_V1','SIGNAL_MODEL_CHANGED'
assert a.get('decisionRule')=='PREWARM120_NEW_ROUND15_LIVE_DEEPSEEK_ONLY40S'
assert a.get('aiDirectionalRequired') is True
assert a.get('maxCallsPerRound')==5
from pathlib import Path
runner=Path('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-runner.mjs').read_text()
core=Path('/opt/zl-prediction-live/deepseek5/deepseek-adaptive15-core.mjs').read_text()
assert "const FEED='http://127.0.0.1:13003/api/shadow-market-data';" in runner
assert 'OFFICIAL_REFERENCE' not in runner and 'refreshOfficialReference' not in runner,'RUNNER_CHANGED_ABORT'
assert 'officialPredictionReference' not in core,'CORE_CHANGED_ABORT'
assert 'rank UP and DOWN using verified live opening price' in core,'EXPECTED_AI_PROMPT_MISSING'
assert "if(current.direction==='WAIT')return recordWait(w,'DEEPSEEK_CHOSE_WAIT',now);" in core
print('ORACLE_PREDEPLOY_GUARDS_SUCCESS=true')
print('ORACLE_AUTOFOLLOW_OFF=true')
PY
work=$(mktemp -d /tmp/zl-official-chainlink-XXXXXXX)
trap 'rm -rf "$work"' EXIT
for file in deepseek-adaptive15-core.mjs deepseek-adaptive15-runner.mjs official-prediction-reference.mjs;do
 curl -fsSL --retry 2 --max-time 35 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/$file" -o "$work/$file"
 "$node" --check "$work/$file"
done
python3 - "$work" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
core=(p/'deepseek-adaptive15-core.mjs').read_text()
runner=(p/'deepseek-adaptive15-runner.mjs').read_text()
helper=(p/'official-prediction-reference.mjs').read_text()
assert "const OFFICIAL_REFERENCE='http://127.0.0.1:13044/api/reference';" in runner
assert "const FEED='http://127.0.0.1:13003/api/shadow-market-data';" in runner
assert "officialPredictionReference:pass==='current'" in core
assert 'officialLiveChainlinkQuote:null' in core
assert "if(current.direction==='WAIT')return recordWait(w,'DEEPSEEK_CHOSE_WAIT',now);" in core
assert 'export const DEADLINE_MS=40000;' in core
assert 'const listPath=' in helper and 'const detailPath=' in helper
assert '/trade/place-order' not in helper and 'signedPost' not in helper
assert "server.listen(port,'127.0.0.1')" in helper
print('ORACLE_NO_TRADING_WRITES_AND_DEADLINES_PRESERVED=true')
PY
backup=/var/lib/zl-prediction/archive/source-backups/deepseek40-official-ref-COMMIT_SHA
mkdir -p "$backup"
cp -p "$core" "$backup/deepseek-adaptive15-core.mjs"
cp -p "$runner" "$backup/deepseek-adaptive15-runner.mjs"
rollback(){
 echo 'ORACLE_ROLLBACK_STARTED=true'
 cp -p "$backup/deepseek-adaptive15-core.mjs" "$core"
 cp -p "$backup/deepseek-adaptive15-runner.mjs" "$runner"
 systemctl restart zl-prediction-deepseek5.service || true
 systemctl stop zl-prediction-official-reference.service || true
 systemctl disable zl-prediction-official-reference.service || true
 rm -f "$unit" "$helper"
 rmdir "$side_dir" 2>/dev/null || true
 systemctl daemon-reload || true
 echo 'ORACLE_ROLLBACK_ATTEMPTED=true'
}
trap rollback ERR
python3 - <<'PY'
import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as u:t=json.load(u)
assert t.get('enabled') is False,'AUTO_FOLLOW_WENT_ON_ABORT'
PY
python3 - "$app" "$work" <<'PY'
from pathlib import Path
import sys,os,tempfile
app,work=map(Path,sys.argv[1:])
for name in ['deepseek-adaptive15-core.mjs','deepseek-adaptive15-runner.mjs']:
 dst=app/name
 ref=(app/'deepseek-adaptive15-core.mjs').stat()
 st=dst.stat() if dst.exists() else ref
 fd,tmp=tempfile.mkstemp(prefix='.oracle-start-',dir=str(app))
 try:
  with os.fdopen(fd,'wb') as f:f.write((work/name).read_bytes())
  os.chmod(tmp,st.st_mode&0o777)
  os.chown(tmp,st.st_uid,st.st_gid)
  os.replace(tmp,dst)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
PY
# The isolated reference program lives in a root-owned, world-readable code-only
# directory because the production model directory is deliberately 0750.
# A dynamically allocated systemd user can load code without access to trading code.
install -d -m 0755 -o root -g root "$side_dir"
install -m 0644 -o root -g root "$work/official-prediction-reference.mjs" "$helper"
# Separate loopback-only read-only service: no order API and no changes to live trade service.
cat > "$unit" <<'UNIT'
[Unit]
Description=Read-only Binance Prediction official current-round CHAINLINK start reference
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
DynamicUser=yes
WorkingDirectory=/
Environment=OFFICIAL_REFERENCE_PORT=13044
EnvironmentFile=-/etc/zl-prediction/trading.env
EnvironmentFile=-/var/lib/zl-exchange-api/prediction/binance.env
ExecStart=/opt/zl-prediction-node/bin/node /opt/zl-prediction-official-reference/official-prediction-reference.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$unit"
systemctl daemon-reload
systemctl enable --now zl-prediction-official-reference.service
for n in $(seq 1 15);do
 if curl -fsS --max-time 3 http://127.0.0.1:13044/healthz -o "$work/health.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$work/health.json"
python3 - "$work/health.json" <<'PY'
import sys,json
s=json.load(open(sys.argv[1]))
assert s['ok'] is True and s['configured'] is True
assert s['trading'] is False and s['bind']=='loopback-only'
print('ORACLE_REFERENCE_SIDECAR_HEALTHY=true')
PY
# Do not interrupt production if the owner re-enabled trading during rollout.
python3 - <<'PY'
import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=7) as u:t=json.load(u)
assert t.get('enabled') is False,'FOLLOW_TOGGLED_DURING_DEPLOY'
PY
systemctl restart zl-prediction-deepseek5.service
for n in $(seq 1 20);do
 if curl -fsS --max-time 4 http://127.0.0.1:13029/api/status -o "$work/ai.json" 2>/dev/null &&
    curl -fsS --max-time 4 http://127.0.0.1:13001/api/status -o "$work/trade.json" 2>/dev/null;then break;fi
 sleep 2
done
test -s "$work/ai.json" && test -s "$work/trade.json"
python3 - "$work/ai.json" "$work/trade.json" <<'PY'
import sys,json
ai=json.load(open(sys.argv[1]));trade=json.load(open(sys.argv[2]))
assert ai.get('ok') is True
assert ai.get('model')=='DEEPSEEK_5M_V1' and ai.get('configured') is True
assert ai.get('decisionRule')=='PREWARM120_NEW_ROUND15_LIVE_DEEPSEEK_ONLY40S'
assert ai.get('reasoning',{}).get('enabled') is True
assert ai.get('aiDirectionalRequired') is True and ai.get('maxCallsPerRound')==5
assert 'officialReference' in ai
assert trade.get('enabled') is False and trade.get('orderSignalModel')=='DEEPSEEK_5M_V1'
print('ORACLE_MODEL_ADDITIONAL_REFERENCE_INTEGRATED=true')
print('ORACLE_TRADE_CONTROLS_UNMODIFIED=true')
print('ORACLE_AUTOFOLLOW_REMAINS_OFF=true')
PY
for unit in zl-prediction-official-reference zl-prediction-deepseek5 zl-prediction-trade zl-prediction-v2 zl-prediction-v3 zl-futures-bot-paper;do
 test "$(systemctl is-active "$unit")" = active || { echo "ORACLE_SERVICE_FAILED=$unit";exit 22; }
done
echo 'ORACLE_ALL_SERVICES_ACTIVE=true'
echo "ORACLE_SOURCE_BACKUP=$backup"
trap - ERR
"""
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!=BRANCH or not re.fullmatch(r'[a-f0-9]{40}',sha):
  print('ORACLE_REF_INVALID_GITHUB_CONTEXT');return 2
 cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 inv=cli.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',instance_id=INSTANCE,
  name='zl-binance-chainlink-start-readonly-deploy',type='RunShellScript',
  working_user='root',command_content=REMOTE.replace('COMMIT_SHA',sha),timeout=210)).body.invoke_id
 for _ in range(110):
  time.sleep(2)
  r=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id=INSTANCE,invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   out=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   print('ORACLE_REFERENCE_DEPLOY',r.invocation_status,'EXIT',r.exit_code)
   print(out[-10000:])
   return 0 if r.invocation_status=='Success' and int(r.exit_code)==0 else 5
 print('ORACLE_REFERENCE_DEPLOY_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

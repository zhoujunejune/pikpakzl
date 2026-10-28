#!/usr/bin/env python3
"""Deploy GUARDIAN analysis as a read-only internal helper of the sole 5m single bot."""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
REGION='ap-southeast-1';INSTANCE='b67374069bb3457ba6a3a2ede9305d3f'
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
NODE=/opt/zl-prediction-node/bin/node
CADDY=/etc/caddy/Caddyfile
PANEL=/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs
ROOT=/opt/zl-prediction-live/guardian5
DATA=/var/lib/zl-prediction/guardian5
UNIT=/etc/systemd/system/zl-prediction-guardian-analysis.service
test -x "$NODE" && test -f "$CADDY" && test -f "$PANEL"
test -f /etc/zl-prediction/deepseek5.env
id zl-pred >/dev/null
for svc in caddy zl-prediction-redis zl-prediction-v2 zl-prediction-v3 zl-prediction-trade zl-prediction-fast5 zl-prediction-fast5-stats zl-prediction-risk-exits zl-prediction-official-reference zl-exchange-api-manager;do
  systemctl is-active --quiet "$svc" || { echo "GUARDIAN_REQUIRED_UNIT_MISSING=$svc";exit 20; }
done
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=9) as r:s=json.load(r)
assert s['ok'] is True and s['enabled'] is False,'LIVE_SINGLE_ACTIVE_ABORT'
with urllib.request.urlopen('http://127.0.0.1:13003/api/shadow-market-data',timeout=8) as r:d=json.load(r)
assert d['ok'] is True and d['readOnly'] is True and d['symbol']=='BTCUSDT'
print('GUARDIAN_EXISTING_SINGLE_OFF_AND_FEED_READY=true')
PY
if ss -H -tln '( sport = :13049 )' | grep -q . && ! systemctl is-active --quiet zl-prediction-guardian-analysis;then
 echo GUARDIAN_PORT_CONFLICT_ABORT;exit 21
fi
STAGE=$(mktemp -d /tmp/zl-guardian5-XXXXXX)
BACK=/var/backups/zl-guardian5-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 700 "$BACK"
trap 'rm -rf "$STAGE"' EXIT
for f in guardian5-core.mjs guardian5-core.test.mjs guardian5-service.mjs deepseek-5m-features.mjs;do
 curl -fsSL --retry 3 --max-time 30 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/COMMIT_SHA/prediction-bot-v1/$f" -o "$STAGE/$f"
 "$NODE" --check "$STAGE/$f"
done
"$NODE" --test "$STAGE/guardian5-core.test.mjs"
echo GUARDIAN_CORE_TESTS_PASSED=true
cp -p "$CADDY" "$BACK/caddy.before"
cp -p "$PANEL" "$BACK/panel.before"
if test -f "$UNIT";then cp -p "$UNIT" "$BACK/unit.before";fi
if test -d "$ROOT";then cp -a "$ROOT" "$BACK/src.before";fi
was_active=0
if systemctl is-active --quiet zl-prediction-guardian-analysis;then was_active=1;fi
restore(){
 echo GUARDIAN_ROLLBACK_STARTED=true
 systemctl stop zl-prediction-guardian-analysis >/dev/null 2>&1 || true
 cp -p "$BACK/caddy.before" "$CADDY"
 cp -p "$BACK/panel.before" "$PANEL"
 if test -f "$BACK/unit.before";then
  cp -p "$BACK/unit.before" "$UNIT"
 else
  systemctl disable zl-prediction-guardian-analysis >/dev/null 2>&1 || true
  rm -f "$UNIT"
 fi
 if test -d "$BACK/src.before";then
  rm -rf "$ROOT"
  cp -a "$BACK/src.before" "$ROOT"
 else
  rm -rf "$ROOT"
 fi
 systemctl daemon-reload
 systemctl reload caddy >/dev/null 2>&1 || true
 systemctl restart zl-prediction-trade >/dev/null 2>&1 || true
 if test "$was_active" = 1;then systemctl restart zl-prediction-guardian-analysis >/dev/null 2>&1 || true;fi
 echo GUARDIAN_ROLLBACK_COMPLETE=true
}
trap restore ERR
install -d -o zl-pred -g zl-pred -m 0750 "$ROOT" "$DATA"
for f in guardian5-core.mjs guardian5-core.test.mjs guardian5-service.mjs deepseek-5m-features.mjs;do
 install -m 0640 -o zl-pred -g zl-pred "$STAGE/$f" "$ROOT/$f"
done
cat > "$STAGE/guardian.unit" <<'EOF'
[Unit]
Description=Read-only GUARDIAN5 strategy analysis for existing BTC single bot
After=network-online.target zl-prediction-v3.service zl-prediction-v2.service
Wants=network-online.target
[Service]
Type=simple
User=zl-pred
Group=zl-pred
WorkingDirectory=/opt/zl-prediction-live/guardian5
EnvironmentFile=/etc/zl-prediction/deepseek5.env
Environment=GUARDIAN_PORT=13049
Environment=GUARDIAN_STATE_FILE=/var/lib/zl-prediction/guardian5/observations.json
ExecStart=/opt/zl-prediction-node/bin/node /opt/zl-prediction-live/guardian5/guardian5-service.mjs
Restart=on-failure
RestartSec=8
MemoryMax=200M
CPUQuota=40%
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/zl-prediction/guardian5
[Install]
WantedBy=multi-user.target
EOF
install -m 0644 "$STAGE/guardian.unit" "$UNIT"
python3 - <<'PY'
from pathlib import Path
import os,re,json
c=Path('/etc/caddy/Caddyfile')
s=c.read_text()
if 'handle_path /guardian/* {' not in s:
 # Single-host template created during retirement. Insert before only matching
 # fallback in the prediction host; don't modify Basic Auth or other routes.
 host='prediction.47-237-188-69.sslip.io {'
 pos=s.find(host)
 assert pos>=0,'PREDICTION_HOST_NOT_FOUND'
 root=s.index('\n  handle {',pos)
 replacement=('  handle /guardian {\n    redir /guardian/ 302\n  }\n'
              '  handle_path /guardian/* {\n    reverse_proxy 127.0.0.1:13049\n  }\n')
 s=s[:root+1]+replacement+s[root+1:]
 p=c.with_name('Caddyfile.guardian.stage')
 p.write_text(s);os.chmod(p,0o644);os.replace(p,c)
panel=Path('/opt/zl-prediction-live/src/railway-diagnostic/panel-stats-shell.mjs')
src=panel.read_text()
m=re.search(r'(?m)^const ZL_HEADER_V2 = (.+);$',src)
if m:
 try:
  header=json.loads(m.group(1))
  if 'href="/guardian/"' not in header:
   assert '</div></div></header>' in header
   link='<a href="/guardian/" style="color:#94cbff;border:1px solid #304a61;border-radius:8px;padding:7px 11px;font-size:12px;text-decoration:none;margin-left:auto">GUARDIAN · 影子策略</a>'
   header=header.replace('</div></div></header>','</div>'+link+'</div></header>',1)
   src=src[:m.start(1)]+json.dumps(header,ensure_ascii=False)+src[m.end(1):]
   temp=panel.with_name(panel.name+'.guardian.stage')
   temp.write_text(src);os.chmod(temp,panel.stat().st_mode&0o777);os.chown(temp,panel.stat().st_uid,panel.stat().st_gid)
   os.replace(temp,panel)
 except Exception as ex:
  print('GUARDIAN_HEADER_LINK_OPTIONAL_FAILURE',type(ex).__name__)
print('GUARDIAN_PUBLIC_ROUTE_STAGED=true')
PY
caddy validate --config "$CADDY"
"$NODE" --check "$PANEL"
systemctl daemon-reload
systemctl enable zl-prediction-guardian-analysis >/dev/null
systemctl restart zl-prediction-guardian-analysis
ready=no
for i in $(seq 1 25);do
 if curl -fsS --max-time 4 http://127.0.0.1:13049/api/status -o "$STAGE/guardian.json" 2>/dev/null;then ready=yes;break;fi
 sleep 2
done
test "$ready" = yes
python3 - "$STAGE/guardian.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
assert x['ok'] and x['model']=='ZL_GUARDIAN_5M_V1'
assert x['mode']=='SHADOW_ANALYSIS_FOR_EXISTING_SINGLE_BOT'
assert x['orders'] is False and x['realOrderEnabled'] is False and x['autoTP_SL'] is False
assert x['productionIntegration'] is False and x['exitExecutionEnabled'] is False
assert x['configured'] is True,'DEEPSEEK_NOT_CONFIGURED'
assert x['automaticTradeEligibility']['eligible'] is False
print('GUARDIAN_SHADOW_ANALYSIS_HEALTHY=true')
print('GUARDIAN_DEEPSEEK_CONFIGURED=true')
print('GUARDIAN_EXECUTION_DISABLED=true')
PY
systemctl reload caddy
systemctl restart zl-prediction-trade
for i in $(seq 1 22);do
 if curl -fsS --max-time 5 http://127.0.0.1:13001/api/status -o "$STAGE/single.json" &&
    curl -fsS --max-time 4 http://127.0.0.1:13049/ -o "$STAGE/ui.html";then break;fi
 sleep 1
done
python3 - "$STAGE/single.json" "$STAGE/ui.html" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]));ui=open(sys.argv[2]).read()
assert s['ok'] is True and s['enabled'] is False
assert 'GUARDIAN' in ui and '影子' in ui
print('GUARDIAN_SINGLE_LIVE_SWITCH_STILL_OFF=true')
print('GUARDIAN_CHINESE_UI_READY=true')
PY
for svc in caddy zl-prediction-redis zl-prediction-v2 zl-prediction-v3 zl-prediction-trade zl-prediction-fast5 zl-prediction-fast5-stats zl-prediction-risk-exits zl-prediction-official-reference zl-exchange-api-manager zl-prediction-guardian-analysis;do
 systemctl is-active --quiet "$svc" || { echo "GUARDIAN_POST_UNIT_DOWN=$svc";exit 60; }
done
for svc in zl-prediction-dual5 zl-event10-deepseek zl-futures-bot-paper;do
 if systemctl is-active --quiet "$svc";then echo "GUARDIAN_RETIRED_UNIT_REAPPEARED=$svc";exit 61;fi
done
echo GUARDIAN_DEPLOY_COMPLETE=true
echo GUARDIAN_BACKUP="$BACK"
trap - ERR
"""
def main():
 sha=os.getenv('GITHUB_SHA','')
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[0-9a-f]{40}',sha):
  print('GUARDIAN_BAD_GITHUB_REVISION');return 2
 cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 endpoint='swas.ap-southeast-1.aliyuncs.com',region_id=REGION))
 invoke=cli.run_command(sw.RunCommandRequest(region_id=REGION,instance_id=INSTANCE,
  name='guardian-single-bot-shadow-deploy',type='RunShellScript',
  command_content=SCRIPT.replace('COMMIT_SHA',sha),working_user='root',timeout=260)).body.invoke_id
 for _ in range(125):
  time.sleep(2)
  r=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id=REGION,instance_id=INSTANCE,invoke_id=invoke)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=r.output or ''
   try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
   except Exception:pass
   print('GUARDIAN_REMOTE_STATUS',r.invocation_status,'EXIT',r.exit_code)
   print(raw[-21000:])
   return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 and 'GUARDIAN_DEPLOY_COMPLETE=true' in raw else 5
 print('GUARDIAN_DEPLOY_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

#!/usr/bin/env python3
"""Deploy ONLY the independent read-only prediction monitor to existing SWAS.

Uses the existing GitHub Actions Alibaba secrets. Never reads Railway variables,
never changes the futures service, and refuses to configure a trading worker.
"""
import base64
import os
import re
import sys
import time

REGION = "ap-southeast-1"
INSTANCE = "b67374069bb3457ba6a3a2ede9305d3f"
BRANCH = "feature/zl-futures-bot-v1"

def main():
    key, secret = os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID"), os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
    sha = os.getenv("GITHUB_SHA", "")
    if not key or not secret:
        print("PREDICTION_DEPLOY_BLOCKED: missing Alibaba secrets")
        return 2
    if os.getenv("GITHUB_REF_NAME") != BRANCH or not re.fullmatch(r"[a-f0-9]{40}", sha):
        print("PREDICTION_DEPLOY_BLOCKED: incorrect branch/SHA")
        return 3
    from alibabacloud_swas_open20200601.client import Client
    from alibabacloud_swas_open20200601 import models as sw
    from alibabacloud_tea_openapi import models as op
    client = Client(op.Config(access_key_id=key, access_key_secret=secret,
                              endpoint="swas.ap-southeast-1.aliyuncs.com", region_id=REGION))
    script = r"""#!/bin/bash
set -Eeuo pipefail
SRC=/opt/zl-futures-bot/src
DEST=/opt/zl-prediction-monitor
test "$(id -u)" -eq 0
test -d "$SRC/.git"
test -f /etc/caddy/Caddyfile
test -f /etc/systemd/system/zl-futures-bot-paper.service
git -C "$SRC" fetch --depth=1 origin feature/zl-futures-bot-v1
mkdir -p "$DEST"
git -C "$SRC" show __SHA__:prediction-bot-v1/serve.py > "$DEST/serve.py.tmp"
python3 -m py_compile "$DEST/serve.py.tmp"
install -m 0644 "$DEST/serve.py.tmp" "$DEST/serve.py"
rm -f "$DEST/serve.py.tmp"
# The futures HTML is loaded at Python startup. Update ONLY its HTML module
# and restart the existing PAPER process once if the menu changed. Durable
# futures state and controls files are not touched.
DASH="$SRC/futures-bot-v1/dashboard.py"
git -C "$SRC" show __SHA__:futures-bot-v1/dashboard.py > "$DEST/dashboard.py.tmp"
python3 -m py_compile "$DEST/dashboard.py.tmp"
if ! cmp -s "$DEST/dashboard.py.tmp" "$DASH"; then
  install -m 0644 "$DEST/dashboard.py.tmp" "$DASH"
  systemctl restart zl-futures-bot-paper.service
fi
rm -f "$DEST/dashboard.py.tmp"
cat > /etc/systemd/system/zl-prediction-readonly.service <<'UNIT'
[Unit]
Description=ZL Prediction Migration Readonly Monitor (separate from futures)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=nobody
Group=nogroup
WorkingDirectory=/opt/zl-prediction-monitor
Environment=PREDICTION_PANEL_PORT=11000
Environment=BIND_HOST=127.0.0.1
ExecStart=/usr/bin/python3 /opt/zl-prediction-monitor/serve.py
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now zl-prediction-readonly.service
systemctl restart zl-prediction-readonly.service
for i in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:11000/healthz | grep -q '"tradeExecutionEnabled": false'; then break; fi
  sleep 1
done
curl -fsS --max-time 2 http://127.0.0.1:11000/healthz | grep -q '"tradeExecutionEnabled": false'
python3 - <<'PY'
from pathlib import Path
p = Path('/etc/caddy/Caddyfile')
original = p.read_text()
assert 'basic_auth' in original and '127.0.0.1:10000' in original, 'existing protected futures site missing'
if 'handle_path /prediction/*' not in original:
    needle = '  reverse_proxy 127.0.0.1:10000'
    assert original.count(needle) == 1, 'cannot safely match proxy'
    new = original.replace(needle, '''  handle_path /prediction/* {
    reverse_proxy 127.0.0.1:11000
  }
  handle /prediction {
    redir /prediction/ 308
  }
  handle {
    reverse_proxy 127.0.0.1:10000
  }''')
    assert new.count('basic_auth') == original.count('basic_auth')
    p.with_suffix('.prediction-backup').write_text(original)
    p.write_text(new)
PY
if ! caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  test -f /etc/caddy/Caddyfile.prediction-backup
  cp /etc/caddy/Caddyfile.prediction-backup /etc/caddy/Caddyfile
  echo "PREDICTION_ROUTE_INVALID_RESTORED";exit 40
fi
systemctl reload caddy
systemctl is-active --quiet zl-prediction-readonly.service
systemctl is-active --quiet zl-futures-bot-paper.service
systemctl is-active --quiet caddy.service
echo "PREDICTION_ROUTE_INSTALLED: /prediction/ read-only, independent port 11000"
echo "PREDICTION_REAL_TRADING=false"
"""
    script = script.replace("__SHA__", sha)
    try:
        got = client.list_instances(sw.ListInstancesRequest(region_id=REGION, page_size=100))
        servers = [v for v in (got.body.instances or []) if getattr(v, "instance_id", "") == INSTANCE]
        if len(servers) != 1 or servers[0].status != "Running":
            print("PREDICTION_DEPLOY_BLOCKED: server not uniquely running")
            return 4
        call = client.run_command(sw.RunCommandRequest(region_id=REGION, instance_id=INSTANCE,
                            name="zl-prediction-readonly-menu", type="RunShellScript",
                            command_content=script, working_user="root", timeout=950))
        invocation = call.body.invoke_id
        if not invocation:
            return 5
        for _ in range(120):
            time.sleep(5)
            result = client.describe_invocation_result(sw.DescribeInvocationResultRequest(
                region_id=REGION, instance_id=INSTANCE, invoke_id=invocation)).body.invocation_result
            if not result:
                continue
            if str(result.invocation_status) in ("Success","Failed","Aborted","Invalid",
                    "ExecutionTimeout","ClientNotRunning","InstanceNotRunning",
                    "CommandNotApplicable","ExitCodeNonzero"):
                raw = result.output or ""
                try:
                    raw = base64.b64decode(raw, validate=True).decode("utf-8", "replace")
                except Exception:
                    pass
                print("PREDICTION_DEPLOY_STATUS:", result.invocation_status)
                print("PREDICTION_DEPLOY_EXIT:", result.exit_code)
                print("PREDICTION_DEPLOY_LOG_TAIL:", raw[-1200:])
                return 0 if str(result.invocation_status) == "Success" and int(result.exit_code) == 0 else 6
        print("PREDICTION_DEPLOY_ERROR: invocation did not finish")
        return 7
    except Exception as exc:
        print("PREDICTION_DEPLOY_ERROR:", type(exc).__name__, str(getattr(exc, "code", "unknown"))[:80])
        return 8

if __name__ == "__main__":
    sys.exit(main())

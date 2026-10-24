#!/usr/bin/env bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
[[ "$APP_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 2
test "$(systemctl is-active zl-prediction-deepseek5)" = active
test -f /etc/zl-prediction/deepseek5.env
node=/opt/zl-prediction-node/bin/node
test -x "$node"
# Read-only PRE-deployment snapshot: establish whether existing live stream
# has real 1m/5m/10m windows BEFORE replacing the collector process.
curl -fsS --max-time 4 http://127.0.0.1:13021/api/health -o /tmp/zl-event10-stream-before.json 2>/dev/null || true
curl -fsS --max-time 4 http://127.0.0.1:13020/api/status -o /tmp/zl-event10-session-before.json 2>/dev/null || true
install -d -m 0755 /opt/zl-event10
for f in server.mjs manual-engine.mjs market-enrichment.mjs trade-stream-collector.mjs panel.html server.test.mjs market-enrichment.test.mjs trade-stream-collector.test.mjs;do
 curl -fsSL --retry 3 --max-time 25 "https://raw.githubusercontent.com/zhoujunejune/pikpakzl/$APP_SHA/event10-bot/$f" -o "/opt/zl-event10/$f"
done
"$node" --check /opt/zl-event10/server.mjs
"$node" --test /opt/zl-event10/server.test.mjs /opt/zl-event10/market-enrichment.test.mjs /opt/zl-event10/trade-stream-collector.test.mjs
cat >/etc/systemd/system/zl-event10-deepseek.service <<'EOF'
[Unit]
Description=ZL Event Contract Ten Minute Read Only DeepSeek Signal
After=network-online.target
[Service]
User=zl-pred
Group=zl-pred
EnvironmentFile=/etc/zl-prediction/deepseek5.env
Environment=EVENT10_PORT=13020
Environment=EVENT10_STATE_FILE=/var/lib/zl-event10/manual-sessions-v2.json
ExecStart=/opt/zl-prediction-node/bin/node /opt/zl-event10/server.mjs
StateDirectory=zl-event10
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/zl-event10
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now zl-event10-deepseek >/dev/null
systemctl restart zl-event10-deepseek
ready=0
for i in $(seq 1 20);do
  if curl -fsS --max-time 4 http://127.0.0.1:13020/api/status -o /tmp/zl-event10-status.json 2>/dev/null;then
    ready=1
    break
  fi
  sleep 2
done
if test "$ready" -ne 1;then
  echo EVENT10_STARTUP_DIAGNOSTICS
  systemctl status zl-event10-deepseek --no-pager -l || true
  journalctl -u zl-event10-deepseek -n 25 --no-pager -o cat || true
  exit 41
fi
python3 - <<'PY'
import json
with open('/tmp/zl-event10-status.json') as f:
 x=json.load(f)
assert x['configured'] is True, 'EVENT10_DEEPSEEK_NOT_CONFIGURED'
assert x['autoTradingEnabled'] is False and x['executionAvailable'] is False
print('EVENT10_BACKEND_READY=true')
print('EVENT10_PROVIDER_MODEL='+str(x['providerModel']))
PY
rm -f /tmp/zl-event10-status.json
# Public market input availability check. Does not place an order or call DeepSeek.
curl -fsS --max-time 15 http://127.0.0.1:13020/api/data-health > /tmp/zl-event10-data-health.json
python3 - <<'PY'
import json
with open('/tmp/zl-event10-data-health.json') as f: d=json.load(f)
assert d['ok'] and d['total']==6
assert d['officialEventContractIndex'] is False
print('EVENT10_EXTRA_PUBLIC_SOURCES_AVAILABLE='+str(d['available'])+'/6')
for key,st in sorted(d['availability'].items()):
 print('EVENT10_EXTRA_SOURCE_'+key.upper()+'='+('READY' if st['available'] else st['error']))
print('EVENT10_NO_EVENT_CONTRACT_TRADE=true')
PY
rm -f /tmp/zl-event10-data-health.json
# Independent continuous Binance USD-M public market feed.
# Start only the isolated collector; never restart any existing trading engine.
"$node" --experimental-websocket -e 'if(typeof WebSocket!=="function")process.exit(19)'
cat >/etc/systemd/system/zl-event10-trade-stream.service <<'EOF'
[Unit]
Description=ZL EVENT10 Continuous Binance USD-M Public Trade Stream Recorder
After=network-online.target
Wants=network-online.target
[Service]
User=zl-pred
Group=zl-pred
Environment=EVENT10_STREAM_PORT=13021
Environment=EVENT10_STREAM_STATE=/var/lib/zl-event10-stream
ExecStart=/opt/zl-prediction-node/bin/node --experimental-websocket /opt/zl-event10/trade-stream-collector.mjs
StateDirectory=zl-event10-stream
StateDirectoryMode=0750
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=/var/lib/zl-event10-stream
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable zl-event10-trade-stream >/dev/null
systemctl restart zl-event10-trade-stream
ready=0
for i in $(seq 1 25);do
 if curl -fsS --max-time 2 http://127.0.0.1:13021/api/health -o /tmp/zl-event10-trade-stream.json 2>/dev/null;then
  if python3 - <<'PY'
import json
d=json.load(open('/tmp/zl-event10-trade-stream.json'))
assert d.get('connected') is True
assert int(d.get('totalSinceProcessStart') or 0)>=2
assert d.get('historyRecordingEnabled') is True
PY
  then ready=1;break;fi
 fi
 sleep 2
done
if test "$ready" != 1;then
 echo EVENT10_WS_LIVE_STREAM_NOT_CONFIRMED=true
 systemctl status zl-event10-trade-stream --no-pager -l || true
 journalctl -u zl-event10-trade-stream -n 25 --no-pager -o cat || true
 cat /tmp/zl-event10-trade-stream.json 2>/dev/null || true
 exit 51
fi
python3 - <<'PY'
import json
d=json.load(open('/tmp/zl-event10-trade-stream.json'))
assert d['source']=='BINANCE_USDM_AGGTRADE_100MS_PUBLIC_WEBSOCKET'
print('EVENT10_WS_CONNECTED=true')
print('EVENT10_WS_ACCEPTED_EVENTS='+str(d['totalSinceProcessStart']))
print('EVENT10_WS_JOURNAL_ENABLED=true')
print('EVENT10_WS_GAPS_DETECTED='+str(d['gapCount']))
print('EVENT10_WS_LAST_EVENT_LATENCY_MS='+str(d['lastEventLatencyMs']))
print('EVENT10_WS_COMPLETE_10M_WINDOW='+str(d['windows']['600s']['complete']))
print('EVENT10_WS_NO_AUTO_SIGNAL_OR_TRADING=true')
PY
rm -f /tmp/zl-event10-trade-stream.json



python3 - <<'PY'
import json,pathlib
p=pathlib.Path('/tmp/zl-event10-stream-before.json')
if p.exists():
 try:
  d=json.loads(p.read_text())
  print('EVENT10_BEFORE_COLLECTOR_CONNECTED='+str(d.get('connected')))
  print('EVENT10_BEFORE_COLLECTOR_SAMPLES='+str(d.get('samplesBuffered')))
  print('EVENT10_BEFORE_COLLECTOR_GAPS='+str(d.get('gapCount')))
  print('EVENT10_BEFORE_COLLECTOR_RECONNECTS='+str(d.get('reconnectCount')))
  print('EVENT10_BEFORE_COLLECTOR_LAST_RECEIVED='+str(d.get('lastReceivedAt')))
  for k,v in (d.get('windows') or {}).items():
   print('EVENT10_BEFORE_WINDOW_'+str(k)+'_COMPLETE='+str(v.get('complete'))+
     '_ISSUES='+','.join(v.get('issues') or []))
 except Exception:
  print('EVENT10_BEFORE_COLLECTOR_UNREADABLE=true')
else:print('EVENT10_BEFORE_COLLECTOR_MISSING=true')
q=pathlib.Path('/tmp/zl-event10-session-before.json')
if q.exists():
 try:
  d=json.loads(q.read_text())
  coverage=d.get('lastFeatureCoverage') or {}
  for k,v in sorted(coverage.items()):
   if v.get('available') is False:
    print('EVENT10_BEFORE_FEATURE_'+str(k).upper()+'_BLOCKER='+str(v.get('error')))
 except Exception:pass
PY
rm -f /tmp/zl-event10-stream-before.json /tmp/zl-event10-session-before.json

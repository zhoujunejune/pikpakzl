#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
import json,urllib.request,urllib.error,subprocess,os,pathlib
for port in [13001,13005,13002,6385]:
 print('RISK_AUDIT_SERVICE_PORT',port,'listen',subprocess.getoutput("ss -ltn '( sport = :"+str(port)+" )'").count('LISTEN')>0)
for svc in ['zl-prediction-trade','zl-prediction-redis','caddy']:
 print('RISK_AUDIT_SERVICE',svc,'active',subprocess.getoutput('systemctl is-active '+svc),'restarts',subprocess.getoutput('systemctl show '+svc+' -p NRestarts --value'))
for port in [13001,13005]:
 for route in ['/api/risk-control','/api/take-profit-control','/api/direction-mode']:
  try:
   with urllib.request.urlopen('http://127.0.0.1:'+str(port)+route,timeout=10) as r:
    raw=json.load(r)
    safe={k:raw.get(k) for k in ['ok','error','source','persistenceReady','persistenceHealthy','persistenceRestored','takeProfitEnabled','takeProfitPercent','stopLossEnabled','stopLossPercent','updatedAt','ready']}
    print('RISK_AUDIT_GET',port,route,r.status,json.dumps(safe))
  except Exception as e:print('RISK_AUDIT_GET_FAILED',port,route,type(e).__name__)
config=pathlib.Path('/etc/zl-prediction')
for fname in ['redis.env','panel.env','trading.env']:
 p=config/fname
 if not p.exists():continue
 entries={}
 for ln in p.read_text().splitlines():
  if '=' in ln and not ln.startswith('#'):
   k,v=ln.split('=',1)
   if k in ['SIGNAL_REDIS_URL','ZL_PUBLIC_ORIGIN','ZL_OUTER_AUTH_ONLY','AUTO_TAKE_PROFIT_ENABLED','AUTO_STOP_LOSS_ENABLED']:
    entries[k]='CONFIGURED_NONEMPTY' if k=='SIGNAL_REDIS_URL' and v else (v if k!='SIGNAL_REDIS_URL' else 'NOT_SET')
 print('RISK_AUDIT_ENV',fname,entries)
pw=config/'redis-auth'
if pw.exists():
 env=os.environ.copy();env['REDISCLI_AUTH']=pw.read_text().strip()
 cmd=['redis-cli','-h','127.0.0.1','-p','6385','--raw']
 for arg in [('PING',),('EXISTS','trade-control:risk-config:v1'),('EXISTS','trade-control:direction-mode:v4')]:
  r=subprocess.run(cmd+list(arg),env=env,capture_output=True,text=True,timeout=9)
  print('RISK_AUDIT_REDIS',arg[0],arg[1] if len(arg)>1 else '',r.returncode,r.stdout.strip()[:120])
print('RISK_AUDIT_RUNTIME_RISK_FILE',pathlib.Path('/tmp/risk-control.json').exists())
PY
echo 'RISK_AUDIT_LOG_SUMMARY_BEGIN'
journalctl -u zl-prediction-trade --since '120 minutes ago' --no-pager -o cat |
python3 -c 'import sys,re,collections,json
 lines=sys.stdin.read().splitlines()
 pats={"redis_connect":r"RISK_REDIS_CONNECT_FAILED|RISK_REDIS_URL_NOT_CONFIGURED|RISK_REDIS_UNAVAILABLE",
 "risk_restore_failed":r"risk_persistence_restore_failed",
 "risk_write_failed":r"保存风险配置失败|risk_control_updated|risk_config_write",
 "auth_rejected":r"PIN 错误|401|403",
 "uncaught":r"uncaughtException|SyntaxError|ERR_|FATAL ERROR"}
 print("RISK_AUDIT_LOG_COUNTS",json.dumps({k:sum(bool(re.search(p,x,re.I)) for x in lines) for k,p in pats.items()}))
 for s in lines[-120:]:
  if any(x in s for x in ("risk_persistence_restore_failed","risk_control_updated","RISK_REDIS_CONNECT_FAILED","RISK_REDIS_URL_NOT_CONFIGURED")):
   try:
    j=json.loads(s)
    print("RISK_AUDIT_LOG_EVENT",j.get("event"),j.get("error"),j.get("at"))
   except Exception: print("RISK_AUDIT_LOG_EVENT_UNPARSED")'

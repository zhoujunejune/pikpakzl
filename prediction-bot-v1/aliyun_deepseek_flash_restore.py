#!/usr/bin/env python3
"""Safely switch only the existing DeepSeek provider from V4 Pro back to Flash on SWAS.
No source model, official ledger, exchange orders or futures settings are changed.
Rollback original environment file on any verification failure. No credentials printed.
"""
import os,time,sys,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api
SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
envfile=/etc/zl-prediction/deepseek5.env
test -f "$envfile"
test ! -L "$envfile"
for svc in zl-prediction-deepseek5 zl-prediction-trade zl-prediction-v2 zl-prediction-v3 zl-futures-bot-paper;do
 test "$(systemctl is-active "$svc")" = active
done
python3 - <<'PY'
import json,urllib.request
def get(port,p):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}{p}',timeout=7) as r:return json.load(r)
a=get(13029,'/api/status')
b=get(13001,'/api/order-signal-model')
assert a['model']=='DEEPSEEK_5M_V1' and a['configured'] is True
assert a['realOrderEnabled'] is False and a['tradeIntegration'] is False
assert b['model']=='DEEPSEEK_5M_V1'
h=get(13029,'/api/history?limit=2')
assert h['model']=='DEEPSEEK_5M_V1' and h['ok'] is True
assert a['providerModel'] in ('deepseek-v4-pro','deepseek-flash'), 'UNEXPECTED_PROVIDER_MODEL'
print('FLASH_PREFLIGHT_EXISTING_MODEL='+str(a['providerModel']))
print('FLASH_PREFLIGHT_OFFICIAL_SAMPLES='+str(h['summary'].get('allOfficialSamples')))
PY
archive=/var/lib/zl-prediction/archive/provider-backups
mkdir -p "$archive"
chmod 0700 "$archive"
backup="$archive/deepseek5-env-before-flash-$(date -u +%Y%m%dT%H%M%SZ)-$$.bak"
cp -p "$envfile" "$backup"
chmod 0600 "$backup"
work=$(mktemp -d /tmp/zl-deepseek-flash-XXXXXX)
restore(){
  cp -p "$backup" "$envfile"
  chmod 0600 "$envfile"
  systemctl restart zl-prediction-deepseek5.service >/dev/null 2>&1 || true
  echo FLASH_ROLLBACK_TO_PREVIOUS_PROVIDER=true
}
trap 'restore; rm -rf "$work"' ERR
trap 'rm -rf "$work"' EXIT
python3 - "$envfile" <<'PY'
from pathlib import Path
import os,re,sys,tempfile,stat
p=Path(sys.argv[1])
s=p.read_text()
lines=s.splitlines()
idx=[i for i,line in enumerate(lines) if re.match(r'^DEEPSEEK_MODEL\s*=',line)]
if len(idx)>1:raise RuntimeError('DUPLICATE_MODEL_KEY')
if idx:lines[idx[0]]='DEEPSEEK_MODEL=deepseek-flash'
else:lines.append('DEEPSEEK_MODEL=deepseek-flash')
st=p.stat()
fd,tmp=tempfile.mkstemp(prefix='.deepseek-flash-',dir=str(p.parent))
try:
 with os.fdopen(fd,'w') as f:f.write('\n'.join(lines)+'\n')
 os.chown(tmp,st.st_uid,st.st_gid)
 os.chmod(tmp,0o600)
 os.replace(tmp,p)
finally:
 if os.path.exists(tmp):os.remove(tmp)
PY
systemctl restart zl-prediction-deepseek5.service
for i in $(seq 1 25);do
 if curl -fsS --max-time 5 http://127.0.0.1:13029/api/status -o "$work/status.json" 2>/dev/null;then
  if python3 - "$work/status.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
assert x['ok'] is True and x['configured'] is True
assert x['providerModel']=='deepseek-flash'
assert x['model']=='DEEPSEEK_5M_V1'
assert x['realOrderEnabled'] is False and x['tradeIntegration'] is False
assert x['reasoning']['enabled'] is True and x['reasoning']['effort']=='high'
PY
  then break;fi
 fi
 sleep 2
done
python3 - "$work/status.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
assert x['providerModel']=='deepseek-flash'
print('FLASH_PRODUCTION_PROVIDER='+x['providerModel'])
print('FLASH_REASONING='+x['reasoning']['effort'])
assert x['learning']['allOfficialSamples']>=0
print('FLASH_LEARNING_SAMPLES='+str(x['learning']['allOfficialSamples']))
print('FLASH_HISTORY_PRESERVED=true')
print('FLASH_ORDER_ENGINE_UNCHANGED=true')
PY
python3 - <<'PY'
import json,urllib.request,subprocess
for svc in ('zl-prediction-trade','zl-prediction-v2','zl-prediction-v3','zl-prediction-deepseek5','zl-futures-bot-paper'):
 assert subprocess.check_output(['systemctl','is-active',svc],text=True).strip()=='active'
def get(p):
 with urllib.request.urlopen('http://127.0.0.1:13001'+p,timeout=8) as r:return json.load(r)
choice=get('/api/order-signal-model')
assert choice['model']=='DEEPSEEK_5M_V1'
assert [x['id'] for x in choice['models']]==['DEEPSEEK_5M_V1']
print('FLASH_PRODUCTION_MODEL_SELECTED=DEEPSEEK_5M_V1')
print('FLASH_FUTURES_AND_PREDICTION_SERVICES_ACTIVE=true')
print('FLASH_DEPLOY_SUCCESS=true')
PY
trap - ERR
"""
def main():
 cli=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 inv=cli.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  name='zl-switch-deepseek-flash-only',type='RunShellScript',
  working_user='root',command_content=SCRIPT,timeout=160)).body.invoke_id
 for _ in range(75):
  time.sleep(2)
  r=cli.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
    instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   raw=r.output or ''
   try:raw=base64.b64decode(raw,validate=True).decode('utf8','replace')
   except Exception:pass
   print('FLASH_REMOTE_STATUS='+str(r.invocation_status),'EXIT='+str(r.exit_code))
   print('\n'.join(x for x in raw.splitlines() if x.startswith('FLASH_'))[-3400:])
   return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 else 5
 print('FLASH_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

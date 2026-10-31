#!/usr/bin/env python3
"""Make GUARDIAN the only production signal selection; fail closed on any missing trading edge."""
import os,sys,time,base64
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
NODE=/opt/zl-prediction-node/bin/node
BASE=/opt/zl-prediction-live/src/railway-diagnostic
CHOICE=$BASE/production-signal-choice.mjs
ENGINE=$BASE/index.mjs
test -f "$CHOICE" && test -f "$ENGINE" && test -x "$NODE"
systemctl is-active --quiet zl-prediction-trade
systemctl is-active --quiet zl-prediction-guardian-analysis
python3 - <<'PY'
import json,urllib.request,urllib.error
def get(port,path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:%d%s'%(port,path),timeout=8) as f:return json.load(f)
 except urllib.error.HTTPError as e:
  return json.loads(e.read().decode('utf8','replace'))
s=get(13001,'/api/status');m=get(13001,'/api/order-signal-model')
g=get(13049,'/api/status')
assert s.get('ok') is True and s.get('enabled') is False,'LIVE_SWITCH_ON_ABORT'
assert not s.get('pendingAction'),'PENDING_ORDER_ABORT'
assert m.get('model') in ('FAST5_SPOT_MOMENTUM_V1','ZL_GUARDIAN_5M_V1') or 'INVALID_MODEL_SELECTION' in str(m.get('error')),'UNEXPECTED_PRODUCTION_MODEL'
assert g.get('ok') is True and g.get('model')=='ZL_GUARDIAN_5M_V1' and g.get('configured') is True
assert g.get('orders') is False and g.get('productionIntegration') is False
print('GUARDIAN_CUTOVER_PREFLIGHT_PASS=true')
PY
BACK=/var/backups/zl-guardian-production-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 700 "$BACK"
cp -p "$CHOICE" "$BACK/choice.before"
cp -p "$ENGINE" "$BACK/engine.before"
echo GUARDIAN_BACKUP_CREATED=true
python3 - <<'PY'
from pathlib import Path
import re,os
base=Path('/opt/zl-prediction-live/src/railway-diagnostic')
choice=base/'production-signal-choice.mjs'
engine=base/'index.mjs'
x=choice.read_text()
label="ZL_GUARDIAN_5M_V1"
if "export const GUARDIAN_MODEL=" not in x:
 at=x.find('export const ORDER_SIGNAL_MODELS=')
 assert at>=0,'CHOICE_CATALOG_ANCHOR_MISSING'
 x=x[:at]+"export const GUARDIAN_MODEL='"+label+"';\n"+x[at:]
start=x.index('export const ORDER_SIGNAL_MODELS=Object.freeze([')
end=x.index(']);',start)+3
x=x[:start]+("export const ORDER_SIGNAL_MODELS=Object.freeze([\n"
 " {id:GUARDIAN_MODEL,name:'GUARDIAN 5M · DeepSeek动态分析（风险条件不满足即WAIT）'}\n"
 "]);")+x[end:]
start=x.index('export async function refreshModelSelection(){')
end=x.index('export async function setModelSelection(',start)
part=x[start:end].replace('SELECTIVE8_MODEL','GUARDIAN_MODEL')
x=x[:start]+part+x[end:]
y=engine.read_text()
anchor='if(!selectionPermitsRound(round,choice))return null;'
assert y.count(anchor)==1,'TRADE_ROUTING_ANCHOR_NOT_UNIQUE'
if 'GUARDIAN_PRODUCTION_SINGLE_SOURCE_V1' not in y:
 insert='''// GUARDIAN_PRODUCTION_SINGLE_SOURCE_V1: sole selected model.
  // Do not convert subjective AI direction into an order. Until the
  // market-specific official price, *executable* BUY quote, calibrated
  // out-of-sample probability and SELL exit logic are integrated, WAIT.
  if(choice.model==='ZL_GUARDIAN_5M_V1'){
    try{
      const response=await fetch('http://127.0.0.1:13049/api/status',{
        cache:'no-store',signal:AbortSignal.timeout(1800)});
      if(response.ok){
        const guardian=await response.json();
        if(guardian?.ok!==true||guardian?.model!=='ZL_GUARDIAN_5M_V1'||
           guardian?.productionIntegration!==false||guardian?.orders!==false)
          console.error('GUARDIAN_UNTRUSTED_ANALYSIS_STATUS');
      }
    }catch(err){console.error('GUARDIAN_ANALYSIS_UNAVAILABLE',String(err?.message||err).slice(0,90))}
    return null;
  }
'''
 y=y.replace(anchor,anchor+'\n  '+insert,1)
for p,s in [(choice,x),(engine,y)]:
 stage=p.with_name(p.name+'.guardian-prod.stage')
 stage.write_text(s)
 os.chown(stage,p.stat().st_uid,p.stat().st_gid)
 os.chmod(stage,p.stat().st_mode&0o777)
 os.replace(stage,p)
print('GUARDIAN_ROUTING_PATCHED=true')
PY
"$NODE" --check "$CHOICE"
"$NODE" --check "$ENGINE"
# Restart the owner-controlled single trade service; other bots are not installed.
systemctl restart zl-prediction-trade
for i in $(seq 1 30);do
 if curl -fsS --max-time 4 http://127.0.0.1:13001/api/order-signal-model -o /tmp/zl-guardian-selected.json &&
    curl -fsS --max-time 4 http://127.0.0.1:13001/api/status -o /tmp/zl-guardian-trade.json;then break;fi
 sleep 2
done
python3 - <<'PY'
import json
c=json.load(open('/tmp/zl-guardian-selected.json'))
s=json.load(open('/tmp/zl-guardian-trade.json'))
assert c.get('ok') and c.get('ready') is True
assert c.get('model')=='ZL_GUARDIAN_5M_V1','PRODUCTION_MODEL_NOT_GUARDIAN'
assert [x['id'] for x in c.get('models',[])]==['ZL_GUARDIAN_5M_V1'],'RETIRED_MODEL_STILL_SELECTABLE'
assert s.get('ok') is True and s.get('enabled') is False,'LIVE_SWITCH_CHANGED'
assert s.get('orderSignalModel')=='ZL_GUARDIAN_5M_V1'
assert s.get('orderSignal') is None,'OLD_SIGNAL_STILL_TRADABLE'
assert s.get('pendingAction') is None,'OLD_PENDING_ORDER_NOT_CLEARED'
print('GUARDIAN_ONLY_PRODUCTION_MODEL=true')
print('GUARDIAN_LEGACY_SIGNAL_DISCONNECTED=true')
print('GUARDIAN_REAL_TRADING_REMAINS_OFF=true')
PY
systemctl is-active --quiet zl-prediction-guardian-analysis
systemctl is-active --quiet zl-prediction-trade
systemctl is-active --quiet zl-prediction-risk-exits
echo GUARDIAN_PRODUCTION_SELECTION_SUCCESS=true
echo GUARDIAN_PRODUCTION_BACKUP="$BACK"
"""

def main():
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
 access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
 endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 inv=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
 instance_id='b67374069bb3457ba6a3a2ede9305d3f',
 name='guardian-sole-production-signal-routing',type='RunShellScript',
 command_content=SCRIPT,working_user='root',timeout=200)).body.invoke_id
 for _ in range(98):
  time.sleep(2)
  r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',invoke_id=inv)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:out=str(r.output or '')
   print('GUARDIAN_SWITCH_REMOTE',r.invocation_status,'EXIT',r.exit_code)
   print(out[-10000:])
   return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 and 'GUARDIAN_PRODUCTION_SELECTION_SUCCESS=true' in out else 6
 print('GUARDIAN_SWITCH_TIMEOUT');return 7
if __name__=='__main__':sys.exit(main())

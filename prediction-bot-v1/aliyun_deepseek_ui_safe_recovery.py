#!/usr/bin/env python3
"""Safely restore Alibaba prediction frontend and apply minimal DeepSeek stats UI patch.
Uses existing SWAS permission; no signal model, order logic, key, or settlement rows changed.
"""
import base64,os,re,sys,time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

SCRIPT=r"""#!/bin/bash
set -Eeuo pipefail
python3 - <<'PY'
from pathlib import Path
import os,subprocess,urllib.request,urllib.error,time,shutil,datetime,json
root=Path('/opt/zl-prediction-live/src/railway-diagnostic')
dst=root/'panel-stats-shell.mjs'
archive=Path('/var/lib/zl-prediction/archive/source-backups')
backups=sorted(archive.glob('deepseek-panel-*.mjs'),key=lambda p:p.stat().st_mtime,reverse=True)
legacy=None
for p in backups:
 src=p.read_text(errors='replace')
 if "const statsScript = " in src and "id=\\"roundStatsCard\\"" in src and
    "async function renderDeepSeekRoundStats" not in src:
  legacy=p
  break
if legacy is None:
 raise RuntimeError('ORIGINAL_PANEL_BACKUP_NOT_FOUND_NO_UNSAFE_CHANGES')
original=legacy.read_text()
installed=dst.read_text()
print('FRONTEND_ORIGINAL_BACKUP_VERIFIED=true',flush=True)
s=original.replace('<div class="k">每轮判断与真实结果</div>',
 '<div class="k">DeepSeek 每轮预测与官方结算 · 独立统计</div>',1)
s=s.replace('仅统计新版RSI(14)直接输出方向与币安预测市场官方结算的准确率；实际订单盈亏另行统计。',
 '唯一生产模型 DEEPSEEK_5M_V1，严格只统计 DeepSeek 已锁定预测及币安官方结算；旧模型已归档。',1)
marker='async function load(){'
start=s.find('const statsScript = ')
assert start!=-1
pos=s.find(marker,start)
assert pos!=-1
addition="""
async function renderDeepSeekOnlyStats(){
 function put(id,v){var el=e(id);if(el)el.textContent=String(v)}
 function showError(message){
   put('rsAccuracy','DeepSeek 统计暂不可用');
   put('rsSettled','-');put('rsDecided','-');put('rsCorrect','-');put('rsWrong','-');
   put('rsWait','未统计');put('rsCoverage','未统计');
   put('rsMeta','仅显示 DeepSeek 自身数据，不回退旧 Selective V2 统计：'+message);
   if(e('rsRows'))e('rsRows').innerHTML='<tr><td colspan="8" style="padding:10px">DeepSeek 数据暂不可用；不显示旧模型记录</td></tr>';
 }
 try{
   var responses=await Promise.all([
     fetch('/api/order-signal-model?ts='+Date.now(),{cache:'no-store'}),
     fetch('/deepseek/api/history?limit=80&ts='+Date.now(),{cache:'no-store'}),
     fetch('/deepseek/api/status?ts='+Date.now(),{cache:'no-store'})
   ]);
   if(responses.some(function(r){return !r.ok}))throw Error('数据接口未全部正常');
   var selected=await responses[0].json(),ledger=await responses[1].json(),status=await responses[2].json();
   if(selected.model!=='DEEPSEEK_5M_V1'||ledger.model!=='DEEPSEEK_5M_V1'||
      ledger.ok!==true||status.model!=='DEEPSEEK_5M_V1'||!Array.isArray(ledger.records))
     throw Error('生产模型或独立账本未就绪');
   var rows=ledger.records.filter(function(x){return Number.isSafeInteger(x.round)&&
     (x.direction==='UP'||x.direction==='DOWN')});
   var settled=rows.filter(function(x){return (x.actual==='UP'||x.actual==='DOWN')&&
     Number.isSafeInteger(Number(x.settledAt))&&typeof x.hit==='boolean'});
   var hits=settled.filter(function(x){return x.hit}).length;
   put('rsAccuracy',settled.length?(100*hits/settled.length).toFixed(2)+'%（'+settled.length+'轮）':'DeepSeek 官方结算样本不足');
   put('rsSettled',settled.length);put('rsDecided',rows.length);
   put('rsCorrect',hits);put('rsWrong',settled.length-hits);
   put('rsWait','未单独计数');put('rsCoverage','未单独计数');
   put('rsMeta','当前唯一生产模型：DEEPSEEK_5M_V1。最近独立预测 '+rows.length+
      ' 轮，已官方结算 '+settled.length+' 轮；结果按 DeepSeek 自身账本配对，旧版记录不混入。');
   rows.sort(function(a,b){return b.round-a.round});
   var current=Math.floor(Date.now()/300000)*300000;
   if(status.round===current&&!rows.some(function(x){return x.round===current}))
     rows.unshift({round:current,waiting:true,provider:status.providerModel});
   if(e('rsRows'))e('rsRows').innerHTML=rows.slice(0,40).map(function(x){
     var actual=x.actual==='UP'||x.actual==='DOWN'?x.actual:null;
     var predicted=x.direction==='UP'||x.direction==='DOWN'?x.direction:null;
     var result=!predicted?'NO_DECISION':!actual?'PENDING':x.hit?'HIT':'MISS';
     var confidence=typeof x.confidence==='number'&&isFinite(x.confidence)?
       x.confidence.toFixed(3)+'（模型自评，未校准）':'未提供';
     var latency=typeof x.signalLatencyMs==='number'&&isFinite(x.signalLatencyMs)?
       (x.signalLatencyMs/1000).toFixed(2)+'s':'-';
     return '<tr style="border-top:1px solid #2b313d">'+
      '<td style="padding:9px 6px">'+esc(tm(x.round))+'</td>'+
      '<td style="padding:9px 6px">'+badge(predicted||'NO_DECISION')+'</td>'+
      '<td style="padding:9px 6px">DeepSeek '+esc(x.provider||'deepseek-flash')+
         (x.waiting?'（思考中）':'')+'</td>'+
      '<td style="padding:9px 6px">'+esc(x.waiting?'等待判断':confidence)+'</td>'+
      '<td style="padding:9px 6px">'+esc(latency)+'</td>'+
      '<td style="padding:9px 6px">'+badge(actual||'PENDING')+'</td>'+
      '<td style="padding:9px 6px">'+badge(result)+'</td>'+
      '<td style="padding:9px 6px">'+(actual?'已取得 Binance 官方结算证据':'等待官方结算')+'</td></tr>';
   }).join('')||'<tr><td colspan="8" style="padding:10px">DeepSeek 暂无预测记录，不混入旧策略</td></tr>';
 }catch(err){showError(err&&err.message?err.message:String(err))}
}
"""
s=s[:pos]+addition+s[pos:].replace(marker,marker+'\n return await renderDeepSeekOnlyStats();',1)
assert 'DeepSeek 每轮预测与官方结算 · 独立统计' in s
assert 'renderDeepSeekOnlyStats' in s
now=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=archive/('before-minimal-deepseek-ui-'+now+'.mjs')
shutil.copy2(dst,backup)
staged=dst.with_name(dst.name+'.minimal-deepseek-pending')
staged.write_text(s)
st=dst.stat()
os.chown(staged,st.st_uid,st.st_gid)
os.chmod(staged,st.st_mode&0o777)
try:
 subprocess.run(['/opt/zl-prediction-node/bin/node','--check',str(staged)],check=True,
  stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=14)
except Exception as exc:
 staged.unlink(missing_ok=True)
 print('FRONTEND_PATCH_SYNTAX_FAILED_NO_CHANGES=true',flush=True)
 raise
os.replace(staged,dst)
print('FRONTEND_MINIMAL_DEEPSEEK_PATCH_WRITTEN=true',flush=True)
def ready():
 try:
  with urllib.request.urlopen('http://127.0.0.1:13001/api/order-signal-model',timeout=5) as r:v=json.load(r)
  return v.get('model')=='DEEPSEEK_5M_V1'
 except Exception:return False
def restart():
 try:subprocess.run(['systemctl','restart','zl-prediction-trade.service'],check=True,timeout=60)
 except Exception:return False
 for _ in range(25):
  if ready():return True
  time.sleep(3)
 return False
if not restart():
 print('FRONTEND_PATCH_HEALTH_CHECK_FAILED_RESTORING_BACKUP=true',flush=True)
 shutil.copy2(legacy,dst)
 restart()
 print('FRONTEND_ORIGINAL_PANEL_RECOVERY_ATTEMPTED=true',flush=True)
 raise RuntimeError('FRONTEND_HEALTH_NOT_RECOVERED')
print('FRONTEND_MODEL_SELECTOR_ACTIVE=true',flush=True)
try:
 with urllib.request.urlopen('http://127.0.0.1:13001/',timeout=8) as r:html=r.read(300000).decode('utf-8','replace')
 print('FRONTEND_LOCAL_HTML_DEEPSEEK_STATS=', 'DeepSeek 每轮预测与官方结算 · 独立统计' in html,flush=True)
 print('FRONTEND_LOCAL_HTML_RENDERER=', 'renderDeepSeekOnlyStats' in html,flush=True)
except Exception as e:print('FRONTEND_HTML_PROBE_ERROR',type(e).__name__,flush=True)
print('FRONTEND_LEGACY_SIGNAL_STATS_ARCHIVED_ONLY=true',flush=True)
PY
""";
def main():
 sha=os.environ.get('GITHUB_SHA','')
 if os.environ.get('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch(r'[0-9a-f]{40}',sha):
  print('FRONTEND_REF_INVALID');return 2
 client=Client(api.Config(access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  region_id='ap-southeast-1',endpoint='swas.ap-southeast-1.aliyuncs.com'))
 try:
  inv=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
   instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   name='zl-recover-minimal-deepseek-panel',type='RunShellScript',
   working_user='root',command_content=SCRIPT,timeout=320)).body.invoke_id
  for _ in range(175):
   time.sleep(2)
   v=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
    region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
    invoke_id=inv)).body.invocation_result
   if v and str(v.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
    try:s=base64.b64decode(v.output or '',validate=True).decode('utf8','replace')
    except Exception:s=v.output or ''
    print('FRONTEND_REPAIR_REMOTE_STATUS',v.invocation_status,'EXIT',v.exit_code)
    print(s[-7500:])
    return 0 if str(v.invocation_status)=='Success' and int(v.exit_code)==0 else 5
  print('FRONTEND_RECOVERY_TIMEOUT');return 6
 except Exception as e:print('FRONTEND_RECOVERY_REMOTE_ERROR',type(e).__name__);return 7
if __name__=='__main__':sys.exit(main())

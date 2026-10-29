#!/usr/bin/env python3
"""Restore GUARDIAN homepage signal, market and per-round read-only visibility.

This script never edits strategy/order/risk code and never flips following state.
When live following is active it stages the UI file WITHOUT restarting trade.
"""
import base64
import os
import re
import sys
import time
from alibabacloud_swas_open20200601.client import Client
from alibabacloud_swas_open20200601 import models as sw
from alibabacloud_tea_openapi import models as api

VIS = r'''<script>(function(){
'use strict';
if(window.__zlGuardianVisibilityRestoreV1)return;
window.__zlGuardianVisibilityRestoreV1=true;
var root=document.querySelector('.w')||document.querySelector('main');
if(!root)return;
var card=document.createElement('section');
card.id='zlGuardianVisibilityRestoreV1';
card.className='c';
card.style.cssText='border:1px solid #38516c;background:#121d2e;color:#e7f0ff;margin:14px 0';
card.innerHTML='<div style="font-weight:750;font-size:17px;margin-bottom:12px">BTC 5分钟 · 实时行情与信号记录</div>'+
'<div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:9px">'+
'<div class="kv"><div class="k">BTC/USDT 现货最新报价</div><div class="v" id="zgvPrice">读取中</div></div>'+
'<div class="kv"><div class="k">行情采集时间</div><div class="v" id="zgvFresh">读取中</div></div>'+
'<div class="kv"><div class="k">当前5分钟轮次</div><div class="v" id="zgvRound">读取中</div></div>'+
'<div class="kv"><div class="k">GUARDIAN 分析方向</div><div class="v" id="zgvSignal">读取中</div></div>'+
'<div class="kv"><div class="k">生产下单信号</div><div class="v" id="zgvTrade">读取中</div></div>'+
'<div class="kv"><div class="k">已保存信号数</div><div class="v" id="zgvCount">读取中</div></div></div>'+
'<div class="muted" id="zgvReason" style="margin:12px 0 8px">正在同步分析原因</div>'+
'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0"><strong style="font-size:15px">GUARDIAN 逐轮信号记录</strong><span class="muted" id="zgvStatus">同步中</span></div>'+
'<div style="overflow-x:auto;max-height:380px;border:1px solid #33465d;border-radius:10px"><table style="width:100%;min-width:550px;border-collapse:collapse;font-size:12px"><thead><tr><th style="padding:10px">轮次</th><th>记录时间</th><th>预测</th><th>置信度</th><th>官方结算</th><th>验证</th></tr></thead><tbody id="zgvRows"><tr><td colspan="6" style="padding:10px">读取中</td></tr></tbody></table></div>'+
'<div class="muted" style="font-size:12px;margin-top:10px">报价为 Binance BTCUSDT 现货价，并非 Binance Prediction 的官方结算价。表格只展示GUARDIAN已经持久化的信号；WAIT/无信号轮次如未保存，不会伪造记录。信号不等于真实成交。</div>';
root.insertBefore(card,root.firstChild);
var busy=false,lastTicker=0;
function e(id){return document.getElementById(id)}
function put(id,x){var n=e(id);if(n)n.textContent=x==null?'-':String(x)}
function tm(v){var n=Number(v);return Number.isFinite(n)&&n>0?new Date(n).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'-'}
function dir(v){return v==='UP'?'UP ↑ 看涨':v==='DOWN'?'DOWN ↓ 看跌':v==='WAIT'?'WAIT · 跳过':v==='THINKING'?'分析中':v==='OBSERVED'?'本轮已保存':'无信号'}
async function get(url,timeout){var r=await fetch(url,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(timeout||5000)});if(!r.ok)throw Error('HTTP '+r.status);return r.json()}
async function ticker(){
 try{
  var r=await fetch('https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT',{cache:'no-store',signal:AbortSignal.timeout(4500)});
  if(!r.ok)throw Error('HTTP '+r.status);
  var x=await r.json(),p=Number(x&&x.price);
  if(!Number.isFinite(p)||p<=0)throw Error('无有效报价');
  put('zgvPrice',p.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' USDT');
  lastTicker=Date.now();
 }catch(err){put('zgvPrice','现货报价不可用');}
}
function draw(rows){
 var body=e('zgvRows');if(!body)return;
 body.replaceChildren();
 var data=Array.isArray(rows)?rows.slice().sort(function(a,b){return Number(b.round)-Number(a.round)}).slice(0,35):[];
 if(!data.length){var tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=6;td.style.padding='12px';td.textContent='暂无已持久化的GUARDIAN信号；无信号轮次不能当作历史记录';tr.appendChild(td);body.appendChild(tr);return}
 data.forEach(function(x){
  var tr=document.createElement('tr');
  var conf=Number(x.subjectiveConfidence);
  var cells=[tm(x.round),tm(x.at),dir(x.predictedDirection),x.subjectiveConfidence==null||!Number.isFinite(conf)?'-':(100*conf).toFixed(1)+'%（主观）',x.officialDirection||'待官方结算',x.status==='SETTLED'?(x.hit?'命中':'未命中'):'未结算'];
  cells.forEach(function(v){var td=document.createElement('td');td.style.cssText='padding:9px 6px;border-top:1px solid #2b3b4e;white-space:nowrap';td.textContent=v;tr.appendChild(td)});
  body.appendChild(tr);
 });
}
async function load(){
 if(busy||document.hidden)return;busy=true;
 try{
  var pair=await Promise.allSettled([get('/guardian/api/status',6500),get('/api/status',6500)]);
  if(pair[0].status==='fulfilled'&&pair[0].value.ok===true){
   var g=pair[0].value, latest=g.latest||{},records=g.records||[];
   var current=records.find(function(x){return Number(x.round)===Number(g.round)});
   put('zgvRound',tm(g.round));
   put('zgvSignal',dir(current?current.predictedDirection:latest.direction));
   put('zgvCount',g.stats&&g.stats.shadowPredictions!=null?g.stats.shadowPredictions:records.length);
   put('zgvFresh',g.observedAt?Math.max(0,Math.floor((Date.now()-Number(g.observedAt))/1000))+'秒前':'尚无采集时间');
   put('zgvReason',latest.reason||'暂无分析原因');
   put('zgvStatus','最近更新 '+tm(Date.now()));
   draw(records);
  }else{
   put('zgvStatus','GUARDIAN记录接口不可用');
   put('zgvReason','本轮未能取得分析服务数据，不能据此判断没有记录');
  }
  if(pair[1].status==='fulfilled'&&pair[1].value.ok===true){
   var t=pair[1].value,s=t.signal||{};
   put('zgvTrade',s.direction==='UP'||s.direction==='DOWN'?dir(s.direction):'未锁定 / 无有效下单信号');
  }else put('zgvTrade','生产状态接口不可用');
 }finally{busy=false}
}
void load();void ticker();
setInterval(load,4500);setInterval(ticker,9000);
document.addEventListener('visibilitychange',function(){if(!document.hidden){void load();if(Date.now()-lastTicker>9000)void ticker()}});
})();</script>'''

# Remote script is generated with only a base64-encoded, static UI fragment.
REMOTE = r"""#!/bin/bash
set -Eeuo pipefail
PANEL=/opt/zl-prediction-live/src/railway-diagnostic/guardian-main-dashboard.mjs
NODE=/opt/zl-prediction-node/bin/node
test -r "$PANEL" && test -x "$NODE"
systemctl is-active --quiet zl-prediction-trade
BACK=/var/backups/guardian5-visibility-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p -m 0700 "$BACK"
cp -p "$PANEL" "$BACK/before.mjs"
export ZGV_BACK="$BACK"
python3 - <<'PY'
from pathlib import Path
import base64,json,os
p=Path('/opt/zl-prediction-live/src/railway-diagnostic/guardian-main-dashboard.mjs')
src=p.read_text()
if "zlGuardianVisibilityRestoreV1" in src:
 print("ZGV_PATCH_ALREADY_STAGED=true")
else:
 fragment=base64.b64decode('FRAGMENT_BASE64_HERE').decode('utf-8')
 needle="return out.replace('</body>',SCRIPT+'</body>');"
 if src.count(needle)!=1:raise RuntimeError('GUARDIAN_INJECTION_ANCHOR_CHANGED')
 replacement="return out.replace('</body>',SCRIPT+"+json.dumps(fragment,ensure_ascii=False)+"+'</body>');"
 revised=src.replace(needle,replacement,1)
 st=p.with_name(p.name+'.zgv-stage')
 st.write_text(revised)
 os.chmod(st,p.stat().st_mode&0o777)
 os.chown(st,p.stat().st_uid,p.stat().st_gid)
 os.replace(st,p)
 print("ZGV_PATCH_STAGED=true")
PY
python3 - <<'PY'
from pathlib import Path
import json,os
p=Path('/opt/zl-prediction-live/src/railway-diagnostic/guardian-main-dashboard.mjs')
src=p.read_text()
if 'ZGV_FALLBACK_SCRIPT' in src:
 print('ZGV_INDEPENDENT_FALLBACK_ALREADY_STAGED=true')
else:
 needle=' if(start<0)return html;'
 assert src.count(needle)==1,'GUARDIAN_OLD_CARD_FALLBACK_ANCHOR_CHANGED'
 matches=[l for l in src.splitlines() if l.startswith(" return out.replace('</body>',SCRIPT+")]
 assert len(matches)==1,'GUARDIAN_RENDER_RETURN_UNEXPECTED'
 old=matches[0]
 quoted=old.split('SCRIPT+',1)[1].rsplit("+'</body>');",1)[0]
 fragment=json.loads(quoted)
 assert 'zlGuardianVisibilityRestoreV1' in fragment and fragment.startswith('<script>')
 declaration='export function injectGuardianMainDashboard(html){'
 assert src.count(declaration)==1
 src=src.replace(declaration,'const ZGV_FALLBACK_SCRIPT='+quoted+';\n'+declaration,1)
 src=src.replace(needle," if(start<0)return html.replace('</body>',ZGV_FALLBACK_SCRIPT+'</body>');",1)
 src=src.replace(old," return out.replace('</body>',SCRIPT+ZGV_FALLBACK_SCRIPT+'</body>');",1)
 stage=p.with_name(p.name+'.zgv-fallback')
 stage.write_text(src)
 os.chmod(stage,p.stat().st_mode&0o777)
 os.chown(stage,p.stat().st_uid,p.stat().st_gid)
 os.replace(stage,p)
 print('ZGV_INDEPENDENT_FALLBACK_STAGED=true')
PY
"$NODE" --check "$PANEL"
STATE=$(python3 - <<'PY'
import urllib.request,json
with urllib.request.urlopen('http://127.0.0.1:13001/api/status',timeout=8) as f:s=json.load(f)
if s.get('ok') is not True:raise RuntimeError('TRADE_STATUS_NOT_OK')
print('ACTIVE' if s.get('enabled') is True or s.get('pendingAction') else 'IDLE')
PY
)
if test "$STATE" != IDLE;then
 echo ZGV_PATCH_ON_DISK_BUT_NOT_LIVE=true
 echo ZGV_FOLLOWING_UNCHANGED=true
 echo ZGV_RESTART_SKIPPED_TO_PROTECT_ACTIVE_TRADES=true
 exit 0
fi
if ! systemctl restart zl-prediction-trade;then
 cp -p "$BACK/before.mjs" "$PANEL"
 systemctl restart zl-prediction-trade || true
 echo ZGV_DEPLOY_ROLLED_BACK=true
 exit 8
fi
READY=0
for i in $(seq 1 62);do
 if curl -fsS --max-time 4 http://127.0.0.1:13001/ -o "$BACK/page.html" && grep -q 'zlGuardianVisibilityRestoreV1' "$BACK/page.html";then READY=1;break;fi
 sleep 2
done
if test "$READY" != 1;then
 cp -p "$BACK/before.mjs" "$PANEL"
 systemctl restart zl-prediction-trade || true
 echo ZGV_DEPLOY_ROLLED_BACK=true
 exit 9
fi
echo ZGV_LIVE_VISIBILITY_RESTORED=true
echo ZGV_TRADE_STRATEGY_UNCHANGED=true
"""
REMOTE=REMOTE.replace('FRAGMENT_BASE64_HERE',base64.b64encode(VIS.encode()).decode())

def main():
 if os.getenv('GITHUB_REF_NAME')!='feature/zl-futures-bot-v1' or not re.fullmatch('[0-9a-f]{40}',os.getenv('GITHUB_SHA','')):
  print('ZGV_INVALID_WORKFLOW_BRANCH');return 2
 client=Client(api.Config(
  access_key_id=os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
  access_key_secret=os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  endpoint='swas.ap-southeast-1.aliyuncs.com',region_id='ap-southeast-1'))
 invoke=client.run_command(sw.RunCommandRequest(region_id='ap-southeast-1',
  instance_id='b67374069bb3457ba6a3a2ede9305d3f',
  name='restore-guardian-main-readonly-visibility',type='RunShellScript',
  command_content=REMOTE,working_user='root',timeout=230)).body.invoke_id
 for _ in range(132):
  time.sleep(2)
  r=client.describe_invocation_result(sw.DescribeInvocationResultRequest(
   region_id='ap-southeast-1',instance_id='b67374069bb3457ba6a3a2ede9305d3f',
   invoke_id=invoke)).body.invocation_result
  if r and str(r.invocation_status) in ('Success','Failed','Aborted','ExecutionTimeout','ExitCodeNonzero'):
   try:out=base64.b64decode(r.output or '',validate=True).decode('utf8','replace')
   except Exception:out='NON_UTF8_REMOTE_RESULT'
   print('ZGV_REMOTE_RESULT',r.invocation_status,r.exit_code)
   print(out[-3000:])
   return 0 if str(r.invocation_status)=='Success' and int(r.exit_code)==0 and ('ZGV_LIVE_VISIBILITY_RESTORED=true' in out or 'ZGV_PATCH_ON_DISK_BUT_NOT_LIVE=true' in out) else 5
 print('ZGV_REMOTE_TIMEOUT');return 6
if __name__=='__main__':sys.exit(main())

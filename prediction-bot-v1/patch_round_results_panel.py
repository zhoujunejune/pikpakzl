#!/usr/bin/env python3
"""Add only a read-only 5m round-results card to existing Alibaba prediction UI."""
from pathlib import Path
import sys,json
if len(sys.argv)!=3:raise SystemExit('usage: patch_round_results_panel.py LIVE_SOURCE OUT')
live,out=map(Path,sys.argv[1:])
s=live.read_text()
CARD="""<section class="c" id="roundResultsOnlyCard" style="margin:14px 0">
 <div class="k">5分钟预测 · 每轮结果（仅记录，不参与学习）</div>
 <div class="big" id="rrAccuracy" style="margin:8px 0">胜率读取中...</div>
 <div class="muted" id="rrMeta">只统计新版5秒信号，依据币安Prediction官方结算，未结算不算输赢。</div>
 <div class="grid" style="margin:12px 0">
  <div class="kv"><div class="k">已结算</div><div class="v" id="rrSettled">-</div></div>
  <div class="kv"><div class="k">命中 / 未命中</div><div class="v" id="rrHitLoss">-</div></div>
  <div class="kv"><div class="k">待结算</div><div class="v" id="rrPending">-</div></div>
  <div class="kv"><div class="k">未出方向</div><div class="v" id="rrNoSignal">-</div></div>
 </div>
 <div style="overflow-x:auto;max-height:430px;border:1px solid #303a4b;border-radius:9px">
  <table style="width:100%;min-width:780px;border-collapse:collapse;font-size:13px">
   <thead style="position:sticky;top:0;background:#151922;color:#b1b9c8"><tr>
    <th style="padding:9px 6px">轮次时间（北京时间）</th>
    <th>出信号时间</th><th>耗时</th><th>方向</th>
    <th>信号来源</th><th>官方结果</th><th>命中情况</th>
   </tr></thead>
   <tbody id="rrRows"><tr><td colspan="7" style="padding:12px">读取中...</td></tr></tbody>
  </table>
 </div>
 <div class="muted" id="rrFooter" style="margin-top:9px">展示最新100轮，每12秒刷新；系统未运行的轮次单独标记，不计入胜率。</div>
</section>"""
JS=r"""(function(){
'use strict';
var root=document.getElementById('roundResultsOnlyCard');if(!root)return;
var el=function(id){return document.getElementById(id)};
var put=function(id,t){var x=el(id);if(x)x.textContent=String(t)};
var ts=function(v){if(!Number.isSafeInteger(v))return '-';return new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})};
var label=function(r){if(r.status==='NO_SIGNAL')return '无信号';if(r.status==='NOT_OBSERVED')return '未采集';return r.direction==='UP'?'UP ↑':r.direction==='DOWN'?'DOWN ↓':'-'};
var result=function(r){if(r.status!=='LOCKED')return r.status==='NOT_OBSERVED'?'未采集':'无信号';if(r.actual!=='UP'&&r.actual!=='DOWN')return '待官方结算';return r.hit===true?'命中':'未命中'};
var cell=function(row,value){var x=document.createElement('td');x.style.padding='8px 6px';x.style.borderTop='1px solid #283244';x.textContent=String(value);row.appendChild(x)};
async function load(){
 try{
  var reply=await fetch('/api/deepseek-round-results?limit=100&t='+Date.now(),{cache:'no-store'});
  if(!reply.ok)throw Error('统计接口 HTTP '+reply.status);
  var data=await reply.json();
  if(data.ok!==true||data.schema!=='ROUND_RESULTS_DISPLAY_ONLY_V1'||!Array.isArray(data.records))throw Error(data.readError||'统计数据异常');
  var a=data.summary||{};
  put('rrAccuracy',a.accuracy==null?'胜率：暂无已结算样本':'累计胜率 '+a.accuracy.toFixed(2)+'%');
  put('rrSettled',a.settled||0);put('rrHitLoss',(a.wins||0)+' / '+(a.losses||0));
  put('rrPending',a.pending||0);put('rrNoSignal',(a.noSignal||0));
  put('rrMeta','新版5秒信号：已记录 '+(a.rounds||0)+' 轮；出方向 '+(a.signals||0)+' 轮。未结算不计入胜率，不参与模型判断。');
  var body=el('rrRows');if(!body)return;body.replaceChildren();
  if(!data.records.length){var tr=document.createElement('tr');cell(tr,'新记录尚未产生');body.appendChild(tr);}
  for(var r of data.records){
   var tr=document.createElement('tr');
   cell(tr,ts(r.round));cell(tr,ts(r.lockedAt));
   cell(tr,Number.isInteger(r.latencyMs)?(r.latencyMs/1000).toFixed(3)+'秒':'-');
   cell(tr,label(r));
   cell(tr,r.status==='LOCKED'?(r.decisionMethod==='DEEPSEEK_SINGLE_CALL_5S'?'DeepSeek一次分析':'实时价格备用'):'-');
   cell(tr,r.actual==='UP'||r.actual==='DOWN'?r.actual:'-');
   cell(tr,result(r));
   body.appendChild(tr);
  }
  put('rrFooter','最新显示 '+data.records.length+' 轮 · 北京时间 · 官方结算更新：'+ts(data.settlementLastAt)+(data.writeError?' · 记录异常：'+data.writeError:''));
 }catch(e){put('rrAccuracy','统计接口暂不可用');put('rrMeta',String(e.message||e));}
}
load();setInterval(load,12000);
})();"""
# The outer HTML contains the original owner-controlled order buttons and must remain unchanged.
old='function injectStats(html) { return html; }'
assert s.count(old)==1,'NOT_FAST5_PANEL_SOURCE'
assert 'roundResultsOnlyCard' not in s and "'/api/deepseek-round-results'" not in s
injection='const roundResultsOnlyCard='+json.dumps(CARD,ensure_ascii=False)+';\n'
injection+='const roundResultsOnlyScript='+json.dumps('<script>'+JS+'</script>',ensure_ascii=False)+';\n'
injection+="""function injectStats(html) {
  if(html.includes('id="roundResultsOnlyCard"'))return html;
  const marker='<div id="riskControlsAnchor"></div>';
  const withCard=html.includes(marker)
    ? html.replace(marker,roundResultsOnlyCard+marker)
    : html.replace('</body>',roundResultsOnlyCard+'</body>');
  return withCard.replace('</body>',roundResultsOnlyScript+'</body>');
}"""
s=s.replace(old,injection,1)
route="  if (req.method === 'GET' && url.pathname === '/api/internal/binance-official-probe')"
assert s.count(route)==1,'ROUTER_ANCHOR_CHANGED'
route_body="""  if (req.method === 'GET' && url.pathname === '/api/deepseek-round-results') {
    const limit=Math.max(1,Math.min(300,Number.parseInt(url.searchParams.get('limit'),10)||100));
    const request=http.get({hostname:'127.0.0.1',port:13029,
      path:'/api/round-results?limit='+limit,headers:{accept:'application/json'}},upstream=>{
      res.writeHead(upstream.statusCode||502,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      upstream.pipe(res);
    });
    request.setTimeout(5000,()=>request.destroy(new Error('STATS_TIMEOUT')));
    request.on('error',()=>{if(!res.headersSent){
      res.writeHead(502,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify({ok:false,error:'PREDICTION_RESULT_SERVICE_UNAVAILABLE'}));
    }else{res.end();}});
    return;
  }
"""
s=s.replace(route,route_body+route,1)
assert s.count("function injectStats(html) {")==1
assert s.count("url.pathname === '/api/deepseek-round-results'")==1
assert 'roundStatsCard' not in s
out.write_text(s)
print('DEEPSEEK_5S_ROUND_RESULTS_UI_PATCH_OK=true')

// Presentation only: replace retired DeepSeek 40-second status block with the
// actual FAST5 production signal and fresh-market state. No trading access.
const OLD_CARD='<section class="c" id="roundResultsOnlyCard" style="margin:14px 0">';
const CARD=[
'<section class="c" id="zlFast5Card" style="margin:14px 0">',
'<div class="k">5分钟预测 · FAST5 本地实时行情模型</div>',
'<div class="big" id="zlF5Main" style="margin:9px 0">读取FAST5生产信号中...</div>',
'<div class="muted" id="zlF5Timeline">上一轮倒数120秒预分析 → 本轮0.1～5秒锁定 → 超过5秒未锁定则WAIT</div>',
'<div class="grid" style="margin:12px 0">',
'<div class="kv"><div class="k">当前生产模型</div><div class="v" id="zlF5Model">--</div></div>',
'<div class="kv"><div class="k">最新信号 / 锁定时刻</div><div class="v" id="zlF5Lock">--</div></div>',
'<div class="kv"><div class="k">实时行情更新延迟</div><div class="v" id="zlF5Age">--</div></div>',
'<div class="kv"><div class="k">实盘自动跟随</div><div class="v" id="zlF5Follow">--</div></div>',
'</div>',
'<div class="muted" id="zlF5Reason">核对行情数据...</div>',
'<div class="muted" id="zlF5Meta" style="margin-top:10px">FAST5自行计算行情，不调用DeepSeek。信号出现不等于订单提交或成交。</div>',
'<div class="k" style="margin-top:16px">FAST5 独立统计面板</div>',
'<div class="big" id="zlF5StatAccuracy" style="margin:8px 0">正在核对官方结算...</div>',
'<div class="grid" style="margin:12px 0">',
'<div class="kv"><div class="k">FAST5有效信号</div><div class="v" id="zlF5StatSignals">--</div></div>',
'<div class="kv"><div class="k">FAST5等待 / 未锁定</div><div class="v" id="zlF5StatWait">--</div></div>',
'<div class="kv"><div class="k">FAST5已结算</div><div class="v" id="zlF5StatSettled">--</div></div>',
'<div class="kv"><div class="k">FAST5命中 / 失败</div><div class="v" id="zlF5StatWL">--</div></div>',
'</div>',
'<div class="muted" id="zlF5StatsNote">仅使用FAST5自身预先锁定的信号和币安官方结算核对。旧模型数据不混入。</div>',
'<div class="k" style="margin-top:16px">最近官方结算（仅供核对，不代表FAST5胜率）</div>',
'<div style="overflow-x:auto;margin-top:9px"><table style="width:100%;font-size:13px;border-collapse:collapse">',
'<thead><tr><th>轮次</th><th>官方结果</th><th>FAST5匹配</th></tr></thead>',
'<tbody id="zlF5OfficialRows"><tr><td colspan="3">正在读取...</td></tr></tbody></table></div>',
'<div class="muted" id="zlF5Error" style="margin-top:8px"></div>',
'</section>'
].join('');
const SCRIPT=`<script>(function(){
'use strict';
var el=function(id){return document.getElementById(id)};
var put=function(id,v){var x=el(id);if(x)x.textContent=String(v)};
var label=function(x){return x==='UP'?'UP（涨）':x==='DOWN'?'DOWN（跌）':'--'};
async function json(url){
 var r=await fetch(url+'?t='+Date.now(),{cache:'no-store'});
 if(!r.ok)throw Error('HTTP '+r.status+' '+url);
 return await r.json();
}
async function load(){
 try{
  var values=await Promise.all([json('/api/fast5-live-status'),json('/api/status')]);
  var s=values[0],t=values[1];
  if(s.ok!==true||s.model!=='FAST5_SPOT_MOMENTUM_V1'||
     t.ok!==true||t.orderSignalModel!=='FAST5_SPOT_MOMENTUM_V1')
   throw Error('FAST5未成为唯一生产模型');
  var now=Date.now(),round=Math.floor(now/300000)*300000;
  var elapsed=now-round,valid=s.round===round;
  var signal=valid&&s.latest&&s.latest.round===round?s.latest:null;
  var age=s.lastFetchAt==null?null:Math.max(0,now-s.lastFetchAt);
  var lock=signal&&Number.isFinite(signal.lockedAt)?signal.lockedAt-round:null;
  var tradingWindow=signal&&elapsed<20000&&now>=signal.lockedAt&&
    now-signal.lockedAt<16000;
  var status;
  if(signal)status=label(signal.direction)+(signal.prewarmOnly?' · 已锁定（上轮120秒趋势信号）':tradingWindow?' · 本轮实时开盘锁定':' · 已锁定，交易窗口已过');
  else if(elapsed>=5000)status='WAIT · 本轮5秒内未锁定，停止出信号';
  else if(s.provisionalDirection)status=label(s.provisionalDirection)+' · 上轮120秒候选（仍在5秒锁定窗口）';
  else if(elapsed<100)status='开轮准备中 · 等待100毫秒';
  else status='开轮0.1～5秒内确认方向中';
  put('zlF5Main',status);
  put('zlF5Model','FAST5 · 无DeepSeek');
  put('zlF5Lock',signal?label(signal.direction)+' / 第'+(lock/1000).toFixed(2)+'秒':'未锁定');
  put('zlF5Age',age==null?'--':age+' ms'+(age>4000?'（数据延迟）':''));
  put('zlF5Follow',t.enabled===true?'开启':t.enabled===false?'关闭':'未知');
  put('zlF5Timeline','本轮已过'+(elapsed/1000).toFixed(2)+'秒 · 上轮120秒预分析 · 本轮0.1～5秒锁定 · 超时WAIT · 已锁定订单仍须完成执行校验');
  put('zlF5Reason',signal?(signal.prewarmOnly?'上轮120秒真实数据锁定；尚未获得本轮开盘价确认。':'本轮实时开盘价格锁定；')+
      (tradingWindow?'交易路由还须检查自动跟随及方向开关':'仅展示本轮信号历史，不可据此补单')
    :valid?(elapsed>=5000?'5秒内未形成有效锁定方向，本轮WAIT，不补单。原因：':'锁定窗口内等待有效方向，原因：')+String(s.latestError||'等待真实行情')
    :'轮次切换中，等待行情同步');
  put('zlF5Meta','生产信号：'+String(t.orderSignalModel)+
      ' · 独立交易开关：'+(t.enabled===true?'开启':'关闭')+
      ' · 信号不是成交回报');
  put('zlF5Error',s.lastError?'行情故障：'+String(s.lastError).slice(0,120):
      age!=null&&age>4000?'行情服务异常：最近行情读取超过4秒':'生产行情服务正常');
 }catch(err){
  put('zlF5Main','FAST5生产状态暂无法读取');
  put('zlF5Error','状态接口异常：'+String(err.message||err).slice(0,130));
 }
}
function htmlTime(ts){
 try{return new Date(ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}
 catch{return '--'}
}
async function loadStats(){
 try{
  var result=await json('/api/round-stats');
  if(result.ok!==true||!Array.isArray(result.records))throw Error('OFFICIAL_SETTLEMENT_UNAVAILABLE');
  var rows=result.records;
  var own=rows.filter(function(x){return x&&[
   x.productionModel,x.productionModelVersion,x.productionSource
  ].includes('FAST5_SPOT_MOMENTUM_V1')&&['UP','DOWN'].includes(x.productionPrediction)});
  var wins=own.filter(function(x){return ['UP','DOWN'].includes(x.productionActual)&&
   x.settledAt!=null&&x.officialSettlementAudit&&
   x.productionActual===x.productionPrediction});
  var settled=own.filter(function(x){return ['UP','DOWN'].includes(x.productionActual)&&
   x.settledAt!=null&&x.officialSettlementAudit});
  put('zlF5StatSignals',own.length?own.length:'--');
  put('zlF5StatWait','--');
  put('zlF5StatSettled',settled.length?settled.length:'--');
  put('zlF5StatWL',settled.length?wins.length+' / '+(settled.length-wins.length):'--');
  put('zlF5StatAccuracy',settled.length?
   'FAST5可核验命中率 '+(100*wins.length/settled.length).toFixed(2)+'%':
   'FAST5胜率：暂无独立可核验样本');
  put('zlF5StatsNote',own.length?
   '仅为接口返回窗口内的FAST5独立记录，不与旧模型合并。':
   '官方接口目前未包含FAST5逐轮信号账本；数据缺失显示--，不冒用其他模型的胜率。');
  var body=el('zlF5OfficialRows');
  if(body){
   body.replaceChildren();
   var official=rows.filter(function(x){return x&&
    Number.isSafeInteger(x.roundStartMs)&&
    ['UP','DOWN'].includes(x.productionActual)&&
    x.officialSettlementAudit&&x.settledAt!=null}).slice(0,15);
   if(!official.length){
    var empty=document.createElement('tr'),td=document.createElement('td');
    td.colSpan=3;td.textContent='暂无可核对的官方结算';empty.appendChild(td);body.appendChild(empty);
   }
   official.forEach(function(x){
    var tr=document.createElement('tr');
    [htmlTime(x.roundStartMs),label(x.productionActual),
     own.some(function(y){return y.roundStartMs===x.roundStartMs})?'已有FAST5记录':'未关联FAST5']
     .forEach(function(value){var td=document.createElement('td');td.textContent=value;
      td.style.padding='8px 6px';td.style.borderBottom='1px solid #344155';tr.appendChild(td)});
    body.appendChild(tr);
   });
  }
 }catch(e){
  put('zlF5StatAccuracy','官方结算接口暂不可用');
  put('zlF5StatsNote','读取失败：'+String(e.message||e).slice(0,120));
 }
}
void loadStats();setInterval(loadStats,30000);
void load();setInterval(load,350);
})();</script>`;
export function injectFast5Dashboard(html){
 if(typeof html!=='string'||!html.includes('</body>'))return html;
 if(html.includes('id="zlFast5Card"'))return html;
 const start=html.indexOf(OLD_CARD);
 if(start<0)return html;
 const end=html.indexOf('</section>',start);
 if(end<0)return html;
 let out=html.slice(0,start)+CARD+html.slice(end+'</section>'.length);
 out=out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,tag=>
  tag.includes('/api/deepseek-round-results?limit=')&&tag.includes('rrMeta')?'':tag);
 return out.replace('</body>',SCRIPT+'</body>');
}

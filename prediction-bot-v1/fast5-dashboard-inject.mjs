// Presentation only: replace retired DeepSeek 40-second status block with the
// actual FAST5 production signal and fresh-market state. No trading access.
const OLD_CARD='<section class="c" id="roundResultsOnlyCard" style="margin:14px 0">';
const CARD=[
'<section class="c" id="zlFast5Card" style="margin:14px 0">',
'<div class="k">5分钟预测 · FAST5 本地实时行情模型</div>',
'<div class="big" id="zlF5Main" style="margin:9px 0">读取FAST5生产信号中...</div>',
'<div class="muted" id="zlF5Timeline">上一轮倒数120秒预分析 → 本轮0.1～1秒确认方向 → 不追过期信号</div>',
'<div class="grid" style="margin:12px 0">',
'<div class="kv"><div class="k">当前生产模型</div><div class="v" id="zlF5Model">--</div></div>',
'<div class="kv"><div class="k">最新信号 / 锁定时刻</div><div class="v" id="zlF5Lock">--</div></div>',
'<div class="kv"><div class="k">实时行情更新延迟</div><div class="v" id="zlF5Age">--</div></div>',
'<div class="kv"><div class="k">实盘自动跟随</div><div class="v" id="zlF5Follow">--</div></div>',
'</div>',
'<div class="muted" id="zlF5Reason">核对行情数据...</div>',
'<div class="muted" id="zlF5Meta" style="margin-top:10px">FAST5自行计算行情，不调用DeepSeek。信号出现不等于订单提交或成交。</div>',
'<div class="k" style="margin-top:16px">FAST5 独立统计</div>',
'<div class="muted">新模型尚未建立经币安官方结算核验的完整历史胜率；不使用旧DeepSeek的命中率代替。</div>',
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
  if(signal)status=label(signal.direction)+(tradingWindow?' · 本轮已锁定':' · 已锁定，交易窗口已过');
  else if(s.provisionalDirection)status=label(s.provisionalDirection)+' · 上轮120秒预判（非实盘信号）';
  else if(elapsed<100)status='准备开轮方向，等待第0.1秒';
  else if(elapsed<=1000)status='0.1～1秒确认本轮开盘报价中';
  else status='本轮WAIT · 未取得可核验的开盘方向';
  put('zlF5Main',status);
  put('zlF5Model','FAST5 · 无DeepSeek');
  put('zlF5Lock',signal?label(signal.direction)+' / 第'+(lock/1000).toFixed(2)+'秒':'未锁定');
  put('zlF5Age',age==null?'--':age+' ms'+(age>4000?'（数据延迟）':''));
  put('zlF5Follow',t.enabled===true?'开启':t.enabled===false?'关闭':'未知');
  put('zlF5Timeline','本轮已过'+(elapsed/1000).toFixed(2)+'秒 · 上轮120秒预分析 · 本轮0.1～1秒确认 · 20秒订单截止');
  put('zlF5Reason',signal?'真实BTC价格趋势锁定；'+
      (tradingWindow?'交易路由还须检查自动跟随及方向开关':'仅展示本轮信号历史，不可据此补单')
    :valid?'尚未获得可执行的本轮开盘报价：'+String(s.latestError||'等待真实行情')
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

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
'<div class="k" style="margin-top:16px">FAST5 下单方向开关</div>',
'<div class="muted" style="margin-top:5px">只改变最终下单方向，不翻转FAST5原始信号、官方结算和胜率统计。设置成功后下一轮生效。</div>',
'<div style="display:flex;flex-wrap:wrap;gap:10px;margin:12px 0">',
'<button type="button" id="zlF5Forward" disabled style="padding:11px 15px;min-width:112px;border:1px solid #75849a;border-radius:9px;background:#243047;color:#fff">正向下单</button>',
'<button type="button" id="zlF5Inverse" disabled style="padding:11px 15px;min-width:112px;border:1px solid #75849a;border-radius:9px;background:#243047;color:#fff">反向下单</button>',
'</div>',
'<div class="muted" id="zlF5DirState">下单方向配置读取中...</div>',
'<div class="muted" id="zlF5DirExample" style="margin-top:7px">正向：UP买UP，DOWN买DOWN；反向：UP买DOWN，DOWN买UP。</div>',
'<div class="muted" id="zlF5DirMessage" role="status" aria-live="polite" style="margin-top:8px"></div>',
'<div class="k" style="margin-top:16px">FAST5 独立统计面板</div>',
'<div class="big" id="zlF5StatAccuracy" style="margin:8px 0">正在核对官方结算...</div>',
'<div class="grid" style="margin:12px 0">',
'<div class="kv"><div class="k">FAST5有效信号</div><div class="v" id="zlF5StatSignals">--</div></div>',
'<div class="kv"><div class="k">FAST5等待 / 未锁定</div><div class="v" id="zlF5StatWait">--</div></div>',
'<div class="kv"><div class="k">FAST5已结算</div><div class="v" id="zlF5StatSettled">--</div></div>',
'<div class="kv"><div class="k">FAST5命中 / 失败</div><div class="v" id="zlF5StatWL">--</div></div>',
'</div>',
'<div class="muted" id="zlF5StatsNote">FAST5独立账本按5分钟轮次时间对齐币安官方结果，旧模型数据不混入。</div>',
'<div class="k" style="margin-top:16px">FAST5逐轮信号与官方结算</div>',
'<div style="overflow-x:auto;margin-top:9px"><table style="width:100%;font-size:13px;border-collapse:collapse">',
'<thead><tr><th>轮次</th><th>FAST5信号</th><th>官方结果</th><th>判定</th></tr></thead>',
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
// Read-only snapshot of the FAST5 locked decision in the legacy trading tiles.
// The trade backend intentionally returns null after its 20s submit window;
// this display must not turn a past lock into an executable order.
function renderTradeTilesSnapshot(state,trade,now,round,signal){
 if(!el('round')||!el('status')||!el('direction')||!el('orderDirection'))return;
 if(trade.signal&&trade.signal.status==='LOCKED')return;
 if(state.round!==round)return;
 var elapsed=now-round,cutoff=Math.min(round+20000,Number(signal?.lockedAt||0)+16000);
 var expired=elapsed>=20000||(signal&&now>=cutoff);
 var modes=trade.directionModes?.FAST5_SPOT_MOMENTUM_V1;
 var mode=signal&&modes?.[signal.direction];
 var opposite=signal?.direction==='UP'?'DOWN':'UP';
 var mapped=mode==='INVERSE'?opposite:mode==='FORWARD'?signal?.direction:null;
 var clock=new Date(round).toLocaleTimeString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'});
 put('round',clock+'（本轮）');
 if(signal&&['UP','DOWN'].includes(signal.direction)){
  put('direction',label(signal.direction)+' · 已锁定');
  put('score',Number.isFinite(signal.scoreBps)?Math.abs(signal.scoreBps).toFixed(2)+' bps':'--');
  put('status',expired?'已锁定 · 下单窗口结束（不可补单）':
   trade.enabled===false?'已锁定 · 跟随关闭':'已锁定 · 交易路由尚未确认（不可假定已下单）');
  put('orderDirection',mapped?
    label(mapped)+'（'+(mode==='INVERSE'?'反向':'正向')+'参考；未提交）':
    '方向关闭或配置未就绪（不可下单）');
 }else{
  put('status',elapsed>=5000?'WAIT · 5秒内未锁定，不下单':'等待FAST5锁定');
  put('direction','无已锁定信号');
  put('orderDirection','无下单信号');
  put('score','--');
 }
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
      ' · 信号不是成交回报 · '+(t.amount==null?'下单金额未配置':'每轮金额已配置'));
  put('zlF5Error',s.lastError?'行情故障：'+String(s.lastError).slice(0,120):
      age!=null&&age>4000?'行情服务异常：最近行情读取超过4秒':'生产行情服务正常');
  renderTradeTilesSnapshot(s,t,now,round,signal);
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
  var result=await json('/api/fast5-round-stats');
  if(result.ok!==true||result.model!=='FAST5_SPOT_MOMENTUM_V1'||
     result.schema!=='FAST5_INDEPENDENT_OFFICIAL_ROUND_LEDGER_V1'||
     !Array.isArray(result.rows)||!result.summary)throw Error('FAST5_INDEPENDENT_LEDGER_UNAVAILABLE');
  var a=result.summary;
  put('zlF5StatSignals',a.signals);
  put('zlF5StatWait',a.waits);
  put('zlF5StatSettled',a.settled);
  put('zlF5StatWL',a.wins+' / '+a.losses);
  put('zlF5StatAccuracy',a.settled>0?
    'FAST5命中率 '+Number(a.accuracyPct).toFixed(2)+'%':
    'FAST5胜率：等待首批独立官方结算');
  put('zlF5StatsNote','自独立账本启用后累计 · 已记录 '+a.total+
    '轮 · 尚待结算 '+a.pending+' · 仅对已锁定UP/DOWN与官方结算匹配；WAIT不计入胜率。');
  var body=el('zlF5OfficialRows');
  if(body){
   body.replaceChildren();
   if(!result.rows.length){
    var blank=document.createElement('tr'),cell=document.createElement('td');
    cell.colSpan=4;cell.textContent='FAST5独立账本已启用，等待首个完整轮次';
    blank.appendChild(cell);body.appendChild(blank);
   }
   result.rows.slice(0,30).forEach(function(x){
    var tr=document.createElement('tr'),outcome=x.official_result;
    var verdict=x.decision==='WAIT'?'WAIT（不计胜率）':
     !['UP','DOWN'].includes(outcome)?'待官方结算':
     x.decision===outcome?'命中':'未命中';
    [htmlTime(x.round),x.decision==='WAIT'?'WAIT':label(x.decision),
     ['UP','DOWN'].includes(outcome)?label(outcome):'待结算',verdict]
    .forEach(function(value){var td=document.createElement('td');td.textContent=value;
     td.style.padding='8px 5px';td.style.borderBottom='1px solid #344155';
     tr.appendChild(td)});
    body.appendChild(tr);
   });
  }
 }catch(e){
  put('zlF5StatAccuracy','FAST5独立统计服务不可用');
  put('zlF5StatsNote','统计接口异常：'+String(e.message||e).slice(0,120));
 }
}
var f5Direction={revision:null,busy:false,mode:null,effectiveAfterRound:null};
var FAST5_ID='FAST5_SPOT_MOMENTUM_V1';
function paintF5Direction(){
 var a=el('zlF5Forward'),b=el('zlF5Inverse');if(!a||!b)return;
 a.disabled=b.disabled=f5Direction.busy||!f5Direction.revision;
 a.style.borderColor=f5Direction.mode==='FORWARD'?'#8accff':'#75849a';
 b.style.borderColor=f5Direction.mode==='INVERSE'?'#8accff':'#75849a';
 a.style.fontWeight=f5Direction.mode==='FORWARD'?'700':'400';
 b.style.fontWeight=f5Direction.mode==='INVERSE'?'700':'400';
 var round=Math.floor(Date.now()/300000)*300000;
 var pending=f5Direction.effectiveAfterRound!=null&&round<=f5Direction.effectiveAfterRound;
 put('zlF5DirState',f5Direction.busy?'正在保存，暂不允许重复提交':
   f5Direction.mode==='FORWARD'?'已配置：正向下单'+(pending?'（下一轮开始生效）':''):
   f5Direction.mode==='INVERSE'?'已配置：反向下单'+(pending?'（下一轮开始生效）':''):
   f5Direction.revision?'UP/DOWN分方向配置不一致或关闭，未选择统一正反向':'方向设置尚未就绪');
}
async function loadF5Direction(){
 if(f5Direction.busy)return;
 try{
  var r=await json('/api/direction-mode');
  if(r.ok!==true||!r.revision||!r.modes||!r.modes[FAST5_ID])
   throw Error('FAST5_ORDER_DIRECTION_NOT_READY');
  var d=r.modes[FAST5_ID];
  f5Direction.revision=r.revision;
  f5Direction.mode=(d.UP===d.DOWN&&['FORWARD','INVERSE'].includes(d.UP))?d.UP:null;
  f5Direction.effectiveAfterRound=r.effectiveAfterRound;
  put('zlF5DirMessage',f5Direction.mode?'本轮原始信号不改变；最终交易方向根据所选设置映射。':
    '当前 UP='+String(d.UP)+'，DOWN='+String(d.DOWN)+'；选择正向或反向可同时统一两侧。');
 }catch(e){
  f5Direction.revision=null;f5Direction.mode=null;
  put('zlF5DirMessage','方向接口读取失败，开关已禁用：'+String(e.message||e).slice(0,95));
 }
 paintF5Direction();
}
async function saveF5Direction(mode){
 if(f5Direction.busy||!f5Direction.revision||!['FORWARD','INVERSE'].includes(mode))return;
 if(mode===f5Direction.mode){
  put('zlF5DirMessage','当前已经是所选模式，无需重复保存。');return;
 }
 f5Direction.busy=true;paintF5Direction();
 try{
  var response=await fetch('/api/fast5-direction-mode',{
   method:'POST',credentials:'same-origin',cache:'no-store',
   headers:{'content-type':'application/json'},
   body:JSON.stringify({mode:mode,expectedRevision:f5Direction.revision})
  });
  var data=await response.json();
  if(!response.ok||data.ok!==true||!data.revision)throw Error(data.error||'保存未成功');
  f5Direction.revision=data.revision;
  f5Direction.effectiveAfterRound=data.effectiveAfterRound;
  f5Direction.mode=mode;
  put('zlF5DirMessage','保存成功：'+(mode==='INVERSE'?'UP买DOWN、DOWN买UP':'UP买UP、DOWN买DOWN')+'；从下一轮开始，已锁定信号不变。');
 }catch(e){
  f5Direction.revision=null;f5Direction.mode=null;
  put('zlF5DirMessage','保存失败，未确认方向变更：'+String(e.message||e).slice(0,95));
 }finally{f5Direction.busy=false;paintF5Direction()}
}
if(el('zlF5Forward'))el('zlF5Forward').addEventListener('click',function(){void saveF5Direction('FORWARD')});
if(el('zlF5Inverse'))el('zlF5Inverse').addEventListener('click',function(){void saveF5Direction('INVERSE')});
void loadF5Direction();setInterval(loadF5Direction,15000);
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

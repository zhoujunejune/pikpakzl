'use strict';
const $=id=>document.getElementById(id);
let settings=null,updating=false,saving=false;
const money=n=>Number.isFinite(Number(n))?Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:4})+' USDT':'—';
const num=n=>Number.isFinite(Number(n))?Number(n).toLocaleString('zh-CN',{maximumFractionDigits:6}):'—';
const time=n=>n?new Date(n).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'—';
const put=(id,value)=>{const node=$(id);if(node)node.textContent=value===undefined||value===null?'—':String(value);};
const textLine=(label,val)=>{const r=document.createElement('div');r.className='row';const a=document.createElement('span');a.textContent=label;const b=document.createElement('strong');b.textContent=val;r.append(a,b);return r;};
async function api(route,config={}){
 const res=await fetch('/genius/api/'+route,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(12000),...config});
 const data=await res.json();if(!res.ok||!data.ok)throw Error(data.error||'HTTP '+res.status);return data;
}
function formValue(){return {leverage:Number($('leverage').value),marginUsdt:Number($('marginUsdt').value)};}
function setForm(s){$('leverage').value=s.leverage;$('marginUsdt').value=s.marginUsdt;}
const horizonLabels={SHORT:'短线',MEDIUM:'中线',LONG:'长线',UNSPECIFIED:'待确定'};
let visiblePositionId=null;
let positionIdsKey='';

const signedMoney=n=>(n>=0?'+':'')+money(n);
function visiblePage(){
 const track=$('positionTrack'),cards=track?.children;
 if(!track||!cards?.length)return 0;
 return Math.min(cards.length-1,Math.max(0,Math.round(track.scrollLeft/Math.max(1,track.clientWidth))));
}
function setPositionPage(index){
 const track=$('positionTrack'),cards=track?.children;
 const length=cards?.length||0;
 if(!length){put('positionPage','');return;}
 const current=Math.max(0,Math.min(index,length-1));
 visiblePositionId=cards[current]?.dataset.id||null;
 put('positionPage',length>1?(current+1)+' / '+length+' · 左右滑动':'');
 [...$('positionDots').children].forEach((node,i)=>{
   node.classList.toggle('is-active',i===current);
   node.setAttribute('aria-current',i===current?'true':'false');
 });
}
function ensurePositionCarousel(positions){
 const track=$('positionTrack'),dots=$('positionDots');
 const key=positions.map(p=>p.id).join('|');
 if(key===positionIdsKey)return;
 const prevId=visiblePositionId;
 positionIdsKey=key;
 track.replaceChildren();dots.replaceChildren();
 positions.forEach((p,i)=>{
   const card=document.createElement('div');
   card.className='position-slide';card.dataset.id=String(p.id);
   card.setAttribute('aria-label',p.symbol+'模拟持仓');
   const labels=['币种 / 方向','模拟开仓价','实时标记价格','浮动盈亏（未扣平仓费）',
     '每笔开仓金额 / 杠杆','AI 持仓周期','开仓时间','平仓方式'];
   for(const label of labels){card.append(textLine(label,'—'));}
   track.append(card);
   if(positions.length>1){
     const dot=document.createElement('button');dot.type='button';
     dot.setAttribute('aria-label','查看第'+(i+1)+'笔持仓');
     dot.addEventListener('click',()=>track.scrollTo({left:i*track.clientWidth,behavior:'smooth'}));
     dots.append(dot);
   }
 });
 dots.hidden=positions.length<2;
 const prevIndex=positions.findIndex(p=>String(p.id)===prevId);
 const index=prevIndex>=0?prevIndex:0;
 track.scrollLeft=index*track.clientWidth;
 setPositionPage(index);
}
function renderPosition(s){
 const positions=Array.isArray(s.positions)?s.positions:(s.position?[s.position]:[]);
 put('positionCount',positions.length+' / 3');
 put('positionState',positions.length?'模拟持仓中':'当前空仓');
 const empty=$('positionEmpty'),track=$('positionTrack');
 empty.hidden=positions.length>0;
 if(!positions.length){
   empty.textContent='当前没有未平仓模拟订单；已平仓订单请查看下方记录。';
   positionIdsKey='';visiblePositionId=null;
   track.replaceChildren();$('positionDots').replaceChildren();
   $('positionDots').hidden=true;put('positionPage','');
   put('positionTotalPnl','0.00 USDT');
   return;
 }
 ensurePositionCarousel(positions);
 const now=Date.now(),snapshots=s.marketSnapshots||[];
 let total=0,complete=true;
 positions.forEach((p,i)=>{
   const root=track.children[i];if(!root)return;
   const symbol=String(p.symbol||'未知');
   const q=snapshots.find(m=>m.symbol===symbol&&
     Number.isFinite(Number(m.markPrice))&&Number(m.markPrice)>0&&
     Number.isFinite(Number(m.checkedAt))&&now-Number(m.checkedAt)<10000);
   const last=q||(s.lastMarket?.symbol===symbol&&now-Number(s.lastMarket.checkedAt)<10000?s.lastMarket:null);
   const price=Number(last?.markPrice),entry=Number(p.entry),qty=Number(p.qty);
   const available=last&&Number.isFinite(price)&&price>0&&Number.isFinite(entry)&&entry>0&&
     Number.isFinite(qty)&&qty>0;
   const pnl=available?(p.side==='LONG'?1:-1)*(price-entry)*qty:null;
   if(pnl===null)complete=false;else total+=pnl;
   const side=p.side==='LONG'?'看涨 LONG':'看跌 SHORT';
   const vals=[symbol+' / '+side,Number.isFinite(entry)?num(entry):'—',
     available?num(price):'行情待更新',pnl===null?'行情待更新':signedMoney(pnl),
     money(p.marginUsdt)+' / '+p.leverage+'倍',horizonLabels[p.horizon]||'待确定',
     time(p.openedAt),'AI 自主 CLOSE / 手动紧急停止'];
   [...root.children].forEach((row,j)=>{
     const strong=row.querySelector('strong');if(strong)strong.textContent=vals[j];
   });
 });
 put('positionTotalPnl',complete?signedMoney(total):'部分行情待更新');
 setPositionPage(visiblePage());
}
$('positionTrack').addEventListener('scroll',()=>setPositionPage(visiblePage()),{passive:true});
function putPnl(id,value){
 const node=$(id);if(!node)return;
 const good=typeof value==='number'&&Number.isFinite(value);
 node.textContent=good?signedMoney(value):'—';
 node.classList.toggle('pnl-positive',good&&value>0);
 node.classList.toggle('pnl-negative',good&&value<0);
}
function renderPnl(s){
 const summary=s.pnlSummary;
 if(!summary||typeof summary!=='object'){
   putPnl('realizedPnl',null);putPnl('unrealizedPnl',null);
   putPnl('cumulativePnl',null);
   put('cumulativePnlNote','累计盈亏数据尚未同步，请检查后台版本。');
   return;
 }
 putPnl('realizedPnl',summary.realizedNetPnl);
 putPnl('unrealizedPnl',summary.openGrossPnl);
 putPnl('cumulativePnl',summary.complete?summary.estimatedCumulativePnl:null);
 put('cumulativePnlNote',summary.complete?
   '已实现净盈亏包含模拟开平仓手续费；累计总盈亏另估算未平仓手续费与滑点。不含资金费、强平或真实成交。':
   '部分持仓行情未更新，累计总盈亏暂不显示；已实现净盈亏仍可查看。');
}
function renderStatus(s){
 renderPosition(s);
 renderPnl(s);
 const ok=s.mode==='PAPER_ONLY'&&s.realTradingEnabled===false;
 put('connection',ok?'模拟服务在线':'连接异常');
 put('marketStream',s.marketStream==='LIVE'?'行情流实时连接':(s.marketStream||'行情流待连接')+' · REST 备用');
 const first=(Array.isArray(s.positions)?s.positions[0]:s.position);
 const m=first?s.marketSnapshots?.find(x=>x.symbol===first.symbol):s.lastMarket;
 put('markPrice',m?.markPrice?(m.symbol+'  '+num(m.markPrice)+' USDT'):'行情待更新');
 const active=Boolean(s.settings?.enabled&&!s.settings?.emergencyStop);
 const billingBlocked=active&&(s.aiBilling?.blocked===true||s.aiStatus==='INSUFFICIENT_API_BALANCE');
 put('engineState',s.settings?.emergencyStop?'紧急停止':billingBlocked?'DeepSeek API余额不足 · AI模拟开仓暂停':active?'AI 自动分析已开启 · '+s.aiStatus:'AI 自动分析已关闭');
 put('lastAnalysis',time(s.lastDecision?.at||s.lastModelCallAt));
 const met=s.metrics||{},activeSymbol=first?.symbol||s.lastMarket?.symbol||'BTCUSDT';
 const micro=met.perSymbol?.[activeSymbol]?.trades?.w10;
 put('marketLag',Number.isFinite(met.wsLagMs)?met.wsLagMs+' 毫秒 · 最新 '+Math.round(met.marketAgeMs||0)+' 毫秒前':'等待行情');
 put('aiLatency',Number.isFinite(met.aiDurationMs)?met.aiDurationMs+' 毫秒 · 成功 '+(met.aiSuccess||0)+' 次':'尚无完成记录');
 put('aiTrigger',met.lastTrigger==='PRICE_EVENT'?'行情异动':met.lastTrigger==='SCHEDULED'?'定时检查':'尚未触发');
 put('microWindow',micro?activeSymbol+' · 10秒 '+(micro.changePct>=0?'+':'')+micro.changePct+'% · 主动买入 '+Math.round(micro.buyRatio*100)+'%':'等待逐笔成交');
 const err=met.errors?.[0];
 put('recentError',billingBlocked?'DeepSeek API 402：余额不足；已暂停无效重试，请检查API账户余额。':err?time(err.at)+' · '+err.kind+' · '+err.detail:'无记录');
 const actions={LONG:'看涨开仓',SHORT:'看跌开仓',HOLD:'继续持有',CLOSE:'AI 主动平仓',WAIT:'暂不操作'};
 put('aiDecision',billingBlocked?'DeepSeek API余额不足，请在DeepSeek开发平台检查余额并充值。程序将每5分钟自动尝试恢复；余额不足期间不会产生新的AI模拟订单。':s.lastDecision?((s.lastDecision.symbol||'全市场')+' · '+(actions[s.lastDecision.action]||s.lastDecision.action)+' · '+(horizonLabels[s.lastDecision.horizon]||'')+' · '+s.lastDecision.reason):'尚无有效 AI 决策');
 const activeHigher=met.perSymbol?.[activeSymbol];
 put('multiTrend',activeHigher?.higherComplete?['15m','1h','4h','1d','1w'].map(k=>k+':'+({UP:'涨',DOWN:'跌',MIXED:'震荡'}[activeHigher.higher?.[k]?.bias]||'待更新')).join(' · '):'高周期行情待补齐');
 put('balance',money(s.paperBalance));put('tradeCount',s.totalClosed);
 if(!saving)$('toggle').textContent=active?'关闭 AI 自动分析':'开启 AI 自动分析';

 // Always sync the control state from the server, but preserve unsaved sizing inputs.
 const firstLoad=!settings;
 settings=s.settings;
 if(firstLoad){
   setForm(settings);
   put('saveStatus','参数已加载。AI 开关与杠杆金额分别保存。');
 }
 // Market errors are displayed in "最近异常记录", never overwrite control feedback.
}
function renderHistory(h){
 const root=$('history');if(!root)return;
 // Keep the user's scroll position while live data refreshes every five seconds.
 const previousScroll=Number(root.scrollTop)||0;
 root.replaceChildren();
 if(!Array.isArray(h.records)||!h.records.length){
  root.textContent='暂无已平仓的模拟交易记录。';
  root.scrollTop=0;return;
 }
 for(const r of h.records.slice(0,100)){
  const item=document.createElement('div');
  const pnl=document.createElement('strong');
  const net=typeof r.netPnl==='number'&&Number.isFinite(r.netPnl)?r.netPnl:null;
  pnl.textContent='盈亏 '+(net===null?'—':signedMoney(net));
  pnl.className=net===null?'':net>=0?'pnl-up':'pnl-down';
  const times=document.createElement('div');times.className='trade-times';
  const opened=document.createElement('small');opened.textContent='开仓：'+time(r.openedAt);
  const closed=document.createElement('small');closed.textContent='平仓：'+time(r.closedAt);
  times.append(opened,closed);
  item.append(pnl,times);
  root.append(item);
 }
 root.scrollTop=previousScroll;
}
async function refresh(){
 if(updating)return;
 updating=true;
 // Position status is independent of trade-history retrieval. History failure must never hide open position.
 try{
  await Promise.all([
   api('status').then(renderStatus).catch(e=>{
    put('connection','持仓状态连接异常');
    put('positionState','读取失败');
    put('saveStatus','持仓读取失败：'+e.message);
   }),
   api('history').then(renderHistory).catch(e=>put('history','历史记录读取失败：'+e.message))
  ]);
 }finally{updating=false;}
}
async function save(changes,kind='money'){
 if(saving||!settings)return;
 saving=true;
 const control=kind==='toggle'||kind==='stop',oldLabel=$('toggle').textContent;
 $('toggle').disabled=true;$('save').disabled=true;$('stop').disabled=true;
 if(kind==='toggle')$('toggle').textContent=changes.enabled?'正在开启 AI…':'正在关闭 AI…';
 put('saveStatus',kind==='toggle'?'正在切换 AI 自动分析…':kind==='stop'?
   '正在停止模拟 AI，后台将按可用的最新行情请求模拟平仓…':'正在保存杠杆和金额…');
 try{
  if(kind==='money'){
   if(!Number.isInteger(changes.leverage)||changes.leverage<1||changes.leverage>100)
     throw Error('杠杆必须是1—100之间的整数');
   if(!Number.isFinite(changes.marginUsdt)||changes.marginUsdt<1||changes.marginUsdt>100)
     throw Error('每笔开仓金额必须在1—100 USDT之间');
  }
  const x=await api('settings',{method:'POST',headers:{'Content-Type':'application/json',
   'X-Haipai-Paper-Control':'yes'},body:JSON.stringify(changes)});
  settings=x.settings;
  if(kind==='money'){
   setForm(settings);
   put('saveStatus','杠杆和金额已保存；仅影响后续新开仓的模拟交易。');
  }else if(kind==='toggle'){
   const active=Boolean(settings.enabled&&!settings.emergencyStop);
   $('toggle').textContent=active?'关闭 AI 自动分析':'开启 AI 自动分析';
   put('engineState',active?'AI 自动分析已开启':'AI 自动分析已关闭');
   put('saveStatus',active?'AI 自动分析已开启（杠杆与金额未随开关修改）':
     'AI 自动分析已关闭；已有模拟持仓保留，等待你重新开启或紧急停止。');
  }else{
   $('toggle').textContent='开启 AI 自动分析';
   put('engineState','紧急停止');
   put('saveStatus','已提交紧急停止。已暂停新开仓；现有模拟仓位需有可用行情才能执行模拟平仓。');
  }
  await refresh();
 }catch(e){
  if(control)$('toggle').textContent=oldLabel;
  put('saveStatus',(control?'操作失败：':'保存失败：')+e.message);
 }finally{
  saving=false;$('toggle').disabled=false;$('save').disabled=false;$('stop').disabled=false;
 }
}
$('save').addEventListener('click',()=>void save(formValue(),'money'));
$('toggle').addEventListener('click',()=>void save({
 enabled:!(settings?.enabled&&!settings?.emergencyStop),emergencyStop:false
},'toggle'));
$('stop').addEventListener('click',()=>void save({enabled:false,emergencyStop:true},'stop'));
void refresh();setInterval(()=>void refresh(),5000);

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
function renderStatus(s){
 renderPosition(s);
 const ok=s.mode==='PAPER_ONLY'&&s.realTradingEnabled===false;
 put('connection',ok?'模拟服务在线':'连接异常');
 put('marketStream',s.marketStream==='LIVE'?'行情流实时连接':(s.marketStream||'行情流待连接')+' · REST 备用');
 const first=(Array.isArray(s.positions)?s.positions[0]:s.position);
 const m=first?s.marketSnapshots?.find(x=>x.symbol===first.symbol):s.lastMarket;
 put('markPrice',m?.markPrice?(m.symbol+'  '+num(m.markPrice)+' USDT'):'行情待更新');
 const active=Boolean(s.settings?.enabled&&!s.settings?.emergencyStop);
 put('engineState',s.settings?.emergencyStop?'紧急停止':active?'AI 自动分析已开启 · '+s.aiStatus:'AI 自动分析已关闭');
 put('lastAnalysis',time(s.lastDecision?.at||s.lastModelCallAt));
 const met=s.metrics||{},activeSymbol=first?.symbol||s.lastMarket?.symbol||'BTCUSDT';
 const micro=met.perSymbol?.[activeSymbol]?.trades?.w10;
 put('marketLag',Number.isFinite(met.wsLagMs)?met.wsLagMs+' 毫秒 · 最新 '+Math.round(met.marketAgeMs||0)+' 毫秒前':'等待行情');
 put('aiLatency',Number.isFinite(met.aiDurationMs)?met.aiDurationMs+' 毫秒 · 成功 '+(met.aiSuccess||0)+' 次':'尚无完成记录');
 put('aiTrigger',met.lastTrigger==='PRICE_EVENT'?'行情异动':met.lastTrigger==='SCHEDULED'?'定时检查':'尚未触发');
 put('microWindow',micro?activeSymbol+' · 10秒 '+(micro.changePct>=0?'+':'')+micro.changePct+'% · 主动买入 '+Math.round(micro.buyRatio*100)+'%':'等待逐笔成交');
 const err=met.errors?.[0];
 put('recentError',err?time(err.at)+' · '+err.kind+' · '+err.detail:'无记录');
 const actions={LONG:'看涨开仓',SHORT:'看跌开仓',HOLD:'继续持有',CLOSE:'AI 主动平仓',WAIT:'暂不操作'};
 put('aiDecision',s.lastDecision?((s.lastDecision.symbol||'全市场')+' · '+(actions[s.lastDecision.action]||s.lastDecision.action)+' · '+(horizonLabels[s.lastDecision.horizon]||'')+' · '+s.lastDecision.reason):'尚无有效 AI 决策');
 const activeHigher=met.perSymbol?.[activeSymbol];
 put('multiTrend',activeHigher?.higherComplete?['15m','1h','4h','1d','1w'].map(k=>k+':'+({UP:'涨',DOWN:'跌',MIXED:'震荡'}[activeHigher.higher?.[k]?.bias]||'待更新')).join(' · '):'高周期行情待补齐');
 put('balance',money(s.paperBalance));put('tradeCount',s.totalClosed);
 $('toggle').textContent=active?'关闭 AI 自动分析':'开启 AI 自动分析';

 if(!settings){settings=s.settings;setForm(settings);}
 if(!saving&&s.lastError)put('saveStatus','行情或 AI 异常：'+s.lastError+'；暂停新增模拟开仓。');
}
function renderHistory(h){
 const root=$('history');if(!root)return;
 root.replaceChildren();
 if(!Array.isArray(h.records)||!h.records.length){
  root.textContent='尚无已结束的模拟交易。';return;
 }
 for(const r of h.records.slice(0,20)){
  const d=document.createElement('div'),head=document.createElement('strong');
  head.textContent=r.symbol+' '+r.side+' · '+(r.netPnl>=0?'+':'')+money(r.netPnl);
  const detail=document.createElement('small');
  const type=r.exitReason==='AI_CLOSE'?'AI 自主平仓':r.exitReason==='EMERGENCY_STOP'?'手动紧急停止':r.exitReason;
  detail.textContent=time(r.closedAt)+' · '+type+(r.aiExitReason?' · '+r.aiExitReason:'')+' · 模拟';
  d.append(head,detail);root.append(d);
 }
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
async function save(changes){
 if(saving||!settings)return;
 saving=true;
 try{
  const x=await api('settings',{method:'POST',headers:{'Content-Type':'application/json','X-Haipai-Paper-Control':'yes'},body:JSON.stringify(changes)});
  settings=x.settings;setForm(settings);
  put('saveStatus','已保存。后台仅进行模拟交易，真实订单保持关闭。');
  await refresh();
 }catch(e){put('saveStatus','保存失败：'+e.message);}finally{saving=false;}
}
$('save').addEventListener('click',()=>void save(formValue()));
$('toggle').addEventListener('click',()=>void save({...formValue(),enabled:!(settings?.enabled&&!settings?.emergencyStop),emergencyStop:false}));
$('stop').addEventListener('click',()=>void save({enabled:false,emergencyStop:true}));
void refresh();setInterval(()=>void refresh(),5000);

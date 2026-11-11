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
function renderPosition(s){
 const root=$('position');
 if(!root)return;
 if(!s.position){
   put('positionState','当前空仓');
   root.textContent='当前没有未平仓的 AI 模拟订单。已平仓订单请查看下方历史记录。';
   return;
 }
 const p=s.position;
 put('positionState','模拟持仓中');
 const symbol=String(p.symbol||'未知'),side=p.side==='LONG'?'看涨 LONG':p.side==='SHORT'?'看跌 SHORT':'未知方向';
 const now=Date.now();
 const snapshot=(s.marketSnapshots||[]).find(m=>m.symbol===symbol&&
   Number.isFinite(Number(m.markPrice))&&Number.isFinite(Number(m.checkedAt))&&now-Number(m.checkedAt)<10000)
    ||(s.lastMarket?.symbol===symbol&&now-Number(s.lastMarket.checkedAt)<10000?s.lastMarket:null);
 const price=Number(snapshot?.markPrice),entry=Number(p.entry),qty=Number(p.qty);
 const usable=Number.isFinite(price)&&price>0&&Number.isFinite(entry)&&entry>0&&
   Number.isFinite(qty)&&qty>0;
 const pnl=usable?(p.side==='LONG'?1:-1)*(price-entry)*qty:null;
 root.replaceChildren();
 root.append(textLine('币种 / 方向',symbol+' / '+side),
   textLine('模拟开仓价',Number.isFinite(entry)?num(entry):'—'),
   textLine('实时标记价格',usable?num(price):'行情更新中'),
   textLine('浮动盈亏（未扣平仓费）',pnl===null?'行情待更新':(pnl>=0?'+':'')+money(pnl)),
   textLine('每笔开仓金额 / 杠杆',money(p.marginUsdt)+' / '+(p.leverage??'—')+'倍'),
   textLine('AI 持仓周期',horizonLabels[p.horizon]||'待确定'),
   textLine('开仓时间',time(p.openedAt)),
   textLine('平仓方式','等待 AI 自主 CLOSE / 可手动紧急停止'));
}
function renderStatus(s){
 renderPosition(s);
 const ok=s.mode==='PAPER_ONLY'&&s.realTradingEnabled===false;
 put('connection',ok?'模拟服务在线':'连接异常');
 put('marketStream',s.marketStream==='LIVE'?'行情流实时连接':(s.marketStream||'行情流待连接')+' · REST 备用');
 const m=s.position?s.marketSnapshots?.find(x=>x.symbol===s.position.symbol):s.lastMarket;
 put('markPrice',m?.markPrice?(m.symbol+'  '+num(m.markPrice)+' USDT'):'行情待更新');
 const active=Boolean(s.settings?.enabled&&!s.settings?.emergencyStop);
 put('engineState',s.settings?.emergencyStop?'紧急停止':active?'AI 自动分析已开启 · '+s.aiStatus:'AI 自动分析已关闭');
 put('lastAnalysis',time(s.lastDecision?.at||s.lastModelCallAt));
 const met=s.metrics||{},activeSymbol=s.position?.symbol||s.lastMarket?.symbol||'BTCUSDT';
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

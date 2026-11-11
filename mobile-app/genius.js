'use strict';
const $=id=>document.getElementById(id);
let settings=null,updating=false,saving=false;
const money=n=>Number.isFinite(Number(n))?Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:4})+' USDT':'—';
const num=n=>Number.isFinite(Number(n))?Number(n).toLocaleString('zh-CN',{maximumFractionDigits:6}):'—';
const time=n=>n?new Date(n).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'—';
const put=(id,value)=>{$(id).textContent=value===undefined||value===null?'—':String(value)};
const textLine=(label,val)=>{const r=document.createElement('div');r.className='row';const a=document.createElement('span');a.textContent=label;const b=document.createElement('strong');b.textContent=val;r.append(a,b);return r;};
async function api(route,config={}){
 const res=await fetch('/genius/api/'+route,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(12000),...config});
 const data=await res.json();if(!res.ok||!data.ok)throw Error(data.error||'HTTP '+res.status);return data;
}
function formValue(){return {leverage:Number($('leverage').value),marginUsdt:Number($('marginUsdt').value)};}
function setForm(s){$('leverage').value=s.leverage;$('marginUsdt').value=s.marginUsdt;}
function renderStatus(s){
 const ok=s.mode==='PAPER_ONLY'&&s.realTradingEnabled===false;
 put('connection',ok?'模拟服务在线':'连接异常');
 put('marketStream',s.marketStream==='LIVE'?'行情流实时连接':(s.marketStream||'行情流待连接')+' · REST 备用');
 const m=s.position?s.marketSnapshots?.find(x=>x.symbol===s.position.symbol):s.lastMarket;
 put('markPrice',m?.markPrice?(m.symbol+'  '+num(m.markPrice)+' USDT'):'行情待更新');
 const active=Boolean(s.settings?.enabled&&!s.settings?.emergencyStop);
 put('engineState',s.settings?.emergencyStop?'紧急停止':active?'AI 自动分析已开启 · '+s.aiStatus:'AI 自动分析已关闭');
 put('lastAnalysis',time(s.lastDecision?.at||s.lastModelCallAt));
 const actions={LONG:'看涨开仓',SHORT:'看跌开仓',HOLD:'继续持有',CLOSE:'AI 主动平仓',WAIT:'暂不操作'};
 put('aiDecision',s.lastDecision?((s.lastDecision.symbol||'全市场')+' · '+(actions[s.lastDecision.action]||s.lastDecision.action)+' · '+s.lastDecision.reason):'尚无有效 AI 决策');
 put('balance',money(s.paperBalance));put('tradeCount',s.totalClosed);
 $('toggle').textContent=active?'关闭 AI 自动分析':'开启 AI 自动分析';
 const position=$('position');position.replaceChildren();
 if(s.position){const p=s.position;position.append(textLine('币种 / 方向',p.symbol+' / '+p.side),
  textLine('模拟开仓价格',num(p.entry)),textLine('开仓金额 / 杠杆',money(p.marginUsdt)+' / '+p.leverage+'倍'),
  textLine('平仓方式','AI 判断（无固定止盈/止损）'),textLine('开仓时间',time(p.openedAt)));
 }else position.textContent='暂无模拟持仓 · AI 正在寻找可用机会';
 if(!settings){settings=s.settings;setForm(settings);}
 if(!saving&&s.lastError)put('saveStatus','行情或 AI 异常：'+s.lastError+'；暂停新增模拟开仓。');
}
async function refresh(){
 if(updating)return;updating=true;
 try{
  const [s,h]=await Promise.all([api('status'),api('history')]);renderStatus(s);
  const root=$('history');root.replaceChildren();
  if(!h.records.length)root.textContent='暂无已结束的模拟交易。';
  for(const r of h.records.slice(0,20)){
   const d=document.createElement('div');const head=document.createElement('strong');
   head.textContent=r.symbol+' '+r.side+' · '+(r.netPnl>=0?'+':'')+money(r.netPnl);
   const detail=document.createElement('small');const type=r.exitReason==='AI_CLOSE'?'AI 自主平仓':r.exitReason==='EMERGENCY_STOP'?'手动紧急停止':r.exitReason;detail.textContent=time(r.closedAt)+' · '+type+(r.aiExitReason?' · '+r.aiExitReason:'')+' · 模拟';
   d.append(head,detail);root.append(d);
  }
 }catch(e){put('connection','服务未连接');put('saveStatus','读取失败：'+e.message);}finally{updating=false;}
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

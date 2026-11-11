'use strict';
const $=id=>document.getElementById(id);
let settings=null,updating=false;
const formFields=['symbol','paperBalance','leverage','marginUsdt','takeProfitPct','stopLossPct','maxDailyLossUsdt','cooldownMinutes'];
const money=n=>Number.isFinite(Number(n))?Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:4})+' USDT':'—';
const time=n=>n?new Date(n).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'—';
const put=(id,value)=>{$(id).textContent=value===undefined||value===null?'—':String(value)};
const textLine=(label,val)=>{const r=document.createElement('div');r.className='row';const a=document.createElement('span');a.textContent=label;const b=document.createElement('strong');b.textContent=val;r.append(a,b);return r;};
async function api(route,config={}){
 const res=await fetch('/genius/api/'+route,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(12000),...config});
 const data=await res.json();if(!res.ok||!data.ok)throw Error(data.error||'HTTP '+res.status);return data;
}
function formValue(){const out={...settings};for(const f of formFields){out[f]=f==='symbol'?$(f).value:Number($(f).value);}return out;}
function setForm(s){for(const f of formFields)$(f).value=s[f];}
function renderStatus(s){
 const ok=s.mode==='PAPER_ONLY'&&s.realTradingEnabled===false;
 put('connection',ok?'模拟服务已连接':'连接或模式异常');
 put('aiModel',s.aiModel+' · '+(s.aiConfigured?'密钥已配置':'密钥未配置'));
 put('markPrice',s.lastMarket?.markPrice?money(s.lastMarket.markPrice):'行情待更新');
 put('engineState',s.settings?.emergencyStop?'紧急停止':s.settings?.enabled?'自动模拟已启用':'自动模拟已暂停');
 put('aiDecision',s.lastDecision?(s.lastDecision.action+' · '+s.lastDecision.reason):('暂无有效分析 · '+s.aiStatus));
 put('balance',money(s.paperBalance));put('tradeCount',s.totalClosed);
 $('toggle').textContent=s.settings?.enabled?'暂停新增模拟仓位':'启用自动模拟';
 const position=$('position');position.replaceChildren();
 if(s.position){const p=s.position;position.append(textLine('币种与方向',p.symbol+' / '+p.side),
  textLine('开仓模拟价',money(p.entry)),textLine('保证金 / 杠杆',p.marginUsdt+' USDT / '+p.leverage+'倍'),
  textLine('模拟止盈价',money(p.takeProfit)),textLine('模拟止损价',money(p.stop)),
  textLine('开仓时间',time(p.openedAt)));
 }else position.textContent='暂无模拟持仓';
 if(!settings){settings=s.settings;setForm(settings);}
 if(s.lastError)put('saveStatus','行情或AI异常：'+s.lastError+'；没有真实下单。');
}
async function refresh(){if(updating)return;updating=true;try{
 const [s,h]=await Promise.all([api('status'),api('history')]);renderStatus(s);
 const root=$('history');root.replaceChildren();
 if(!h.records.length)root.textContent='尚无模拟成交记录。';
 for(const r of h.records.slice(0,20)){
  const d=document.createElement('div');const head=document.createElement('strong');
  head.textContent=r.symbol+' '+r.side+' · '+(r.netPnl>=0?'+':'')+money(r.netPnl);
  const detail=document.createElement('small');detail.textContent=time(r.closedAt)+' · '+r.exitReason+' · 模拟交易';
  d.append(head,detail);root.append(d);
 }
 }catch(e){put('connection','服务未连接');put('saveStatus','读取失败：'+e.message);}finally{updating=false;}}
async function save(values){try{
 const x=await api('settings',{method:'POST',headers:{'Content-Type':'application/json','X-Haipai-Paper-Control':'yes'},body:JSON.stringify(values)});
 settings=x.settings;setForm(settings);put('saveStatus','模拟参数已保存；真实下单仍关闭。');await refresh();
 }catch(e){put('saveStatus','保存失败：'+e.message);}}
$('save').addEventListener('click',()=>{if(settings)void save({...formValue(),enabled:settings.enabled,emergencyStop:settings.emergencyStop});});
$('toggle').addEventListener('click',()=>{if(settings){const next={...formValue(),enabled:!settings.enabled,emergencyStop:false};void save(next);}});
$('stop').addEventListener('click',()=>{if(settings)void save({...settings,enabled:false,emergencyStop:true});});
void refresh();setInterval(()=>void refresh(),7000);
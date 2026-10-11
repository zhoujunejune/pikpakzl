(function(){
 'use strict';
 // UI config only; this never turns on a daily-loss trading fuse.
 const el=id=>document.getElementById(id);
 const put=(id,message)=>{const target=el(id);if(target)target.textContent=String(message);};
 const money=value=>Number(value).toFixed(2)+' USDT';
 let saving=false,loaded=false;
 async function read(){
  try{
   const resp=await fetch('/api/daily-loss-limit?ts='+Date.now(),{cache:'no-store'});
   const data=await resp.json();
   if(!resp.ok||!data.ok)throw new Error(data.error||'观察配置读取失败');
   put('dailyLossMode','观察模式 · 不拦截任何真实交易');
   const enabled=data.monitorEnabled===true;
   put('dailyLossSwitchStatus',data.configured?(enabled?'观察开关：已开启（盈亏数据未核验）':'观察开关：已关闭'):'观察开关：尚未设置金额');
   put('dailyLossEnforceStatus','真实交易熔断：未接入 · 不会拦截下单');
   if(el('dailyLossEnableButton'))el('dailyLossEnableButton').disabled=saving||!data.configured||enabled;
   if(el('dailyLossDisableButton'))el('dailyLossDisableButton').disabled=saving||!enabled;
   put('dailyLossLimitValue',data.configured&&Number.isFinite(data.dailyLimitUsdt)?money(data.dailyLimitUsdt):'尚未设置');
   put('dailyLossPnl','尚未完成官方核验');
   put('dailyLossRemaining','不可计算');
   put('dailyLossHint','观察开关仅记录监控偏好；当日官方已实现盈亏尚未独立核验，因此无法计算剩余额度。无论开关开启或关闭，均不会拦截真实交易。统计时区：北京时间。');
   const input=el('dailyLossAmount'),editor=el('dailyLossEditor');
   if(input&&!saving&&!editor?.open&&data.configured&&Number.isFinite(data.dailyLimitUsdt))input.value=String(data.dailyLimitUsdt);
   loaded=true;
  }catch(e){
   if(!loaded){
    put('dailyLossLimitValue','读取失败');
    put('dailyLossMode','观察模式 · 配置不可验证');
    put('dailyLossSwitchStatus','观察开关：无法读取');
   }
   put('dailyLossHint','配置服务不可用（'+String(e.message||e)+'）。每日亏损拦截从未启用，不能依赖本栏目保护资金。');
  }
 }
 async function save(){
  if(saving)return;
  const raw=String(el('dailyLossAmount')?.value||'').trim();
  const pin=String(el('dailyLossPin')?.value||el('pin')?.value||'').trim();
  if(!/^\d+(?:\.\d{1,2})?$/.test(raw)||Number(raw)<0.01||Number(raw)>100000){
   put('dailyLossMessage','请输入 0.01—100000 USDT，最多两位小数');return;
  }
  if(!pin){put('dailyLossMessage','请输入控制 PIN');return;}
  saving=true;
  const button=el('dailyLossSaveButton');if(button)button.disabled=true;
  put('dailyLossMessage','正在保存观察参数...');
  try{
   const response=await fetch('/api/daily-loss-limit',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({dailyLimitUsdt:raw,pin})
   });
   const data=await response.json();
   if(!response.ok||!data.ok)throw new Error(data.error||'保存失败');
   if(el('dailyLossPin'))el('dailyLossPin').value='';
   put('dailyLossMessage','已保存 '+money(data.dailyLimitUsdt)+' 的观察阈值；未开启真实熔断');
   put('dailyLossLimitValue',money(data.dailyLimitUsdt));
   await read();
  }catch(e){
   put('dailyLossMessage',String(e.message||e));
  }finally{
   saving=false;if(button)button.disabled=false;
  }
 }

 async function switchObservation(enabled){
  if(saving)return;
  const pin=String(el('dailyLossPin')?.value||el('pin')?.value||'').trim();
  if(!pin){put('dailyLossSwitchMessage','请先在此栏目输入控制 PIN');return;}
  saving=true;
  if(el('dailyLossEnableButton'))el('dailyLossEnableButton').disabled=true;
  if(el('dailyLossDisableButton'))el('dailyLossDisableButton').disabled=true;
  put('dailyLossSwitchMessage','正在保存观察开关...');
  try{
   const response=await fetch('/api/daily-loss-limit',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({monitorEnabled:enabled,pin})
   });
   const data=await response.json();
   if(!response.ok||!data.ok)throw new Error(data.error||'开关保存失败');
   if(data.enforcementEnabled!==false)throw new Error('服务器返回了意外熔断状态，请检查配置');
   if(el('dailyLossPin'))el('dailyLossPin').value='';
   put('dailyLossSwitchMessage',(enabled?'已开启':'已关闭')+'每日亏损观察开关；真实停单熔断尚未启用');
   await read();
  }catch(e){
   put('dailyLossSwitchMessage',String(e.message||e));
   await read();
  }finally{
   saving=false;
  }
 }
 function boot(){
  if(!el('dailyLossCard'))return;
  el('dailyLossSaveButton')?.addEventListener('click',save);
  el('dailyLossEnableButton')?.addEventListener('click',()=>switchObservation(true));
  el('dailyLossDisableButton')?.addEventListener('click',()=>switchObservation(false));
  void read();setInterval(read,15000);
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);
 else boot();
})();
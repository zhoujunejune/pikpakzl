// GUARDIAN5 main-page presentation. Read-only DOM rendering: no trade commands.
const OLD_CARD='<section class="c" id="roundResultsOnlyCard" style="margin:14px 0">';
const CARD=String.raw`<section class="c" id="zlGuardianMain" style="margin:14px 0">
<div class="k">BTC · GUARDIAN 5M · 生产策略监控</div>
<div class="big" id="zlGMain" style="margin:9px 0;min-height:1.8em;font-variant-numeric:tabular-nums">读取 GUARDIAN 状态中...</div>
<div class="muted" id="zlGReason" style="margin:9px 0 14px;min-height:2.8em">仅在条件充分时给出方向；不能确定则 WAIT</div>
<div class="grid" style="margin:12px 0">
 <div class="kv"><div class="k">当前生产信号模型</div><div class="v" id="zlGModel">读取中</div></div>
 <div class="kv"><div class="k">DeepSeek 分析</div><div class="v" id="zlGAI">读取中</div></div>
 <div class="kv"><div class="k">行情更新延迟</div><div class="v" id="zlGMarket">读取中</div></div>
 <div class="kv"><div class="k">实盘跟随开关</div><div class="v" id="zlGFollow">读取中</div></div>
 <div class="kv"><div class="k">已记录预测</div><div class="v" id="zlGCount">--</div></div>
 <div class="kv"><div class="k">已结算方向准确率</div><div class="v" id="zlGAccuracy">--</div></div>
</div>
<div class="grid" style="margin:12px 0">
 <div class="kv"><div class="k">动态移动止盈</div><div class="v" id="zlGDynamicTP">核验中</div></div>
 <div class="kv"><div class="k">动态止损</div><div class="v" id="zlGDynamicSL">核验中</div></div>
 <div class="kv"><div class="k">现有固定止盈</div><div class="v" id="zlGFixedTP">核验中</div></div>
 <div class="kv"><div class="k">现有固定止损</div><div class="v" id="zlGFixedSL">核验中</div></div>
 <div class="kv"><div class="k">风控设置持久化</div><div class="v" id="zlGRiskPersistence">核验中</div></div>
 <div class="kv"><div class="k">风控平仓执行验证</div><div class="v" id="zlGRiskExec">核验中</div></div>
</div>
<div class="kv" id="zlGuardianRiskSwitchCard" style="margin:14px 0;border:1px solid #34526e;border-radius:12px;padding:14px">
 <div class="k" style="font-size:13px">GUARDIAN 专属动态风控</div>
 <div class="v" id="zlGRiskToggleState" style="margin:8px 0;font-size:20px">正在查询实际开关...</div>
 <div class="muted" id="zlGRiskToggleReason" style="line-height:1.6">必须核验真实卖出报价、平仓和失败恢复后才能开启。</div>
 <div style="display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin-top:12px">
  <input type="password" id="zlGRiskTogglePin" aria-label="动态风控控制 PIN" autocomplete="off" placeholder="已登录站点可免填 PIN" style="min-width:135px;flex:1;max-width:230px;padding:11px;border-radius:8px;background:#101b2b;color:#eff5ff;border:1px solid #36516a">
  <button type="button" id="zlGRiskToggleButton" aria-label="切换 GUARDIAN 动态止盈止损" onclick="zlGuardianToggleRisk()" style="border-radius:9px;background:#203c54;color:#e8f3ff;border:1px solid #5481a4;min-height:43px;padding:10px 15px;cursor:pointer">读取中</button>
 </div>
 <div id="zlGRiskToggleNotice" role="status" aria-live="polite" style="min-height:20px;font-size:13px;margin-top:8px;color:#e1b77c"></div>
</div>
<div class="muted" id="zlGDetail" style="margin:12px 0;min-height:2.5em">正在检查实际状态与交易接入情况</div>
<div class="muted" style="margin:12px 0;padding:10px 12px;border:1px solid #30485e;border-radius:9px">GUARDIAN 动态风控开关与旧固定止盈止损互相独立。只有后端确认风控 Worker 生效时才显示“运行中”；未通过真实 SELL 验收前，点击开启会被安全拦截。停止跟随不等于停止现有仓位的风险监控。</div>
<a href="/guardian/" style="display:inline-block;margin:7px 0 3px;padding:10px 13px;color:#a7d8ff;text-decoration:none;border:1px solid #456681;border-radius:9px">查看 GUARDIAN 详细信号与记录</a>
</section>`;
const SCRIPT=String.raw`<script>(function(){
 if(window.__zlGuardianMainStarted)return;
 window.__zlGuardianMainStarted=true;
 function el(id){return document.getElementById(id)}
 function put(id,value){var n=el(id);if(n&&n.textContent!==String(value))n.textContent=String(value)}
 async function get(url){
  var r=await fetch(url,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(7000)});
  if(!r.ok)throw Error('接口HTTP '+r.status);
  return await r.json()
 }
 function fmtTime(t){
  if(!Number.isFinite(Number(t))||Number(t)<=0)return '暂无记录';
  return new Date(Number(t)).toLocaleTimeString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'});
 }
 function direction(x){
  if(x==='UP')return 'UP · 看涨（仅分析）';
  if(x==='DOWN')return 'DOWN · 看跌（仅分析）';
  if(x==='OBSERVED')return '已记录本轮信号';
  if(x==='THINKING')return 'DeepSeek 分析中';
  return 'WAIT · 暂不交易'
 }
 var loading=false,riskBusy=false;
 var guardianToggle={loaded:false,requestedEnabled:false,effectiveEnabled:false,canEnable:false};
 function toggleNote(text){put('zlGRiskToggleNotice',text||'')}
 function renderToggle(d){
  if(!d||d.ok!==true){
   guardianToggle.loaded=false;
   put('zlGRiskToggleState','状态未知 · 不允许操作');
   put('zlGRiskToggleReason','动态风控接口不可用，无法判断是否真正受保护');
   var b=el('zlGRiskToggleButton');if(b)b.disabled=true;
   return;
  }
  guardianToggle={loaded:true,requestedEnabled:d.requestedEnabled===true,
    effectiveEnabled:d.effectiveEnabled===true,canEnable:d.canEnable===true};
  var label=d.effectiveEnabled?(d.approvalVerified?'运行中 · 已有SELL验证记录':'监控已启动 · SELL成交未验证'):
    d.requestedEnabled?'开启请求已保存 · 尚未确认生效':
    '已关闭 · 未启用动态止盈止损';
  put('zlGRiskToggleState',label);
  put('zlGRiskToggleReason',d.reason||'未取得实际风控状态');
  var btn=el('zlGRiskToggleButton');
  if(btn){btn.disabled=riskBusy;btn.textContent=riskBusy?'正在保存...':
     d.requestedEnabled?'关闭动态止盈止损':'开启动态止盈止损';}
  put('zlGDynamicTP',d.effectiveEnabled?'监控已接入 · SELL未保证成交':'未启用');
  put('zlGDynamicSL',d.effectiveEnabled?'监控已接入 · SELL未保证成交':'未启用');
  put('zlGRiskExec',d.effectiveEnabled?
    (d.approvalVerified?'Worker运行 · 有历史SELL验收记录':'监控运行 · 真实SELL尚未验证'):
    '动态平仓尚未运行 / 未取得交易所成交验证');
 }
 window.zlGuardianToggleRisk=async function(){
  if(riskBusy||!guardianToggle.loaded)return;
  var pin=el('zlGRiskTogglePin');
  var password=pin&&String(pin.value||'').trim();
  var enabled=!guardianToggle.requestedEnabled;
  // A UI toggle must never claim that an unverified SELL worker is active.
  if(enabled&&!guardianToggle.canEnable){
   toggleNote('尚未完成真实SELL平仓及异常恢复验收，系统禁止开启；当前实盘风控没有生效。');
   return;
  }
  riskBusy=true;renderToggle({...guardianToggle,ok:true});
  try{
   var response=await fetch('/api/guardian-dynamic-risk',{method:'POST',
    credentials:'same-origin',cache:'no-store',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({enabled:enabled,pin:password}),
    signal:AbortSignal.timeout(9000)});
   var data=await response.json();
   if(!response.ok||data.ok!==true)throw Error(data.error||'控制接口拒绝操作');
   if(pin)pin.value='';
   renderToggle(data);
   toggleNote(data.effectiveEnabled?'监控运行中；真实SELL尚未保证成交':
    enabled?'已保存请求，但风控未确认生效；不可据此假定订单受保护':'关闭请求已保存；存量持仓如有风险仍需监控');
  }catch(e){toggleNote('操作失败：'+String(e.message||e).slice(0,150))}
  finally{riskBusy=false;void load()}
 };
 async function load(){
  if(loading||document.hidden)return;loading=true;
  try{
   var result=await Promise.all([get('/guardian/api/status'),get('/api/status'),get('/api/risk-control').catch(function(){return null}),get('/api/guardian-dynamic-risk').catch(function(){return null})]);
   var g=result[0],t=result[1],risk=result[2],guardianRisk=result[3];
   if(g.ok!==true||g.model!=='ZL_GUARDIAN_5M_V1')throw Error('GUARDIAN分析服务未就绪');
   if(t.ok!==true)throw Error('生产控制服务未就绪');
   var ready=t.orderSignalModel==='ZL_GUARDIAN_5M_V1'&&t.orderSignalModelReady===true;
   put('zlGMain',ready?direction(g.latest&&g.latest.direction):'生产信号配置暂不可用');
   put('zlGReason',g.latest&&g.latest.reason||'等待新一轮实时行情');
   put('zlGModel',ready?'GUARDIAN 5M · 已选择':'配置未就绪');
   put('zlGAI',g.lastAIAt?'最近分析 '+fmtTime(g.lastAIAt):g.configured?'已配置 · 等待信号':'未配置');
   var age=g.observedAt==null?null:Math.max(0,Date.now()-Number(g.observedAt));
   put('zlGMarket',age==null?'等待行情':age<60000?Math.round(age/1000)+' 秒': '行情延迟 '+Math.round(age/1000)+' 秒');
   put('zlGFollow',t.enabled===true?'已开启（当前不可实盘下单）':'关闭');
   if(!riskBusy)renderToggle(guardianRisk);
   put('zlGFixedTP',risk&&risk.ok?(risk.takeProfitEnabled?'开启 · '+Number(risk.takeProfitPercent)+'% 理论盈利空间':'关闭'):'读取失败');
   put('zlGFixedSL',risk&&risk.ok?(risk.stopLossEnabled?'开启 · 亏损 '+Number(risk.stopLossPercent)+'% 触发':'关闭'):'读取失败');
   put('zlGRiskPersistence',risk&&risk.ok?(risk.persistenceHealthy===true?'正常':'未就绪'):'状态未知');
   // Real Worker state comes only from the dedicated control endpoint.
   var stats=g.stats||{};
   put('zlGCount',Number.isFinite(stats.shadowPredictions)?stats.shadowPredictions:0);
   put('zlGAccuracy',stats.settled>0&&Number.isFinite(stats.directionAccuracy)?(100*stats.directionAccuracy).toFixed(1)+'%（'+stats.settled+'轮）':'暂无有效结算');
   var errs=g.error?' · 分析异常：'+String(g.error).slice(0,110):'';
   put('zlGDetail',(g.productionIntegration===false?'已选为生产信号，但真实订单尚未接通 · ':'')+
      '最新轮次 '+(g.round?fmtTime(g.round):'--')+' · 当前结论仅供观察'+errs);
  }catch(e){
   put('zlGMain','GUARDIAN状态读取失败');
   put('zlGReason','状态接口异常：'+String(e.message||e).slice(0,120));
   put('zlGModel','连接待恢复');
  }finally{loading=false}
 }
 void load();
 setInterval(load,4000);
 document.addEventListener('visibilitychange',function(){if(!document.hidden)void load()});
})();</script>`;
export function injectGuardianMainDashboard(html){
 if(typeof html!=='string'||!html.includes('</body>'))return html;
 if(html.includes('id="zlGuardianMain"'))return html;
 const start=html.indexOf(OLD_CARD);
 if(start<0)return html;
 const end=html.indexOf('</section>',start);
 if(end<0)return html;
 let out=html.slice(0,start)+CARD+html.slice(end+'</section>'.length);
 out=out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,tag=>
  tag.includes('/api/deepseek-round-results?limit=')&&tag.includes('rrMeta')?'':tag);
 return out.replace('</body>',SCRIPT+'</body>');
}

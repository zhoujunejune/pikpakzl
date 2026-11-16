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
<div class="muted" id="zlGDetail" style="margin:12px 0;min-height:2.5em">正在检查实际状态与交易接入情况</div>
<div class="muted" style="margin:12px 0;padding:10px 12px;border:1px solid #30485e;border-radius:9px">GUARDIAN 已指定为唯一生产信号模型，但它的真实开仓和动态止盈止损执行仍未接通。现有固定比例止盈止损属于另一套风险服务，不能当作 GUARDIAN 动态平仓成功的证明。</div>
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
 var loading=false;
 async function load(){
  if(loading||document.hidden)return;loading=true;
  try{
   var result=await Promise.all([get('/guardian/api/status'),get('/api/status'),get('/api/risk-control').catch(function(){return null})]);
   var g=result[0],t=result[1],risk=result[2];
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
   put('zlGDynamicTP',g.exitExecutionEnabled===true?'已接通（须再确认成交）':'未接入');
   put('zlGDynamicSL',g.exitExecutionEnabled===true?'已接通（须再确认成交）':'未接入');
   put('zlGFixedTP',risk&&risk.ok?(risk.takeProfitEnabled?'开启 · '+Number(risk.takeProfitPercent)+'% 理论盈利空间':'关闭'):'读取失败');
   put('zlGFixedSL',risk&&risk.ok?(risk.stopLossEnabled?'开启 · 亏损 '+Number(risk.stopLossPercent)+'% 触发':'关闭'):'读取失败');
   put('zlGRiskPersistence',risk&&risk.ok?(risk.persistenceHealthy===true?'正常':'未就绪'):'状态未知');
   put('zlGRiskExec','未取得实时 SELL 报价及成交核验证据');
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

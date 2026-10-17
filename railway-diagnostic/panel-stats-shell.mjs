import http from 'node:http';
import { shadowCard, shadowScript, proxyShadowStatus } from './shadow-breakout20-dashboard.mjs';
import { noviceMixShadow } from './novice-mix-shadow.mjs';
import {createPostflipStatsService,POSTFLIP_START_ROUND} from './postflip-official-stats.mjs';
import { spawn } from 'node:child_process';

// RAILWAY_EGRESS_IP_READONLY_DIAG_20261014
// One-shot startup diagnostic: no credentials, no trading API writes, no order changes.
void (async () => {
  for (const [target, url] of [
    ['public_egress_ip', 'https://checkip.amazonaws.com/'],
    ['binance_public_ping', 'https://api.binance.com/api/v3/ping'],
  ]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(6500), cache: 'no-store' });
      const publicIp = target === 'public_egress_ip' && response.ok ? (await response.text()).trim().slice(0, 64) : null;
      console.log(JSON.stringify({ event: 'railway_egress_ip_readonly_diagnostic', target, httpStatus: response.status, publicIp, at: new Date().toISOString() }));
    } catch (error) {
      console.log(JSON.stringify({ event: 'railway_egress_ip_readonly_diagnostic', target, error: error?.name || 'NETWORK_ERROR', at: new Date().toISOString() }));
    }
  }
})();

const PORT = Number(process.env.PORT || 3000);
const INNER_PANEL_PORT = Number(process.env.INNER_PANEL_PORT || 3002);
const ROUND_STATS_ORIGIN = String(process.env.ROUND_STATS_ORIGIN || 'https://signal-diagnostic-v2-production.up.railway.app').replace(/\/+$/, '');
const ROUND_STATS_PUBLIC_ORIGIN = String(process.env.ROUND_STATS_PUBLIC_ORIGIN || 'https://signal-diagnostic-v2-production.up.railway.app').replace(/\/+$/, '');
const STATS_PROXY_PRIMARY_TIMEOUT_MS = Math.max(1000, Number(process.env.STATS_PROXY_PRIMARY_TIMEOUT_MS || 2500));
const STATS_PROXY_FALLBACK_TIMEOUT_MS = Math.max(3000, Number(process.env.STATS_PROXY_FALLBACK_TIMEOUT_MS || 7000));
const STATS_PROXY_RETRY_MS = Math.max(100, Number(process.env.STATS_PROXY_RETRY_MS || 250));
const postflipStats=createPostflipStatsService({noviceRows:()=>noviceMixShadow.rowsSince(POSTFLIP_START_ROUND)});
let lastGoodStats = null;
let lastGoodStatsAt = 0;
let statsRefreshPromise = null;
let statsRefreshLastError = null;

function log(event, extra = {}) {
  console.log(JSON.stringify({ event, shell: 'panel-stats', at: new Date().toISOString(), ...extra }));
}

const statsCard = `<div class="c" id="roundStatsCard">
<div class="k">每轮判断与真实结果</div>
<div class="big" id="rsAccuracy">准确率读取中...</div>
<div class="muted" id="rsMeta">仅统计当前模型原始方向的币安官方结算；50%信号层随机翻转后的胜率及实际成交盈亏须另行统计。</div>
<div class="grid" style="margin-top:12px">
<div class="kv"><div class="k">已结算</div><div class="v" id="rsSettled">-</div></div>
<div class="kv"><div class="k">有效判断</div><div class="v" id="rsDecided">-</div></div>
<div class="kv"><div class="k">命中</div><div class="v" id="rsCorrect">-</div></div>
<div class="kv"><div class="k">未命中</div><div class="v" id="rsWrong">-</div></div>
<div class="kv"><div class="k">未出方向</div><div class="v" id="rsWait">-</div></div>
<div class="kv"><div class="k">判断覆盖率</div><div class="v" id="rsCoverage">-</div></div>
</div>
<div style="overflow:auto;max-height:460px;margin-top:12px;border:1px solid #2b313d;border-radius:10px"><table style="width:100%;border-collapse:collapse;font-size:13px;min-width:720px"><thead style="position:sticky;top:0;background:#151922;z-index:2"><tr style="text-align:left;color:#8f98a8"><th style="padding:8px 6px">轮次</th><th style="padding:8px 6px">生产判断</th><th style="padding:8px 6px">来源</th><th style="padding:8px 6px">强度 / 原始评分</th><th style="padding:8px 6px">耗时</th><th style="padding:8px 6px">官方结果</th><th style="padding:8px 6px">命中结果</th><th style="padding:8px 6px">官方结算证据</th></tr></thead><tbody id="rsRows"><tr><td colspan="8" style="padding:10px 6px;color:#8f98a8">读取中...</td></tr></tbody></table></div>
<div class="muted" style="margin-top:10px">有置信度时显示接口原值；置信度缺失但有 score 时，显示原始评分绝对值（未校准，非概率、非预测胜率，不同模型之间不可直接比较）；两者均缺失则标记“未提供”或“兜底无评分”。真实结果仅按 Binance Prediction 官方结算。</div>
</div>`;

const previewCard = `<div class="c" id="waitVisibilityCard">
<div class="k">实时方向观察 · 生产交易严格分离</div>
<div class="big" id="wvTradeStatus">正在核对生产方向...</div>
<div class="muted" id="wvMeta">非现役15秒信号只作为历史证据；生产放行状态以现役列表和实时锁定为准。</div>
<div class="grid" style="margin-top:12px">
<div class="kv"><div class="k">最新15秒观察方向</div><div class="v" id="wvPreview">-</div></div>
<div class="kv"><div class="k">预测市场盘口倾向</div><div class="v" id="wvPmSide">-</div></div>
<div class="kv"><div class="k">最近20轮候选覆盖率</div><div class="v" id="wvCoverage">-</div></div>
<div class="kv"><div class="k">已结算候选命中率</div><div class="v" id="wvHitRate">-</div></div>
</div>
<div class="muted" id="wvBlockers" style="margin-top:10px">正在读取拒绝原因...</div>
<div style="overflow:auto;max-height:370px;margin-top:10px;border:1px solid #2b313d;border-radius:10px"><table style="width:100%;border-collapse:collapse;font-size:13px;min-width:640px"><thead style="position:sticky;top:0;background:#151922;z-index:2"><tr style="text-align:left;color:#8f98a8"><th style="padding:8px 6px">轮次</th><th style="padding:8px 6px">15秒候选（非下单）</th><th style="padding:8px 6px">生产</th><th style="padding:8px 6px">官方结果</th><th style="padding:8px 6px">候选结果</th><th style="padding:8px 6px">未通过原因</th></tr></thead><tbody id="wvRows"><tr><td colspan="6" style="padding:9px 6px">读取中...</td></tr></tbody></table></div>
<div class="muted" style="margin-top:10px">候选方向、盘口倾向、生产已锁定方向是三种不同信息。候选仅按事前冻结记录计算；命中率采用系统登记的 Binance Prediction 结算，不代表独立审计认证。不会改变实际下单逻辑。</div>
</div>`;

const policyCard = `<div class="c" id="signalPolicyCard">
<div class="k">生产信号策略 · 当前活跃模型</div>
<div class="big" id="spTitle">正在读取现役信号状态...</div>
<div class="muted" style="margin-top:6px">以生产服务当前活跃模型清单为准；历史策略不会重新获得生产资格。</div>
<div id="spRouteStages" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;font-size:12px"><span class="muted">同步生产模型中...</span></div>
<div class="grid" style="margin-top:12px">
  <div class="kv"><div class="k">当前生产来源</div><div class="v" id="spQualified">-</div></div>
  <div class="kv"><div class="k">其他来源状态</div><div class="v" id="spObserve">-</div></div>
  <div class="kv"><div class="k">新策略晋级</div><div class="v">已关闭</div></div>
  <div class="kv"><div class="k">进度数据</div><div class="v" id="spFreshness">读取中</div></div>
</div>
<div class="muted" id="spRule" style="margin-top:10px">读取生产信号规则中...</div>
<div id="spLegacyRegistryWrap" style="overflow:auto;max-height:410px;margin-top:12px;border:1px solid #2b313d;border-radius:10px">
<table style="width:100%;border-collapse:collapse;font-size:12px;min-width:820px"><thead style="position:sticky;top:0;background:#151922;z-index:2">
<tr style="text-align:left;color:#8f98a8"><th style="padding:8px 6px">15秒现役模型</th><th style="padding:8px 6px">风控状态</th><th style="padding:8px 6px">前瞻样本</th><th style="padding:8px 6px">总准确率</th><th style="padding:8px 6px">近30次</th><th style="padding:8px 6px">UP / DOWN</th><th style="padding:8px 6px">30分钟熔断</th></tr>
</thead><tbody id="spRows"><tr><td colspan="7" style="padding:12px 6px">读取现役记录中...</td></tr></tbody></table></div>
<div class="muted" id="spNotice" style="margin-top:10px">正在同步当前生产信号...</div>
</div>`;

const policyScript = `<script>(function(){
'use strict';
function e(x){return document.getElementById(x)}
function esc(v){return String(v==null?'-':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function pct(v){return typeof v==='number'&&isFinite(v)?(100*v).toFixed(1)+'%':'-'}
function age(v){return typeof v==='number'&&isFinite(v)?v:'-'}
function circuit(x){var scopes=x&&x.scopes||{};var closed=Object.keys(scopes).filter(function(k){return scopes[k]&&scopes[k].mode==='COOLDOWN'});return closed.length?'冷却：'+closed.join('/'):Object.keys(scopes).some(function(k){return scopes[k]&&scopes[k].mode==='HALF_OPEN'})?'试运行中':'未冷却'}
// The backend registry is authoritative: retired candidates are not shown.
globalThis.__active15sCandidateIds=[];
async function load(){
 if(!e('signalPolicyCard'))return;
 try{
  // The live round-stats model catalog is authoritative; training registry is
  // historical and must never relabel the currently selected production route.
  var liveResponse=await fetch('/api/round-stats?ts='+Date.now(),{cache:'no-store'});
  var liveCatalog=await liveResponse.json();
  if(!liveResponse.ok||!liveCatalog||liveCatalog.ok!==true)
    throw Error('生产模型清单暂不可用');
  var productionMode=String(liveCatalog.productionSignalSourceMode||'');
  var currentModels=(Array.isArray(liveCatalog.activeSignalModels)?liveCatalog.activeSignalModels:[])
    .filter(function(m){return m&&m.active!==false&&m.id&&m.source});
  var routeStages=e('spRouteStages');
  if(productionMode==='MARKET_FUSION_FAST8'||productionMode==='BREAKOUT20_FAST8'){
    var breakout20Mode=productionMode==='BREAKOUT20_FAST8';
    if(e('spLegacyRegistryWrap'))e('spLegacyRegistryWrap').style.display='none';
    var name=currentModels.length
      ?currentModels.map(function(m){return m.name||m.id}).join(' + ')
      :'生产模型未确认';
    globalThis.__active15sCandidateIds=[];
    if(routeStages)routeStages.innerHTML='<span class="on">唯一生产模型 · '+esc(name)+'</span>'
      +(breakout20Mode?'<span>Cloudflare T+6.25秒采样，8秒截止</span>':'<span>目标第1秒锁定，8秒截止</span>')
      +'<span>旧策略不参与生产</span>';
    e('spQualified').textContent=currentModels.length?'1 类活跃来源':'未确认';
    e('spObserve').textContent='其他旧策略暂停';
    e('spFreshness').textContent='已同步生产接口';
    e('spTitle').textContent=name+(breakout20Mode?' · RSI/MACD 8秒影子方向':' · 8秒行情融合');
    e('spRows').innerHTML='<tr><td colspan="7" style="padding:12px 6px">当前生产仅使用 '+esc(name)+'；旧策略不参与实时生产预测。</td></tr>';
    e('spRule').textContent=breakout20Mode
      ?'生产信号采用突破20%即可的 RSI、MACD、价格区间和高低位，Cloudflare 原轮次 T+6.25秒附近锁定，Railway 仅接受本轮8秒内有效方向。历史影子预测不补录生产，失联或超时不伪造方向。'
      :'仅使用趋势评分与本轮有效市场报价；历史80%、实时20%，目标第1秒锁定，8秒截止。动量、OFI、成交压力均不参与；无真实数据不伪造信号。';
    e('spNotice').textContent=breakout20Mode
      ?'生产采用独立云端模型方向，正反向开关沿用 SELECTIVE_V2_FAST8_PRIMARY 既有配置。生产命中率以币安官方结算独立计算，不混用影子模型现货代理结果。'
      :'来源映射沿用现有方向开关配置；真实胜率仅按本模型版本与币安官方结算统计，不继承旧策略记录。';
    return;
  }
  if(e('spLegacyRegistryWrap'))e('spLegacyRegistryWrap').style.display='';
  if(routeStages)routeStages.innerHTML=currentModels.length
    ?currentModels.map(function(m){return '<span>'+esc(m.name||m.id)+'</span>'}).join('')
    :'<span class="muted">当前生产模型未确认</span>';
  var r=await fetch('/api/training-status?ts='+Date.now(),{cache:'no-store'});
  var j=await r.json();
  if(!r.ok||!j||j.ok!==true)throw Error(j&&j.error||'训练数据不可用');
  var registry=j.models&&j.models.all15sCandidateRegistry;
  if(!registry||!Array.isArray(registry.candidates))throw Error('现役信号注册表不存在');
  if(String(registry.productionRoute||'').indexOf('SELECTIVE_V2_FAST8_THEN_EDGE_RESCUE_FAST8')===0){
    globalThis.__active15sCandidateIds=[];
    e('spQualified').textContent='Selective V2 + Edge Rescue';
    e('spObserve').textContent='旧15秒候选暂停';
    e('spFreshness').textContent='已同步';
    e('spTitle').innerHTML='<span class="on">Selective V2（主） → Edge Rescue（兜底） · 8秒锁定</span>';
    e('spRows').innerHTML='<tr><td colspan="7" style="padding:12px 6px">当前生产仅使用8秒 Selective V2、8秒 Edge Rescue，以及真实行情低置信度方向兜底；旧15秒候选均不参与本轮锁定。</td></tr>';
    e('spRule').textContent='截止时间8秒；若V2和Edge Rescue均未通过，但有有效行情方向，低置信度信号仍允许按原下单规则执行；缺乏真实行情时不编造方向。';
    e('spNotice').textContent='这是一套新8秒版本：官方命中率独立统计，不继承历史22秒版本胜率。';
    return;
  }
  if(String(registry.productionRoute||'').indexOf('EXCLUSIVE_ZL_FAST8_65')===0){
    globalThis.__active15sCandidateIds=[];
    e('spQualified').textContent='0';
    e('spObserve').textContent=String(registry.candidates.length)+'条暂停';
    e('spFreshness').textContent='已同步';
    e('spTitle').innerHTML='<span class="warn">ZL_FAST8_65 唯一候选 · 旧信号源全部暂停</span>';
    e('spRows').innerHTML='<tr><td colspan="7" style="padding:12px 6px">15秒候选、Selective V2 与独立补救均暂停生产放行；模型、持久化淘汰记录及官方历史保留。</td></tr>';
    e('spRule').textContent='8秒影子方向可查看；实盘信号必须通过1000轮前瞻65%与已训练模型质量门槛，未达标自动 WAIT。';
    e('spNotice').textContent='当前路由：ZL_FAST8_65（只读预览） → 独立质量门槛 → 未达标 WAIT；其他生产来源不兜底。';
    return;
  }
  var by={};registry.candidates.forEach(function(x){if(x&&x.candidateId)by[x.candidateId]=x});
  var banned={'PM_TREND_045_CURRENT_03':true,'CURRENT_04_TREND_055_PM05':true,'BLENDED_04_PM_AGREE':true,'ABS_PM_REGIME35':true,'PM_LEAN_03':true,'zl_new_vip75':true};
  var ids=registry.candidates.filter(function(x){return x&&x.candidateId&&!banned[x.candidateId]}).map(function(x){return x.candidateId});
  globalThis.__active15sCandidateIds=ids.slice();
  var approved=0,observing=0;
  e('spRows').innerHTML=ids.map(function(id){
   var x=by[id],proof=x&&x.candidateForward;
   if(!x){observing++;return '<tr style="border-top:1px solid #2b313d"><td style="padding:8px 6px">'+esc(id)+'</td><td colspan="6" style="padding:8px 6px">该模型的生产资格数据未返回</td></tr>'}
   var ok=x.eligibleForProduction===true;
   if(ok)approved++;else observing++;
   var n=proof&&Number.isFinite(Number(proof.strictForwardSamples))?Number(proof.strictForwardSamples):null;
   var progress=n===null?'未获取':n+'次';
   var status=ok?'<span class="on">现役可放行</span>':(proof&&proof.status==='FORWARD_COMPLETE_NOT_QUALIFIED'?'<span class="bad">当前风控不通过</span>':'<span class="warn">暂不可放行</span>');
   var sides=proof?'UP '+age(proof.up&&proof.up.samples)+'次 '+pct(proof.up&&proof.up.accuracy)+' / DOWN '+age(proof.down&&proof.down.samples)+'次 '+pct(proof.down&&proof.down.accuracy):'-';
   return '<tr style="border-top:1px solid #2b313d"><td style="padding:8px 6px">'+esc(id)+'</td><td style="padding:8px 6px">'+status+'</td><td style="padding:8px 6px">'+esc(progress)+'</td><td style="padding:8px 6px">'+esc(pct(proof&&proof.forwardAccuracy))+'</td><td style="padding:8px 6px">'+esc(pct(proof&&proof.recent30&&proof.recent30.accuracy))+'</td><td style="padding:8px 6px">'+esc(sides)+'</td><td style="padding:8px 6px">'+esc(circuit(x.timedFuse))+'</td></tr>';
  }).join('');
  e('spQualified').textContent=approved+'/'+ids.length;
  e('spObserve').textContent=observing+'/'+ids.length;
  e('spTitle').innerHTML=approved?'<span class="on">'+approved+'种现役15秒策略可放行</span>':'<span class="warn">当前无现役15秒策略可放行；继续 Selective V2</span>';
  e('spFreshness').textContent='已同步';
  e('spNotice').textContent='生产路由：'+(registry.productionRoute||'现役15秒优先 → V2 → 硬熔断独立补救 → WAIT')+'；新晋级已关闭；现役仍需行情与独立熔断检查。每15秒同步一次。';
 }catch(err){
  e('spTitle').textContent='现役信号状态读取失败，不能判断当前可放行性';
  e('spFreshness').textContent='不可用';
  e('spQualified').textContent='未获取';
  e('spObserve').textContent='未获取';
  e('spRows').innerHTML='<tr><td colspan="7" style="padding:12px 6px">无法取得生产现役信号记录：'+esc(err&&err.message||String(err))+'</td></tr>';
 }
}
function boot(){load();setInterval(load,15000)}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();</script>`;

const previewScript = `<script>(function(){
'use strict';
function e(id){return document.getElementById(id)}
function esc(v){return String(v==null?'-':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function tm(ms){return Number.isFinite(Number(ms))?new Date(Number(ms)).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'-'}
function dir(v){return v==='UP'?'UP ↑':v==='DOWN'?'DOWN ↓':'WAIT'}
function frozen(r){var f=r&&r.v3NoBase15sShadow;return f&&f.baseAbsentAtObservation===true&&f.inputFrozenBeforeSettlement===true&&Number(f.round)===Number(r.roundStartMs)?f:null}
var priority=['ABS_PM_CURRENT15','PM_CURRENT25_SUPPORT08','PM_REGIME35_SUPPORT08','PM_FLOW15_CURRENT_03','CURRENT_03_TREND_045_PM08','CURRENT_03_PM_AGREE'];
function candidate(f){if(!f||!f.candidates)return null;var active=globalThis.__active15sCandidateIds||[];for(var i=0;i<priority.length;i++){if(active.indexOf(priority[i])<0)continue;var q=f.candidates[priority[i]];if(q&&(q.decision==='UP'||q.decision==='DOWN')&&q.qualified===true&&Array.isArray(q.reasons)&&q.reasons.length===0)return {direction:q.decision,model:priority[i]}}return null}
function reason(f){if(!f)return '15秒尚未冻结';var x=f.facts||{};var failures=x.gateFailures||[];if(failures.length)return failures.join('、');var reasons=[];Object.keys(f.candidates||{}).forEach(function(k){if((globalThis.__active15sCandidateIds||[]).indexOf(k)<0)return;var a=f.candidates[k];if(a&&a.decision==='WAIT'&&Array.isArray(a.reasons))reasons=reasons.concat(a.reasons)});var uniq=Array.from(new Set(reasons));return uniq.length?uniq.slice(0,2).join('、'):'模型确认条件未满足'}
function official(r){return r&&(r.productionActual==='UP'||r.productionActual==='DOWN')?r.productionActual:null}
function prod(r){return r&&(r.productionPrediction==='UP'||r.productionPrediction==='DOWN')?r.productionPrediction:null}
function pm(f){var facts=f&&f.facts||{};var v=facts.upMid;if(!facts.bookMappingReliable||!facts.bookRoundAligned||!Number.isFinite(Number(v)))return '不可用';v=Number(v);if(v<0||v>1)return '不可用';return (v>=0.5?'UP':'DOWN')+'（UP报价 '+(v*100).toFixed(1)+'%）'}
async function load(){
if(!e('waitVisibilityCard'))return;
try{
var response=await fetch('/api/round-stats?ts='+Date.now(),{cache:'no-store'});var j=await response.json();
if(!response.ok||!j||!j.ok)throw Error((j&&j.error)||'轮次统计服务不可用');
var rows=(j.records||[]).filter(function(r){return !!frozen(r)}).sort(function(a,b){return Number(b.roundStartMs)-Number(a.roundStartMs)});
var newest=(j.records||[]).slice().sort(function(a,b){return Number(b.roundStartMs)-Number(a.roundStartMs)})[0]||null;
var newestFrozen=frozen(newest),freshCandidate=candidate(newestFrozen),liveTrade=prod(newest);
e('wvTradeStatus').innerHTML=liveTrade?'生产已锁定：<span class="on">'+esc(dir(liveTrade))+'</span>':'生产：<span class="warn">WAIT（未触发下单信号）</span>';
e('wvPreview').innerHTML=freshCandidate?'<span class="on">'+esc(dir(freshCandidate.direction))+'</span> <span class="muted">（仅观察）</span>':'<span class="warn">WAIT（无候选）</span>';
e('wvPmSide').textContent=newestFrozen?pm(newestFrozen):'等待15秒冻结';
var windowRows=rows.slice(0,20);var eligible=windowRows.filter(function(r){return !!candidate(frozen(r))});var reviewed=eligible.filter(function(r){return !!official(r)});
var hits=reviewed.filter(function(r){return candidate(frozen(r)).direction===official(r)}).length;
e('wvCoverage').textContent=windowRows.length?(eligible.length+'/'+windowRows.length+' · '+(100*eligible.length/windowRows.length).toFixed(1)+'%'):'0轮';
e('wvHitRate').textContent=reviewed.length?(hits+'/'+reviewed.length+' · '+(100*hits/reviewed.length).toFixed(1)+'%'):'样本不足';
e('wvMeta').textContent='最后记录：'+(newest?tm(newest.roundStartMs):'尚无轮次')+' · 15秒快照：'+rows.length+'轮 · 候选为前瞻试验，不代表可交易信号'+(j.stale?' · ⚠ 缓存已过期':'');
e('wvBlockers').textContent=newestFrozen?'本轮未通过原因：'+reason(newestFrozen):'本轮15秒观察尚未完成；不会把未冻结的实时猜测计入候选准确率。';
e('wvRows').innerHTML=rows.slice(0,12).map(function(r){
var f=frozen(r),c=candidate(f),act=official(r),trade=prod(r);
var x=c?(act?(c.direction===act?'命中':'未中'):'待结算'):'无候选';
return '<tr style="border-top:1px solid #2b313d"><td style="padding:9px 6px">'+esc(tm(r.roundStartMs))+'</td><td style="padding:9px 6px">'+esc(c?dir(c.direction)+' · '+c.model:'WAIT')+'</td><td style="padding:9px 6px">'+esc(trade?dir(trade):'WAIT')+'</td><td style="padding:9px 6px">'+esc(act||'待结算')+'</td><td style="padding:9px 6px">'+esc(x)+'</td><td style="padding:9px 6px">'+esc(c?'-':reason(f))+'</td></tr>'
}).join('')||'<tr><td colspan="6" style="padding:10px 6px">暂无15秒前瞻快照</td></tr>';
}catch(error){if(e('wvTradeStatus'))e('wvTradeStatus').textContent='方向观察读取失败';if(e('wvBlockers'))e('wvBlockers').textContent=error&&error.message?error.message:String(error)}
}
function boot(){load();setInterval(load,3000)}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();</script>`;

const statsScript = `<script>(function(){
'use strict';
function e(i){return document.getElementById(i)}
function esc(v){return String(v==null?'-':v).replace(/[&<>\"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[c]})}
function tm(ms){if(!ms)return '-';try{return new Date(Number(ms)).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}catch(_){return '-'}}
function sourceName(x){var source=String(x&&x.productionSource||'');if(source==='SELECTIVE_V2_FAST8_PRIMARY')return 'Selective V2（8秒主策略）';if(source==='EDGE_RESCUE_FAST8_PRIMARY')return 'Edge Rescue（8秒兜底）';if(source==='SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION')return '低置信度行情方向（允许下单）';if(x&&x.productionModel==='zl_new_vip75')return x.productionFallbackUsed?'VIP75 无信息方向（非模型预测）':'zl_new_vip75 原版固定权重';if(x&&x.productionModel==='FLOW_BOOK_PROXY_V1')return '行情状态 FAST8（历史）';var v=String(x&&x.productionSource||'');if(v==='ZL_NEW_VIP75_PRIMARY'||v==='LOW_PRIORITY_15S_PM_LEAN_03_PRIMARY')return '已删除策略（历史记录）';if(v==='ZL_FAST8_65_PRIMARY')return 'ZL_FAST8_65（8秒）';if(v==='LOCK_QUALITY_SELECTIVE_V2_PRIMARY')return 'Selective V2（历史）';if(v==='SELECTIVE_V2_EDGE_RESCUE_PRIMARY')return '已删除策略（历史记录）';if(v==='PM_CURRENT25_SUPPORT08_15S_PRIMARY'||v==='CURRENT_03_PM_AGREE_15S_PRIMARY'||(v.indexOf('LOW_PRIORITY_15S_')===0&&v.endsWith('_PRIMARY'))){var model=x&&x.productionModel||v.replace(/^LOW_PRIORITY_15S_/,'').replace(/_15S_PRIMARY$/,'').replace(/_PRIMARY$/,'');if((globalThis.__active15sCandidateIds||[]).indexOf(model)<0)return '已删除的15秒历史策略';return (String(x&&x.productionFallbackReason||'').indexOf('AUTO_PROMOTED_')===0?'15秒现役 · ':'15秒历史试验 · ')+model}if(v==='SHADOW_CANDIDATE_PRIMARY')return 'Shadow(历史)';if(v==='SHADOW_V3_AUTOML_PRIMARY')return 'V3 AutoML(历史)';if(v==='V6_FALLBACK')return 'V6回退(历史)';return v||'WAIT'}
function badge(v){var x=String(v||'-');if(x==='UP')return '<span class="on">UP</span>';if(x==='DOWN')return '<span class="bad">DOWN</span>';if(x==='HIT')return '<span class="on">命中</span>';if(x==='MISS')return '<span class="bad">未命中</span>';if(x==='NO_DECISION')return '<span class="warn">WAIT</span>';if(x==='PENDING')return '<span class="warn">待结算</span>';return esc(x)}
function strengthLabel(x){
 var c=x&&x.productionConfidence;
 if(c!==null&&c!==undefined&&c!==''&&Number.isFinite(Number(c)))
   return Number(c).toFixed(3)+'（置信度）';
 var raw=x&&x.productionScore;
 if(raw!==null&&raw!==undefined&&raw!==''&&Number.isFinite(Number(raw)))
   return '评分 '+Math.abs(Number(raw)).toFixed(3)+(x.productionFallbackUsed?' · 低证据':'');
 return x&&x.productionFallbackUsed?'兜底无评分':'未提供';
}
async function getStats(){
var errMsg='';
try{
  var r=await fetch('/api/round-stats?ts='+Date.now(),{cache:'no-store'});
  var j=await r.json();
  if(r.ok&&j&&j.ok){
    try{localStorage.setItem('v6_official_round_stats_cache',JSON.stringify({at:Date.now(),data:j}))}catch(_){}
    return j
  }
  errMsg=(j&&j.error)||('proxy HTTP '+r.status)
}catch(x){
  errMsg=x&&x.message?x.message:String(x)
}
try{
  var c=JSON.parse(localStorage.getItem('v6_official_round_stats_cache')||'null');
  if(c&&c.data&&c.data.ok){
    c.data.stale=true;
    c.data.staleAgeMs=Date.now()-Number(c.at||0);
    c.data.proxyWarning=errMsg;
    return c.data
  }
}catch(_){}
throw new Error(errMsg||'统计服务暂不可用')
}

async function renderNoviceRoundStats(){
 var response=await fetch('/api/shadow-breakout20/novice-mix?ts='+Date.now(),{cache:'no-store'});
 var data=await response.json();
 if(!response.ok||!data||data.ok!==true||data.model!=='NOVICE_MIX_LOW_V1'||data.readOnly!==true)
  throw Error('新手混合独立统计不可用');
 if(globalThis.__orderModelStatsSelection!=='NOVICE_MIX_LOW_V1')return;
 var r=data.results||{},overall=r.overall||{},total=Number(r.rounds||0),locked=Number(r.locked||0),gaps=Number(r.dataGaps||0);
 var correct=Number(overall.hits||0),count=Number(overall.samples||0);
 e('rsAccuracy').innerHTML=count?'新手混合模型命中率：<span class="on">'+(correct*100/count).toFixed(2)+'%</span>':'新手混合模型命中率：暂无已结算';
 e('rsSettled').textContent=count;
 e('rsDecided').textContent=count;
 e('rsCorrect').innerHTML='<span class="on">'+correct+'</span>';
 e('rsWrong').innerHTML='<span class="bad">'+(count-correct)+'</span>';
 e('rsWait').textContent=gaps;
 e('rsCoverage').textContent=total?(locked*100/total).toFixed(2)+'%':'-';
 e('rsMeta').textContent='当前真实下单选择：NOVICE_MIX_LOW_V1 · 独立影子模型的预测与 Binance Prediction 官方结算配对；'
  +'有效已结算 '+count+' 轮，数据缺口 '+gaps+' 轮；不包含突破20%即可历史数据，不代表实际订单收益。';
 var rows=Array.isArray(data.recent)?data.recent.slice(0,30):[];
 e('rsRows').innerHTML=rows.length?rows.map(function(x){
  var valid=x.status==='LOCKED'||x.status==='PARTIAL_INPUT';
  var actual=x.actual==='UP'||x.actual==='DOWN'?x.actual:null;
  var predicted=valid?(x.direction==='UP'||x.direction==='DOWN'?x.direction:'WAIT'):'WAIT';
  var score=valid&&typeof x.score==='number'&&isFinite(x.score)?'评分 '+Math.abs(x.score).toFixed(3):'无有效行情评分';
  var delay=Number.isFinite(Number(x.lockedAt))&&Number.isFinite(Number(x.round))?((Number(x.lockedAt)-Number(x.round))/1000).toFixed(3)+'s':'-';
  var result=!valid?'数据缺口':!actual?'PENDING':(predicted===actual?'HIT':'MISS');
  return '<tr style="border-top:1px solid #2b313d">'+
   '<td style="padding:9px 6px">'+tm(x.round)+'</td>'+
   '<td style="padding:9px 6px">'+badge(predicted)+'</td>'+
   '<td style="padding:9px 6px">NOVICE_MIX_LOW_V1</td>'+
   '<td style="padding:9px 6px">'+esc(score)+'</td>'+
   '<td style="padding:9px 6px">'+esc(delay)+'</td>'+
   '<td style="padding:9px 6px">'+badge(actual||'PENDING')+'</td>'+
   '<td style="padding:9px 6px">'+badge(result)+'</td>'+
   '<td style="padding:9px 6px">'+(valid&&actual?'Binance Prediction 官方结算':valid?'等待官方结算':'未锁定有效行情，不计胜率')+'</td></tr>';
 }).join(''):'<tr><td colspan="8" style="padding:10px 6px;color:#8f98a8">新手混合模型尚无独立轮次记录</td></tr>';
}
async function load(){
if(globalThis.__orderModelStatsSelection==='NOVICE_MIX_LOW_V1'){
 try{await renderNoviceRoundStats()}
 catch(err){if(globalThis.__orderModelStatsSelection==='NOVICE_MIX_LOW_V1'){
  e('rsAccuracy').textContent='新手混合模型统计读取失败';
  e('rsMeta').textContent='独立模型接口错误：'+(err?.message||err)+'。未回退使用老模型数据。';
  e('rsRows').innerHTML='<tr><td colspan="8" style="padding:10px 6px">新模型数据暂不可用，不展示老模型记录</td></tr>';
 }}
 return;
}
try{
var j=await getStats();var h=j.health||{};
if(globalThis.__orderModelStatsSelection==='NOVICE_MIX_LOW_V1')return;
var selective8=j.productionSignalSourceMode==='SELECTIVE_V2_FAST8';
var activeCatalog=(Array.isArray(j.activeSignalModels)?j.activeSignalModels:[])
 .filter(function(m){return m&&m.active!==false&&m.id&&m.source&&m.version});
var all=(j.records||[]).filter(function(x){
 if(activeCatalog.length)return activeCatalog.some(function(m){
  return x.productionModel===m.id&&x.productionSource===m.source&&
   (x.productionModelVersion===m.version||x.productionModelVersion===m.version+':NO_INFORMATION');
 });
 // Compatibility for old tracker versions without activeSignalModels.
 return selective8
  ? x.productionModel==='SELECTIVE_V2_FAST8_PREWARM_V1' && x.productionModelVersion==='SELECTIVE_V2_FAST8_PREWARM_V1'
  : x.productionModel==='zl_new_vip75'&&j.activeProductionModel&&
    (x.productionModelVersion===j.activeProductionModel.version||x.productionModelVersion===j.activeProductionModel.version+':NO_INFORMATION');
});
function currentSourceName(x){
 var model=activeCatalog.find(function(m){return m.id===x.productionModel&&m.source===x.productionSource});
 return model?(model.name||model.id):sourceName(x);
}
function official(x){return x.productionActual==='UP'||x.productionActual==='DOWN'?x.productionActual:null}
function pred(x){return x.productionPrediction==='UP'||x.productionPrediction==='DOWN'?x.productionPrediction:null}
function derived(x){var p=pred(x),a=official(x);return !a?'PENDING':(!p?'NO_DECISION':(p===a?'HIT':'MISS'))}
var settled=all.filter(function(x){return !!official(x)&&(selective8||(x.productionFallbackUsed!==true&&x.productionModelVersion===j.activeProductionModel.version))}),decided=settled.filter(function(x){return !!pred(x)});
var correct=decided.filter(function(x){return derived(x)==='HIT'}).length,wrong=decided.filter(function(x){return derived(x)==='MISS'}).length;
var s={settledRounds:settled.length,decidedRounds:decided.length,correct:correct,wrong:wrong,noDecision:settled.length-decided.length,accuracyPct:decided.length?correct*100/decided.length:null,coveragePct:settled.length?decided.length*100/settled.length:null};
if(j.productionSignalSourceMode==='BREAKOUT20_FAST8'){
  // The official model ledger is longer than the generic 100-row UI snapshot.
  // If that ledger is unavailable, do not silently fall back to a partial figure.
  s={settledRounds:0,decidedRounds:0,correct:0,wrong:0,noDecision:0,accuracyPct:null,coveragePct:null};
  try{
    var verifiedResponse=await fetch('/api/shadow-breakout20/status?ts='+Date.now(),{cache:'no-store'});
    var verified=await verifiedResponse.json();
    var officialRate=verifiedResponse.ok&&verified.official?.available?verified.official.results:null;
    if(officialRate&&officialRate.overall){
      var v=officialRate.overall;
      s={settledRounds:v.samples,decidedRounds:v.samples,correct:v.hits,
         wrong:v.samples-v.hits,noDecision:0,
         accuracyPct:v.accuracy==null?null:v.accuracy*100,coveragePct:null};
    }
  }catch(_){}
}
e('rsAccuracy').innerHTML=s.accuracyPct==null?'新版模型命中率：-':'新版模型命中率：<span class="on">'+Number(s.accuracyPct).toFixed(2)+'%</span>';
e('rsSettled').textContent=s.settledRounds;e('rsDecided').textContent=s.decidedRounds;e('rsCorrect').innerHTML='<span class="on">'+s.correct+'</span>';e('rsWrong').innerHTML='<span class="bad">'+s.wrong+'</span>';e('rsWait').textContent=s.noDecision;e('rsCoverage').textContent=s.coveragePct==null?'-':Number(s.coveragePct).toFixed(2)+'%';
var settlement=j.settlementSource==='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY'?'Binance Prediction 官方结算':'结算源：'+(j.settlementSource||'-');
var status=h.lastSettlementError?' · 最近结算：'+h.lastSettlementError:'';
var stale=j.stale?' · ⚠ 当前显示缓存数据 '+Math.round((j.staleAgeMs||0)/1000)+'s':'';
var activeNames=activeCatalog.length?activeCatalog.map(function(m){return m.name||m.id}).join(' / ')
 :selective8?'Selective V2（8秒） / Edge Rescue（8秒） / 行情兜底'
 :j.activeProductionModel?.id||'暂无明确活跃模型';
e('rsMeta').textContent='当前生产：'+activeNames+' · '+settlement+
 (j.productionSignalSourceMode==='BREAKOUT20_FAST8'?' · 准确率采用 Railway 保留历史的本模型官方结算':' · 仅按活跃模型和版本的生产原始方向计分')+'，不代表反向订单成交或盈亏'+status+stale;
var a=all.slice(0,50);e('rsRows').innerHTML=a.length?a.map(function(x){var st=strengthLabel(x),dl=x.productionDelayMs==null?'-':(Number(x.productionDelayMs)/1000).toFixed(2)+'s',src=currentSourceName(x),actual=(x.productionActual==='UP'||x.productionActual==='DOWN')?x.productionActual:'PENDING',evidence=(x.resolutionEvidence&&String(x.resolutionEvidence).indexOf('OFFICIAL_')===0)?x.resolutionEvidence:'等待官方结算';return '<tr style="border-top:1px solid #2b313d"><td style="padding:9px 6px">'+tm(x.roundStartMs)+'</td><td style="padding:9px 6px">'+badge(x.productionPrediction)+'</td><td style="padding:9px 6px">'+esc(src)+'</td><td style="padding:9px 6px">'+st+'</td><td style="padding:9px 6px">'+dl+'</td><td style="padding:9px 6px">'+badge(actual)+'</td><td style="padding:9px 6px">'+badge(derived(x))+'</td><td style="padding:9px 6px">'+esc(evidence)+'</td></tr>'}).join(''):'<tr><td colspan="8" style="padding:10px 6px;color:#8f98a8">等待本策略首个轮次...</td></tr>';
}catch(err){if(e('rsAccuracy'))e('rsAccuracy').innerHTML='<span class="bad">统计读取失败</span>';if(e('rsMeta'))e('rsMeta').textContent=err&&err.message?err.message:'统计服务暂不可用'}}
globalThis.__refreshOrderModelRoundStats=load;
function boot(){load();setInterval(load,3000)}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();</script>`;


// One active production model. Retired and previously experimental signals are
// excluded from the current dashboard; immutable historical evidence stays in
// the tracker archive and is never rewritten or attributed to the new model.
const primaryCard = `<div class="c" id="activeFast8ModelCard">
<div class="k">当前生产信号模型 · 8秒版</div>
<div class="big" id="activeFast8Name">读取生产模型中...</div>
<div class="muted" id="activeFast8Desc">生产模型清单以后台返回结果为准</div>
<div style="border:1px solid #45546b;border-radius:12px;margin:12px 0;padding:12px;background:#111723">
  <div class="k" style="font-size:14px">实盘下单信号来源 · 模型选择</div>
  <select id="orderSignalModelSelect" aria-label="选择真实下单信号模型"
    style="width:100%;margin-top:8px;padding:12px 9px;background:#0d1016;color:#e6edf7;border:1px solid #435069;border-radius:9px;font-size:15px">
    <option value="BREAKOUT20_RSI_MACD_RANGE_V1">突破20%即可（现有生产信号）</option>
    <option value="NOVICE_MIX_LOW_V1">新手错误混合 NOVICE_MIX_LOW_V1</option>
  </select>
  <button id="orderSignalModelSave" type="button"
    style="margin-top:9px;padding:12px;background:#2b4158;color:#f1f5f9;border-radius:9px;font-size:14px">保存下单信号（需控制 PIN）</button>
  <div id="orderSignalModelState" class="muted" role="status" aria-live="polite" style="margin-top:8px">下单模型配置读取中...</div>
  <div id="orderSignalModelStats" class="muted" style="margin-top:5px">所选模型独立胜率读取中...</div>
  <div class="muted" style="margin-top:7px">两个模型的原始预测保持不变，锁定后各自独立以50%概率翻转正式信号（每轮固定）；最终下单继续走现有 UP/DOWN 正向/反向开关，不再二次随机。影子模型缺数据时不使用旧信号兜底。</div>
</div>
<div class="grid" style="margin-top:12px">
<div class="kv"><div class="k">模型原始预测</div><div class="v" id="activeFast8Direction">读取中</div></div>
<div class="kv"><div class="k">正式输出信号（50%随机翻转后）</div><div class="v" id="activeFast8EmittedDirection">读取中</div></div>
<div class="kv"><div class="k">下单信号（当前正向 / 反向）</div><div class="v" id="activeFast8OrderDirection">读取中</div></div>
<div class="kv"><div class="k">本模型原始方向官方命中率</div><div class="v" id="activeFast8Accuracy">-</div></div>
<div class="kv"><div class="k">历史原始方向的理论映射命中率（未计入随机翻转）</div><div class="v" id="activeFast8InverseAccuracy">-</div></div>
<div class="kv"><div class="k">开启方向理论命中 / 未中</div><div class="v" id="activeFast8InverseHitMiss">-</div></div>
<div class="kv"><div class="k">命中 / 未中</div><div class="v" id="activeFast8HitMiss">-</div></div>
<div class="kv"><div class="k">实际锁定轮次</div><div class="v" id="activeFast8Coverage">-</div></div>
</div>
<div class="k" style="margin-top:14px">当前活跃模型 · 已支持来源的 UP/DOWN 独立开关</div>
<div class="muted" style="margin-top:6px">每个来源分别选择 UP 正向/反向、DOWN 正向/反向；同方向互斥，均关闭则只显示预测、不下单。需控制 PIN，下一轮生效。</div>
<div id="directionModeChoices" style="margin-top:9px;display:grid;gap:8px"><div class="muted">后台配置读取中...</div></div>
<div id="directionModeMessage" role="status" aria-live="polite" class="muted" style="margin-top:8px"></div>
<div class="k" style="margin-top:14px">活跃信号模型 · 自动同步展示与分方向胜率</div>
<div style="overflow:auto;margin-top:8px;border:1px solid #2b313d;border-radius:10px">
<table style="width:100%;border-collapse:collapse;min-width:630px;font-size:12px">
<thead style="color:#8f98a8"><tr><th style="padding:9px 6px;text-align:left">信号来源</th><th>当前 UP/DOWN 模式</th><th>总胜率</th><th>UP胜率</th><th>DOWN胜率</th><th>按当前下单规则推算命中率</th></tr></thead>
<tbody id="sourceRateRows"><tr><td colspan="6" style="padding:10px 6px">统计读取中...</td></tr></tbody>
</table></div>
<div class="muted" style="margin-top:7px">按币安官方结算、历史模型原始预测及当前正/反向模式推算，未计入50%随机翻转。正式输出与实际下单需以当前状态和独立记录为准；这不是成交胜率或收益率。</div>
<div class="muted" id="activeFast8Note" style="margin-top:10px">仅统计当前生产模型版本的官方结算；任何低证据方向都不代表具有预测优势。</div>
</div>`;
const primaryScript = `<script>(function(){
'use strict';
function e(x){return document.getElementById(x)}
function pct(v){return v==null?'-':Number(v).toFixed(2)+'%'}
function escModel(v){return String(v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
var policy='',revision='';
var chosenOrderModel='BREAKOUT20_RSI_MACD_RANGE_V1';
var hasLiveOrderModelSelection=false;
var choiceRevision='',choiceBusy=false,choiceDirty=false,choiceReady=false;
function chosenModelName(model){
 return model==='NOVICE_MIX_LOW_V1'?'新手错误混合 NOVICE_MIX_LOW_V1':'突破20%即可';
}
async function loadOrderModelChoice(){
 if(choiceBusy||!e('orderSignalModelSelect')||!e('orderSignalModelState'))return;
 try{
  var response=await fetch('/api/order-signal-model?ts='+Date.now(),{cache:'no-store'});
  var data=await response.json();
  if(!response.ok||data.ok!==true||data.ready!==true)throw Error(data.error||'下单源配置未就绪');
  if(!Array.isArray(data.models)||!data.models.some(function(x){return x.id===data.model;}))
   throw Error('下单模型白名单无效');
  var previouslyChosen=chosenOrderModel;
  chosenOrderModel=data.model;choiceRevision=data.revision;choiceReady=true;
  globalThis.__orderModelStatsSelection=chosenOrderModel;
  hasLiveOrderModelSelection=true;
  if(previouslyChosen!==chosenOrderModel){
   if(typeof globalThis.__refreshOrderModelRoundStats==='function')globalThis.__refreshOrderModelRoundStats();
   load();
  }
  var select=e('orderSignalModelSelect');
  if(select&&!choiceDirty)select.value=chosenOrderModel;
  e('orderSignalModelState').textContent='当前真实下单信号：'+chosenModelName(chosenOrderModel)
    +(data.effectiveAfterRound!=null&&Date.now()<Number(data.effectiveAfterRound)+300000?' · 下一轮生效':' · 已生效')
    +' · 选择后请点保存';
  loadOrderModelStats();
 }catch(err){choiceReady=false;e('orderSignalModelState').textContent='下单信号配置读取失败，禁止切换：'+(err.message||err);}
}
async function loadOrderModelStats(){
 if(!e('orderSignalModelStats'))return;
 try{
  var endpoint=chosenOrderModel==='NOVICE_MIX_LOW_V1'?'/api/shadow-breakout20/novice-mix':'/api/shadow-breakout20/status';
  var response=await fetch(endpoint+'?ts='+Date.now(),{cache:'no-store'});
  var data=await response.json();
  if(!response.ok||data.ok!==true)throw Error('读取失败');
  var r=data.results||{},v=r.overall||{};
  e('orderSignalModelStats').textContent='独立模型统计：'+
   (v.samples?(Number(v.accuracy)*100).toFixed(2)+'% ('+v.hits+'/'+v.samples+')':'暂无已结算')+
   ' · UP '+(r.up&&r.up.samples?(Number(r.up.accuracy)*100).toFixed(2)+'%':'暂无')+
   ' · DOWN '+(r.down&&r.down.samples?(Number(r.down.accuracy)*100).toFixed(2)+'%':'暂无')+
   ' · 锁定 '+Number(r.locked||0)+' 轮';
 }catch(err){e('orderSignalModelStats').textContent='所选模型胜率读取失败（不改变下单选择）';}
}
async function saveOrderModelChoice(){
 if(!choiceReady||choiceBusy)return;
 var select=e('orderSignalModelSelect'),pin=e('pin');
 if(!select||!pin||!pin.value){e('orderSignalModelState').textContent='请先在页面上方填写控制 PIN';return}
 var next=select.value;
 if(!['BREAKOUT20_RSI_MACD_RANGE_V1','NOVICE_MIX_LOW_V1'].includes(next))return;
 if(next===chosenOrderModel){choiceDirty=false;e('orderSignalModelState').textContent='当前已是所选模型，无需切换';return}
 if(!window.confirm('确认从下一轮开始，用 '+chosenModelName(next)+' 作为真实下单信号？这会改变实际订单方向，当前轮次不切换。'))return;
 choiceBusy=true;
 var btn=e('orderSignalModelSave');if(btn)btn.disabled=true;
 try{
  var response=await fetch('/api/order-signal-model',{method:'POST',
   headers:{'content-type':'application/json'},
   body:JSON.stringify({model:next,expectedRevision:choiceRevision,pin:pin.value})});
  var data=await response.json();
  if(!response.ok||data.ok!==true)throw Error(data.error||'切换失败');
  choiceDirty=false;chosenOrderModel=data.model;choiceRevision=data.revision;choiceReady=true;
  globalThis.__orderModelStatsSelection=chosenOrderModel;
  if(typeof globalThis.__refreshOrderModelRoundStats==='function')globalThis.__refreshOrderModelRoundStats();
  load();
  e('orderSignalModelState').textContent='保存成功：'+chosenModelName(next)+'，下一轮才开始用于实盘下单';
  await loadOrderModelChoice();
 }catch(err){e('orderSignalModelState').textContent='保存失败：'+(err.message||err);choiceDirty=false;await loadOrderModelChoice();}
 finally{choiceBusy=false;if(btn)btn.disabled=false;}
}
function bindOrderModelChoice(){
 var sel=e('orderSignalModelSelect'),btn=e('orderSignalModelSave');
 if(sel)sel.addEventListener('change',function(){choiceDirty=true;e('orderSignalModelState').textContent='尚未保存：'+chosenModelName(sel.value)+'。保存后下一轮生效。'});
 if(btn)btn.addEventListener('click',saveOrderModelChoice);
}
var sources=[
 {id:'SELECTIVE_V2_FAST8_PRIMARY',name:'Selective V2（主策略）',modes:{UP:'OFF',DOWN:'OFF'}},
 {id:'EDGE_RESCUE_FAST8_PRIMARY',name:'Edge Rescue（兜底）',modes:{UP:'OFF',DOWN:'OFF'}},
 {id:'SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION',name:'低置信度行情兜底',modes:{UP:'OFF',DOWN:'OFF'}}
];
// The tracker catalog is authoritative. The legacy three-source setting
// remains intact on the control service, but retired/inactive sources are hidden.
var activeCatalog=[];
function activeSourceName(source){
 var entry=activeCatalog.find(function(m){return m.source===source});
 if(chosenOrderModel==='NOVICE_MIX_LOW_V1'&&source==='SELECTIVE_V2_FAST8_PRIMARY'&&entry)
  return '新手错误混合 NOVICE_MIX_LOW_V1';
 return entry?(entry.name||entry.id):null;
}
var directionModeReady=false,directionModeBusy=false;
function syncActiveCatalog(j){
 var raw=Array.isArray(j.activeSignalModels)?j.activeSignalModels:[];
 if(!raw.length&&j.productionSignalSourceMode==='SELECTIVE_V2_FAST8')
   raw=sources.map(function(s){return {id:'SELECTIVE_V2_FAST8_PREWARM_V1',source:s.id,name:s.name}});
 if(!raw.length&&j.activeProductionModel)
   raw=[{id:j.activeProductionModel.id,source:j.activeProductionModel.source,name:j.activeProductionModel.id}];
 activeCatalog=raw.filter(function(x){return x&&typeof x.id==='string'&&x.id&&
   typeof x.source==='string'&&x.source&&x.active!==false});
 renderDirectionModes();
}
function modeLabel(v){return v==='FORWARD'?'正向':v==='INVERSE'?'反向':'关闭'}
function validateModes(modes){
 if(!modes||Object.keys(modes).length!==3)throw Error('后台配置来源不完整');
 sources.forEach(function(src){
   var m=modes[src.id];
   if(!m||Object.keys(m).length!==2||['UP','DOWN'].some(function(side){return !['FORWARD','INVERSE','OFF'].includes(m[side])}))
     throw Error('后台方向配置无效：'+src.name);
 });
}
function renderDirectionModes(){
 var target=e('directionModeChoices');if(!target)return;
 var visible=sources.filter(function(src){return activeCatalog.some(function(m){return m.source===src.id})});
 target.innerHTML=visible.length?visible.map(function(src){
  var i=sources.indexOf(src);
  return '<div style="background:#10141c;padding:12px;border-radius:10px;min-width:0">'+
    '<div style="font-size:13px;font-weight:700;margin-bottom:8px">'+escModel(activeSourceName(src.id)||src.name)+'</div>'+
    ['UP','DOWN'].map(function(side){
     return '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:7px;margin:6px 0">'+
       '<div style="font-size:12px;min-width:80px"><strong>'+side+'</strong>：'+(directionModeReady?modeLabel(src.modes[side]):'未就绪')+'</div>'+
       '<div style="display:flex;gap:6px;flex-wrap:wrap">'+['FORWARD','INVERSE'].map(function(mode){
         var selected=directionModeReady&&src.modes[side]===mode;
         return '<button type="button" data-dir-index="'+i+'" data-dir-side="'+side+'" data-dir-mode="'+mode+'" aria-pressed="'+selected+'" '+
           (!directionModeReady||directionModeBusy?'disabled ':'')+
           'style="width:auto;min-width:72px;margin:0;padding:9px 12px;font-size:12px;border:1px solid '+(selected?'#3ddc84':'#435069')+
           ';background:'+(selected?'#17392b':'#222838')+';color:'+(selected?'#7ff0b0':'#b6c0d0')+'">'+side+' '+modeLabel(mode)+'</button>';
       }).join('')+'</div></div>';
    }).join('')+'</div>';
 }).join(''):'<div class="muted">当前活跃模型没有匹配的旧版来源开关；不显示已暂停的三类来源，原有后台方向规则保持不变。</div>';
 if(target.querySelectorAll)target.querySelectorAll('button').forEach(function(btn){
   btn.addEventListener('click',function(){setDirectionModeFromUI(Number(btn.getAttribute('data-dir-index')),
     btn.getAttribute('data-dir-side'),btn.getAttribute('data-dir-mode'))});
 });
}
function acceptSettings(state){
 validateModes(state.modes);
 if(typeof state.revision!=='string'||!state.revision||typeof state.policy!=='string')throw Error('缺少配置版本');
 sources.forEach(function(src){src.modes={UP:state.modes[src.id].UP,DOWN:state.modes[src.id].DOWN}});
 revision=state.revision;policy=state.policy;directionModeReady=true;
 renderDirectionModes();
}
async function loadDirectionModes(){
 if(directionModeBusy)return;
 try{
  var response=await fetch('/api/direction-mode?ts='+Date.now(),{cache:'no-store'});
  var state=await response.json();
  if(!response.ok||!state.ok)throw Error(state.error||'方向配置未就绪');
  acceptSettings(state);
  load();
 }catch(err){
  directionModeReady=false;policy='';revision='';renderDirectionModes();
  var target=e('directionModeMessage');if(target)target.textContent='方向配置读取失败（开关已禁用）：'+(err.message||err);
 }
}
async function setDirectionModeFromUI(index,side,selectedMode){
 if(!directionModeReady||directionModeBusy||!sources[index]||!['UP','DOWN'].includes(side)||
    !['FORWARD','INVERSE'].includes(selectedMode))return;
 var src=sources[index],mode=src.modes[side]===selectedMode?'OFF':selectedMode;
 // A source identifier may be reused by a newer model. Never present its old
 // source alias as the production model name, nor edit a retired source.
 var modelName=activeSourceName(src.id);
 if(!modelName){e('directionModeMessage').textContent='该信号来源已非当前活跃模型，请刷新后重试';return}
 var pin=e('pin');
 if(!pin||!pin.value){e('directionModeMessage').textContent='请先在上方填写控制 PIN';return}
 var description=mode==='OFF'?'关闭该预测方向自动下单':'切换到'+modeLabel(mode)+'下单';
 if(!window.confirm('将 '+modelName+' 的 '+side+' '+description+'？下一轮生效。'))return;
 directionModeBusy=true;renderDirectionModes();e('directionModeMessage').textContent='保存中...';
 try{
  var response=await fetch('/api/direction-mode',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({source:src.id,direction:side,mode:mode,expectedRevision:revision,pin:pin.value})});
  var data=await response.json();
  if(!response.ok||!data.ok)throw Error((response.status===409?'配置冲突，请刷新重试：':'')+(data.error||'保存失败'));
  acceptSettings(data);
  e('directionModeMessage').textContent='保存成功，下一轮生效：'+(activeSourceName(src.id)||modelName)+' '+side+' → '+modeLabel(mode);
  updateOrderSignal();load();
 }catch(err){
  directionModeReady=false;policy='';revision='';
  e('directionModeMessage').textContent='保存失败：'+(err.message||err);
 }finally{
  directionModeBusy=false;renderDirectionModes();
  // Discard any stale local state after a conflict or failed persistence.
  if(!directionModeReady)await loadDirectionModes();
 }
}
window.setDirectionModeFromUI=setDirectionModeFromUI;
function bySource(z){return sources.find(function(src){return src.id===z.productionSource})||null}
function orderSide(z){
 var pred=z.productionPrediction,src=bySource(z);
 if(!directionModeReady||!src||!['UP','DOWN'].includes(pred))return null;
 var mode=src.modes[pred];
 if(mode==='OFF')return null;
 return mode==='INVERSE'?(pred==='UP'?'DOWN':'UP'):mode==='FORWARD'?pred:null;
}

async function renderNovicePrimary(){
 var response=await fetch('/api/shadow-breakout20/novice-mix?ts='+Date.now(),{cache:'no-store'});
 var data=await response.json();
 if(!response.ok||data?.ok!==true||data.model!=='NOVICE_MIX_LOW_V1'||data.readOnly!==true)throw Error('独立新手模型数据不可用');
 if(chosenOrderModel!=='NOVICE_MIX_LOW_V1')return;
 var r=data.results||{},all=r.overall||{},n=Number(all.samples||0),h=Number(all.hits||0);
 var now=Math.floor(Date.now()/300000)*300000,latest=data.latest||{},valid=(latest.status==='LOCKED'||latest.status==='PARTIAL_INPUT')&&latest.round===now;
 e('activeFast8Name').textContent='新手错误混合 NOVICE_MIX_LOW_V1';
 e('activeFast8Desc').textContent='BTC 5分钟 · 独立影子预测 · 8秒内锁定 · 页面仅显示当前选择模型的历史；未验证有稳定优势';
 e('activeFast8Direction').textContent=valid?latest.direction:'本轮未锁定 / 暂不可下单';
 e('activeFast8Accuracy').textContent=n?pct(h*100/n):'暂无已确认官方结算';
 e('activeFast8HitMiss').textContent=h+' / '+(n-h)+'（'+n+'轮）';
 e('activeFast8Coverage').textContent=Number(r.locked||0)+' 轮锁定 · '+Number(r.dataGaps||0)+' 轮数据缺口';
 var src=sources.find(function(x){return x.id==='SELECTIVE_V2_FAST8_PRIMARY'})||null;
 var rows=Array.isArray(data.recent)?data.recent:[];
 var settled=rows.filter(function(x){return (x.status==='LOCKED'||x.status==='PARTIAL_INPUT')&&(x.actual==='UP'||x.actual==='DOWN')});
 var allowed=settled.filter(function(x){return directionModeReady&&src&&src.modes[x.direction]!=='OFF'});
 var mappedHits=allowed.filter(function(x){var mode=src.modes[x.direction];var direction=mode==='INVERSE'?(x.direction==='UP'?'DOWN':'UP'):x.direction;return direction===x.actual;}).length;
 e('activeFast8InverseAccuracy').textContent=allowed.length?pct(mappedHits*100/allowed.length):'可用样本不足';
 e('activeFast8InverseHitMiss').textContent=mappedHits+' / '+(allowed.length-mappedHits)+'（仅最近'+rows.length+'条记录中的'+allowed.length+'轮）';
 function sideText(k){var p=r[k]||{};return p.samples?p.hits+'/'+p.samples+' · '+pct(p.hits*100/p.samples):'暂无已确认官方结果';}
 var modes=src&&directionModeReady?'UP：'+modeLabel(src.modes.UP)+' / DOWN：'+modeLabel(src.modes.DOWN):'方向开关未就绪';
 var part=e('sourceRateRows');
 if(part)part.innerHTML='<tr style="border-top:1px solid #2b313d"><td style="padding:9px 6px">新手错误混合 NOVICE_MIX_LOW_V1</td>'+
 '<td style="text-align:center">'+escModel(modes)+'</td>'+
 '<td style="text-align:center">'+(n?h+'/'+n+' · '+pct(100*h/n):'暂无已确认结果')+'</td>'+
 '<td style="text-align:center">'+sideText('up')+'</td>'+
 '<td style="text-align:center">'+sideText('down')+'</td>'+
 '<td style="text-align:center">'+(allowed.length?mappedHits+'/'+allowed.length+' · '+pct(100*mappedHits/allowed.length):'可用样本不足')+'</td></tr>';
 e('activeFast8Note').textContent='当前下单选择：NOVICE_MIX_LOW_V1 · 新模型官方结算 '+n+
   ' 轮 · 反向理论映射仅基于新模型最近'+rows.length+'条可用记录和当前开关，不代表真实订单盈亏 · 不含突破20%即可历史结算。';
 renderDirectionModes();
}
function load(){
 if(chosenOrderModel==='NOVICE_MIX_LOW_V1'){
  renderNovicePrimary().catch(function(err){
   if(chosenOrderModel!=='NOVICE_MIX_LOW_V1')return;
   e('activeFast8Name').textContent='新手错误混合 NOVICE_MIX_LOW_V1';
   e('activeFast8Accuracy').textContent='独立统计暂不可用';
   e('activeFast8HitMiss').textContent='-';
   e('activeFast8InverseAccuracy').textContent='-';
   e('activeFast8InverseHitMiss').textContent='-';
   e('activeFast8Coverage').textContent='-';
   e('activeFast8Direction').textContent='新模型数据未就绪';
   e('sourceRateRows').innerHTML='<tr><td colspan="6" style="padding:10px 6px">新模型数据不可用，禁止显示老模型胜率</td></tr>';
   e('activeFast8Note').textContent=err?.message||'新模型统计读取失败';
  });
  return;
 }
 fetch('/api/round-stats?ts='+Date.now(),{cache:'no-store'})
 .then(function(r){if(!r.ok)throw Error('统计接口 HTTP '+r.status);return r.json()})
 .then(async function(j){
  if(!j||!j.ok)throw Error('生产统计不可用');
  if(chosenOrderModel==='NOVICE_MIX_LOW_V1')return;
  var breakout20Official=null;
  if(j.productionSignalSourceMode==='BREAKOUT20_FAST8'){
   try{
    var officialResponse=await fetch('/api/shadow-breakout20/status?ts='+Date.now(),{cache:'no-store'});
    var officialBody=await officialResponse.json();
    if(officialResponse.ok&&officialBody.official?.available)
      breakout20Official=officialBody.official.results;
   }catch(_){}
  }
  if(chosenOrderModel==='NOVICE_MIX_LOW_V1')return;
  var currentMode=j.productionSignalSourceMode==='SELECTIVE_V2_FAST8';
  syncActiveCatalog(j);
  var version='SELECTIVE_V2_FAST8_PREWARM_V1';
  var model=j.activeProductionModel;
  var records=(j.records||[]).filter(function(z){
   return currentMode
    ?z.productionModel===version&&z.productionModelVersion===version
    :model&&z.productionModel===model.id&&(z.productionModelVersion===model.version||z.productionModelVersion===model.version+':NO_INFORMATION');
  });
  var now=Math.floor(Date.now()/300000)*300000;
  var current=records.find(function(z){return Number(z.roundStartMs)===now});
  var dir=current&&['UP','DOWN'].includes(current.productionPrediction)?current.productionPrediction:'待本轮锁定';
  if(current&&current.productionSource==='SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION'){
   var src=bySource(current);
   dir+='（低置信度 · '+(src&&directionModeReady?modeLabel(src.modes[current.productionPrediction]):'未就绪')+'）';
  }
  e('activeFast8Name').textContent=activeCatalog.length
   ?activeCatalog.map(function(m){return m.name||m.id}).join(' + '):'当前没有活跃信号模型';
  e('activeFast8Desc').textContent='BTC 5分钟 · 8秒截止 · 模型列表由生产服务自动同步；低证据方向不代表预测优势；非活跃来源隐藏';
  if(chosenOrderModel!=='NOVICE_MIX_LOW_V1')e('activeFast8Direction').textContent=dir;
  var settled=records.filter(function(z){return z.productionActual==='UP'||z.productionActual==='DOWN'});
  var decided=settled.filter(function(z){return z.productionPrediction==='UP'||z.productionPrediction==='DOWN'});
  var hits=decided.filter(function(z){return z.productionPrediction===z.productionActual}).length;
  var misses=decided.length-hits;
  var mappedEligible=decided.filter(function(z){return orderSide(z)!==null});
  var mappedHits=mappedEligible.filter(function(z){return orderSide(z)===z.productionActual}).length;
  var mappedMisses=mappedEligible.length-mappedHits;
  var officialTotal=breakout20Official?.overall;
  e('activeFast8Accuracy').textContent=j.productionSignalSourceMode==='BREAKOUT20_FAST8'
   ?(officialTotal&&officialTotal.samples?pct(100*officialTotal.hits/officialTotal.samples):'暂无已确认官方结果')
   :(decided.length?pct(100*hits/decided.length):'尚无新结算');
  e('activeFast8InverseAccuracy').textContent=mappedEligible.length?pct(100*mappedHits/mappedEligible.length):'样本不足';
  e('activeFast8InverseHitMiss').textContent=mappedEligible.length?(mappedHits+' / '+mappedMisses+'（'+mappedEligible.length+'轮）'):'-';
  e('activeFast8HitMiss').textContent=j.productionSignalSourceMode==='BREAKOUT20_FAST8'
   ?(officialTotal?officialTotal.hits+' / '+(officialTotal.samples-officialTotal.hits):'官方数据暂不可用')
   :hits+' / '+misses;
  var locked=records.filter(function(z){return z.productionPrediction==='UP'||z.productionPrediction==='DOWN'}).length;
  e('activeFast8Coverage').textContent=j.productionSignalSourceMode==='BREAKOUT20_FAST8'
   ?(breakout20Official?breakout20Official.locked+' 轮（Railway 已保留）':'官方数据暂不可用')
   :locked+' 轮'+(records.length?' · '+pct(100*locked/records.length):' · 样本不足');
  var fallback=records.filter(function(z){return z.productionSource==='SELECTIVE_V2_FAST8_UNVERIFIED_DIRECTION'}).length;
  var rows=e('sourceRateRows');
  if(rows)rows.innerHTML=activeCatalog.length?activeCatalog.map(function(item){
   var matched=sources.find(function(src){return src.id===item.source});
   var src=matched||{id:item.source,name:item.name||item.id,modes:{UP:'OFF',DOWN:'OFF'}};
   var group=decided.filter(function(z){return z.productionSource===item.source && z.productionModel===item.id});
   var rawHits=group.filter(function(z){return z.productionPrediction===z.productionActual}).length;
   var allowed=group.filter(function(z){return orderSide(z)!==null});
   var orderHits=allowed.filter(function(z){return orderSide(z)===z.productionActual}).length;
   var total=group.length;
   if(j.productionSignalSourceMode==='BREAKOUT20_FAST8'){
     total=officialTotal?.samples??0;rawHits=officialTotal?.hits??0;
   }
   function sideRate(side){
    if(j.productionSignalSourceMode==='BREAKOUT20_FAST8'){
      var pair=breakout20Official?.[side.toLowerCase()];
      return pair&&pair.samples?pair.hits+'/'+pair.samples+' · '+pct(pair.hits*100/pair.samples):'暂无已确认官方结果';
    }
    var part=group.filter(function(z){return z.productionPrediction===side});
    var correct=part.filter(function(z){return z.productionPrediction===z.productionActual}).length;
    return part.length?correct+'/'+part.length+' · '+pct(correct*100/part.length):'样本不足（0轮）';
   }
   return '<tr style="border-top:1px solid #2b313d">'+
    '<td style="padding:9px 6px">'+escModel(item.name||item.id)+'</td>'+
    '<td style="text-align:center">'+(matched
       ? 'UP：'+(directionModeReady?modeLabel(src.modes.UP):'未就绪')+' / DOWN：'+(directionModeReady?modeLabel(src.modes.DOWN):'未就绪')
       : '无独立来源开关')+'</td>'+
    '<td style="text-align:center">'+(total?rawHits+'/'+total+' · '+pct(rawHits*100/total):'样本不足（0轮）')+'</td>'+
    '<td style="text-align:center">'+sideRate('UP')+'</td>'+
    '<td style="text-align:center">'+sideRate('DOWN')+'</td>'+
    '<td style="text-align:center">'+(allowed.length?orderHits+'/'+allowed.length+' · '+pct(orderHits*100/allowed.length):'样本不足（0轮）')+'</td></tr>';
  }).join(''):'<tr><td colspan="6" style="padding:10px 6px">生产服务暂无活跃模型，不显示历史或退役信号</td></tr>';
  e('activeFast8Note').textContent='当前活跃 '+activeCatalog.length+' 类来源 · 已结算方向 '+(j.productionSignalSourceMode==='BREAKOUT20_FAST8'?(officialTotal?.samples??0):decided.length)+
   ' 轮 · 低置信度方向 '+fallback+' 轮 · 仅当前模型版本与币安官方结算计分；正反向理论映射仍基于页面最近100轮，不代表实际成交'+
   (j.stale?' · 统计缓存可能过期':'');
 }).catch(function(err){e('activeFast8Direction').textContent='状态未确认';e('activeFast8Note').textContent=err&&err.message?err.message:String(err)})
}
function updateOrderSignal(){
 fetch('/api/status?ts='+Date.now(),{cache:'no-store'})
 .then(function(r){if(!r.ok)throw Error('交易控制状态 HTTP '+r.status);return r.json()})
 .then(function(j){
  var target=e('activeFast8OrderDirection');if(!target)return;
  var expected=Math.floor(Date.now()/300000)*300000,live=j.signal||{};
  var locked=live.status==='LOCKED'&&Number(live.round)===expected;
  var emitted=e('activeFast8EmittedDirection');
  if(emitted)emitted.textContent=locked?
    live.direction+'（'+(live.randomFlipApplied?'本轮随机翻转':'本轮保留原方向')+'）':'本轮未锁定';
  var ready=directionModeReady&&j.directionModeReady&&locked&&j.orderDirectionPolicy===policy;
  // Model-raw stats remain independent; this poll owns emitted and order side.
  if(!ready){target.textContent='未锁定或配置未就绪';return}
  var mode=j.orderMappingMode,src=sources.find(function(s){return s.id===j.orderProductionSource});
  if(j.orderSignal===null){target.textContent='不下单（'+(mode==='OFF'?'该方向已关闭':'不可执行')+'）';return}
  var expectedSide=mode==='INVERSE'?(live.direction==='UP'?'DOWN':'UP'):mode==='FORWARD'?live.direction:null;
  target.textContent=j.orderSignal===expectedSide?
    (j.orderSignal+'（'+modeLabel(mode)+' · '+chosenModelName(chosenOrderModel)+'）'):'方向映射校验失败';
 }).catch(function(){var target=e('activeFast8OrderDirection');if(target)target.textContent='下单方向状态不可用'})
}
function boot(){bindOrderModelChoice();loadOrderModelChoice();renderDirectionModes();loadDirectionModes();load();updateOrderSignal();
 setInterval(load,3000);setInterval(updateOrderSignal,2000);setInterval(loadDirectionModes,5000);
 setInterval(loadOrderModelChoice,8000)}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot()
})();</script>`;

// Keep live statistics updates from resizing the narrow mobile viewport.
// This is injected into the control page only; backend signal/order logic is untouched.
const layoutStabilityStyle = `<style id="dashboard-layout-stability">
.w,.w>.c{min-width:0;box-sizing:border-box}
.w .grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.w .grid>.kv,.w .kv>.v,.w .kv>.k,.w .big,.w .muted{min-width:0;overflow-wrap:anywhere}
.w .grid>.kv{box-sizing:border-box}
#activeFast8ModelCard select{max-width:100%;min-width:0;box-sizing:border-box}
#activeFast8Direction,#activeFast8EmittedDirection,#activeFast8OrderDirection{min-height:3.5em;line-height:1.4}
@media(max-width:540px){.w>.c{padding:14px}.w .kv{padding:10px}}
</style>`;

function injectStats(html) {
  if (html.includes('id="roundStatsCard"')) return html;
  const marker = '<div id="riskControlsAnchor"></div>';
  let out = html.includes(marker) ? html.replace(marker, `${primaryCard}${statsCard}${shadowCard}${marker}`) : html.replace('</body>', `${primaryCard}${statsCard}${shadowCard}</body>`);
  out = out.replace('</head>', layoutStabilityStyle+'</head>');
  return out.replace('</body>', `${primaryScript}${statsScript}${shadowScript}</body>`);
}

let child = null;
let stopping = false;
function startInner() {
  child = spawn(process.execPath, ['control-shell.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(INNER_PANEL_PORT), INNER_CONTROL_PORT: String(process.env.INNER_CONTROL_PORT || 3001) },
    stdio: 'inherit',
  });
  log('inner_panel_started', { pid: child.pid, port: INNER_PANEL_PORT });
  child.on('exit', (code, signal) => { log('inner_panel_exited', { code, signal }); child = null; if (!stopping) setTimeout(startInner, 500); });
}

function proxyInner(req, res, transformHtml = false) {
  const headers = { ...req.headers, host: `127.0.0.1:${INNER_PANEL_PORT}` };
  const p = http.request({ hostname: '127.0.0.1', port: INNER_PANEL_PORT, path: req.url, method: req.method, headers }, innerRes => {
    if (!transformHtml) { res.writeHead(innerRes.statusCode || 502, innerRes.headers); innerRes.pipe(res); return; }
    const chunks = [];
    innerRes.on('data', c => chunks.push(c));
    innerRes.on('end', () => {
      const body = injectStats(Buffer.concat(chunks).toString('utf8'));
      const outHeaders = { ...innerRes.headers }; delete outHeaders['content-length']; outHeaders['content-type'] = 'text/html; charset=utf-8'; outHeaders['cache-control'] = 'no-store';
      res.writeHead(innerRes.statusCode || 200, outHeaders); res.end(body);
    });
  });
  p.on('error', err => { res.writeHead(502, { 'content-type':'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok:false, error:`内部控制台未就绪：${err.message}` })); });
  req.pipe(p);
}

async function fetchStatsOrigin(origin, timeoutMs, label) {
  const startedAt = Date.now();
  try {
    const r = await fetch(origin + '/api/round-stats', {
      cache:'no-store',
      signal:AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    if (!r.ok) throw new Error('HTTP_' + r.status);
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('INVALID_JSON'); }
    if (!json?.ok) throw new Error(json?.error || 'NOT_OK');
    log('stats_origin_ok', { label, origin, latencyMs:Date.now()-startedAt });
    return { ok:true, json };
  } catch (err) {
    log('stats_origin_failed', { label, origin, latencyMs:Date.now()-startedAt, error:err?.message || String(err) });
    return { ok:false, error:err?.message || String(err) };
  }
}

async function refreshStatsCache() {
  if (statsRefreshPromise) return statsRefreshPromise;
  statsRefreshPromise = (async () => {
    const primary = await fetchStatsOrigin(ROUND_STATS_ORIGIN, STATS_PROXY_PRIMARY_TIMEOUT_MS, 'cache_primary');
    if (primary.ok) {
      lastGoodStats = primary.json;
      lastGoodStatsAt = Date.now();
      statsRefreshLastError = null;
      return true;
    }

    if (ROUND_STATS_PUBLIC_ORIGIN && ROUND_STATS_PUBLIC_ORIGIN !== ROUND_STATS_ORIGIN) {
      const fallback = await fetchStatsOrigin(ROUND_STATS_PUBLIC_ORIGIN, STATS_PROXY_FALLBACK_TIMEOUT_MS, 'cache_public_fallback');
      if (fallback.ok) {
        lastGoodStats = fallback.json;
        lastGoodStatsAt = Date.now();
        statsRefreshLastError = null;
        return true;
      }
      statsRefreshLastError = fallback.error || primary.error;
    } else {
      statsRefreshLastError = primary.error;
    }
    return false;
  })();

  try {
    return await statsRefreshPromise;
  } finally {
    statsRefreshPromise = null;
  }
}

async function proxyTrainingStatus(res) {
  const origins = [ROUND_STATS_ORIGIN, ROUND_STATS_PUBLIC_ORIGIN].filter((v, i, a) => v && a.indexOf(v) === i);
  let lastError = null;
  for (const origin of origins) {
    try {
      const r = await fetch(origin + '/api/training-status', {
        cache:'no-store',
        signal:AbortSignal.timeout(STATS_PROXY_FALLBACK_TIMEOUT_MS),
      });
      const text = await r.text();
      if (!r.ok) throw new Error('HTTP_' + r.status);
      let json;
      try { json = JSON.parse(text); } catch { throw new Error('INVALID_JSON'); }
      if (!json?.ok) throw new Error(json?.error || 'NOT_OK');
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
      return res.end(JSON.stringify(json));
    } catch (err) {
      lastError = err?.message || String(err);
      log('training_status_proxy_failed', { origin, error:lastError });
    }
  }
  res.writeHead(502, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
  return res.end(JSON.stringify({ ok:false, error:lastError || 'TRAINING_STATUS_UNAVAILABLE' }));
}

async function proxyStats(res) {
  // UI reads the panel-local cache instead of hitting V2 for every browser/tab.
  if (!lastGoodStats) await refreshStatsCache();

  if (lastGoodStats) {
    const age = Date.now() - lastGoodStatsAt;
    const body = age > 5000
      ? { ...lastGoodStats, stale:true, staleAgeMs:age, proxyWarning:statsRefreshLastError || null }
      : lastGoodStats;
    res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
    return res.end(JSON.stringify(body));
  }

  res.writeHead(502, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
  return res.end(JSON.stringify({ ok:false, error:statsRefreshLastError || 'ROUND_STATS_CACHE_NOT_READY' }));
}


// Read-only connectivity probe; disabled unless explicitly enabled on Railway.
// Does not access account balances, place orders, or expose credentials.
async function binanceOfficialReadOnlyProbe(req, res) {
  if (process.env.BINANCE_OFFICIAL_PROBE_ENABLED !== 'true') {
    res.writeHead(404, {'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify({ok:false,error:'PROBE_DISABLED'}));
  }
  const probeToken = process.env.BINANCE_OFFICIAL_PROBE_TOKEN;
  const providedToken = req.headers['x-audit-probe-token'];
  if (!probeToken || typeof providedToken !== 'string' ||
      providedToken.length !== probeToken.length ||
      !(await import('node:crypto')).timingSafeEqual(Buffer.from(providedToken), Buffer.from(probeToken))) {
    res.writeHead(403, {'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify({ok:false,error:'FORBIDDEN'}));
  }
  const key = process.env.BINANCE_PREDICTION_API_KEY;
  const secret = process.env.BINANCE_PREDICTION_API_SECRET;
  if (!key || !secret) {
    res.writeHead(503, {'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify({ok:false,error:'CREDENTIALS_NOT_CONFIGURED'}));
  }
  const crypto = await import('node:crypto');
  let topicId = null;
  try {
    const statsResponse = await fetch('http://127.0.0.1:' + PORT + '/api/round-stats', {signal:AbortSignal.timeout(6000)});
    const stats = await statsResponse.json();
    const row = (Array.isArray(stats.records) ? stats.records : []).find(
      x => (x.officialSettlementAudit?.marketTopicId || x.predictionMarketTopicId) &&
           (x.productionPrediction === 'UP' || x.productionPrediction === 'DOWN'));
    topicId = row?.officialSettlementAudit?.marketTopicId || row?.predictionMarketTopicId || null;
  } catch {}
  if (!topicId) {
    res.writeHead(503, {'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify({ok:false,error:'NO_PERSISTED_PRODUCTION_TOPIC_ID'}));
  }
  const params = new URLSearchParams({marketTopicId:String(topicId),timestamp:String(Date.now()),recvWindow:'5000'});
  const signature = crypto.createHmac('sha256',secret).update(params.toString()).digest('hex');
  try {
    const response = await fetch('https://api.binance.com/sapi/v1/w3w/wallet/prediction/market/detail?' + params + '&signature=' + signature, {
      headers:{'X-MBX-APIKEY':key}, signal:AbortSignal.timeout(8000), cache:'no-store'
    });
    const body = await response.text();
    let parsed; try { parsed = JSON.parse(body); } catch {}
    // Never expose Binance response bodies, signatures, headers or secret values.
    const result = {ok:response.ok,httpStatus:response.status,
      binanceCode:typeof parsed?.code==='number'?parsed.code:null,
      officialTopicReturned:parsed?.marketTopicId != null || parsed?.data?.marketTopicId != null,
      responseTopKeys:parsed && typeof parsed==='object'?Object.keys(parsed).slice(0,16):[],
      responseDataKeys:parsed?.data && typeof parsed.data==='object'?Object.keys(parsed.data).slice(0,20):[],
      responseDataType:Array.isArray(parsed?.data)?'array':typeof parsed?.data,
      checkedAt:new Date().toISOString()};
    res.writeHead(response.ok?200:502,{'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(502,{'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify({ok:false,error:err?.name==='TimeoutError'?'TIMEOUT':'NETWORK_ERROR'}));
  }
}

startInner();
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/internal/binance-official-probe') return binanceOfficialReadOnlyProbe(req,res);
  if (req.method === 'GET' && url.pathname === '/api/shadow-breakout20/status') return proxyShadowStatus(res);
  if (req.method === 'GET' && url.pathname === '/api/shadow-breakout20/novice-mix') return noviceMixShadow.handler(res);
  if (req.method === 'GET' && url.pathname === '/api/postflip-official-stats') {
    const model=url.searchParams.get('model');
    if(!['BREAKOUT20_RSI_MACD_RANGE_V1','NOVICE_MIX_LOW_V1'].includes(model)){
      res.writeHead(400,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      return res.end(JSON.stringify({ok:false,error:'INVALID_STATS_MODEL'}));
    }
    const data=postflipStats.snapshot(model);
    res.writeHead(data.ok?200:503,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    return res.end(JSON.stringify(data));
  }
  if (req.method === 'GET' && url.pathname === '/api/round-stats') return proxyStats(res);
  if (req.method === 'GET' && url.pathname === '/api/training-status') return proxyTrainingStatus(res);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trade-control')) return proxyInner(req, res, true);
  return proxyInner(req, res, false);
}).listen(PORT, '0.0.0.0', () => {
  void noviceMixShadow.start()
    .catch(error => log('novice_shadow_start_error', { error: String(error?.message||error) }))
    .finally(()=>{void postflipStats.start().catch(error=>
      log('postflip_accuracy_start_error',{error:String(error?.message||error)}));});
  log('panel_stats_shell_started', {
    port:PORT,
    innerPanelPort:INNER_PANEL_PORT,
    roundStatsOrigin:ROUND_STATS_ORIGIN,
    publicFallbackOrigin:ROUND_STATS_PUBLIC_ORIGIN,
    primaryTimeoutMs:STATS_PROXY_PRIMARY_TIMEOUT_MS,
    fallbackTimeoutMs:STATS_PROXY_FALLBACK_TIMEOUT_MS,
    statsCacheMode:'SINGLE_FLIGHT_BACKGROUND_REFRESH',
  });
  if (process.env.BINANCE_OFFICIAL_PROBE_ENABLED === 'true') {
    setTimeout(async () => {
      try {
        const response = await fetch('http://127.0.0.1:' + PORT + '/api/internal/binance-official-probe', {
          headers:{'x-audit-probe-token':process.env.BINANCE_OFFICIAL_PROBE_TOKEN || ''},
          signal:AbortSignal.timeout(12000)
        });
        const result = await response.json();
        log('binance_official_singapore_probe', {httpStatus:result.httpStatus ?? null,
          binanceCode:result.binanceCode ?? null, officialTopicReturned:result.officialTopicReturned ?? false,
          ok:result.ok === true, error:result.error ?? null,
          responseTopKeys:result.responseTopKeys ?? [],responseDataKeys:result.responseDataKeys ?? [],
          responseDataType:result.responseDataType ?? null});
      } catch (err) { log('binance_official_singapore_probe', {ok:false,error:err?.name || 'REQUEST_FAILED'}); }
    }, 3000).unref();
  }
  setTimeout(refreshStatsCache, 300).unref();
  setInterval(refreshStatsCache, 1000).unref();
});

function shutdown(signal){stopping=true;if(child)child.kill('SIGTERM');log('panel_stats_shell_stopped',{signal});setTimeout(()=>process.exit(0),150).unref()}
process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));

import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 3000);
const INNER_PANEL_PORT = Number(process.env.INNER_PANEL_PORT || 3002);
const ROUND_STATS_ORIGIN = String(process.env.ROUND_STATS_ORIGIN || 'https://signal-diagnostic-v2-production.up.railway.app').replace(/\/+$/, '');
const ROUND_STATS_PUBLIC_ORIGIN = String(process.env.ROUND_STATS_PUBLIC_ORIGIN || 'https://signal-diagnostic-v2-production.up.railway.app').replace(/\/+$/, '');
const STATS_PROXY_PRIMARY_TIMEOUT_MS = Math.max(1000, Number(process.env.STATS_PROXY_PRIMARY_TIMEOUT_MS || 2500));
const STATS_PROXY_FALLBACK_TIMEOUT_MS = Math.max(3000, Number(process.env.STATS_PROXY_FALLBACK_TIMEOUT_MS || 7000));
const STATS_PROXY_RETRY_MS = Math.max(100, Number(process.env.STATS_PROXY_RETRY_MS || 250));
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
<div class="muted" id="rsMeta">生产信号：冻结 Shadow；真实结果只采用 Binance Prediction 官方结算。</div>
<div class="grid" style="margin-top:12px">
<div class="kv"><div class="k">已结算</div><div class="v" id="rsSettled">-</div></div>
<div class="kv"><div class="k">有效判断</div><div class="v" id="rsDecided">-</div></div>
<div class="kv"><div class="k">命中</div><div class="v" id="rsCorrect">-</div></div>
<div class="kv"><div class="k">未命中</div><div class="v" id="rsWrong">-</div></div>
<div class="kv"><div class="k">未出方向</div><div class="v" id="rsWait">-</div></div>
<div class="kv"><div class="k">判断覆盖率</div><div class="v" id="rsCoverage">-</div></div>
</div>
<div style="overflow:auto;max-height:460px;margin-top:12px;border:1px solid #2b313d;border-radius:10px"><table style="width:100%;border-collapse:collapse;font-size:13px;min-width:720px"><thead style="position:sticky;top:0;background:#151922;z-index:2"><tr style="text-align:left;color:#8f98a8"><th style="padding:8px 6px">轮次</th><th style="padding:8px 6px">生产判断</th><th style="padding:8px 6px">来源</th><th style="padding:8px 6px">强度</th><th style="padding:8px 6px">耗时</th><th style="padding:8px 6px">官方结果</th><th style="padding:8px 6px">命中结果</th><th style="padding:8px 6px">官方结算证据</th></tr></thead><tbody id="rsRows"><tr><td colspan="8" style="padding:10px 6px;color:#8f98a8">读取中...</td></tr></tbody></table></div>
<div class="muted" style="margin-top:10px">真实结果只认 Binance Prediction 官方 UP/DOWN；官方未结算时显示“待结算”。现货 K 线不再参与命中判定或 Shadow 训练标签。</div>
</div>`;

const previewCard = `<div class="c" id="waitVisibilityCard">
<div class="k">实时方向观察 · 生产交易严格分离</div>
<div class="big" id="wvTradeStatus">正在核对生产方向...</div>
<div class="muted" id="wvMeta">预判方向只是供观察，不能代替生产锁定信号、也不触发下单。</div>
<div class="grid" style="margin-top:12px">
<div class="kv"><div class="k">最新15秒候选</div><div class="v" id="wvPreview">-</div></div>
<div class="kv"><div class="k">预测市场盘口倾向</div><div class="v" id="wvPmSide">-</div></div>
<div class="kv"><div class="k">最近20轮候选覆盖率</div><div class="v" id="wvCoverage">-</div></div>
<div class="kv"><div class="k">已结算候选命中率</div><div class="v" id="wvHitRate">-</div></div>
</div>
<div class="muted" id="wvBlockers" style="margin-top:10px">正在读取拒绝原因...</div>
<div style="overflow:auto;max-height:370px;margin-top:10px;border:1px solid #2b313d;border-radius:10px"><table style="width:100%;border-collapse:collapse;font-size:13px;min-width:640px"><thead style="position:sticky;top:0;background:#151922;z-index:2"><tr style="text-align:left;color:#8f98a8"><th style="padding:8px 6px">轮次</th><th style="padding:8px 6px">15秒候选（非下单）</th><th style="padding:8px 6px">生产</th><th style="padding:8px 6px">官方结果</th><th style="padding:8px 6px">候选结果</th><th style="padding:8px 6px">未通过原因</th></tr></thead><tbody id="wvRows"><tr><td colspan="6" style="padding:9px 6px">读取中...</td></tr></tbody></table></div>
<div class="muted" style="margin-top:10px">候选方向、盘口倾向、生产已锁定方向是三种不同信息。候选仅按事前冻结记录计算；命中率采用系统登记的 Binance Prediction 结算，不代表独立审计认证。不会改变实际下单逻辑。</div>
</div>`;

const previewScript = `<script>(function(){
'use strict';
function e(id){return document.getElementById(id)}
function esc(v){return String(v==null?'-':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function tm(ms){return Number.isFinite(Number(ms))?new Date(Number(ms)).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'-'}
function dir(v){return v==='UP'?'UP ↑':v==='DOWN'?'DOWN ↓':'WAIT'}
function frozen(r){var f=r&&r.v3NoBase15sShadow;return f&&f.baseAbsentAtObservation===true&&f.inputFrozenBeforeSettlement===true&&Number(f.round)===Number(r.roundStartMs)?f:null}
var priority=['ABS_PM_CURRENT15','ABS_PM_REGIME35','PM_CURRENT25_SUPPORT08','PM_REGIME35_SUPPORT08','PM_FLOW15_CURRENT_03','PM_TREND_045_CURRENT_03','CURRENT_04_TREND_055_PM05','CURRENT_03_TREND_045_PM08','CURRENT_03_PM_AGREE','BLENDED_04_PM_AGREE','PM_LEAN_03'];
function candidate(f){if(!f||!f.candidates)return null;for(var i=0;i<priority.length;i++){var q=f.candidates[priority[i]];if(q&&(q.decision==='UP'||q.decision==='DOWN')&&q.qualified===true&&Array.isArray(q.reasons)&&q.reasons.length===0)return {direction:q.decision,model:priority[i]}}return null}
function reason(f){if(!f)return '15秒尚未冻结';var x=f.facts||{};var failures=x.gateFailures||[];if(failures.length)return failures.join('、');var reasons=[];Object.keys(f.candidates||{}).forEach(function(k){var a=f.candidates[k];if(a&&a.decision==='WAIT'&&Array.isArray(a.reasons))reasons=reasons.concat(a.reasons)});var uniq=Array.from(new Set(reasons));return uniq.length?uniq.slice(0,2).join('、'):'模型确认条件未满足'}
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
e('wvPreview').innerHTML=freshCandidate?'<span class="on">'+esc(dir(freshCandidate.direction))+'</span>':'<span class="warn">WAIT</span>';
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
function badge(v){var x=String(v||'-');if(x==='UP')return '<span class="on">UP</span>';if(x==='DOWN')return '<span class="bad">DOWN</span>';if(x==='HIT')return '<span class="on">命中</span>';if(x==='MISS')return '<span class="bad">未命中</span>';if(x==='NO_DECISION')return '<span class="warn">WAIT</span>';if(x==='PENDING')return '<span class="warn">待结算</span>';return esc(x)}
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
async function load(){try{
var j=await getStats();var h=j.health||{};
var all=(j.records||[]).filter(function(x){return !j.productionStartMs||Number(x.roundStartMs)>=Number(j.productionStartMs)});
function official(x){return x.productionActual==='UP'||x.productionActual==='DOWN'?x.productionActual:null}
function pred(x){return x.productionPrediction==='UP'||x.productionPrediction==='DOWN'?x.productionPrediction:null}
function derived(x){var p=pred(x),a=official(x);return !a?'PENDING':(!p?'NO_DECISION':(p===a?'HIT':'MISS'))}
var settled=all.filter(function(x){return !!official(x)}),decided=settled.filter(function(x){return !!pred(x)});
var correct=decided.filter(function(x){return derived(x)==='HIT'}).length,wrong=decided.filter(function(x){return derived(x)==='MISS'}).length;
var s={settledRounds:settled.length,decidedRounds:decided.length,correct:correct,wrong:wrong,noDecision:settled.length-decided.length,accuracyPct:decided.length?correct*100/decided.length:null,coveragePct:settled.length?decided.length*100/settled.length:null};
e('rsAccuracy').innerHTML=s.accuracyPct==null?'准确率：-':'准确率：<span class="on">'+Number(s.accuracyPct).toFixed(2)+'%</span>';
e('rsSettled').textContent=s.settledRounds;e('rsDecided').textContent=s.decidedRounds;e('rsCorrect').innerHTML='<span class="on">'+s.correct+'</span>';e('rsWrong').innerHTML='<span class="bad">'+s.wrong+'</span>';e('rsWait').textContent=s.noDecision;e('rsCoverage').textContent=s.coveragePct==null?'-':Number(s.coveragePct).toFixed(2)+'%';
var settlement=j.settlementSource==='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY'?'Binance Prediction 官方结算':'结算源：'+(j.settlementSource||'-');
var status=h.lastSettlementError?' · 最近结算：'+h.lastSettlementError:'';
var stale=j.stale?' · ⚠ 当前显示缓存数据 '+Math.round((j.staleAgeMs||0)/1000)+'s':'';
e('rsMeta').textContent='生产策略：冻结 Shadow 主信号 · 命中判定只认 Binance Prediction 官方 UP/DOWN · 官方未结算保持待结算 · 信号检查 '+(h.signalPollMs||'-')+'ms · Shadow 特征观察期 '+((h.shadowObserveMs||j.shadowObserveMs)?Number(h.shadowObserveMs||j.shadowObserveMs)/1000+'秒':'读取中')+' · '+settlement+' · Shadow轮次 '+(s.primaryShadowRounds??0)+' · V6回退 '+(s.v6FallbackRounds??0)+status+stale;
var a=(j.records||[]).filter(function(x){return !j.productionStartMs||Number(x.roundStartMs)>=Number(j.productionStartMs)}).slice(0,50);e('rsRows').innerHTML=a.length?a.map(function(x){var st=x.productionConfidence==null?'-':Number(x.productionConfidence).toFixed(3),dl=x.productionDelayMs==null?'-':(Number(x.productionDelayMs)/1000).toFixed(2)+'s',src=x.productionSource==='SHADOW_CANDIDATE_PRIMARY'?'Shadow':(x.productionSource==='SHADOW_V3_AUTOML_PRIMARY'?'V3 AutoML':(x.productionSource==='LOCK_QUALITY_SELECTIVE_V2_PRIMARY'?'Selective V2':(x.productionSource==='V6_FALLBACK'?'V6回退':(x.productionSource||'WAIT')))),actual=(x.productionActual==='UP'||x.productionActual==='DOWN')?x.productionActual:'PENDING',evidence=(x.resolutionEvidence&&String(x.resolutionEvidence).indexOf('OFFICIAL_')===0)?x.resolutionEvidence:'等待官方结算';return '<tr style="border-top:1px solid #2b313d"><td style="padding:9px 6px">'+tm(x.roundStartMs)+'</td><td style="padding:9px 6px">'+badge(x.productionPrediction)+'</td><td style="padding:9px 6px">'+esc(src)+'</td><td style="padding:9px 6px">'+st+'</td><td style="padding:9px 6px">'+dl+'</td><td style="padding:9px 6px">'+badge(actual)+'</td><td style="padding:9px 6px">'+badge(derived(x))+'</td><td style="padding:9px 6px">'+esc(evidence)+'</td></tr>'}).join(''):'<tr><td colspan="8" style="padding:10px 6px;color:#8f98a8">等待生产 Shadow 首个轮次...</td></tr>';
}catch(err){if(e('rsAccuracy'))e('rsAccuracy').innerHTML='<span class="bad">统计读取失败</span>';if(e('rsMeta'))e('rsMeta').textContent=err&&err.message?err.message:'统计服务暂不可用'}}
function boot(){load();setInterval(load,3000)}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();</script>`;

function injectStats(html) {
  if (html.includes('id="roundStatsCard"')) return html;
  const marker = '<div class="c"><input id="amount"';
  let out = html.includes(marker) ? html.replace(marker, `${previewCard}${statsCard}${marker}`) : html.replace('</body>', `${previewCard}${statsCard}</body>`);
  return out.replace('</body>', `${statsScript}${previewScript}</body>`);
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
  if (req.method === 'GET' && url.pathname === '/api/round-stats') return proxyStats(res);
  if (req.method === 'GET' && url.pathname === '/api/training-status') return proxyTrainingStatus(res);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trade-control')) return proxyInner(req, res, true);
  return proxyInner(req, res, false);
}).listen(PORT, '0.0.0.0', () => {
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

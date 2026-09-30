import fs from 'node:fs';

const sourceUrl = new URL('./control-shell.mjs', import.meta.url);
const runtimeUrl = new URL('./.control-shell-stats-runtime.mjs', import.meta.url);
let source = fs.readFileSync(sourceUrl, 'utf8');

const originMarker = "const PORT = Number(process.env.PORT || 3000);\nconst INNER_PORT = Number(process.env.INNER_CONTROL_PORT || 3001);";
if (!source.includes(originMarker)) throw new Error('SIGNAL_STATS_ORIGIN_MARKER_NOT_FOUND');
source = source.replace(
  originMarker,
  originMarker + "\nconst SIGNAL_STATS_ORIGIN = String(process.env.RAILWAY_SERVICE_SIGNAL_DIAGNOSTIC_V3_URL || process.env.SITE_ORIGIN || '').replace(/\\/+$/, '');"
);

const panelHtml = `<div class="c" id="signalStatsCard"><div class="k">每轮判断准确率</div><div class="big" id="signalAccuracy">统计中...</div><div class="muted" id="signalStatsMeta">每个5分钟轮次独立记录；不需要实际下单。</div><div class="grid" style="margin-top:12px"><div class="kv"><div class="k">已判断</div><div class="v" id="signalJudged">-</div></div><div class="kv"><div class="k">命中 / 未中</div><div class="v" id="signalHitMiss">-</div></div><div class="kv"><div class="k">观望轮次</div><div class="v" id="signalWaits">-</div></div><div class="kv"><div class="k">待结算</div><div class="v" id="signalPending">-</div></div></div><div style="overflow-x:auto;margin-top:14px"><table style="width:100%;border-collapse:collapse;font-size:13px;min-width:520px"><thead><tr><th style="text-align:left;padding:8px 5px;color:#8f98a8">轮次</th><th style="text-align:left;padding:8px 5px;color:#8f98a8">判断</th><th style="text-align:left;padding:8px 5px;color:#8f98a8">真实</th><th style="text-align:right;padding:8px 5px;color:#8f98a8">开盘</th><th style="text-align:right;padding:8px 5px;color:#8f98a8">收盘</th><th style="text-align:left;padding:8px 5px;color:#8f98a8">结果</th></tr></thead><tbody id="signalStatsRows"><tr><td colspan="6" style="padding:10px 5px;color:#8f98a8">正在读取...</td></tr></tbody></table></div><div class="muted" style="margin-top:10px">规则：本轮第一次 LOCKED 的 UP/DOWN 作为正式判断；真实结果使用 Binance 5分钟K线收盘价与开盘价比较。WAIT/平盘不计入准确率。</div></div>`;

const panelScript = `<script>(function(){'use strict';function e(i){return document.getElementById(i)}function esc(v){return String(v==null?'-':v).replace(/[&<>\"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[c]})}function t(ms){if(!ms)return'-';try{return new Date(ms).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}catch(x){return'-'}}function p(v){return v==='UP'?'上涨':v==='DOWN'?'下跌':v==='WAIT'?'观望':v==='FLAT'?'平盘':'-'}function result(v){return v==='HIT'?'✓ 命中':v==='MISS'?'✕ 未中':v==='WAIT'?'— 观望':v==='FLAT'?'— 平盘':'待结算'}function load(){fetch('/api/signal-stats?ts='+Date.now(),{cache:'no-store'}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){if(!x.ok)throw new Error((x.j&&x.j.error)||'读取失败');var j=x.j||{},s=j.summary||{};e('signalAccuracy').innerHTML=s.accuracyPct==null?'<span class="warn">暂无已结算判断</span>':'<span class="ok">'+Number(s.accuracyPct).toFixed(2)+'%</span>';e('signalJudged').textContent=s.judgedRounds==null?'-':s.judgedRounds;e('signalHitMiss').textContent=(s.hits==null?'-':s.hits)+' / '+(s.misses==null?'-':s.misses);e('signalWaits').textContent=s.waits==null?'-':s.waits;e('signalPending').textContent=s.pending==null?'-':s.pending;e('signalStatsMeta').textContent='累计记录 '+(s.totalRecordedRounds||0)+' 轮 · 已结算 '+(s.settledRounds||0)+' 轮 · 与是否下单无关';var rows=(j.records||[]).slice(0,12);e('signalStatsRows').innerHTML=rows.length?rows.map(function(r){var open=r.openPrice==null?'-':Number(r.openPrice).toFixed(2),close=r.closePrice==null?'-':Number(r.closePrice).toFixed(2);return'<tr style="border-top:1px solid #2a3140"><td style="padding:9px 5px">'+esc(t(r.roundStartMs))+'</td><td style="padding:9px 5px">'+esc(p(r.prediction))+'</td><td style="padding:9px 5px">'+esc(p(r.actual))+'</td><td style="padding:9px 5px;text-align:right">'+esc(open)+'</td><td style="padding:9px 5px;text-align:right">'+esc(close)+'</td><td style="padding:9px 5px">'+esc(result(r.outcome))+'</td></tr>'}).join(''):'<tr><td colspan="6" style="padding:10px 5px;color:#8f98a8">暂无轮次记录</td></tr>'}).catch(function(err){e('signalAccuracy').innerHTML='<span class="bad">统计读取失败</span>';e('signalStatsMeta').textContent=err.message||'无法连接信号统计服务'})}function boot(){load();setInterval(load,2000)}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot()})();</script>`;

const injectMarker = 'function injectRiskControls(html) {';
if (!source.includes(injectMarker)) throw new Error('SIGNAL_STATS_INJECT_MARKER_NOT_FOUND');
source = source.replace(injectMarker, `const signalStatsPanel = ${JSON.stringify(panelHtml)};\nconst signalStatsScript = ${JSON.stringify(panelScript)};\n\n${injectMarker}`);

const injectEndMarker = "  out = out.replace('</body>', `${riskScript}</body>`);\n  return out;\n}";
if (!source.includes(injectEndMarker)) throw new Error('SIGNAL_STATS_INJECT_END_MARKER_NOT_FOUND');
source = source.replace(
  injectEndMarker,
  "  out = out.replace('</body>', `${riskScript}</body>`);\n  out = out.replace('</body>', signalStatsPanel + signalStatsScript + '</body>');\n  return out;\n}"
);

const routeMarker = "  if (req.method === 'GET' && url.pathname === '/api/risk-control') {";
if (!source.includes(routeMarker)) throw new Error('SIGNAL_STATS_ROUTE_MARKER_NOT_FOUND');
const statsRoute = String.raw`  if (req.method === 'GET' && url.pathname === '/api/signal-stats') {
    if (!SIGNAL_STATS_ORIGIN) return sendJson(res, 503, { ok: false, error: '信号统计服务地址未配置' });
    try {
      const r = await fetch(SIGNAL_STATS_ORIGIN + '/api/stats', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { ok: false, error: '信号统计返回无法解析' }; }
      return sendJson(res, r.ok ? 200 : 502, body);
    } catch (e) {
      return sendJson(res, 502, { ok: false, error: '信号统计连接失败：' + (e?.message || String(e)) });
    }
  }

`;
source = source.replace(routeMarker, statsRoute + routeMarker);

fs.writeFileSync(runtimeUrl, source, 'utf8');
console.log(JSON.stringify({ event: 'signal_stats_panel_runtime_patch_ready', runtime: runtimeUrl.pathname, signalOriginConfigured: Boolean(process.env.RAILWAY_SERVICE_SIGNAL_DIAGNOSTIC_V3_URL || process.env.SITE_ORIGIN) }));
await import(runtimeUrl.href + '?v=' + Date.now());

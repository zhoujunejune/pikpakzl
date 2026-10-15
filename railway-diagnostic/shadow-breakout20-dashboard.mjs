// Breakout20 read-only live dashboard. No production signal or trade controls.
export const shadowCard = "<section class=\"c\" id=\"breakout20ShadowCard\" aria-label=\"突破20%即可独立影子模型\" style=\"border:1px solid #45546b\">\n  <div class=\"k\">突破20%即可 · 生产信号 / 官方结算只读统计</div>\n  <div class=\"big\" style=\"margin-top:6px\">突破20%即可 <span id=\"b20Connection\" class=\"muted\" style=\"font-size:13px\">连接中...</span></div>\n  <div class=\"muted\" id=\"b20Meta\">Cloudflare 独立预测；每5分钟一轮，目标8秒内锁定。</div>\n  <div class=\"grid\" style=\"margin-top:12px\">\n    <div class=\"kv\"><div class=\"k\">最新生产信号方向</div><div class=\"v\" id=\"b20Direction\">-</div></div>\n    <div class=\"kv\"><div class=\"k\">官方结算准确率（生产）</div><div class=\"v\" id=\"b20Accuracy\">-</div></div>\n    <div class=\"kv\"><div class=\"k\">UP 官方准确率</div><div class=\"v\" id=\"b20UpAccuracy\">-</div></div>\n    <div class=\"kv\"><div class=\"k\">DOWN 官方准确率</div><div class=\"v\" id=\"b20DownAccuracy\">-</div></div>\n    <div class=\"kv\"><div class=\"k\">最近20个官方结算</div><div class=\"v\" id=\"b20Recent20\">-</div></div>\n    <div class=\"kv\"><div class=\"k\">生产锁定 / 影子数据缺口</div><div class=\"v\" id=\"b20Coverage\">-</div></div>\n    <div class=\"kv\"><div class=\"k\">待结算</div><div class=\"v\" id=\"b20Pending\">-</div></div>\n    <div class=\"kv\"><div class=\"k\">当前训练模型</div><div class=\"v\" id=\"b20Model\">-</div></div>\n  </div>\n  <div class=\"muted\" id=\"b20Timing\" style=\"margin-top:12px\">等待独立数据更新...</div>\n  <div class=\"muted\" id=\"b20Training\" style=\"margin-top:4px\">等待训练状态...</div>\n  <div style=\"overflow-x:auto;max-height:340px;margin-top:12px;border:1px solid #2b313d;border-radius:10px\">\n    <table style=\"width:100%;border-collapse:collapse;font-size:12px;min-width:600px\">\n      <thead style=\"position:sticky;top:0;background:#151922\"><tr style=\"text-align:left;color:#8f98a8\">\n        <th style=\"padding:8px 6px\">轮次</th><th style=\"padding:8px 6px\">生产预测</th><th style=\"padding:8px 6px\">币安预测市场官方结果</th>\n        <th style=\"padding:8px 6px\">命中</th><th style=\"padding:8px 6px\">锁定时间</th>\n      </tr></thead>\n      <tbody id=\"b20Rows\"><tr><td colspan=\"5\" style=\"padding:10px\">正在读取...</td></tr></tbody>\n    </table>\n  </div>\n  <div class=\"muted\" style=\"margin-top:10px\">正式准确率仅按 Railway 已保存的 Binance Prediction 最终官方结算计算，只计本模型在生产中8秒内锁定的信号；不混入其他模型或现货代理结果。官方未结算不计入分母。历史归档不计入当前保留历史的统计。Cloudflare 自动训练仍基于现货近似数据，与上方官方命中率严格区分。此面板只读。</div>\n</section>";
export const shadowScript = "<script>(function(){\n'use strict';\nfunction el(id){return document.getElementById(id)}\nfunction put(id,text){var x=el(id);if(x)x.textContent=String(text)}\nfunction esc(v){return String(v==null?'-':v).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]})}\nfunction pct(s){return s&&Number.isFinite(s.accuracy)?(s.accuracy*100).toFixed(2)+'% ('+Number(s.hits||0)+'/'+Number(s.samples||0)+')':'暂无已结算'}\nfunction clock(ms){return Number(ms)>0?new Date(Number(ms)).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'-'}\nfunction dir(v){return v==='UP'?'UP ↑':v==='DOWN'?'DOWN ↓':'—'}\nfunction conclusion(r){if(!['UP','DOWN'].includes(r.actual))return '待官方结算';return r.direction===r.actual?'✓ 命中':'✕ 未命中'}\nfunction render(s){\n var latest=s.latest||{},r=s.results||{},t=s.timed||{},tr=s.training||{},official=s.official||{};\n var stale=!t.lastTickAt||Date.now()-Number(t.lastTickAt)>360000;\n put('b20Connection',!official.available?'● 官方结果暂不可用':r.overall?.samples===0?'● 尚无已确认官方结算':stale?'● 影子行情最近未更新':'● 官方对账正常');\n put('b20Direction',official.available?dir(latest.direction)+(latest.t?' · '+clock(latest.t):''):'暂无生产锁定');\n put('b20Accuracy',pct(r.overall));put('b20UpAccuracy',pct(r.up));put('b20DownAccuracy',pct(r.down));\n put('b20Recent20',pct(r.recent20));\n put('b20Coverage',Number(r.locked||0)+' / '+Number(r.dataGaps||0));\n put('b20Pending',Number(r.pending||0));\n put('b20Model',tr.trainedModel==='BASELINE'?'基线模型':tr.trainedModel||'未初始化');\n put('b20Meta','预测来自 Cloudflare；最终结果来自 Railway · '+(official.available?(r.overall?.samples>0?'官方已结算 '+r.overall.samples+' 轮':'尚无官方已结算轮次 · '+(latest.pendingReason==='PREDICTION_TOPIC_NOT_FOUND'?'预测市场合约编号未找到':'等待官方结果')):'官方接口不可用，不用现货结果补算')+' · 刷新 '+clock(s.fetchedAt));\n put('b20Timing','上轮运行：'+clock(t.lastTickAt)+' · 最新有效数据：'+clock(t.lastGoodDataAt)+' · 下次轮次：'+clock(t.nextAlarm)\n   +' · 最新锁定耗时：'+(Number.isFinite(Number(latest.delayMs))?Number(latest.delayMs)/1000+' 秒':'-')\n   +' · 最新记录：'+(latest.status||'暂无'));\n var train=tr.latestTraining||{},history=Number(tr.historicalApproxSamples||0);\n put('b20Training','历史近似训练样本：'+history+' · 最后训练：'+clock(train.at)\n   +' · 训练状态：'+(train.ok===true?(train.adopted?'候选通过验证并晋级':'候选未优于基线，保留基线'):(train.reason||'尚无结果'))\n   +' · 历史训练留出集不计入上方准确率');\n var rows=official.available&&Array.isArray(s.recent)?s.recent.slice(0,12):[];\n var body=el('b20Rows');\n if(body)body.innerHTML=rows.length?rows.map(function(x){return '<tr style=\"border-top:1px solid #2a3140\">'+\n  '<td style=\"padding:8px 6px\">'+esc(clock(x.t))+'</td>'+\n  '<td style=\"padding:8px 6px\">'+esc(dir(x.direction))+'</td>'+\n  '<td style=\"padding:8px 6px\">'+esc(dir(x.actual))+'</td>'+\n  '<td style=\"padding:8px 6px\">'+esc(conclusion(x))+'</td>'+\n  '<td style=\"padding:8px 6px\">'+esc(clock(x.lockedAt))+'</td></tr>'}).join('')\n  :'<tr><td colspan=\"5\" style=\"padding:10px\">暂无生产官方对账记录</td></tr>';\n}\nfunction load(){\n if(!el('breakout20ShadowCard'))return;\n fetch('/api/shadow-breakout20/status?ts='+Date.now(),{cache:'no-store'}).then(function(response){\n  return response.json().then(function(payload){if(!response.ok||!payload||payload.ok!==true)throw Error(payload&&payload.error||'读取失败');return payload})\n }).then(render).catch(function(err){\n  put('b20Connection','● 暂时无法读取');\n  put('b20Meta','影子数据读取失败：'+(err&&err.message||'连接失败')+'。不会影响生产信号或下单。');\n });\n}\nfunction boot(){load();setInterval(load,5000)}\nif(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();\n})();</script>";

// This module is display-only; never import it into signal routing or trading code.
export function createShadowStatusProxy({fetcher = globalThis.fetch, now = Date.now, cacheTtlMs = 4500,
  officialEndpoint = String(process.env.ROUND_STATS_ORIGIN || 'https://signal-diagnostic-v2-production.up.railway.app').replace(/\/+$/, '') + '/api/breakout20-official-accuracy'} = {}) {
  const endpoint = 'https://breakout20-shadow.zl528094-3ba.workers.dev/status';
  let last = null, lastAt = 0, pending = null;
  async function snapshot() {
    if (last && now()-lastAt < cacheTtlMs) return last;
    if (!pending) {
      pending = (async () => {
        const response = await fetcher(endpoint, {
          method: 'GET', cache: 'no-store',
          headers: { accept: 'application/json' }, signal: AbortSignal.timeout(2800)
        });
        if (!response.ok) throw new Error('CLOUDFLARE_HTTP_' + response.status);
        const payload = await response.json();
        if (payload?.name !== '突破20%即可' || payload?.readOnly !== true ||
            payload?.orders !== false || payload?.productionIntegration !== false ||
            !payload?.results || !payload?.timed) throw new Error('INVALID_READONLY_SHADOW_STATUS');
        const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj?.[k] ?? null]));
        // Railway is the authority for Binance Prediction official final outcomes.
        // Never silently replace unavailable official data with spot-candle labels.
        let official={available:false,reason:'RAILWAY_OFFICIAL_SETTLEMENT_UNAVAILABLE'};
        try {
          const officialResponse=await fetcher(officialEndpoint,{
            method:'GET',cache:'no-store',headers:{accept:'application/json'},
            signal:AbortSignal.timeout(2600)
          });
          if(!officialResponse.ok)throw Error('OFFICIAL_HTTP_'+officialResponse.status);
          const data=await officialResponse.json();
          if(data?.ok!==true || data?.model!=='BREAKOUT20_RSI_MACD_RANGE_V1' ||
             data?.source!=='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY' ||
             data?.statsScope!=='CURRENT_MODEL_VERSION_PRODUCTION_LOCKS_ONLY' ||
             !data?.results || !Array.isArray(data?.recent))
            throw Error('INVALID_OFFICIAL_PROVENANCE');
          if(!Number.isFinite(data.generatedAt)||Math.abs(now()-data.generatedAt)>120000)
            throw Error('OFFICIAL_DATA_STALE');
          const summarized=Object.fromEntries(['overall','up','down','recent20','recent100'].map(k=>
            [k,pick(data.results[k],['samples','hits','accuracy'])]));
          official={
            available:true,source:data.source,model:data.model,statsScope:data.statsScope,
            retentionMayLimitTotal:Boolean(data.retentionMayLimitTotal),
            generatedAt:data.generatedAt,
            results:{rounds:data.results.rounds,locked:data.results.locked,
              pending:data.results.pending,...summarized},
            latest:data.latest&&pick(data.latest,['t','direction','actual','status','lockedAt','delayMs','result','resolutionEvidence','pendingReason']),
            recent:data.recent.slice(0,50).map(row=>
              pick(row,['t','direction','actual','status','lockedAt','delayMs','result','resolutionEvidence','pendingReason']))
          };
        }catch {
          // Missing official resolution is "unavailable", NEVER a spot proxy hit.
        }
        const result = {
          ok: true, fetchedAt: now(), name: payload.name, version: String(payload.version || ''),
          timed: pick(payload.timed, ['lastTickAt', 'lastGoodDataAt', 'nextAlarm', 'deadlineMs']),
          training: {
            historicalApproxSamples: payload.training?.historicalApproxSamples ?? null,
            trainedModel: payload.training?.trainedModel ?? null,
            latestTraining: pick(payload.training?.latestTraining, ['at', 'ok', 'adopted', 'reason', 'trainingSamples', 'holdoutSamples'])
          },
          official,
          shadowSpotResults: {
            rounds: payload.results.rounds, locked: payload.results.locked,
            dataGaps: payload.results.dataGaps, pending: payload.results.pending,
            ...Object.fromEntries(['overall','up','down','recent20','recent100'].map(k =>
              [k, pick(payload.results?.[k], ['samples','hits','accuracy'])]))
          },
          results: official.available
            ? {...official.results,dataGaps:payload.results.dataGaps}
            : {rounds:0,locked:0,pending:0,dataGaps:payload.results.dataGaps,
                ...Object.fromEntries(['overall','up','down','recent20','recent100'].map(k =>
                  [k,{samples:0,hits:0,accuracy:null}]))},
          latest:official.available?official.latest:null,
          recent:official.available?official.recent:[]
        };
        last = result; lastAt = now(); return result;
      })().finally(() => { pending = null; });
    }
    return pending;
  }
  return async function shadowStatusProxy(res) {
    try {
      const payload = await snapshot();
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8',
        'cache-control':'no-store', 'x-content-type-options':'nosniff' });
      return res.end(JSON.stringify(payload));
    } catch {
      res.writeHead(502, { 'content-type':'application/json; charset=utf-8',
        'cache-control':'no-store', 'x-content-type-options':'nosniff' });
      return res.end(JSON.stringify({ok:false,error:'SHADOW_STATUS_TEMPORARILY_UNAVAILABLE'}));
    }
  };
}
export const proxyShadowStatus = createShadowStatusProxy();

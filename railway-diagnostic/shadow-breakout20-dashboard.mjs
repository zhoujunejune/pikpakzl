// Breakout20 read-only live dashboard. No production signal or trade controls.
export const shadowCard = "<section class=\"c\" id=\"breakout20ShadowCard\" aria-label=\"突破20%即可独立影子模型\" style=\"border:1px solid #45546b\">\n  <div class=\"k\">独立影子模型 · 仅观察 · 不参与下单</div>\n  <div class=\"big\" style=\"margin-top:6px\">突破20%即可 <span id=\"b20Connection\" class=\"muted\" style=\"font-size:13px\">连接中...</span></div>\n  <div class=\"muted\" id=\"b20Meta\">Cloudflare 独立预测；每5分钟一轮，目标8秒内锁定。</div>\n  <div class=\"grid\" style=\"margin-top:12px\">\n    <div class=\"kv\"><div class=\"k\">最新影子方向</div><div class=\"v\" id=\"b20Direction\">-</div></div>\n    <div class=\"kv\"><div class=\"k\">总体准确率（已结算）</div><div class=\"v\" id=\"b20Accuracy\">-</div></div>\n    <div class=\"kv\"><div class=\"k\">UP 准确率</div><div class=\"v\" id=\"b20UpAccuracy\">-</div></div>\n    <div class=\"kv\"><div class=\"k\">DOWN 准确率</div><div class=\"v\" id=\"b20DownAccuracy\">-</div></div>\n    <div class=\"kv\"><div class=\"k\">最近20轮准确率</div><div class=\"v\" id=\"b20Recent20\">-</div></div>\n    <div class=\"kv\"><div class=\"k\">有效锁定 / 数据缺口</div><div class=\"v\" id=\"b20Coverage\">-</div></div>\n    <div class=\"kv\"><div class=\"k\">待结算</div><div class=\"v\" id=\"b20Pending\">-</div></div>\n    <div class=\"kv\"><div class=\"k\">当前训练模型</div><div class=\"v\" id=\"b20Model\">-</div></div>\n  </div>\n  <div class=\"muted\" id=\"b20Timing\" style=\"margin-top:12px\">等待独立数据更新...</div>\n  <div class=\"muted\" id=\"b20Training\" style=\"margin-top:4px\">等待训练状态...</div>\n  <div style=\"overflow-x:auto;max-height:340px;margin-top:12px;border:1px solid #2b313d;border-radius:10px\">\n    <table style=\"width:100%;border-collapse:collapse;font-size:12px;min-width:600px\">\n      <thead style=\"position:sticky;top:0;background:#151922\"><tr style=\"text-align:left;color:#8f98a8\">\n        <th style=\"padding:8px 6px\">轮次</th><th style=\"padding:8px 6px\">影子预测</th><th style=\"padding:8px 6px\">现货代理结果</th>\n        <th style=\"padding:8px 6px\">命中</th><th style=\"padding:8px 6px\">锁定时间</th>\n      </tr></thead>\n      <tbody id=\"b20Rows\"><tr><td colspan=\"5\" style=\"padding:10px\">正在读取...</td></tr></tbody>\n    </table>\n  </div>\n  <div class=\"muted\" style=\"margin-top:10px\">准确率仅统计独立前瞻预测与 BTCUSDT 现货5分钟开收盘涨跌的匹配结果，不是 Binance Prediction 官方结算、实盘胜率或收益率。数据缺口与未结算轮次不计入准确率；历史训练样本不混入前瞻胜率。此面板只读。</div>\n</section>";
export const shadowScript = "<script>(function(){\n'use strict';\nfunction el(id){return document.getElementById(id)}\nfunction put(id,text){var x=el(id);if(x)x.textContent=String(text)}\nfunction esc(v){return String(v==null?'-':v).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]})}\nfunction pct(s){return s&&Number.isFinite(s.accuracy)?(s.accuracy*100).toFixed(2)+'% ('+Number(s.hits||0)+'/'+Number(s.samples||0)+')':'暂无已结算'}\nfunction clock(ms){return Number(ms)>0?new Date(Number(ms)).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'-'}\nfunction dir(v){return v==='UP'?'UP ↑':v==='DOWN'?'DOWN ↓':'—'}\nfunction conclusion(r){if(r.status==='DATA_GAP')return '数据缺口';if(r.status==='TIE_UNRESOLVED')return '平盘';if(!['UP','DOWN'].includes(r.actual))return '待结算';return r.direction===r.actual?'✓ 命中':'✕ 未命中'}\nfunction render(s){\n var latest=s.latest||{},r=s.results||{},t=s.timed||{},tr=s.training||{};\n var stale=!t.lastTickAt||Date.now()-Number(t.lastTickAt)>360000;\n put('b20Connection',stale?'● 最近未更新':'● 独立运行中');\n put('b20Direction',dir(latest.direction)+(latest.t?' · '+clock(latest.t):'')+(stale?'（旧记录）':''));\n put('b20Accuracy',pct(r.overall));put('b20UpAccuracy',pct(r.up));put('b20DownAccuracy',pct(r.down));\n put('b20Recent20',pct(r.recent20));\n put('b20Coverage',Number(r.locked||0)+' / '+Number(r.dataGaps||0));\n put('b20Pending',Number(r.pending||0));\n put('b20Model',tr.trainedModel==='BASELINE'?'基线模型':tr.trainedModel||'未初始化');\n put('b20Meta','Cloudflare 独立数据 · '+(s.name||'突破20%即可')+' · 最近刷新 '+clock(s.fetchedAt));\n put('b20Timing','上轮运行：'+clock(t.lastTickAt)+' · 最新有效数据：'+clock(t.lastGoodDataAt)+' · 下次轮次：'+clock(t.nextAlarm)\n   +' · 最新锁定耗时：'+(Number.isFinite(Number(latest.delayMs))?Number(latest.delayMs)/1000+' 秒':'-')\n   +' · 最新记录：'+(latest.status||'暂无'));\n var train=tr.latestTraining||{},history=Number(tr.historicalApproxSamples||0);\n put('b20Training','历史近似训练样本：'+history+' · 最后训练：'+clock(train.at)\n   +' · 训练状态：'+(train.ok===true?(train.adopted?'候选通过验证并晋级':'候选未优于基线，保留基线'):(train.reason||'尚无结果'))\n   +' · 历史训练留出集不计入上方准确率');\n var rows=Array.isArray(s.recent)?s.recent.slice(-12).reverse():[];\n var body=el('b20Rows');\n if(body)body.innerHTML=rows.length?rows.map(function(x){return '<tr style=\"border-top:1px solid #2a3140\">'+\n  '<td style=\"padding:8px 6px\">'+esc(clock(x.t))+'</td>'+\n  '<td style=\"padding:8px 6px\">'+esc(dir(x.direction))+'</td>'+\n  '<td style=\"padding:8px 6px\">'+esc(dir(x.actual))+'</td>'+\n  '<td style=\"padding:8px 6px\">'+esc(conclusion(x))+'</td>'+\n  '<td style=\"padding:8px 6px\">'+esc(clock(x.lockedAt))+'</td></tr>'}).join('')\n  :'<tr><td colspan=\"5\" style=\"padding:10px\">尚无影子轮次记录</td></tr>';\n}\nfunction load(){\n if(!el('breakout20ShadowCard'))return;\n fetch('/api/shadow-breakout20/status?ts='+Date.now(),{cache:'no-store'}).then(function(response){\n  return response.json().then(function(payload){if(!response.ok||!payload||payload.ok!==true)throw Error(payload&&payload.error||'读取失败');return payload})\n }).then(render).catch(function(err){\n  put('b20Connection','● 暂时无法读取');\n  put('b20Meta','影子数据读取失败：'+(err&&err.message||'连接失败')+'。不会影响生产信号或下单。');\n });\n}\nfunction boot(){load();setInterval(load,5000)}\nif(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();\n})();</script>";

// This module is display-only; never import it into signal routing or trading code.
export function createShadowStatusProxy({fetcher = globalThis.fetch, now = Date.now, cacheTtlMs = 4500} = {}) {
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
        const result = {
          ok: true, fetchedAt: now(), name: payload.name, version: String(payload.version || ''),
          timed: pick(payload.timed, ['lastTickAt', 'lastGoodDataAt', 'nextAlarm', 'deadlineMs']),
          training: {
            historicalApproxSamples: payload.training?.historicalApproxSamples ?? null,
            trainedModel: payload.training?.trainedModel ?? null,
            latestTraining: pick(payload.training?.latestTraining, ['at', 'ok', 'adopted', 'reason', 'trainingSamples', 'holdoutSamples'])
          },
          results: {
            rounds: payload.results.rounds, locked: payload.results.locked,
            dataGaps: payload.results.dataGaps, pending: payload.results.pending,
            ...Object.fromEntries(['overall','up','down','recent20','recent100'].map(k =>
              [k, pick(payload.results?.[k], ['samples','hits','accuracy'])]))
          },
          latest: pick(payload.latest, ['t','direction','actual','status','lockedAt','delayMs','model','reason']),
          recent: (Array.isArray(payload.recent)?payload.recent:[]).slice(-12).map(row =>
            pick(row, ['t','direction','actual','status','lockedAt','reason']))
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

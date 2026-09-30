import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 3000);
const INNER_PANEL_PORT = Number(process.env.INNER_PANEL_PORT || 3002);
const ROUND_STATS_ORIGIN = String(process.env.ROUND_STATS_ORIGIN || 'https://signal-diagnostic-v2-production.up.railway.app').replace(/\/+$/, '');

function log(event, extra = {}) {
  console.log(JSON.stringify({ event, shell: 'panel-stats', at: new Date().toISOString(), ...extra }));
}

const statsCard = `<div class="c" id="roundStatsCard"><div class="k">每轮判断与真实结果</div><div class="big" id="rsAccuracy">准确率读取中...</div><div class="muted" id="rsMeta">统计独立于是否下单；每轮第一次确认后的 UP/DOWN 会锁定为该轮预测。</div><div class="grid" style="margin-top:12px"><div class="kv"><div class="k">已结算</div><div class="v" id="rsSettled">-</div></div><div class="kv"><div class="k">有效判断</div><div class="v" id="rsDecided">-</div></div><div class="kv"><div class="k">命中</div><div class="v" id="rsCorrect">-</div></div><div class="kv"><div class="k">未命中</div><div class="v" id="rsWrong">-</div></div><div class="kv"><div class="k">未出方向</div><div class="v" id="rsWait">-</div></div><div class="kv"><div class="k">判断覆盖率</div><div class="v" id="rsCoverage">-</div></div></div><div style="overflow-x:auto;margin-top:12px"><table style="width:100%;border-collapse:collapse;font-size:13px;min-width:520px"><thead><tr style="text-align:left;color:#8f98a8"><th style="padding:8px 6px">轮次</th><th style="padding:8px 6px">判断</th><th style="padding:8px 6px">真实</th><th style="padding:8px 6px">结果</th><th style="padding:8px 6px">开盘→收盘</th></tr></thead><tbody id="rsRows"><tr><td colspan="5" style="padding:10px 6px;color:#8f98a8">读取中...</td></tr></tbody></table></div><div class="muted" style="margin-top:10px">准确率 = 命中 ÷ 已结算且实际给出 UP/DOWN 的轮次；WAIT 单独统计，不偷偷改历史判断。</div></div>`;

const statsScript = `<script>(function(){'use strict';function e(i){return document.getElementById(i)}function esc(v){return String(v==null?'-':v).replace(/[&<>\"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[c]})}function tm(ms){if(!ms)return '-';try{return new Date(Number(ms)).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}catch(_){return '-'}}function badge(v){var x=String(v||'-');if(x==='UP')return '<span class="on">UP</span>';if(x==='DOWN')return '<span class="bad">DOWN</span>';if(x==='HIT')return '<span class="on">命中</span>';if(x==='MISS')return '<span class="bad">未命中</span>';if(x==='NO_DECISION')return '<span class="warn">WAIT</span>';if(x==='PENDING')return '<span class="warn">待结算</span>';return esc(x)}async function load(){try{var r=await fetch('/api/round-stats?ts='+Date.now(),{cache:'no-store'});var j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'读取失败');var s=j.summary||{};e('rsAccuracy').innerHTML=s.accuracyPct==null?'准确率：-':'准确率：<span class="on">'+Number(s.accuracyPct).toFixed(2)+'%</span>';e('rsSettled').textContent=s.settledRounds??0;e('rsDecided').textContent=s.decidedRounds??0;e('rsCorrect').innerHTML='<span class="on">'+(s.correct??0)+'</span>';e('rsWrong').innerHTML='<span class="bad">'+(s.wrong??0)+'</span>';e('rsWait').textContent=s.noDecision??0;e('rsCoverage').textContent=s.coveragePct==null?'-':Number(s.coveragePct).toFixed(2)+'%';var h=j.health||{};e('rsMeta').textContent='统计独立于是否下单 · 信号检查 '+(h.signalPollMs||'-')+'ms · '+(h.klineWsConnected?'真实5分钟K线已连接':'真实K线连接异常');var a=(j.records||[]).slice(0,10);e('rsRows').innerHTML=a.length?a.map(function(x){var px=x.openPrice==null?'-':Number(x.openPrice).toFixed(2);var pc=x.closePrice==null?'-':Number(x.closePrice).toFixed(2);return '<tr style="border-top:1px solid #2b313d"><td style="padding:9px 6px">'+tm(x.roundStartMs)+'</td><td style="padding:9px 6px">'+badge(x.prediction)+'</td><td style="padding:9px 6px">'+badge(x.actual)+'</td><td style="padding:9px 6px">'+badge(x.result)+'</td><td style="padding:9px 6px">'+px+' → '+pc+'</td></tr>'}).join(''):'<tr><td colspan="5" style="padding:10px 6px;color:#8f98a8">等待首个轮次...</td></tr>'}catch(err){var a=e('rsAccuracy'),m=e('rsMeta');if(a)a.innerHTML='<span class="bad">统计读取失败</span>';if(m)m.textContent=err&&err.message?err.message:'统计服务暂不可用'}}function boot(){load();setInterval(load,2000)}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot()})();</script>`;

function injectStats(html) {
  if (html.includes('id="roundStatsCard"')) return html;
  const marker = '<div class="c"><input id="amount"';
  let out = html.includes(marker) ? html.replace(marker, `${statsCard}${marker}`) : html.replace('</body>', `${statsCard}</body>`);
  out = out.replace('</body>', `${statsScript}</body>`);
  return out;
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
  child.on('exit', (code, signal) => {
    log('inner_panel_exited', { code, signal });
    child = null;
    if (!stopping) setTimeout(startInner, 500);
  });
}

function proxyInner(req, res, transformHtml = false) {
  const headers = { ...req.headers, host: `127.0.0.1:${INNER_PANEL_PORT}` };
  const p = http.request({ hostname: '127.0.0.1', port: INNER_PANEL_PORT, path: req.url, method: req.method, headers }, innerRes => {
    if (!transformHtml) {
      res.writeHead(innerRes.statusCode || 502, innerRes.headers);
      innerRes.pipe(res);
      return;
    }
    const chunks = [];
    innerRes.on('data', c => chunks.push(c));
    innerRes.on('end', () => {
      const body = injectStats(Buffer.concat(chunks).toString('utf8'));
      const outHeaders = { ...innerRes.headers };
      delete outHeaders['content-length'];
      outHeaders['content-type'] = 'text/html; charset=utf-8';
      outHeaders['cache-control'] = 'no-store';
      res.writeHead(innerRes.statusCode || 200, outHeaders);
      res.end(body);
    });
  });
  p.on('error', e => {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: `内部控制台未就绪：${e.message}` }));
  });
  req.pipe(p);
}

async function proxyStats(res) {
  try {
    const r = await fetch(`${ROUND_STATS_ORIGIN}/api/round-stats`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    const text = await r.text();
    res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
  }
}

startInner();

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/round-stats') return proxyStats(res);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trade-control')) return proxyInner(req, res, true);
  return proxyInner(req, res, false);
}).listen(PORT, '0.0.0.0', () => {
  log('panel_stats_shell_started', { port: PORT, innerPanelPort: INNER_PANEL_PORT, roundStatsOrigin: ROUND_STATS_ORIGIN });
});

function shutdown(signal) {
  stopping = true;
  if (child) child.kill('SIGTERM');
  log('panel_stats_shell_stopped', { signal });
  setTimeout(() => process.exit(0), 150).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

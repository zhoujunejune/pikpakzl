import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 3000);
const INNER_PORT = Number(process.env.INNER_CONTROL_PORT || 3001);
const CONTROL_PIN_SHA256 = process.env.CONTROL_PIN_SHA256 || '';
const RISK_CONTROL_FILE = '/tmp/risk-control.json';

function log(event, extra = {}) {
  console.log(JSON.stringify({ event, shell: 'trade-control', at: new Date().toISOString(), ...extra }));
}

function pinOK(pin) {
  return crypto.createHash('sha256').update(String(pin || '')).digest('hex') === CONTROL_PIN_SHA256;
}

function envBool(name, fallback = 'false') {
  return !['0', 'false', 'off', 'no'].includes(String(process.env[name] || fallback).toLowerCase());
}

function envPercent(name, fallback = 50) {
  const n = Number(process.env[name] || fallback);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : fallback;
}

function defaultRiskConfig() {
  return {
    takeProfitEnabled: envBool('AUTO_TAKE_PROFIT_ENABLED', 'false'),
    takeProfitPercent: envPercent('AUTO_TAKE_PROFIT_PERCENT', 50),
    stopLossEnabled: envBool('AUTO_STOP_LOSS_ENABLED', 'false'),
    stopLossPercent: envPercent('AUTO_STOP_LOSS_PERCENT', 50),
    source: 'env',
    updatedAt: null,
  };
}

function readRiskConfig() {
  const fallback = defaultRiskConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(RISK_CONTROL_FILE, 'utf8'));
    const tp = Number(parsed?.takeProfitPercent);
    const sl = Number(parsed?.stopLossPercent);
    return {
      takeProfitEnabled: Boolean(parsed?.takeProfitEnabled),
      takeProfitPercent: Number.isFinite(tp) && tp >= 1 && tp <= 100 ? tp : fallback.takeProfitPercent,
      stopLossEnabled: Boolean(parsed?.stopLossEnabled),
      stopLossPercent: Number.isFinite(sl) && sl >= 1 && sl <= 100 ? sl : fallback.stopLossPercent,
      source: 'runtime',
      updatedAt: parsed?.updatedAt || null,
    };
  } catch (e) {
    if (e?.code !== 'ENOENT') log('risk_control_read_failed', { error: e?.message || String(e) });
    return fallback;
  }
}

function writeRiskConfig(next) {
  const payload = {
    takeProfitEnabled: Boolean(next.takeProfitEnabled),
    takeProfitPercent: Number(next.takeProfitPercent),
    stopLossEnabled: Boolean(next.stopLossEnabled),
    stopLossPercent: Number(next.stopLossPercent),
    updatedAt: new Date().toISOString(),
  };
  const temp = `${RISK_CONTROL_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(payload), 'utf8');
  fs.renameSync(temp, RISK_CONTROL_FILE);
  log('risk_control_updated', payload);
  return { ...payload, source: 'runtime' };
}

function validPercent(n) {
  return Number.isFinite(n) && n >= 1 && n <= 100;
}

async function readJsonBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const riskCards = `<div class="c" id="tp50Card"><div class="k">自动止盈</div><div class="big" id="tpState">读取中...</div><div class="muted" id="tpMeta">按最大可盈利空间百分比触发，达到目标后自动卖出全部份额。</div><input id="tpPercent" type="number" inputmode="decimal" min="1" max="100" step="0.1" placeholder="止盈百分比，例如 50"><button class="confirm" onclick="saveTpPercent()">保存止盈比例</button><button class="start" onclick="setTp(true)">打开自动止盈</button><button class="stop" onclick="setTp(false)">关闭自动止盈</button><div class="muted" style="margin-top:10px">例：本金 1.00，最高可得 1.52，设置 50% 时，目标可卖金额为 1.26 USDT。</div></div><div class="c" id="slCard"><div class="k">自动止损</div><div class="big" id="slState">读取中...</div><div class="muted" id="slMeta">按投入本金的损失比例触发，依据真实 SELL Quote 自动卖出全部份额。</div><input id="slPercent" type="number" inputmode="decimal" min="1" max="100" step="0.1" placeholder="止损百分比，例如 50"><button class="confirm" onclick="saveSlPercent()">保存止损比例</button><button class="start" onclick="setSl(true)">打开自动止损</button><button class="stop" onclick="setSl(false)">关闭自动止损</button><div class="muted" style="margin-top:10px">例：本金 1.00，止损 50%，真实可卖价值跌到 0.50 USDT 或更低时自动卖出全部份额。</div></div>`;

const riskScript = `<script>(function(){'use strict';var cfg={takeProfitEnabled:false,takeProfitPercent:50,stopLossEnabled:false,stopLossPercent:50};function e(i){return document.getElementById(i)}function q(m,u,b,c){var x=new XMLHttpRequest();x.open(m,u,true);x.setRequestHeader('Cache-Control','no-cache');if(m!=='GET')x.setRequestHeader('Content-Type','application/json');x.onreadystatechange=function(){if(x.readyState!==4)return;var j={};try{j=JSON.parse(x.responseText||'{}')}catch(z){j={error:'返回数据无法解析'}}c(x.status,j)};x.onerror=function(){c(0,{error:'网络请求失败'})};x.send(b?JSON.stringify(b):null)}function render(j){cfg=j||cfg;var ts=e('tpState'),ss=e('slState'),tm=e('tpMeta'),sm=e('slMeta'),tp=e('tpPercent'),sp=e('slPercent');if(ts)ts.innerHTML=cfg.takeProfitEnabled?'<span class="on">● 自动止盈已开启</span>':'<span class="off">● 自动止盈已关闭</span>';if(ss)ss.innerHTML=cfg.stopLossEnabled?'<span class="on">● 自动止损已开启</span>':'<span class="off">● 自动止损已关闭</span>';if(tp&&document.activeElement!==tp)tp.value=cfg.takeProfitPercent==null?50:cfg.takeProfitPercent;if(sp&&document.activeElement!==sp)sp.value=cfg.stopLossPercent==null?50:cfg.stopLossPercent;var src=cfg.source==='runtime'?'页面设置已生效':'使用 Railway 默认设置';if(tm)tm.textContent='当前比例：'+(cfg.takeProfitPercent==null?50:cfg.takeProfitPercent)+'% · '+src;if(sm)sm.textContent='当前比例：'+(cfg.stopLossPercent==null?50:cfg.stopLossPercent)+'% · '+src}function load(){q('GET','/api/risk-control?ts='+Date.now(),null,function(c,j){if(c!==200){var ts=e('tpState'),ss=e('slState');if(ts)ts.innerHTML='<span class="bad">● 状态读取失败</span>';if(ss)ss.innerHTML='<span class="bad">● 状态读取失败</span>';return}render(j)})}function post(next){var p=e('pin');q('POST','/api/risk-control',{takeProfitEnabled:!!next.takeProfitEnabled,takeProfitPercent:Number(next.takeProfitPercent),stopLossEnabled:!!next.stopLossEnabled,stopLossPercent:Number(next.stopLossPercent),pin:p?p.value:''},function(c,j){if(c<200||c>=300){alert((j&&j.error)||'保存风险设置失败');return}render(j)})}function val(id,label){var n=Number(e(id)&&e(id).value);if(!isFinite(n)||n<1||n>100){alert(label+'请输入 1 - 100');return null}return n}window.setTp=function(v){var n=val('tpPercent','止盈百分比');if(n==null)return;post({takeProfitEnabled:!!v,takeProfitPercent:n,stopLossEnabled:cfg.stopLossEnabled,stopLossPercent:cfg.stopLossPercent})};window.saveTpPercent=function(){window.setTp(cfg.takeProfitEnabled)};window.setSl=function(v){var n=val('slPercent','止损百分比');if(n==null)return;post({takeProfitEnabled:cfg.takeProfitEnabled,takeProfitPercent:cfg.takeProfitPercent,stopLossEnabled:!!v,stopLossPercent:n})};window.saveSlPercent=function(){window.setSl(cfg.stopLossEnabled)};function boot(){load();setInterval(load,5000)}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot()})();</script>`;

function injectRiskControls(html) {
  if (html.includes('id="slCard"')) return html;
  const marker = '<div class="c"><input id="amount"';
  let out = html.includes(marker) ? html.replace(marker, `${riskCards}${marker}`) : html.replace('</body>', `${riskCards}</body>`);
  out = out.replace('</body>', `${riskScript}</body>`);
  return out;
}

let inner = null;
let stopping = false;

function startInner() {
  inner = spawn(process.execPath, ['wrapper.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(INNER_PORT), NODE_OPTIONS: '--require=./min1-preload.cjs' },
    stdio: 'inherit',
  });
  log('inner_control_started', { pid: inner.pid, port: INNER_PORT });
  inner.on('exit', (code, signal) => {
    log('inner_control_exited', { code, signal });
    inner = null;
    if (!stopping) setTimeout(startInner, 500);
  });
}

function proxy(req, res, { transformHtml = false } = {}) {
  const headers = { ...req.headers, host: `127.0.0.1:${INNER_PORT}` };
  const p = http.request({ hostname: '127.0.0.1', port: INNER_PORT, path: req.url, method: req.method, headers }, innerRes => {
    if (!transformHtml) {
      res.writeHead(innerRes.statusCode || 502, innerRes.headers);
      innerRes.pipe(res);
      return;
    }
    const chunks = [];
    innerRes.on('data', c => chunks.push(c));
    innerRes.on('end', () => {
      const body = injectRiskControls(Buffer.concat(chunks).toString('utf8'));
      const outHeaders = { ...innerRes.headers };
      delete outHeaders['content-length'];
      outHeaders['content-type'] = 'text/html; charset=utf-8';
      outHeaders['cache-control'] = 'no-store';
      res.writeHead(innerRes.statusCode || 200, outHeaders);
      res.end(body);
    });
  });
  p.on('error', e => sendJson(res, 502, { ok: false, error: `内部控制台未就绪：${e.message}` }));
  req.pipe(p);
}

startInner();

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/risk-control') {
    return sendJson(res, 200, { ok: true, ...readRiskConfig() });
  }

  if (req.method === 'POST' && url.pathname === '/api/risk-control') {
    const body = await readJsonBody(req);
    if (!pinOK(body.pin)) return sendJson(res, 401, { ok: false, error: 'PIN 错误' });
    const current = readRiskConfig();
    const next = {
      takeProfitEnabled: body.takeProfitEnabled === undefined ? current.takeProfitEnabled : Boolean(body.takeProfitEnabled),
      takeProfitPercent: body.takeProfitPercent === undefined ? current.takeProfitPercent : Number(body.takeProfitPercent),
      stopLossEnabled: body.stopLossEnabled === undefined ? current.stopLossEnabled : Boolean(body.stopLossEnabled),
      stopLossPercent: body.stopLossPercent === undefined ? current.stopLossPercent : Number(body.stopLossPercent),
    };
    if (!validPercent(next.takeProfitPercent)) return sendJson(res, 400, { ok: false, error: '止盈百分比必须在 1% - 100% 之间' });
    if (!validPercent(next.stopLossPercent)) return sendJson(res, 400, { ok: false, error: '止损百分比必须在 1% - 100% 之间' });
    try {
      return sendJson(res, 200, { ok: true, ...writeRiskConfig(next) });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: `保存风险配置失败：${e?.message || String(e)}` });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/take-profit-control') {
    const c = readRiskConfig();
    return sendJson(res, 200, { ok: true, enabled: c.takeProfitEnabled, percent: c.takeProfitPercent, source: c.source, updatedAt: c.updatedAt });
  }

  if (req.method === 'POST' && url.pathname === '/api/take-profit-control') {
    const body = await readJsonBody(req);
    if (!pinOK(body.pin)) return sendJson(res, 401, { ok: false, error: 'PIN 错误' });
    const percent = Number(body.percent);
    if (!validPercent(percent)) return sendJson(res, 400, { ok: false, error: '止盈百分比必须在 1% - 100% 之间' });
    const current = readRiskConfig();
    try {
      const c = writeRiskConfig({ ...current, takeProfitEnabled: Boolean(body.enabled), takeProfitPercent: percent });
      return sendJson(res, 200, { ok: true, enabled: c.takeProfitEnabled, percent: c.takeProfitPercent, source: c.source, updatedAt: c.updatedAt });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: `保存止盈配置失败：${e?.message || String(e)}` });
    }
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trade-control')) return proxy(req, res, { transformHtml: true });
  return proxy(req, res);
}).listen(PORT, '0.0.0.0', () => {
  log('control_shell_started', { port: PORT, innerPort: INNER_PORT, riskControlFile: RISK_CONTROL_FILE });
});

function shutdown(signal) {
  stopping = true;
  if (inner) inner.kill('SIGTERM');
  log('control_shell_stopped', { signal });
  setTimeout(() => process.exit(0), 150).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

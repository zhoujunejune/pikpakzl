import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 3000);
const INNER_PORT = Number(process.env.INNER_CONTROL_PORT || 3001);
const CONTROL_PIN_SHA256 = process.env.CONTROL_PIN_SHA256 || '';
const TP50_CONTROL_FILE = '/tmp/tp50-control.json';

function log(event, extra = {}) {
  console.log(JSON.stringify({ event, shell: 'trade-control', at: new Date().toISOString(), ...extra }));
}

function pinOK(pin) {
  return crypto.createHash('sha256').update(String(pin || '')).digest('hex') === CONTROL_PIN_SHA256;
}

function defaultTp50Config() {
  const enabled = !['0', 'false', 'off', 'no'].includes(String(process.env.AUTO_TAKE_PROFIT_ENABLED || 'false').toLowerCase());
  const rawPercent = Number(process.env.AUTO_TAKE_PROFIT_PERCENT || 50);
  const percent = Number.isFinite(rawPercent) && rawPercent >= 1 && rawPercent <= 100 ? rawPercent : 50;
  return { enabled, percent, source: 'env', updatedAt: null };
}

function readTp50Config() {
  const fallback = defaultTp50Config();
  try {
    const parsed = JSON.parse(fs.readFileSync(TP50_CONTROL_FILE, 'utf8'));
    const rawPercent = Number(parsed?.percent);
    return {
      enabled: Boolean(parsed?.enabled),
      percent: Number.isFinite(rawPercent) && rawPercent >= 1 && rawPercent <= 100 ? rawPercent : fallback.percent,
      source: 'runtime',
      updatedAt: parsed?.updatedAt || null,
    };
  } catch (e) {
    if (e?.code !== 'ENOENT') log('tp50_control_read_failed', { error: e?.message || String(e) });
    return fallback;
  }
}

function writeTp50Config(enabled, percent) {
  const next = {
    enabled: Boolean(enabled),
    percent: Number(percent),
    updatedAt: new Date().toISOString(),
  };
  const temp = `${TP50_CONTROL_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next), 'utf8');
  fs.renameSync(temp, TP50_CONTROL_FILE);
  log('tp50_control_updated', next);
  return { ...next, source: 'runtime' };
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

const tpCard = `<div class="c" id="tp50Card"><div class="k">自动止盈</div><div class="big" id="tp50State">读取中...</div><div class="muted" id="tp50Meta">按最大利润空间的百分比触发，达到目标后自动卖出全部份额。</div><input id="tp50Percent" type="number" inputmode="decimal" min="1" max="100" step="0.1" placeholder="止盈百分比，例如 50"><button class="confirm" onclick="saveTp50Percent()">保存止盈比例</button><button class="start" onclick="setTp50(true)">打开自动止盈</button><button class="stop" onclick="setTp50(false)">关闭自动止盈</button><div class="muted" style="margin-top:10px">例：本金 1.00，最高可得 1.52，设置 50% 时，目标卖出金额为 1.26 USDT。打开/关闭或修改比例后约 0.3 秒内生效。</div></div>`;

const tpScript = `<script>(function(){'use strict';var tp50Enabled=false;function e(i){return document.getElementById(i)}function q(m,u,b,c){var x=new XMLHttpRequest();x.open(m,u,true);x.setRequestHeader('Cache-Control','no-cache');if(m!=='GET')x.setRequestHeader('Content-Type','application/json');x.onreadystatechange=function(){if(x.readyState!==4)return;var j={};try{j=JSON.parse(x.responseText||'{}')}catch(z){j={error:'返回数据无法解析'}}c(x.status,j)};x.onerror=function(){c(0,{error:'网络请求失败'})};x.send(b?JSON.stringify(b):null)}function r(){q('GET','/api/take-profit-control?ts='+Date.now(),null,function(c,j){var s=e('tp50State'),m=e('tp50Meta'),p=e('tp50Percent');if(!s)return;if(c!==200){s.innerHTML='<span class="bad">● 状态读取失败</span>';if(m)m.textContent=(j&&j.error)||'无法读取止盈设置';return}tp50Enabled=!!j.enabled;s.innerHTML=tp50Enabled?'<span class="on">● 自动止盈已开启</span>':'<span class="off">● 自动止盈已关闭</span>';if(p&&document.activeElement!==p)p.value=j.percent==null?50:j.percent;if(m)m.textContent='当前比例：'+(j.percent==null?50:j.percent)+'% · '+(j.source==='runtime'?'页面设置已生效':'使用 Railway 默认设置')})}function s(v){var p=e('tp50Percent'),n=e('pin'),x=Number(p&&p.value);if(!isFinite(x)||x<1||x>100){alert('止盈百分比请输入 1 - 100');return}q('POST','/api/take-profit-control',{enabled:!!v,percent:x,pin:n?n.value:''},function(c,j){if(c<200||c>=300){alert((j&&j.error)||'保存止盈设置失败');return}tp50Enabled=!!j.enabled;r()})}window.setTp50=function(v){s(!!v)};window.saveTp50Percent=function(){s(tp50Enabled)};function b(){r();setInterval(r,2000)}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',b);else b()})();</script>`;

function injectTpControls(html) {
  if (html.includes('id="tp50Card"')) return html;
  const marker = '<div class="c"><input id="amount"';
  let out = html.includes(marker) ? html.replace(marker, `${tpCard}${marker}`) : html.replace('</body>', `${tpCard}</body>`);
  out = out.replace('</body>', `${tpScript}</body>`);
  return out;
}

let inner = null;
let stopping = false;

function startInner() {
  inner = spawn(process.execPath, ['wrapper.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(INNER_PORT),
      NODE_OPTIONS: '--require=./min1-preload.cjs',
    },
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
  const p = http.request({
    hostname: '127.0.0.1',
    port: INNER_PORT,
    path: req.url,
    method: req.method,
    headers,
  }, innerRes => {
    if (!transformHtml) {
      res.writeHead(innerRes.statusCode || 502, innerRes.headers);
      innerRes.pipe(res);
      return;
    }
    const chunks = [];
    innerRes.on('data', c => chunks.push(c));
    innerRes.on('end', () => {
      const body = injectTpControls(Buffer.concat(chunks).toString('utf8'));
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

  if (req.method === 'GET' && url.pathname === '/api/take-profit-control') {
    return sendJson(res, 200, { ok: true, ...readTp50Config() });
  }

  if (req.method === 'POST' && url.pathname === '/api/take-profit-control') {
    const body = await readJsonBody(req);
    if (!pinOK(body.pin)) return sendJson(res, 401, { ok: false, error: 'PIN 错误' });
    const percent = Number(body.percent);
    if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
      return sendJson(res, 400, { ok: false, error: '止盈百分比必须在 1% - 100% 之间' });
    }
    try {
      return sendJson(res, 200, { ok: true, ...writeTp50Config(Boolean(body.enabled), percent) });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: `保存止盈配置失败：${e?.message || String(e)}` });
    }
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trade-control')) {
    return proxy(req, res, { transformHtml: true });
  }

  return proxy(req, res);
}).listen(PORT, '0.0.0.0', () => {
  log('control_shell_started', { port: PORT, innerPort: INNER_PORT, tp50ControlFile: TP50_CONTROL_FILE });
});

function shutdown(signal) {
  stopping = true;
  if (inner) inner.kill('SIGTERM');
  log('control_shell_stopped', { signal });
  setTimeout(() => process.exit(0), 150).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

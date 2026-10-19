import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { RISK_CONFIG_FILE as RISK_CONTROL_FILE, hydrateRiskConfig, persistRiskConfig } from './risk-config-storage.mjs';

const PORT = Number(process.env.PORT || 3000);
const INNER_PORT = Number(process.env.INNER_CONTROL_PORT || 3001);
const CONTROL_PIN_SHA256 = process.env.CONTROL_PIN_SHA256 || '';

let persistenceReady = false;
let persistenceHealthy = false;
let persistenceRestored = false;
let persistenceError = null;
let syncInFlight = false;
let writeChain = Promise.resolve();
async function syncRiskConfig() {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    const result = await hydrateRiskConfig();
    persistenceHealthy = true;
    persistenceRestored = Boolean(result.restored);
    persistenceError = null;
  } catch (error) {
    persistenceHealthy = false;
    persistenceError = String(error?.message || error);
    log('risk_persistence_restore_failed', { error: persistenceError });
  } finally {
    persistenceReady = true;
    syncInFlight = false;
  }
}
void syncRiskConfig();
const persistenceSyncTimer = setInterval(() => void syncRiskConfig(), 15000);
function serializedRiskWrite(operation) {
  const next = writeChain.catch(() => {}).then(operation);
  writeChain = next;
  return next;
}

function log(event, extra = {}) {
  console.log(JSON.stringify({ event, shell: 'trade-control', at: new Date().toISOString(), ...extra }));
}

// For Alibaba only: the entire public entrypoint is behind Caddy Basic Auth.
// Do not accept a request merely because a PIN was omitted. The proxy must
// assert authenticated ingress, and POSTs must be same-origin browser requests.
function pinOK(pin, req) {
  if (process.env.ZL_OUTER_AUTH_ONLY === 'true') {
    const origin = String(process.env.ZL_PUBLIC_ORIGIN || '');
    return Boolean(req && origin.startsWith('https://') &&
      req.headers['x-zl-verified-login'] === '1' &&
      req.headers.origin === origin &&
      req.headers['sec-fetch-site'] === 'same-origin');
  }
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

// The dedicated risk runner reports actual monitoring readiness. A saved
// switch is not evidence that a Binance exit order can be executed.
const RISK_RUNTIME_STATUS_FILE = process.env.RISK_STATUS_FILE || '/tmp/risk-runtime-status.json';
function riskExecutionStatus(){
  try{
    const j=JSON.parse(fs.readFileSync(RISK_RUNTIME_STATUS_FILE,'utf8'));
    const ts=Date.parse(j.at);
    if(!Number.isFinite(ts)||Math.abs(Date.now()-ts)>15000)
      return {ready:false,reason:'RISK_CONTROLLER_STATUS_STALE'};
    return {ready:true,enabled:j.enabled===true,
      workerRunning:j.workerRunning===true,configApplied:j.configApplied===true,
      persistenceHealthy:j.persistenceHealthy===true,
      updatedAt:j.at};
  }catch{
    return {ready:false,reason:'RISK_CONTROLLER_NOT_RUNNING'};
  }
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
      source: persistenceHealthy && persistenceRestored ? 'redis' : 'runtime',
      updatedAt: parsed?.updatedAt || null,
    };
  } catch (e) {
    if (e?.code !== 'ENOENT') log('risk_control_read_failed', { error: e?.message || String(e) });
    return fallback;
  }
}

async function writeRiskConfig(next) {
  const payload = {
    takeProfitEnabled: Boolean(next.takeProfitEnabled),
    takeProfitPercent: Number(next.takeProfitPercent),
    stopLossEnabled: Boolean(next.stopLossEnabled),
    stopLossPercent: Number(next.stopLossPercent),
    updatedAt: new Date().toISOString(),
  };
  const persisted = await persistRiskConfig(payload);
  persistenceHealthy = true;
  persistenceRestored = true;
  persistenceError = null;
  log('risk_control_updated', payload);
  return persisted;
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

const riskCards = "<style>\n.risk-combined{border:1px solid #333b4b}\n.risk-group-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}\n.risk-group-title{font-weight:800;font-size:22px;margin:4px 0}\n.risk-flag{font-size:11px;color:#b6c1d7;white-space:nowrap;border:1px solid #414b5d;border-radius:999px;padding:6px 9px}\n.risk-row{margin-top:12px;background:#111721;border:1px solid #354052;border-radius:13px;overflow:hidden}\n.risk-row:focus-within{border-color:#566786}\n.risk-row details>summary{cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;list-style:none;padding:14px 12px;min-height:64px;-webkit-tap-highlight-color:transparent}\n.risk-row details>summary::-webkit-details-marker{display:none}\n.risk-row details>summary:focus-visible{outline:2px solid #f0b90b;outline-offset:-2px}\n.risk-row details[open]>summary{border-bottom:1px solid #354052;background:#1c2432}\n.risk-summary-title{display:flex;flex-direction:column;min-width:0;gap:3px;flex:1}\n.risk-summary-title strong{font-size:17px}\n.risk-summary-title small{font-size:12px;color:#a8b0bd}\n.risk-summary-data{text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:3px;white-space:nowrap}\n.risk-reading{font-size:22px;font-weight:850;line-height:1.2}\n.risk-tag{font-size:12px}\n.risk-toggle-chevron{color:#a8b0bd;font-size:20px;padding-left:2px;transition:transform .12s}\n.risk-row details[open] .risk-toggle-chevron{transform:rotate(180deg)}\n.risk-edit-body{padding:12px}\n.risk-input-pair{display:grid;grid-template-columns:minmax(0,1fr) 108px;gap:10px;align-items:center}\n.risk-input-pair input{margin:8px 0}\n.risk-input-pair input[type=range]{accent-color:#f0b90b;padding:3px;border:none;background:transparent}\n.risk-input-pair input[type=number]{padding:12px 9px;text-align:center}\n.risk-presets{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-top:8px}\n.risk-presets button{margin:0;padding:10px 3px;width:100%;font-size:13px;color:#e3ebfa;background:#293347;border:1px solid #47536a}\n.risk-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}\n.risk-actions button{padding:12px 5px;font-size:14px}\n.risk-notice{font-size:13px;line-height:1.4;padding:0 12px}\n.risk-notice:not(:empty){padding:9px 12px}\n.risk-helper{color:#a8b0bd;font-size:13px;line-height:1.6;margin-top:10px}\n</style>\n<div class=\"c risk-combined\" id=\"riskControlsCard\">\n  <div class=\"risk-group-head\">\n    <div><div class=\"k\">止盈止损设置</div><div class=\"risk-group-title\">自动止盈止损</div></div>\n    <span class=\"risk-flag\">两个参数分别设置</span>\n  </div>\n  <div class=\"muted\">点击下方“止盈”或“止损”一行即可调整。修改比例不会改变另一项，也不会自动切换开关。</div>\n  <div class=\"risk-row\" id=\"tp50Card\">\n    <details id=\"tpEditor\">\n      <summary onclick=\"riskOpen('tp')\" aria-label=\"点此调整止盈比例\">\n        <span class=\"risk-summary-title\"><strong>自动止盈</strong><small>点此调整止盈比例</small></span>\n        <span class=\"risk-summary-data\"><span class=\"risk-reading\" id=\"tpValue\">--%</span><span class=\"risk-tag\" id=\"tpState\">读取中</span></span>\n        <span class=\"risk-toggle-chevron\" aria-hidden=\"true\">⌄</span>\n      </summary>\n      <div class=\"risk-edit-body\">\n        <div class=\"muted\" id=\"tpMeta\">正在读取当前生效比例...</div>\n        <label class=\"k\" for=\"tpPercent\">止盈目标百分比（1%—100%）</label>\n        <div class=\"risk-input-pair\">\n          <input aria-label=\"止盈比例滑块\" id=\"tpRange\" type=\"range\" min=\"1\" max=\"100\" step=\"0.1\" oninput=\"riskSync('tp','range')\">\n          <input aria-label=\"止盈比例数字\" id=\"tpPercent\" type=\"number\" inputmode=\"decimal\" min=\"1\" max=\"100\" step=\"0.1\" oninput=\"riskSync('tp','number')\">\n        </div>\n        <div class=\"risk-presets\">\n          <button type=\"button\" onclick=\"riskPreset('tp',10)\">10%</button>\n          <button type=\"button\" onclick=\"riskPreset('tp',25)\">25%</button>\n          <button type=\"button\" onclick=\"riskPreset('tp',50)\">50%</button>\n          <button type=\"button\" onclick=\"riskPreset('tp',75)\">75%</button>\n        </div>\n        <input type=\"hidden\" id=\"tpPin\" autocomplete=\"off\" inputmode=\"numeric\" placeholder=\"无需二次控制 PIN\" aria-label=\"止盈控制 PIN\">\n        <button type=\"button\" class=\"confirm\" onclick=\"saveTpPercent()\">保存止盈比例</button>\n        <div class=\"risk-actions\">\n          <button type=\"button\" class=\"start\" onclick=\"setTp(true)\">启用止盈</button>\n          <button type=\"button\" class=\"stop\" onclick=\"setTp(false)\">关闭止盈</button>\n        </div>\n        <div class=\"risk-helper\">止盈按最大可盈利空间百分比触发。例如本金 1.00、最高可得 1.52，设置50%时目标可卖金额约1.26 USDT。保存比例不会开启或关闭止盈。</div>\n      </div>\n    </details>\n    <div class=\"risk-notice\" id=\"tpNotice\" role=\"status\" aria-live=\"polite\"></div>\n  </div>\n  <div class=\"risk-row\" id=\"slCard\">\n    <details id=\"slEditor\">\n      <summary onclick=\"riskOpen('sl')\" aria-label=\"点此调整止损比例\">\n        <span class=\"risk-summary-title\"><strong>自动止损</strong><small>点此调整止损比例</small></span>\n        <span class=\"risk-summary-data\"><span class=\"risk-reading\" id=\"slValue\">--%</span><span class=\"risk-tag\" id=\"slState\">读取中</span></span>\n        <span class=\"risk-toggle-chevron\" aria-hidden=\"true\">⌄</span>\n      </summary>\n      <div class=\"risk-edit-body\">\n        <div class=\"muted\" id=\"slMeta\">正在读取当前生效比例...</div>\n        <label class=\"k\" for=\"slPercent\">止损百分比（1%—100%）</label>\n        <div class=\"risk-input-pair\">\n          <input aria-label=\"止损比例滑块\" id=\"slRange\" type=\"range\" min=\"1\" max=\"100\" step=\"0.1\" oninput=\"riskSync('sl','range')\">\n          <input aria-label=\"止损比例数字\" id=\"slPercent\" type=\"number\" inputmode=\"decimal\" min=\"1\" max=\"100\" step=\"0.1\" oninput=\"riskSync('sl','number')\">\n        </div>\n        <div class=\"risk-presets\">\n          <button type=\"button\" onclick=\"riskPreset('sl',10)\">10%</button>\n          <button type=\"button\" onclick=\"riskPreset('sl',25)\">25%</button>\n          <button type=\"button\" onclick=\"riskPreset('sl',50)\">50%</button>\n          <button type=\"button\" onclick=\"riskPreset('sl',75)\">75%</button>\n        </div>\n        <input type=\"hidden\" id=\"slPin\" autocomplete=\"off\" inputmode=\"numeric\" placeholder=\"无需二次控制 PIN\" aria-label=\"止损控制 PIN\">\n        <button type=\"button\" class=\"confirm\" onclick=\"saveSlPercent()\">保存止损比例</button>\n        <div class=\"risk-actions\">\n          <button type=\"button\" class=\"start\" onclick=\"setSl(true)\">启用止损</button>\n          <button type=\"button\" class=\"stop\" onclick=\"setSl(false)\">关闭止损</button>\n        </div>\n        <div class=\"risk-helper\">止损按投入本金的损失比例触发，以真实SELL Quote计算。例如本金1.00，设置50%，真实可卖价值跌到0.50 USDT或以下时触发。保存比例不影响止盈。</div>\n      </div>\n    </details>\n    <div class=\"risk-notice\" id=\"slNotice\" role=\"status\" aria-live=\"polite\"></div>\n  </div>\n  <div class=\"risk-helper\">百分比和开关分别保存，已通过阿里云 HTTPS 登录认证。当前生效值及开关状态显示在两行右侧。</div>\n</div>";

const riskScript = "<script>(function(){\n'use strict';\nvar cfg={takeProfitEnabled:false,takeProfitPercent:50,stopLossEnabled:false,stopLossPercent:50,source:'env'};\nvar busy=false;\nfunction e(id){return document.getElementById(id)}\nfunction pct(value){var n=Number(value);return Number.isFinite(n)?String(Math.round(n*10)/10)+'%':'--%'}\nfunction note(kind,message,bad){var el=e(kind+'Notice');if(el){el.textContent=message||'';el.className='risk-notice '+(bad?'bad':'on')}}\nfunction xhr(method,path,body,cb){\n var x=new XMLHttpRequest();x.open(method,path,true);x.setRequestHeader('Cache-Control','no-cache');\n if(method!=='GET')x.setRequestHeader('Content-Type','application/json');\n x.onreadystatechange=function(){if(x.readyState!==4)return;var data;try{data=JSON.parse(x.responseText||'{}')}catch(_){data={error:'返回数据无法解析'}}cb(x.status,data)};\n x.onerror=function(){cb(0,{error:'网络请求失败'})};x.send(body?JSON.stringify(body):null);\n}\nfunction sync(kind,n){\n var input=e(kind+'Percent'),range=e(kind+'Range');\n if(input)input.value=n;if(range)range.value=n;\n}\nfunction render(next){\n if(!next||next.ok===false)return;\n cfg={...cfg,...next};\n for(var i=0;i<2;i++){\n  var kind=i===0?'tp':'sl',on=i===0?!!cfg.takeProfitEnabled:!!cfg.stopLossEnabled;\n  var n=i===0?cfg.takeProfitPercent:cfg.stopLossPercent;\n  var state=e(kind+'State'),value=e(kind+'Value'),meta=e(kind+'Meta'),editor=e(kind+'Editor');\n  if(state){state.textContent=on?'● 已启用':'● 已关闭';state.className='risk-tag '+(on?'on':'off')}\n  if(value)value.textContent=pct(n);\n  if(meta)meta.textContent='当前已保存：'+pct(n)+' · '+(cfg.source==='redis'?'Redis 持久化':cfg.source==='runtime'?'运行时配置':'默认配置')+(cfg.persistenceReady&&!cfg.persistenceHealthy?' · ⚠ 持久化存储不可用':'')+(cfg.execution?.ready?(cfg.execution.enabled&&!cfg.execution.configApplied?' · ⚠ 监控程序尚未就绪':cfg.execution.enabled?' · 后台监控中':' · 监控待命'):' · ⚠ 监控服务不可用');\n  if(!editor||!editor.open)sync(kind,n==null?50:n);\n }\n}\nfunction load(){\n if(busy)return;\n xhr('GET','/api/risk-control?ts='+Date.now(),null,function(status,data){\n  if(status!==200||!data||data.ok===false){\n   if(!cfg.updatedAt){for(var i=0;i<2;i++){var kind=i?'sl':'tp',s=e(kind+'State');if(s)s.textContent='● 读取失败'}}\n   return;\n  }\n  render(data);\n });\n}\nwindow.riskOpen=function(kind){\n if(kind!=='tp'&&kind!=='sl')return;\n var other=kind==='tp'?'sl':'tp',previous=e(other+'Editor');\n if(previous&&previous.open){previous.open=false;var last=other==='tp'?cfg.takeProfitPercent:cfg.stopLossPercent;sync(other,last==null?50:last)}\n var n=kind==='tp'?cfg.takeProfitPercent:cfg.stopLossPercent;\n sync(kind,n==null?50:n);\n note(kind,'',false);\n};\nwindow.riskSync=function(kind,from){\n if(kind!=='tp'&&kind!=='sl')return;\n var a=e(kind+'Percent'),b=e(kind+'Range');if(!a||!b)return;\n if(from==='range')a.value=b.value;\n else if(from==='number'&&a.value.trim()!==''&&Number(a.value)>=1&&Number(a.value)<=100)b.value=a.value;\n};\nwindow.riskPreset=function(kind,value){\n if(kind!=='tp'&&kind!=='sl')return;\n sync(kind,value);\n};\nfunction valid(kind){\n var a=e(kind+'Percent');var raw=a?String(a.value).trim():'';\n var n=raw===''?NaN:Number(raw);\n if(!Number.isFinite(n)||n<1||n>100){note(kind,'请输入1%到100%之间的比例',true);return null}\n return n;\n}\nfunction post(change,kind,message){\n if(busy){note(kind,'正在保存，请勿重复点击',true);return}\n // Authenticated website controls authorization; no second PIN input.\n busy=true;note(kind,'正在保存...',false);\n xhr('POST','/api/risk-control',{...change},function(status,data){\n  busy=false;\n  if(status<200||status>=300||!data||data.ok===false){\n   note(kind,(data&&data.error)||'保存失败，请重试',true);\n   return;\n  }\n  render(data);\n  var editor=e(kind+'Editor');if(editor)editor.open=false;\n  note(kind,message+' · 已保存到后台；执行状态请以监控提示为准',false);\n });\n}\nwindow.saveTpPercent=function(){var value=valid('tp');if(value!==null)post({takeProfitPercent:value},'tp','止盈比例 '+pct(value))};\nwindow.saveSlPercent=function(){var value=valid('sl');if(value!==null)post({stopLossPercent:value},'sl','止损比例 '+pct(value))};\nwindow.setTp=function(on){post({takeProfitEnabled:!!on},'tp',on?'自动止盈已启用':'自动止盈已关闭')};\nwindow.setSl=function(on){post({stopLossEnabled:!!on},'sl',on?'自动止损已启用':'自动止损已关闭')};\n\nfunction boot(){load();setInterval(load,5000)}\n\nif(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();\n})();</script>";

function injectRiskControls(html) {
  if (html.includes('id="slCard"')) return html;
  const marker = '<div id="riskControlsAnchor"></div>';
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
  // Render Free cold starts can expose the outer proxy before port 3001 listens.
  // Retry only idempotent reads; NEVER replay a money-moving POST.
  const safeRead = req.method === 'GET' || req.method === 'HEAD';
  const maxRetries = safeRead ? 30 : 0;
  const attempt = (n = 0) => {
    if (res.destroyed || res.writableEnded) return;
    const headers = { ...req.headers, host: `127.0.0.1:${INNER_PORT}` };
    const p = http.request({ hostname: '127.0.0.1', port: INNER_PORT, path: req.url, method: req.method, headers }, innerRes => {
      if (n) log('inner_control_proxy_recovered', { attempts:n, port:INNER_PORT });
      if (!transformHtml) {
        res.writeHead(innerRes.statusCode || 502, innerRes.headers);
        innerRes.pipe(res);
        return;
      }
      const chunks = [];
      innerRes.on('data', c => chunks.push(c));
      innerRes.on('end', () => {
        if (res.destroyed || res.writableEnded) return;
        const body = injectRiskControls(Buffer.concat(chunks).toString('utf8'));
        const outHeaders = { ...innerRes.headers };
        delete outHeaders['content-length'];
        outHeaders['content-type'] = 'text/html; charset=utf-8';
        outHeaders['cache-control'] = 'no-store';
        res.writeHead(innerRes.statusCode || 200, outHeaders);
        res.end(body);
      });
    });
    p.on('error', e => {
      if (safeRead && e?.code === 'ECONNREFUSED' && n < maxRetries &&
          !res.headersSent && !res.destroyed) {
        if (n === 0) log('inner_control_startup_wait', { port:INNER_PORT });
        setTimeout(() => attempt(n + 1), 400).unref();
        return;
      }
      if (!res.headersSent && !res.destroyed) {
        res.setHeader('cache-control', 'no-store');
        res.setHeader('retry-after', '2');
        sendJson(res, 503, { ok:false,
          error:'内部控制台暂未就绪，请稍后重试',
          reason:e?.code || 'INNER_CONTROL_UNAVAILABLE' });
      }
    });
    if (safeRead) p.end();
    else req.pipe(p);
  };
  attempt();
}

startInner();

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/risk-control') {
    return sendJson(res, 200, { ok: true, ...readRiskConfig(), persistenceReady, persistenceHealthy, persistenceRestored, execution:riskExecutionStatus() });
  }

  if (req.method === 'POST' && url.pathname === '/api/risk-control') {
    const body = await readJsonBody(req);
    if (!pinOK(body.pin, req)) return sendJson(res, 401, { ok: false, error: '站点登录未通过或请求来源不符，请重新登录' });
    if (!persistenceReady || !persistenceHealthy) return sendJson(res, 503, { ok: false, error: '持久化存储不可用，已阻止可能丢失的配置修改；请检查 Redis 状态' });
    try {
      const updated = await serializedRiskWrite(async () => {
        const current = readRiskConfig();
        const next = {
          takeProfitEnabled: body.takeProfitEnabled === undefined ? current.takeProfitEnabled : Boolean(body.takeProfitEnabled),
          takeProfitPercent: body.takeProfitPercent === undefined ? current.takeProfitPercent : Number(body.takeProfitPercent),
          stopLossEnabled: body.stopLossEnabled === undefined ? current.stopLossEnabled : Boolean(body.stopLossEnabled),
          stopLossPercent: body.stopLossPercent === undefined ? current.stopLossPercent : Number(body.stopLossPercent),
        };
        if (!validPercent(next.takeProfitPercent)) throw new RangeError('止盈百分比必须在 1% - 100% 之间');
        if (!validPercent(next.stopLossPercent)) throw new RangeError('止损百分比必须在 1% - 100% 之间');
        return await writeRiskConfig(next);
      });
      return sendJson(res, 200, { ok: true, ...updated });
    } catch (e) {
      return sendJson(res, e instanceof RangeError ? 400 : 503, { ok: false, error: `保存风险配置失败：${e?.message || String(e)}` });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/take-profit-control') {
    const c = readRiskConfig();
    return sendJson(res, 200, { ok: true, enabled: c.takeProfitEnabled, percent: c.takeProfitPercent, source: c.source, updatedAt: c.updatedAt });
  }

  if (req.method === 'POST' && url.pathname === '/api/take-profit-control') {
    const body = await readJsonBody(req);
    if (!pinOK(body.pin, req)) return sendJson(res, 401, { ok: false, error: '站点登录未通过或请求来源不符，请重新登录' });
    const percent = Number(body.percent);
    if (!validPercent(percent)) return sendJson(res, 400, { ok: false, error: '止盈百分比必须在 1% - 100% 之间' });
    if (!persistenceReady || !persistenceHealthy) return sendJson(res, 503, { ok: false, error: '持久化存储不可用，暂不允许修改止盈配置' });
    try {
      const c = await serializedRiskWrite(async () => writeRiskConfig({ ...readRiskConfig(), takeProfitEnabled: Boolean(body.enabled), takeProfitPercent: percent }));
      return sendJson(res, 200, { ok: true, enabled: c.takeProfitEnabled, percent: c.takeProfitPercent, source: c.source, updatedAt: c.updatedAt });
    } catch (e) {
      return sendJson(res, 503, { ok: false, error: `保存止盈配置失败：${e?.message || String(e)}` });
    }
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trade-control')) return proxy(req, res, { transformHtml: true });
  return proxy(req, res);
}).listen(PORT, '127.0.0.1', () => {
  log('control_shell_started', { port: PORT, innerPort: INNER_PORT, riskControlFile: RISK_CONTROL_FILE });
});

function shutdown(signal) {
  stopping = true;
  clearInterval(persistenceSyncTimer);
  if (inner) inner.kill('SIGTERM');
  log('control_shell_stopped', { signal });
  setTimeout(() => process.exit(0), 150).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

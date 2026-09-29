import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const SITE_ORIGIN = (process.env.SITE_ORIGIN || '').replace(/\/+$/, '');
const CONTROL_PIN_SHA256 = process.env.CONTROL_PIN_SHA256 || '';

let enabled = false;
let lastRound = null;
let lastAction = null;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function pinOK(pin) {
  return crypto.createHash('sha256').update(String(pin || '')).digest('hex') === CONTROL_PIN_SHA256;
}

async function getSignal() {
  if (!SITE_ORIGIN) return null;
  try {
    const res = await fetch(`${SITE_ORIGIN}/api/local-predictions`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const record = Array.isArray(json?.records) ? json.records[0] : null;
    const source = record || json?.live || null;
    if (!source) return null;
    return {
      round: source.round ?? source.input?.round ?? null,
      status: source.status ?? (source.signal ? 'LOCKED' : 'WAIT'),
      direction: source.signal?.direction ?? null,
      score: source.signal?.score ?? null,
    };
  } catch {
    return null;
  }
}

async function dryRunWorker() {
  if (!enabled) return;
  const signal = await getSignal();
  if (!signal) return;
  if (signal.status !== 'LOCKED') return;
  if (!signal.round) return;
  if (!['UP', 'DOWN'].includes(signal.direction)) return;
  if (String(signal.round) === String(lastRound)) return;

  lastRound = signal.round;
  lastAction = {
    at: new Date().toISOString(),
    round: signal.round,
    signal: signal.direction,
    score: signal.score,
    action: signal.direction === 'UP' ? 'BUY_UP' : 'BUY_DOWN',
    mode: 'DRY_RUN',
    realOrderPlaced: false,
  };
  console.log(JSON.stringify({ event: 'dry_run_action', ...lastAction }));
}

setInterval(dryRunWorker, 5000);

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>5分钟自动执行控制台</title>
<style>
body{font-family:system-ui,-apple-system;background:#0f1117;color:#fff;margin:0;padding:18px}
.w{max-width:520px;margin:auto}.c{background:#191d27;border-radius:18px;padding:18px;margin:14px 0}
.big{font-size:26px;font-weight:800}.on{color:#3ddc84}.off{color:#ff6868}.muted{color:#a8b0bd;font-size:14px;line-height:1.6}
input,button{width:100%;box-sizing:border-box;padding:15px;border-radius:12px;margin-top:10px;font-size:17px}
input{background:#0d1016;color:white;border:1px solid #3b4352}button{border:0;font-weight:800}
.start{background:#28c76f;color:#06150b}.stop{background:#ff5c62;color:white}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.kv{background:#10141c;padding:12px;border-radius:12px}.k{font-size:12px;color:#8f98a8}.v{font-size:17px;font-weight:700;margin-top:4px}
</style>
</head>
<body><div class="w">
<h2>5分钟自动执行控制台</h2>
<div class="c"><div id="switch" class="big">加载中...</div><div class="muted">当前模式：DRY_RUN（模拟执行，不会提交真钱订单）</div></div>
<div class="c"><div class="grid">
<div class="kv"><div class="k">当前轮次</div><div class="v" id="round">-</div></div>
<div class="kv"><div class="k">状态</div><div class="v" id="status">-</div></div>
<div class="kv"><div class="k">方向</div><div class="v" id="direction">-</div></div>
<div class="kv"><div class="k">Score</div><div class="v" id="score">-</div></div>
</div><div class="muted" id="last" style="margin-top:12px">最近动作：-</div></div>
<div class="c"><input id="pin" inputmode="numeric" placeholder="输入控制 PIN">
<button class="start" onclick="setV(true)">开启每5分钟自动执行</button>
<button class="stop" onclick="setV(false)">关闭自动执行</button>
<div class="muted">开启后只处理新的 LOCKED 轮次；同一个 round 只处理一次。关闭后停止后续轮次。</div></div>
</div>
<script>
async function refresh(){
  try{
    const j=await(await fetch('/api/status',{cache:'no-store'})).json();
    document.getElementById('switch').innerHTML=j.enabled?'<span class="on">● 自动执行已开启</span>':'<span class="off">● 自动执行已关闭</span>';
    const s=j.signal||{};
    document.getElementById('round').textContent=s.round??'-';
    document.getElementById('status').textContent=s.status??'-';
    document.getElementById('direction').textContent=s.direction??'-';
    document.getElementById('score').textContent=s.score==null?'-':Number(s.score).toFixed(2);
    document.getElementById('last').textContent='最近动作：'+(j.lastAction?j.lastAction.action+' / round '+j.lastAction.round:'-');
  }catch(e){document.getElementById('switch').textContent='状态读取失败'}
}
async function setV(v){
  const r=await fetch('/api/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:v,pin:document.getElementById('pin').value})});
  const j=await r.json();
  if(!r.ok){alert(j.error||'操作失败');return}
  refresh();
}
refresh();setInterval(refresh,3000);
</script>
</body></html>`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return send(res, 200, { ok: true, mode: 'DRY_RUN', hasSiteOrigin: Boolean(SITE_ORIGIN) });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trade-control')) {
    return send(res, 200, page, 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const signal = await getSignal();
    return send(res, 200, { ok: true, enabled, mode: 'DRY_RUN', signal, lastAction });
  }

  if (req.method === 'POST' && url.pathname === '/api/control') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}

    if (!pinOK(body.pin)) {
      return send(res, 401, { ok: false, error: 'PIN 错误' });
    }

    enabled = Boolean(body.enabled);
    console.log(JSON.stringify({ event: 'dry_run_control', enabled, at: new Date().toISOString() }));
    return send(res, 200, { ok: true, enabled, mode: 'DRY_RUN' });
  }

  return send(res, 404, { ok: false, error: 'Not found' });
}).listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'control_panel_started', port: PORT, mode: 'DRY_RUN', hasSiteOrigin: Boolean(SITE_ORIGIN) }));
});

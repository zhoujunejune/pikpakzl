import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const SITE_ORIGIN = (process.env.SITE_ORIGIN || '').replace(/\/+$/, '');
const CONTROL_PIN_SHA256 = process.env.CONTROL_PIN_SHA256 || '';
const BINANCE_API_KEY = process.env.BINANCE_PREDICTION_API_KEY || '';
const BINANCE_API_SECRET = process.env.BINANCE_PREDICTION_API_SECRET || '';
const PREDICTION_WALLET_ADDRESS = process.env.BINANCE_PREDICTION_WALLET_ADDRESS || '';

let enabled = false;
let tradeAmount = null;
let lastRound = null;
let startAfterRound = null;
let pendingAction = null;
let lastBalance = null;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function pinOK(pin) {
  return crypto.createHash('sha256').update(String(pin || '')).digest('hex') === CONTROL_PIN_SHA256;
}

function signQuery(query) {
  return crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
}

function binanceMarketUrl(round) {
  const n = Number(round);
  if (!Number.isFinite(n) || n <= 0) return 'https://web3.binance.com/prediction';
  const seconds = n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  return `https://web3.binance.com/prediction/detail/btc-updown-5m-${seconds}`;
}

async function getPaymentBalances() {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    return { ok: false, error: 'BINANCE_API_CREDENTIALS_MISSING', items: [] };
  }
  try {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}&recvWindow=5000`;
    const signature = signQuery(query);
    const url = `https://api.binance.com/sapi/v1/w3w/wallet/prediction/balance/payment-options?${query}&signature=${signature}`;
    const r = await fetch(url, {
      headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    if (!r.ok) {
      return { ok: false, status: r.status, error: data?.msg || data?.message || 'BINANCE_BALANCE_QUERY_FAILED', code: data?.code ?? null, items: [] };
    }
    const items = Array.isArray(data?.items) ? data.items.map(x => ({
      accountType: x.accountType ?? null,
      availableBalanceDisplay: x.availableBalanceDisplay ?? null,
      enabled: Boolean(x.enabled),
    })) : [];
    return { ok: true, items, checkedAt: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: e?.message || 'BINANCE_BALANCE_QUERY_ERROR', items: [] };
  }
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
    const source = json?.live || null;
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

async function prepareWorker() {
  if (!enabled || !(tradeAmount > 0)) return;
  const signal = await getSignal();
  if (!signal || signal.status !== 'LOCKED' || !signal.round || !['UP', 'DOWN'].includes(signal.direction)) return;
  if (startAfterRound != null && String(signal.round) === String(startAfterRound)) return;
  if (String(signal.round) === String(lastRound)) return;

  lastRound = signal.round;
  pendingAction = {
    at: new Date().toISOString(),
    round: signal.round,
    signal: signal.direction,
    score: signal.score,
    action: signal.direction === 'UP' ? 'BUY_UP' : 'BUY_DOWN',
    amount: tradeAmount,
    marketUrl: binanceMarketUrl(signal.round),
    mode: 'MANUAL_LIVE',
    submittedByServer: false,
  };
  console.log(JSON.stringify({ event: 'manual_live_prepared', ...pendingAction }));
}

setInterval(prepareWorker, 3000);

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>5分钟实盘准备控制台</title>
<style>
body{font-family:system-ui,-apple-system;background:#0f1117;color:#fff;margin:0;padding:18px}.w{max-width:560px;margin:auto}.c{background:#191d27;border-radius:18px;padding:18px;margin:14px 0}.big{font-size:26px;font-weight:800}.on{color:#3ddc84}.off{color:#ff6868}.muted{color:#a8b0bd;font-size:14px;line-height:1.6}input,button,.linkbtn{width:100%;box-sizing:border-box;padding:15px;border-radius:12px;margin-top:10px;font-size:17px}input{background:#0d1016;color:white;border:1px solid #3b4352}button,.linkbtn{border:0;font-weight:800;text-align:center;display:block;text-decoration:none}.start{background:#28c76f;color:#06150b}.stop{background:#ff5c62;color:white}.open{background:#f0b90b;color:#171717}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.kv{background:#10141c;padding:12px;border-radius:12px}.k{font-size:12px;color:#8f98a8}.v{font-size:17px;font-weight:700;margin-top:4px}.wallet{font-size:30px;font-weight:900;margin-top:6px}.ok{color:#3ddc84}.bad{color:#ff6868}.pending{border:1px solid #3f4655}.hidden{display:none}
</style>
</head>
<body><div class="w">
<h2>5分钟实盘准备控制台</h2>
<div class="c"><div id="switch" class="big">加载中...</div><div class="muted">当前模式：MANUAL_LIVE。系统自动跟随新一轮锁定信号准备下单信息，但不会替你提交资金交易；最后一步由你在 Binance 页面亲自确认。</div></div>
<div class="c">
<div class="k">Prediction 可用余额</div>
<div class="wallet" id="walletBalance">读取中...</div>
<div class="muted" id="walletMeta">正在连接 Binance Prediction...</div>
</div>
<div class="c"><div class="grid">
<div class="kv"><div class="k">当前轮次</div><div class="v" id="round">-</div></div>
<div class="kv"><div class="k">状态</div><div class="v" id="status">-</div></div>
<div class="kv"><div class="k">方向</div><div class="v" id="direction">-</div></div>
<div class="kv"><div class="k">Score</div><div class="v" id="score">-</div></div>
<div class="kv"><div class="k">每轮金额</div><div class="v" id="amountView">-</div></div>
<div class="kv"><div class="k">模式</div><div class="v">MANUAL_LIVE</div></div>
</div></div>
<div class="c pending">
<div class="k">待你提交的本轮实盘单</div>
<div class="big" id="pendingTitle">暂无</div>
<div class="muted" id="pendingMeta">开启后只从下一轮开始准备，避免误用当前已锁定轮次。</div>
<a id="marketLink" class="linkbtn open hidden" target="_blank" rel="noopener">打开 Binance 本轮市场并手动提交</a>
</div>
<div class="c">
<input id="amount" type="number" inputmode="decimal" min="0.00000001" step="any" placeholder="输入每一轮准备金额，例如 1.5">
<input id="pin" inputmode="numeric" placeholder="输入控制 PIN">
<button class="start" onclick="setV(true)">按此金额开始跟随新信号</button>
<button class="stop" onclick="setV(false)">停止跟随</button>
<div class="muted">开启时会记住当前 round，并跳过这一轮；只有后续新的 LOCKED 轮次才会生成待提交单。同一个 round 只准备一次。</div>
</div>
</div>
<script>
async function refresh(){
  try{
    const r=await fetch('/api/status',{cache:'no-store'});
    const j=await r.json();
    document.getElementById('switch').innerHTML=j.enabled?'<span class="on">● 跟随已开启</span>':'<span class="off">● 跟随已停止</span>';
    const s=j.signal||{};
    document.getElementById('round').textContent=s.round??'-';
    document.getElementById('status').textContent=s.status??'-';
    document.getElementById('direction').textContent=s.direction??'-';
    document.getElementById('score').textContent=s.score==null?'-':Number(s.score).toFixed(2);
    document.getElementById('amountView').textContent=j.amount==null?'-':j.amount;
    const amountEl=document.getElementById('amount');
    if(document.activeElement!==amountEl && j.amount!=null) amountEl.value=j.amount;

    const p=j.pendingAction;
    const link=document.getElementById('marketLink');
    if(p){
      document.getElementById('pendingTitle').textContent=(p.signal==='UP'?'上涨 / BUY_UP':'下跌 / BUY_DOWN')+' · '+p.amount+' USDT';
      document.getElementById('pendingMeta').textContent='round '+p.round+' · score '+(p.score==null?'-':Number(p.score).toFixed(2))+' · 已准备，等待你在 Binance 页面最终确认';
      link.href=p.marketUrl;
      link.classList.remove('hidden');
    }else{
      document.getElementById('pendingTitle').textContent='暂无';
      document.getElementById('pendingMeta').textContent=j.enabled?'正在等待下一轮 LOCKED 信号...':'开启后只从下一轮开始准备，避免误用当前已锁定轮次。';
      link.classList.add('hidden');
      link.removeAttribute('href');
    }

    const b=j.balance||{};
    const first=(b.items||[]).find(x=>x.enabled)||(b.items||[])[0];
    if(b.ok && first){
      document.getElementById('walletBalance').innerHTML='<span class="ok">'+first.availableBalanceDisplay+' USDT</span>';
      document.getElementById('walletMeta').textContent='账户：'+first.accountType+' · Binance Prediction 实时可用余额';
    } else {
      document.getElementById('walletBalance').innerHTML='<span class="bad">读取失败</span>';
      document.getElementById('walletMeta').textContent=(b.error||'未返回可用余额')+(b.code!=null?' ('+b.code+')':'');
    }
  }catch(e){
    document.getElementById('switch').textContent='状态读取失败';
  }
}
async function setV(v){
  const amount=Number(document.getElementById('amount').value);
  if(v && (!(amount>0) || !Number.isFinite(amount))){alert('请先输入大于 0 的每轮金额');return}
  const r=await fetch('/api/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:v,amount:v?amount:undefined,pin:document.getElementById('pin').value})});
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
    return send(res, 200, {
      ok: true,
      mode: 'MANUAL_LIVE',
      hasSiteOrigin: Boolean(SITE_ORIGIN),
      hasBinanceCredentials: Boolean(BINANCE_API_KEY && BINANCE_API_SECRET),
      hasPredictionWallet: Boolean(PREDICTION_WALLET_ADDRESS),
    });
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/trade-control')) {
    return send(res, 200, page, 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const [signal, balance] = await Promise.all([getSignal(), getPaymentBalances()]);
    lastBalance = balance;
    return send(res, 200, {
      ok: true,
      enabled,
      amount: tradeAmount,
      mode: 'MANUAL_LIVE',
      signal,
      balance,
      startAfterRound,
      pendingAction,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/balance') {
    const balance = await getPaymentBalances();
    lastBalance = balance;
    return send(res, balance.ok ? 200 : 502, balance);
  }

  if (req.method === 'POST' && url.pathname === '/api/control') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    if (!pinOK(body.pin)) return send(res, 401, { ok: false, error: 'PIN 错误' });

    const nextEnabled = Boolean(body.enabled);
    if (nextEnabled) {
      const amount = Number(body.amount);
      if (!(amount > 0) || !Number.isFinite(amount)) {
        return send(res, 400, { ok: false, error: '每轮金额必须大于 0' });
      }
      tradeAmount = amount;
      const current = await getSignal();
      startAfterRound = current?.round ?? null;
      lastRound = startAfterRound;
      pendingAction = null;
    } else {
      pendingAction = null;
    }
    enabled = nextEnabled;
    console.log(JSON.stringify({
      event: 'manual_live_control',
      enabled,
      amount: tradeAmount,
      startAfterRound,
      at: new Date().toISOString(),
    }));
    return send(res, 200, {
      ok: true,
      enabled,
      amount: tradeAmount,
      startAfterRound,
      mode: 'MANUAL_LIVE',
    });
  }

  return send(res, 404, { ok: false, error: 'Not found' });
}).listen(PORT, '0.0.0.0', async () => {
  console.log(JSON.stringify({
    event: 'control_panel_started',
    port: PORT,
    mode: 'MANUAL_LIVE',
    hasSiteOrigin: Boolean(SITE_ORIGIN),
    hasBinanceCredentials: Boolean(BINANCE_API_KEY && BINANCE_API_SECRET),
    hasPredictionWallet: Boolean(PREDICTION_WALLET_ADDRESS),
  }));
  const balance = await getPaymentBalances();
  lastBalance = balance;
  console.log(JSON.stringify({ event: 'prediction_balance_check', ...balance }));
});

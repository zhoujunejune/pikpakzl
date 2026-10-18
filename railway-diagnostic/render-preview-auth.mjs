import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';

const enabled = process.env.RENDER_MIGRATION_PREVIEW === 'true';
const pinHash = String(process.env.RENDER_PANEL_LOGIN_PIN_SHA256 || '').trim().toLowerCase();
const sessionSecret = String(process.env.RENDER_PANEL_SESSION_SECRET || '');
const authReady = /^[0-9a-f]{64}$/.test(pinHash) && sessionSecret.length >= 48;
const cookieName = 'zl_render_session';
const ttlMs = 8 * 60 * 60 * 1000;
const windowMs = 15 * 60 * 1000;
const lockMs = 15 * 60 * 1000;
const ipFailures = new Map();
let globalFailures = [];
let globalBlockUntil = 0;

function responseHeaders(extra={}){
  return {'cache-control':'no-store, private','x-robots-tag':'noindex, nofollow',
    'x-frame-options':'DENY','x-content-type-options':'nosniff',
    'referrer-policy':'no-referrer',...extra};
}
function sendJson(res,status,obj){
  res.writeHead(status,responseHeaders({'content-type':'application/json; charset=utf-8'}));
  res.end(JSON.stringify(obj));
}
function same(a,b){
  const x=Buffer.from(String(a)),y=Buffer.from(String(b));
  return x.length===y.length && timingSafeEqual(x,y);
}
function sign(raw){
  return createHmac('sha256',sessionSecret).update(raw).digest('hex');
}
function authenticated(req){
  if(!authReady) return false;
  const cookie=String(req.headers.cookie||'').split(';').map(v=>v.trim())
    .find(v=>v.startsWith(cookieName+'='));
  if(!cookie) return false;
  const token=cookie.slice(cookieName.length+1);
  const parts=token.split('.');
  if(parts.length!==3 || !/^[a-f0-9]{64}$/.test(parts[2]))return false;
  const expires=Number(parts[1]);
  if(!Number.isSafeInteger(expires)||expires<Date.now()||expires>Date.now()+ttlMs)return false;
  return same(sign(parts[0]+'.'+parts[1]),parts[2]);
}
const loginPage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Render 交易观察台 · 验证</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1119;color:#f3f6fb;font:16px system-ui,sans-serif;padding:20px}.card{width:100%;max-width:380px;background:#1b2030;border:1px solid #384155;padding:28px;border-radius:16px}h1{font-size:23px;margin:0 0 12px}p{font-size:14px;color:#b8c1ce;line-height:1.7}label{display:block;margin:22px 0 8px;font-size:14px}input{width:100%;padding:13px;border-radius:9px;border:1px solid #586071;background:#0d1320;color:white;font-size:20px;letter-spacing:2px}button{background:#21bc72;border:0;border-radius:9px;margin-top:18px;padding:14px;width:100%;font-weight:700;font-size:17px;color:#081a12}small{display:block;margin-top:18px;color:#a9b6c7}</style>
</head><body><div class="card"><h1>Render 交易观察台</h1><p>请输入访问 PIN。通过验证后，才能查看实时信号及账户信息。</p>
<form method="POST" action="/auth/login" autocomplete="off"><label for="pin">访问 PIN</label><input id="pin" name="pin" type="password" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" required autofocus autocomplete="off">
<button type="submit">验证并进入</button></form>
<small>仅限查看：测试环境暂不支持实盘下单。</small></div></body></html>`;

function ipKey(req){
  // Rate limit by the network peer; do not trust spoofable forwarded IP headers.
  return String(req.socket.remoteAddress||'unknown');
}
function blocked(ip){
  const now=Date.now();
  if(globalBlockUntil>now)return true;
  const x=ipFailures.get(ip);
  if(!x)return false;
  if(x.until<=now){ipFailures.delete(ip);return false;}
  return x.count>=5;
}
function failed(ip){
  const now=Date.now(),old=ipFailures.get(ip);
  const x=old && old.until>now ? old : {count:0,until:now+windowMs};
  x.count++;
  ipFailures.set(ip,x);
  globalFailures=globalFailures.filter(t=>now-t<windowMs);
  globalFailures.push(now);
  if(globalFailures.length>=30)globalBlockUntil=now+lockMs;
  if(ipFailures.size>1000){
    for(const [k,v] of ipFailures){if(v.until<=now)ipFailures.delete(k);}
  }
}
async function handleLogin(req,res){
  if(!authReady)return sendJson(res,503,{ok:false,error:'LOGIN_NOT_CONFIGURED'});
  const ip=ipKey(req);
  if(blocked(ip)){
    res.writeHead(429,responseHeaders({'content-type':'text/plain; charset=utf-8','retry-after':'900'}));
    return res.end('尝试次数过多，请稍后重试。');
  }
  try{
    let raw='';
    for await(const chunk of req){
      raw+=chunk.toString('utf8');
      if(raw.length>2048) return sendJson(res,413,{ok:false,error:'INPUT_TOO_LARGE'});
    }
    const pin=new URLSearchParams(raw).get('pin')||'';
    const hash=createHash('sha256').update(pin).digest('hex');
    if(!/^[0-9]{6}$/.test(pin)||!same(hash,pinHash)){
      failed(ip);
      res.writeHead(401,responseHeaders({'content-type':'text/html; charset=utf-8'}));
      return res.end(loginPage.replace('<h1>Render 交易观察台</h1>',
        '<h1>Render 交易观察台</h1><p style="color:#ff9f9f">PIN 不正确，请重试。</p>'));
    }
    ipFailures.delete(ip);
    const rawToken=randomBytes(32).toString('hex')+'.'+String(Date.now()+ttlMs);
    const token=rawToken+'.'+sign(rawToken);
    res.writeHead(303,responseHeaders({'location':'/',
      'set-cookie':cookieName+'='+token+'; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict'}));
    return res.end();
  }catch{
    return sendJson(res,400,{ok:false,error:'INVALID_LOGIN_REQUEST'});
  }
}

// Returns true when the request has been fully handled.
export function handleRenderPreviewAuth(req,res,url){
  if(!enabled)return false;
  if(url.pathname==='/healthz'&&(req.method==='GET'||req.method==='HEAD')){
    res.writeHead(200,responseHeaders({'content-type':'application/json; charset=utf-8'}));
    if(req.method==='HEAD')res.end();else res.end('{"ok":true,"preview":true}');
    return true;
  }
  if(url.pathname==='/auth/login'&&req.method==='POST'){
    void handleLogin(req,res);return true;
  }
  if(url.pathname==='/auth/login'&&req.method==='GET'){
    if(authenticated(req)){
      res.writeHead(303,responseHeaders({'location':'/'}));res.end();return true;
    }
    res.writeHead(authReady?200:503,responseHeaders({'content-type':'text/html; charset=utf-8'}));
    res.end(authReady?loginPage:'<h1>访问验证暂未配置，请联系管理员</h1>');
    return true;
  }
  if(url.pathname==='/auth/logout'&&req.method==='POST'){
    res.writeHead(303,responseHeaders({'location':'/auth/login',
      'set-cookie':cookieName+'=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict'}));
    res.end();return true;
  }
  if(!authenticated(req)){
    if(req.method==='GET' && (url.pathname==='/'||url.pathname==='/trade-control')){
      res.writeHead(303,responseHeaders({'location':'/auth/login'}));res.end();return true;
    }
    return sendJson(res,401,{ok:false,error:'LOGIN_REQUIRED'}),true;
  }
  res.setHeader('cache-control','no-store, private');
  res.setHeader('x-frame-options','DENY');
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('referrer-policy','no-referrer');
  return false;
}

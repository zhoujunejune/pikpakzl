"""Private credential editor for the already authenticated Alibaba prediction host.

Only accepts Binance HMAC credentials and optional wallet identifiers over
same-origin HTTPS behind Caddy Basic Auth; never displays, prints or logs keys.
This does not submit Binance orders or enable auto-trading.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from pathlib import Path
import json
import os
import re
import tempfile

BIND = "127.0.0.1"
PORT = 13006
PUBLIC_ORIGIN = "https://prediction.47-237-188-69.sslip.io"
DEST = Path("/etc/zl-prediction/owner-secrets/binance.env")
KEY_PATTERN = re.compile(r"^[A-Za-z0-9]{32,192}$")
WALLET_PATTERN = re.compile(r"^[A-Za-z0-9x_-]{1,160}$")

HTML = """<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>币安预测 API 设置 · ZL</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b1020;color:#ecf3ff;font:15px/1.6 system-ui,-apple-system,sans-serif}
main{max-width:590px;margin:auto;padding:24px 15px 60px}
h1{font-size:23px}h2{font-size:18px}
.card{border:1px solid #344158;background:#172137;padding:20px;border-radius:15px;margin:16px 0}
label{display:block;font-weight:600;margin:16px 0 4px}
input{padding:13px;width:100%;background:#0d1728;color:#fff;border:1px solid #62728c;border-radius:9px;font-size:16px}
button{width:100%;padding:14px;border:none;background:#2181d5;border-radius:9px;color:#fff;font-weight:700;font-size:16px;cursor:pointer;margin-top:19px}
button:disabled{opacity:.6}
a{color:#82c3ff}.muted{font-size:13px;color:#b1bed0}.warn{color:#ffd89c}.success{color:#5de0ae}
</style></head><body><main><a href="/">← 返回预测机器人</a>
<h1>Binance Prediction API 设置</h1>
<div class="card"><h2>独立加密通道内填写</h2>
<p class="muted">仅用于阿里云预测交易后台。不会写入 GitHub，也不会影响合约机器人；不会把密钥回显到页面。需使用支持 HMAC 签名的 Binance API 密钥。</p>
<div id="status" class="muted">正在读取配置状态…</div>
<form id="credentialForm" autocomplete="off">
<label for="apiKey">新的 API Key</label>
<input id="apiKey" type="password" required minlength="32" maxlength="192" spellcheck="false" autocomplete="off">
<label for="apiSecret">新的 API Secret</label>
<input id="apiSecret" type="password" required minlength="32" maxlength="192" spellcheck="false" autocomplete="off">
<label for="walletAddress">Prediction 钱包地址（可选）</label>
<input id="walletAddress" type="text" maxlength="160" spellcheck="false" autocomplete="off">
<label for="walletId">Prediction 钱包 ID（可选）</label>
<input id="walletId" type="text" maxlength="160" spellcheck="false" autocomplete="off">
<button id="save" type="submit">安全保存新的 API 配置</button>
</form>
<p id="result" role="status" class="muted"></p></div>
<div class="card"><p class="warn">保存后后台服务会重新加载配置，自动实盘下单不会因此开启。请先验证账号权限、地区合规、余额读取和订单状态；如果需要 API IP 白名单，应以阿里云实际出口 IP 为准。请关闭 API 提现权限。</p>
<p class="muted">本页面由现有 HTTPS 登录保护，不需要原 Railway 的控制 PIN。不同域名首次访问可能需要重新使用相同的页面登录密码。</p></div></main>
<script>
const el=id=>document.getElementById(id);
async function status(){
 try{const r=await fetch('status',{cache:'no-store'});const j=await r.json();
 el('status').textContent=j.configured?'已配置 API Key 与 Secret（密钥内容不显示）':'还没有配置阿里云预测 API';
 }catch{el('status').textContent='配置状态暂不可读取'}
}
el('credentialForm').addEventListener('submit',async ev=>{
 ev.preventDefault();
 if(!window.confirm('确认将这组 API 配置保存到阿里云预测服务器？这不会开启自动下单。'))return;
 el('save').disabled=true;el('result').textContent='正在安全保存…';
 try{
  const body={apiKey:el('apiKey').value.trim(),apiSecret:el('apiSecret').value.trim(),
   walletAddress:el('walletAddress').value.trim(),walletId:el('walletId').value.trim()};
  const r=await fetch('credentials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'same-origin'});
  const j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||'保存失败');
  el('result').textContent='已保存。后台正在重新加载，自动下单仍关闭。';
  el('result').className='success';
  el('credentialForm').reset();status();
 }catch(e){el('result').textContent=e.message||'保存失败';el('result').className='warn'}
 finally{el('save').disabled=false}
});
status();
</script></body></html>"""

def present():
    try:
        items = {}
        for line in DEST.read_text(encoding="utf-8").splitlines():
            if "=" in line:
                name, value = line.split("=",1)
                items[name] = bool(value)
        return items.get("BINANCE_PREDICTION_API_KEY",False) and items.get("BINANCE_PREDICTION_API_SECRET",False)
    except FileNotFoundError:
        return False

class App(BaseHTTPRequestHandler):
    def authenticated(self):
        # Caddy deletes client-supplied values, then asserts successful login.
        return self.headers.get("X-ZL-Verified-Login") == "1" and self.headers.get("Host")==urlsplit(PUBLIC_ORIGIN).netloc

    def send(self,status,body,ctype="application/json; charset=utf-8"):
        payload=body.encode() if isinstance(body,str) else json.dumps(body,ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type",ctype)
        self.send_header("Content-Length",str(len(payload)))
        self.send_header("Cache-Control","no-store, private")
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("X-Frame-Options","DENY")
        self.send_header("Referrer-Policy","no-referrer")
        self.send_header("Content-Security-Policy","default-src 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if not self.authenticated():
            return self.send(403,{"ok":False,"error":"AUTHENTICATED_GATEWAY_REQUIRED"})
        path=urlsplit(self.path).path
        if path in ("/","/index.html"):
            return self.send(200,HTML,"text/html; charset=utf-8")
        if path=="/status":
            return self.send(200,{"ok":True,"configured":present(),"autoTradingEnabled":False})
        return self.send(404,{"ok":False,"error":"NOT_FOUND"})

    def do_POST(self):
        if not self.authenticated():
            return self.send(403,{"ok":False,"error":"AUTHENTICATED_GATEWAY_REQUIRED"})
        if (self.headers.get("Origin")!=PUBLIC_ORIGIN
            or self.headers.get("Sec-Fetch-Site")!="same-origin"
            or self.headers.get("Content-Type","").split(";")[0]!="application/json"
            or urlsplit(self.path).path!="/credentials"):
            return self.send(403,{"ok":False,"error":"SAME_ORIGIN_REQUIRED"})
        try:
            n=int(self.headers.get("Content-Length","0"))
            if n<1 or n>4096:return self.send(413,{"ok":False,"error":"INVALID_BODY_SIZE"})
            body=json.loads(self.rfile.read(n))
            if not isinstance(body,dict) or set(body)!={"apiKey","apiSecret","walletAddress","walletId"}:
                return self.send(400,{"ok":False,"error":"INVALID_FIELDS"})
            key=body["apiKey"];secret=body["apiSecret"]
            wallet=body["walletAddress"];wid=body["walletId"]
            if not all(isinstance(x,str) for x in (key,secret,wallet,wid)):
                return self.send(400,{"ok":False,"error":"INVALID_FIELDS"})
            if not (KEY_PATTERN.fullmatch(key) and KEY_PATTERN.fullmatch(secret)):
                return self.send(400,{"ok":False,"error":"REQUIRES_HMAC_ALPHANUMERIC_API_KEY_PAIR"})
            if (wallet and not WALLET_PATTERN.fullmatch(wallet)) or (wid and not WALLET_PATTERN.fullmatch(wid)):
                return self.send(400,{"ok":False,"error":"INVALID_WALLET_IDENTIFIER"})
            DEST.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            lines=["BINANCE_PREDICTION_API_KEY="+key,
                   "BINANCE_PREDICTION_API_SECRET="+secret]
            if wallet:lines.append("BINANCE_PREDICTION_WALLET_ADDRESS="+wallet)
            if wid:lines.append("BINANCE_PREDICTION_WALLET_ID="+wid)
            fd,tmp=tempfile.mkstemp(prefix=".update-",dir=DEST.parent)
            try:
                os.fchmod(fd,0o600)
                with os.fdopen(fd,"w",encoding="utf-8") as fp:
                    fp.write("\n".join(lines)+"\n")
                    fp.flush();os.fsync(fp.fileno())
                os.replace(tmp,DEST)
            finally:
                if os.path.exists(tmp):os.unlink(tmp)
            return self.send(200,{"ok":True,"saved":True,"autoTradingEnabled":False})
        except Exception:
            return self.send(500,{"ok":False,"error":"SAVE_FAILED"})

    def log_message(self,*args):
        # Never log credentials or entire request path.
        return

if __name__=="__main__":
    if os.geteuid()==0:raise RuntimeError("Credential editor must not run as root")
    ThreadingHTTPServer((BIND,PORT),App).serve_forever()

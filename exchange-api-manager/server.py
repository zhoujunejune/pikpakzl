"""Shared exchange API credential manager, protected by existing Caddy HTTPS login.

Two isolated bots (futures/prediction), extensible exchange-specific adapters.
Keys are never returned or logged. Saving never submits orders or enables live mode.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from pathlib import Path
from datetime import datetime, timezone
import json
import os
import re
import tempfile
import threading
import hashlib
import hmac
import time
import urllib.request
import urllib.error

ROOT = Path("/var/lib/zl-exchange-api")
ORIGINS = {"47-237-188-69.sslip.io", "prediction.47-237-188-69.sslip.io"}
BOTS = {"futures": "合约机器人", "prediction": "预测机器人"}
EXCHANGES = {"binance": "Binance", "okx": "OKX", "bybit": "Bybit", "bitget": "Bitget"}
AUTHORIZED = {"futures": {"binance"}, "prediction": {"binance"}}
PORT = 13016
STORE_LOCK = threading.RLock()

PAGE = r"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>ZL 交易所 API 管理</title>
<style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#172339;--line:#344764;--dim:#b2bfd2;--fg:#eff5ff;--blue:#3585d9}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,'PingFang SC',sans-serif;margin:0}
main{max-width:760px;padding:20px 15px 64px;margin:auto}
h1{font-size:24px;margin:8px 0}h2{font-size:18px;margin:0 0 12px}
a{color:#8ec6ff;text-decoration:none}
nav{display:flex;flex-wrap:wrap;gap:12px;margin:13px 0 20px}
nav a{border:1px solid var(--line);padding:10px 12px;border-radius:9px;font-weight:600}
.card{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:20px;margin:15px 0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
label{display:block;font-weight:650;margin:12px 0 6px}
input,select{font:inherit;color:var(--fg);width:100%;border-radius:9px;border:1px solid #536984;background:#0d1728;padding:12px;min-height:46px}
button{font:inherit;font-weight:700;background:var(--blue);color:#fff;border:0;border-radius:9px;padding:13px;width:100%;cursor:pointer;margin-top:13px}
button:disabled{opacity:.55}
.muted{color:var(--dim);font-size:13px}.ok{color:#63e4b3}.warn{color:#ffd48e}
.error{color:#ff9aa5}.notice{padding:12px;border-left:3px solid #e7ba6d;background:#1b263b;font-size:13px;line-height:1.65}
.status{padding:10px;margin-top:12px;background:#101d30;border-radius:9px}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}.actions button{margin:10px 0 0}
@media(max-width:460px){.grid,.actions{grid-template-columns:1fr}}
</style></head><body><main>
<h1>交易所 API 管理</h1>
<div class="muted">阿里云服务器 · 现有页面登录认证 · 两个机器人独立密钥</div>
<nav><a href="https://47-237-188-69.sslip.io/dashboard/">合约机器人</a>
<a href="https://prediction.47-237-188-69.sslip.io/">预测机器人</a>
<a href="/api-keys/" aria-current="page">API 管理</a></nav>
<div class="notice">这里只配置账户连接密钥，不会开启交易，也不会更改机器人模式。合约机器人目前仍为模拟运行；预测机器人是否可实盘还须验证行情、交易权限和实际订单路径。请勿开启 API 提现权限。</div>
<div class="card">
<h2>选择机器人和交易所</h2>
<div class="grid"><div><label for="bot">连接到哪个机器人</label>
<select id="bot"><option value="futures">合约机器人</option><option value="prediction">预测机器人</option></select></div>
<div><label for="exchange">选择交易所</label>
<select id="exchange"><option value="binance">Binance 币安</option><option value="okx">OKX</option><option value="bybit">Bybit</option><option value="bitget">Bitget</option></select></div></div>
<div class="status" id="status" role="status">正在读取密钥配置状态…</div>
<p class="muted" id="capability"></p>
<form id="form" autocomplete="off">
<label for="apiKey">API Key</label><input type="password" id="apiKey" autocomplete="new-password" spellcheck="false" minlength="8" maxlength="256" required>
<label for="secret">API Secret</label><input type="password" id="secret" autocomplete="new-password" spellcheck="false" minlength="8" maxlength="256" required>
<div id="passphraseBox" hidden><label for="passphrase">API Passphrase（部分交易所需要）</label>
<input id="passphrase" type="password" autocomplete="new-password" maxlength="256" spellcheck="false"></div>
<div id="walletBox" hidden>
<label for="walletAddress">Prediction 钱包地址（可选）</label>
<input id="walletAddress" autocomplete="off" maxlength="160" spellcheck="false">
<label for="walletId">Prediction 钱包 ID（可选）</label>
<input id="walletId" autocomplete="off" maxlength="160" spellcheck="false">
</div>
<div class="actions"><button type="submit" id="save">保存或更换 API</button>
<button type="button" id="check" style="background:#245a7b">只读连接检测</button></div>
</form>
<p id="message" role="status" class="muted"></p>
</div>
<div class="card"><h2>使用说明</h2><p class="muted">两个机器人的密钥分别保存在阿里云服务器文件中，只有服务器本机和对应机器人可读取。页面不会回显已保存的 Key 或 Secret。其他交易所可以预先保存密钥，但只有完成相应交易适配器后才可连接交易。不要把密钥发到聊天或上传到 GitHub。</p></div>
</main><script>
'use strict';
const $=id=>document.getElementById(id), base='api/';
function selected(){return {bot:$('bot').value,exchange:$('exchange').value}}
function show(msg,cls='muted'){$('message').textContent=msg;$('message').className=cls}
async function query(){
 const {bot,exchange}=selected();
 $('walletBox').hidden=!(bot==='prediction'&&exchange==='binance');
 $('passphraseBox').hidden=exchange!=='okx';
 const supported=exchange==='binance';
 $('capability').textContent=supported?'该交易所已有此项目的连接代码，但保存 API 不代表真实交易已启用。':'此交易所暂时仅提供安全存储，交易适配器尚未接入，不能声称已连接。';
 try{
  const res=await fetch('api/status?bot='+encodeURIComponent(bot)+'&exchange='+encodeURIComponent(exchange),{cache:'no-store'});
  const data=await res.json();if(!res.ok)throw Error(data.error||'状态不可用');
  $('status').textContent=(data.configured?'已保存 API 密钥':'尚未通过本页面配置 API')+
    ' · '+(data.configured?'更新日期 '+(data.updatedAt||'未知'):'可填写新密钥')+
    ' · '+(data.adapterReady?'已有交易所适配代码':'暂未接入交易适配器');
 }catch(e){$('status').textContent='状态读取失败：'+e.message}
 show('');
}
$('bot').addEventListener('change',query);$('exchange').addEventListener('change',query);
$('form').addEventListener('submit',async evt=>{
 evt.preventDefault();const {bot,exchange}=selected();
 if(!confirm('确认把新的 '+$('exchange').selectedOptions[0].text+' API 保存给「'+$('bot').selectedOptions[0].text+'」？不会开启交易。'))return;
 $('save').disabled=true;show('正在保存到阿里云服务器…');
 try{
  const body={bot,exchange,apiKey:$('apiKey').value.trim(),apiSecret:$('secret').value.trim(),
   passphrase:$('passphrase').value,walletAddress:$('walletAddress').value.trim(),walletId:$('walletId').value.trim()};
  const res=await fetch('api/credentials',{method:'POST',headers:{'Content-Type':'application/json','X-ZL-API-Manager':'1'},credentials:'same-origin',body:JSON.stringify(body)});
  const data=await res.json();if(!res.ok)throw Error(data.error||'保存失败');
  $('form').reset();$('bot').value=bot;$('exchange').value=exchange;
  show('保存成功。密钥不会在页面回显，机器人交易开关未改变。','ok');await query();
 }catch(e){show('保存失败：'+e.message,'error')}
 finally{$('save').disabled=false}
});
$('check').addEventListener('click',async()=>{
 const {bot,exchange}=selected();
 if(exchange!=='binance'){show('此交易所的只读连接检测尚未接入。','warn');return}
 $('check').disabled=true;show('检测中：只发送只读签名请求，不会提交订单。');
 try{
  const res=await fetch('api/check',{method:'POST',headers:{'Content-Type':'application/json','X-ZL-API-Manager':'1'},credentials:'same-origin',body:JSON.stringify({bot,exchange})});
  const data=await res.json();
  show((data.ok?'交易所已接受签名请求。':'未通过验证。')+' 状态：'+(data.reason||'')+(data.httpStatus?' · HTTP '+data.httpStatus:''),
       data.ok?'ok':'warn');
 }catch(e){show('连接检测失败：'+e.message,'error')}
 finally{$('check').disabled=false}
});
query();
</script></body></html>"""

def path_for(bot, exchange):
    if bot not in BOTS or exchange not in EXCHANGES: raise ValueError("INVALID_SELECTION")
    return ROOT / bot / (exchange + ".json")

def safe_read(bot, exchange):
    try:
        with path_for(bot, exchange).open("r",encoding="utf8") as f:
            record=json.load(f)
        return record if record.get("bot")==bot and record.get("exchange")==exchange else None
    except (FileNotFoundError, OSError, json.JSONDecodeError, ValueError):
        return None

def persist(record):
    bot,exchange=record["bot"],record["exchange"]
    parent=ROOT / bot
    parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    os.chmod(parent,0o700)
    fd,temp=tempfile.mkstemp(prefix=".key-",dir=str(parent))
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,"w",encoding="utf8") as fp:
            json.dump(record,fp,ensure_ascii=False,separators=(",",":"))
            fp.flush();os.fsync(fp.fileno())
        os.replace(temp,path_for(bot,exchange))
        if exchange=="binance":
            # Each bot receives only its own variables through a systemd
            # EnvironmentFile. An atomic replace avoids half-written credentials.
            if not re.fullmatch(r"[A-Za-z0-9_-]{8,256}",record["apiKey"]):
                raise ValueError("BINANCE_KEY_FORMAT")
            if not re.fullmatch(r"[A-Za-z0-9_-]{8,256}",record["apiSecret"]):
                raise ValueError("BINANCE_SECRET_FORMAT")
            names = {"futures":("BINANCE_API_KEY","BINANCE_API_SECRET"),
                     "prediction":("BINANCE_PREDICTION_API_KEY","BINANCE_PREDICTION_API_SECRET")}
            a,b=names[bot]
            rows=[a+"="+record["apiKey"],b+"="+record["apiSecret"]]
            if bot=="prediction":
                if record.get("walletAddress"):
                    rows.append("BINANCE_PREDICTION_WALLET_ADDRESS="+record["walletAddress"])
                if record.get("walletId"):
                    rows.append("BINANCE_PREDICTION_WALLET_ID="+record["walletId"])
            ef,envtmp=tempfile.mkstemp(prefix=".env-",dir=str(parent))
            try:
                os.fchmod(ef,0o600)
                with os.fdopen(ef,"w",encoding="utf8") as env_file:
                    env_file.write("\n".join(rows)+"\n")
                    env_file.flush();os.fsync(env_file.fileno())
                os.replace(envtmp,parent/"binance.env")
            finally:
                if os.path.exists(envtmp):os.unlink(envtmp)
        try:
            d=os.open(str(parent),os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(d)
            finally:os.close(d)
        except OSError:pass
    finally:
        if os.path.exists(temp):os.unlink(temp)

def validate(body):
    if not isinstance(body,dict) or set(body)!={"bot","exchange","apiKey","apiSecret","passphrase","walletAddress","walletId"}:
        raise ValueError("INVALID_FIELDS")
    bot,exchange=body["bot"],body["exchange"]
    if bot not in BOTS or exchange not in EXCHANGES:raise ValueError("INVALID_SELECTION")
    for key in ("apiKey","apiSecret","passphrase","walletAddress","walletId"):
        if not isinstance(body[key],str) or len(body[key])>256 or any(ord(c)<32 or ord(c)==127 for c in body[key]):
            raise ValueError("INVALID_CREDENTIAL_FORMAT")
    if len(body["apiKey"])<8 or len(body["apiSecret"])<8:
        raise ValueError("API_KEY_AND_SECRET_REQUIRED")
    if exchange=="binance" and not (
        re.fullmatch(r"[A-Za-z0-9_-]{8,256}",body["apiKey"]) and
        re.fullmatch(r"[A-Za-z0-9_-]{8,256}",body["apiSecret"])):
        raise ValueError("BINANCE_HMAC_KEY_FORMAT_REQUIRED")
    if bot=="prediction" and exchange=="binance":
        for k in ("walletAddress","walletId"):
            if len(body[k])>160 or (body[k] and not re.fullmatch("[A-Za-z0-9x_-]+",body[k])):
                raise ValueError("INVALID_WALLET_FIELDS")
    return {key:body[key] for key in ("bot","exchange","apiKey","apiSecret","passphrase","walletAddress","walletId")}

def signed_readonly_check(record):
    """No buy/sell; only signed GET /sapi/v1/account/apiRestrictions or /fapi/v2/balance."""
    if record["exchange"]!="binance":return {"ok":False,"reason":"ADAPTER_NOT_YET_AVAILABLE"}
    bot=record["bot"]
    host="https://fapi.binance.com" if bot=="futures" else "https://api.binance.com"
    path="/fapi/v2/balance" if bot=="futures" else "/sapi/v1/account/apiRestrictions"
    from urllib.parse import urlencode
    params=urlencode({"timestamp":int(time.time()*1000),"recvWindow":5000})
    sig=hmac.new(record["apiSecret"].encode(),params.encode(),hashlib.sha256).hexdigest()
    req=urllib.request.Request(host+path+"?"+params+"&signature="+sig,
                               headers={"X-MBX-APIKEY":record["apiKey"],"Accept":"application/json"})
    try:
        with urllib.request.urlopen(req,timeout=7) as resp:
            resp.read(1000)
            return {"ok":True,"reason":"SIGNED_READ_ONLY_GET_ACCEPTED","httpStatus":resp.status}
    except urllib.error.HTTPError as error:
        # Never return exchange body (can contain account data).
        return {"ok":False,"reason":("HTTP_451_REGION_RESTRICTED" if error.code==451 else
           "HTTP_418_IP_LIMIT" if error.code==418 else
           "HTTP_429_RATE_LIMIT" if error.code==429 else
           "EXCHANGE_REJECTED_OR_UNAUTHORIZED"),"httpStatus":error.code}
    except (urllib.error.URLError,TimeoutError):
        return {"ok":False,"reason":"NETWORK_OR_TIMEOUT"}

class Handler(BaseHTTPRequestHandler):
    server_version="ZLAPIGateway/1"
    sys_version=""
    def log_message(self,*args):return
    def checked(self):
        # Caddy explicitly overwrites forwarded auth assertion and removes
        # the client's Authorization header. Listen only on localhost.
        host=self.headers.get("Host","").split(":")[0]
        return self.client_address[0]=="127.0.0.1" and host in ORIGINS and self.headers.get("X-ZL-Verified-Login")=="1"
    def send(self,status,body,ctype="application/json; charset=utf-8"):
        data=body.encode("utf8") if isinstance(body,str) else json.dumps(body,ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type",ctype)
        self.send_header("Content-Length",str(len(data)))
        self.send_header("Cache-Control","no-store, private")
        self.send_header("Pragma","no-cache")
        self.send_header("X-Frame-Options","DENY")
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("Referrer-Policy","no-referrer")
        self.send_header("Content-Security-Policy","default-src 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'")
        self.end_headers()
        self.wfile.write(data)
    def post_security(self):
        host=self.headers.get("Host","").split(":")[0]
        return (self.checked() and self.headers.get("Origin")=="https://"+host
                and self.headers.get("X-ZL-API-Manager")=="1"
                and self.headers.get("Content-Type","").split(";")[0]=="application/json"
                and self.headers.get("Sec-Fetch-Site","same-origin")=="same-origin")
    def do_GET(self):
        if not self.checked():return self.send(403,{"ok":False,"error":"LOGIN_REQUIRED"})
        url=urlsplit(self.path)
        if url.path in ("/","/index.html"):return self.send(200,PAGE,"text/html; charset=utf-8")
        if url.path=="/api/status":
            from urllib.parse import parse_qs
            values=parse_qs(url.query)
            bot=values.get("bot",[""])[0];exchange=values.get("exchange",[""])[0]
            if bot not in BOTS or exchange not in EXCHANGES:return self.send(400,{"error":"INVALID_SELECTION"})
            with STORE_LOCK:
                rec=safe_read(bot,exchange)
            return self.send(200,{"ok":True,"configured":bool(rec),
                "bot":bot,"exchange":exchange,"updatedAt":rec.get("updatedAt") if rec else None,
                "adapterReady":exchange in AUTHORIZED[bot]})
        if url.path=="/healthz":return self.send(200,{"ok":True,"service":"exchange-api-manager"})
        return self.send(404,{"ok":False,"error":"NOT_FOUND"})
    def do_POST(self):
        if not self.post_security():return self.send(403,{"ok":False,"error":"AUTH_AND_ORIGIN_REQUIRED"})
        path=urlsplit(self.path).path
        if path not in ("/api/credentials","/api/check"):return self.send(404,{"error":"NOT_FOUND"})
        try:
            size=int(self.headers.get("Content-Length","0"))
            if not 0<size<=4096:return self.send(413,{"error":"BODY_TOO_LARGE_OR_EMPTY"})
            body=json.loads(self.rfile.read(size))
            if path=="/api/credentials":
                record=validate(body)
                record["updatedAt"]=datetime.now(timezone.utc).isoformat(timespec="seconds")
                with STORE_LOCK:persist(record)
                # systemd.path notices atomic rename in bot-specific directory,
                # restarts only that bot. No live trading flags are modified here.
                return self.send(200,{"ok":True,"saved":True,"bot":record["bot"],
                                      "exchange":record["exchange"],"tradingEnabledBySave":False})
            if not isinstance(body,dict) or set(body)!={"bot","exchange"}:
                raise ValueError("INVALID_SELECTION")
            bot,exchange=body["bot"],body["exchange"]
            if bot not in BOTS or exchange not in EXCHANGES:raise ValueError("INVALID_SELECTION")
            with STORE_LOCK: rec=safe_read(bot,exchange)
            if not rec:return self.send(409,{"ok":False,"reason":"API_NOT_CONFIGURED"})
            return self.send(200,signed_readonly_check(rec))
        except (ValueError,TypeError,json.JSONDecodeError) as e:
            return self.send(400,{"ok":False,"error":str(e)[:100]})
        except OSError:
            return self.send(503,{"ok":False,"error":"CONFIG_STORAGE_UNAVAILABLE"})

if __name__=="__main__":
    if os.geteuid()==0:raise RuntimeError("API manager must not run as root")
    ROOT.mkdir(mode=0o700,parents=True,exist_ok=True)
    ThreadingHTTPServer(("127.0.0.1",PORT),Handler).serve_forever()

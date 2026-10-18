"""Minimal Render free-tier paper-trading UI. This has NO trade execution endpoint."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import datetime as dt
import html
import json
import os
import threading
import time
import traceback

import bot
from preflight import assess

BOOT_AT=dt.datetime.now(dt.timezone.utc).isoformat()
WORKER={"running":False,"error":None,"finished_at":None,"preflight":None}

def worker():
    WORKER["running"]=True
    try:
        # No outbound requests during Binance 418 cooldown. After expiry, allow a
        # one-off test order permission check (does not enter matching engine).
        check=assess(allow_trade_test=True)
        WORKER["preflight"]={
            "outboundAllowed":check.get("outboundAllowed",False),
            "credentialNamesPresent":check.get("keyPresent",False) and check.get("secretPresent",False),
            "authenticated":check.get("authenticated",False),
            "testOrderPermission":check.get("tradePermissionTested",False),
            "blocker":check.get("blocker"),
        }
        if not check.get("outboundAllowed"):
            raise RuntimeError("Exchange ban/cooldown until "+str(check.get("retryNotBefore")))
        bot.main()
    except Exception as e:
        WORKER["error"]=str(e)[:200]
        WORKER["finished_at"]=dt.datetime.now(dt.timezone.utc).isoformat()
        bot.log("worker_failed", error=str(e)[:200])
    finally:
        WORKER["running"]=False

def public_snapshot():
    try:
        current=bot.load()
        trades=current.get("history") or []
        balance=float(current.get("balance",bot.PAPER_BALANCE))
        days=[round(float(t.get("net",0)),6) for t in trades]
        return {
            "app":"zl-futures-bot-v1",
            "mode":"paper",
            "liveTradingEnabled":False,
            "ephemeralStorageWarning":"Render free local state disappears after restart, redeploy, or sleep. Statistics reset; do not treat as a persistent performance record.",
            "strategy":"5m breakout + 1h EMA trend",
            "startingBalance":bot.PAPER_BALANCE,
            "simulatedBalance":round(balance,4),
            "simulatedPnL":round(balance-bot.PAPER_BALANCE,4),
            "closedTrades":len(trades),
            "wins":sum(1 for x in days if x>0),
            "losses":sum(1 for x in days if x<=0),
            "lastTrades":[{"net":round(float(t.get("net",0)),4),"reason":str(t.get("reason",""))[:30],
                           "at":t.get("at")} for t in trades[-12:]],
            "position":current.get("trade"),
            "halted":bool(current.get("halt",False)),
            "workerRunning":WORKER["running"],
            "workerError":WORKER["error"],
            "preflight":WORKER["preflight"],
            "exchangeAccess": "blocked" if WORKER["error"] and any(x in WORKER["error"] for x in ("418", "451", "429")) else ("available" if WORKER["running"] else "unverified"),
            "leverageConfigured":bot.LEVERAGE,
            "leverageMaximum":20,
            "riskPerTradePercent":round(bot.RISK_FRACTION*100,2),
            "instanceBootAt":BOOT_AT,
            "note":"Paper trades use reference mark prices, estimated fees, no order-book fill/slippage. Not proof of profit.",
        }
    except Exception as e:
        return {"app":"zl-futures-bot-v1","mode":"paper","liveTradingEnabled":False,"error":"state_unavailable", "workerRunning":WORKER["running"]}

PAGE="""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZL Futures Bot V1 | 模拟合约</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:780px;margin:25px auto;padding:12px;background:#101624;color:#eff4ff}
section{background:#1a2436;padding:20px;margin:15px 0;border-radius:14px}h1,h2{margin:5px 0 14px}
.warn{color:#ffce82}.good{color:#84e0ac}.bad{color:#ff9292}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
small{color:#aebbcf}table{width:100%;border-collapse:collapse}td,th{padding:8px;text-align:left;border-bottom:1px solid #32405b}pre{white-space:pre-wrap;word-break:break-word}</style>
</head><body><h1>ZL Futures Bot V1</h1><p class="warn">仅模拟交易 · 无真实下单 · 最多20倍可配置</p>
<section><h2>运行诊断</h2><p id="error" class="bad">加载中…</p><p>交易所拒绝时立即停止行情请求，不更换IP、不绕过交易所限制。无真实交易密钥、无真实下单。</p></section>
<section><h2>当前模拟状态</h2><div class="grid"><div><small>模拟余额</small><h2 id="bal">—</h2></div>
<div><small>累计盈亏</small><h2 id="pnl">—</h2></div><div><small>已结算模拟交易</small><h2 id="count">—</h2></div>
<div><small>策略任务</small><h2 id="task">—</h2></div></div></section>
<section><h2>当前模拟仓位</h2><pre id="position">—</pre></section>
<section><h2>最近模拟交易</h2><div id="history">—</div></section>
<section class="warn"><h2>重要限制</h2>Render 免费 Web 服务闲置会休眠；重启会丢失本地统计。模拟行情采用标记价格，不模拟真实成交滑点，不能据此声称策略盈利。
这是独立研究服务，不连接预测市场生产，也不具备真实下单按钮。</section>
<script>
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
async function refresh(){
try{
const r=await fetch('/status',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);
const d=await r.json();
document.getElementById('bal').textContent=d.simulatedBalance+' USDT';
document.getElementById('pnl').textContent=d.simulatedPnL+' USDT';
document.getElementById('count').textContent=d.closedTrades+' / '+d.wins+'胜';
document.getElementById('task').textContent=d.workerRunning?'运行中':'已停止';
document.getElementById('error').textContent=d.workerError?'策略停止原因：'+d.workerError:(d.workerRunning?'策略任务正在运行；非实盘。':'策略尚未运行');
document.getElementById('position').textContent=d.position?JSON.stringify(d.position,null,2):'空仓';
const rows=d.lastTrades||[];
document.getElementById('history').innerHTML=rows.length?
'<table><tr><th>时间戳</th><th>结果</th><th>净盈亏 (USDT)</th></tr>'+rows.slice().reverse().map(x=>'<tr><td>'+esc(new Date(x.at*1000).toLocaleString())+'</td><td>'+esc(x.reason)+'</td><td>'+esc(x.net)+'</td></tr>').join('')+'</table>':
'尚无已结算的模拟交易';
}catch(e){document.getElementById('task').textContent='状态读取失败';document.getElementById('error').textContent='无法读取状态，请查看Render日志';}
}
refresh();setInterval(refresh,15000);
</script></body></html>"""

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/healthz","/health"):
            payload={"ok":True,"mode":"paper","workerRunning":WORKER["running"],"bootAt":BOOT_AT}
            self.send_json(payload)
        elif self.path=="/status":
            self.send_json(public_snapshot())
        elif self.path=="/":
            payload=PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type","text/html; charset=utf-8")
            self.send_header("Cache-Control","no-store")
            self.send_header("Content-Length",str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            self.send_error(404)
    def send_json(self,value):
        payload=json.dumps(value,ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Cache-Control","no-store")
        self.send_header("Content-Length",str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self,format,*args):
        pass

def main():
    if bot.MODE!="paper":
        raise RuntimeError("Render preview is paper-only: refuse live mode in web service")
    t=threading.Thread(target=worker,name="paper-engine",daemon=True)
    t.start()
    port=int(os.environ.get("PORT","10000"))
    bot.log("render_paper_http_ready",port=port)
    ThreadingHTTPServer((os.environ.get("BIND_HOST", "127.0.0.1"),port),Handler).serve_forever()

if __name__=="__main__":
    main()

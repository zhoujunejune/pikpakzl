"""Standalone, read-only prediction dashboard for the Alibaba SWAS host.

Does not import futures code, read Binance credentials, submit orders or change
Railway state. This is a migration monitor, NOT the migrated trading engine.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import datetime
import json
import os
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

HOST = "127.0.0.1"
PORT = int(os.environ.get("PREDICTION_PANEL_PORT", "11000"))
SOURCES = {
    "v2": "https://zl-signal-v2-migration.onrender.com/api/round-stats",
    "v3": "https://zl-signal-v3-migration.onrender.com/api/shadow-market-data",
    "edge": "https://edge-5m-v1.zl528094-3ba.workers.dev/status",
}
_CACHE = {"at": 0, "value": None}
_LOCK = threading.Lock()
PAGE = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b1020"><title>ZL 预测机器人 · 独立工作台</title>
<style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#151f33;--line:#273650;--dim:#9fb0c9;--fg:#eef4ff;--a:#5da8ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"PingFang SC",sans-serif;line-height:1.5}
main{max-width:760px;padding:20px 14px 60px;margin:auto}.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:17px;margin:14px 0}
h1{font-size:23px;margin:0}h2{font-size:16px;margin:0 0 12px}.sub,small{color:var(--dim)}
.bot-nav{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}
.bot-nav a{display:block;padding:12px 8px;text-align:center;text-decoration:none;color:var(--fg);border:1px solid #3c4d6e;background:#142239;border-radius:11px;font-weight:650}
.bot-nav a.active{background:#196bb6;border-color:#2786df}
.warn{border-left:3px solid #ffc978;padding-left:12px;color:#ffdba6;font-size:13px;margin:12px 0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.metric{background:#101a2b;padding:12px;border-radius:11px;min-width:0}
.metric strong{font-size:17px;display:block;overflow-wrap:anywhere}.metric small{display:block}
a{color:#87c1ff}.row{display:flex;justify-content:space-between;gap:12px;align-items:center;border-bottom:1px solid var(--line);padding:9px 0}
.state{font-size:12px;padding:3px 9px;border:1px solid var(--line);border-radius:15px}
.ok{color:#47dbab}.bad{color:#ff8d98}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:340px;overflow-y:auto}
</style></head><body><main>
<h1>ZL 机器人控制台</h1><div class="sub">阿里云 · 独立菜单 / 独立进程 / 独立接口</div>
<nav class="bot-nav" aria-label="选择机器人">
<a href="/dashboard/">合约机器人</a><a href="/prediction/" class="active" aria-current="page">预测机器人</a>
</nav>
<div class="warn">当前为<strong>预测机器人迁移监控（只读）</strong>，不是阿里云实盘预测交易引擎。旧 Railway 预测服务、订单和历史记录未迁移完成；为防止重复下单，本页面不提供提交订单和实盘开关。</div>
<section class="card"><h2>预测服务状态</h2><div id="overall" class="sub">读取中…</div><div id="sources"></div>
<small>监控来源为旧系统的公开只读接口；接口不可用时标记为不可用，不能视为已迁移。</small></section>
<section class="card"><h2>预测信号与结算统计（旧系统）</h2><div class="grid">
<div class="metric"><small>生产信号模式</small><strong id="mode">—</strong></div>
<div class="metric"><small>活跃预测模型</small><strong id="model">—</strong></div>
<div class="metric"><small>近期轮次</small><strong id="round">—</strong></div>
<div class="metric"><small>官方结算来源</small><strong id="settlement">—</strong></div>
</div><h2 style="margin-top:15px">统计原始摘要（不推断胜率）</h2><pre id="summary">尚未读取</pre>
<h2>最近轮次（最多 12 条）</h2><pre id="records">尚未读取</pre></section>
<section class="card"><h2>迁移进度</h2>
<div class="row"><span>前台菜单及隔离路由</span><span class="ok">已设计</span></div>
<div class="row"><span>阿里云预测只读监控</span><span id="monitor-state">检查中</span></div>
<div class="row"><span>Redis / V2 / V3 / 采集器 / 实盘交易后台</span><span class="bad">未切换</span></div>
<div class="row"><span>Railway 历史及配置迁移</span><span class="bad">未完成</span></div>
<p class="sub">仅切换本页面不影响合约机器人的状态、策略、止盈止损及模拟数据。原预测交易设置不会写入合约系统。</p></section>
</main><script>
function e(id){return document.getElementById(id)}
function pretty(v){return v==null?"暂无":JSON.stringify(v,null,2)}
async function load(){
try{
 const r=await fetch("api/overview",{cache:"no-store"});
 if(!r.ok)throw Error("HTTP "+r.status);
 const data=await r.json(),v2=data.sources.v2||{};
 e("overall").textContent="数据检查时间："+data.checkedAt+" · 交易写操作：禁用";
 e("sources").replaceChildren();
 for(const name of ["v2","v3","edge"]){
  const item=data.sources[name]||{},line=document.createElement("div");
  line.className="row";
  const title=document.createElement("span");title.textContent=({v2:"V2 · 官方结算",v3:"V3 · 行情源",edge:"EDGE · 影子信号"})[name];
  const status=document.createElement("span");status.className="state "+(item.ok?"ok":"bad");
  status.textContent=item.ok?"只读接口可达":"不可用 "+(item.error||"");
  line.append(title,status);e("sources").append(line);
 }
 e("mode").textContent=v2.productionSignalSourceMode||"未确认";
 e("model").textContent=Array.isArray(v2.activeSignalModels)?v2.activeSignalModels.map(x=>x.name||x.id).join("、")||"无活跃模型":"未确认";
 e("round").textContent=v2.records&&v2.records.length?String(v2.records[0].roundStartMs||v2.records[0].roundId||"查看下方"):"无有效数据";
 e("settlement").textContent=v2.settlementSource||"未确认";
 e("summary").textContent=pretty(v2.summary);
 e("records").textContent=pretty(v2.records);
 e("monitor-state").textContent=v2.ok?"只读监控已连接":"数据源异常";
}catch(err){e("overall").textContent="独立监控服务不可用："+String(err);e("monitor-state").textContent="不可用"}
}
load();setInterval(load,15000);
</script></body></html>"""

def fetch_source(name, url):
    # Hard-coded HTTPS allowlist. No caller-supplied URL; never include API keys.
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "ZL-prediction-readonly-monitor/1"})
        with urllib.request.urlopen(req, timeout=4) as response:
            if response.status != 200:
                return {"ok": False, "error": "HTTP " + str(response.status)}
            raw = response.read(900000)
            data = json.loads(raw)
        if not isinstance(data, dict):
            return {"ok": False, "error": "NON_OBJECT_RESPONSE"}
        if name == "v2":
            return {
                "ok": data.get("ok") is True,
                "productionSignalSourceMode": data.get("productionSignalSourceMode"),
                "activeSignalModels": (data.get("activeSignalModels") or [])[:8],
                "settlementSource": data.get("settlementSource"),
                "summary": data.get("summary"),
                "records": (data.get("records") or [])[:12],
            }
        return {"ok": True, "responseKeys": sorted(data.keys())[:25],
                "updatedAt": data.get("updatedAt") or data.get("timestamp") or data.get("asOf")}
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": "HTTP " + str(exc.code)}
    except Exception as exc:
        return {"ok": False, "error": type(exc).__name__}

def overview():
    # Avoid concurrent polls flooding sleeping Render backends.
    with _LOCK:
        if _CACHE["value"] is not None and time.monotonic() - _CACHE["at"] < 15:
            return _CACHE["value"]
        result = {"ok": True, "mode": "read_only_migration_monitor",
                  "tradeExecutionEnabled": False, "checkedAt": datetime.datetime.now(
                      datetime.timezone.utc).isoformat(),
                  "sources": {name: fetch_source(name, url) for name, url in SOURCES.items()}}
        _CACHE.update(at=time.monotonic(), value=result)
        return result

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/" or path == "/index.html":
            self.write(PAGE, "text/html; charset=utf-8")
        elif path == "/healthz":
            self.write({"ok": True, "service": "zl-prediction-readonly-monitor",
                        "tradeExecutionEnabled": False})
        elif path == "/api/overview":
            self.write(overview())
        else:
            self.send_error(404)
    def do_POST(self):
        self.send_error(405, "prediction trading and settings are not migrated")
    def write(self, value, mime="application/json; charset=utf-8"):
        payload = (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)).encode()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self, fmt, *args):
        return

if __name__ == "__main__":
    if os.environ.get("BIND_HOST", HOST) != "127.0.0.1":
        raise RuntimeError("read-only prediction panel must bind loopback only")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

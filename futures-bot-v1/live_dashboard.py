"""Dedicated real-futures control page. Never display simulated positions as live."""
PAGE=r"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZL 合约机器人 · 实盘</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0d1420;color:#f0f5ff;font-family:system-ui,"PingFang SC",sans-serif}
main{max-width:800px;margin:auto;padding:18px 14px 55px}.card{background:#182335;border:1px solid #30435d;border-radius:16px;margin:14px 0;padding:17px}
h1{font-size:24px;margin:4px 0}h2{font-size:17px;margin:0 0 13px}.muted,small{color:#b2c4df}.row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:12px 0}
.good{color:#4ce3ab}.bad{color:#ff8394}.warn{color:#ffd27d}.pill{border:1px solid #406080;border-radius:20px;padding:5px 12px;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.box{background:#101d2f;border-radius:12px;padding:13px;min-width:0;overflow-wrap:anywhere}
.box small{display:block}.box b{display:block;font-size:19px;margin-top:5px;font-variant-numeric:tabular-nums}
button{border:1px solid #4375ae;border-radius:11px;color:white;background:#196bb6;padding:13px 20px;min-height:50px;font-size:16px;font-weight:700;cursor:pointer}
button.off{background:#632c38;border-color:#ad4d63}button:disabled{opacity:.45;cursor:not-allowed}
nav{display:flex;gap:12px}a{color:#8bc7ff}nav a{padding:10px;border-radius:9px;background:#142742}
#message{min-height:26px;font-size:14px;margin-top:12px}
@media(max-width:480px){.row button{width:100%}}
</style></head><body><main>
<nav><a href="/dashboard/">合约机器人</a><a href="/prediction/">预测机器人</a><a href="/api-keys/">交易所 API 管理</a></nav>
<div class="row"><div><h1>合约机器人 · 实盘</h1><small>币安 USDⓈ-M · BTCUSDT / ETHUSDT / BTCUSDC</small></div><span id="mode" class="pill">读取中</span></div>
<section class="card">
<h2>真实交易总开关</h2><div id="switch" style="font-size:25px;font-weight:800" class="bad">读取中</div>
<div class="row"><button id="start" onclick="toggle(true)">开启实盘自动交易</button><button class="off" id="stop" onclick="toggle(false)">关闭实盘新开仓</button></div>
<div id="message" aria-live="polite"></div>
<small>开启后会使用真实余额自动下合约单；关闭只禁止新的开仓，已有持仓的交易所止盈止损继续有效。部署、服务重启后开关自动关闭。</small>
</section>
<section class="card"><h2>引擎和账户</h2>
<div class="grid"><div class="box"><small>引擎状态</small><b id="engine">—</b></div>
<div class="box"><small>账户交易准备</small><b id="ready">—</b></div>
<div class="box"><small>真实 USDT 可用</small><b id="usdt">—</b></div>
<div class="box"><small>真实 USDC 可用</small><b id="usdc">—</b></div>
</div><div class="muted" id="blocker" style="margin-top:10px"></div></section>
<section class="card"><h2>三个合约交易对（实时价格）</h2><div id="prices" class="grid">加载中…</div>
<small>三个交易对独立判断，最多每个币对一个仓位；不设置平仓后冷却，但必须有有效交易信号和足够保证金。</small></section>
<section class="card"><h2>交易所实盘持仓与止盈止损</h2><div id="positions">加载中…</div>
<small>仅显示机器人已记录并核对的持仓。显示价格和浮动盈亏为估算，订单成交以币安记录为准。</small></section>
<section class="card"><h2>近期实盘平仓记录</h2><div id="trades">加载中…</div>
<small>历史模拟交易不计入实盘盈亏。遇到交易所返回状态不明、止损单丢失或权限异常时自动停止新开仓。</small></section>
</main><script>
const $=id=>document.getElementById(id);let busy=false;
const esc=v=>String(v??"—").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=v=>typeof v==="number"&&Number.isFinite(v)?v.toFixed(4):"—";
async function refresh(){
 try{
  const r=await fetch("/status",{cache:"no-store"});if(!r.ok)throw Error("HTTP "+r.status);
  const d=await r.json();const on=d.liveTradingEnabled===true;
  $("mode").textContent=d.mode==="live"?"真实账户 / 实盘模式":"尚未部署实盘引擎";
  $("switch").textContent=on?"● 实盘新开仓已开启":"● 实盘新开仓已关闭";
  $("switch").className=on?"good":"bad";$("start").disabled=busy||on||d.mode!=="live"||d.halted||!d.workerRunning;
  $("stop").disabled=busy||!on;
  $("engine").textContent=d.workerRunning?"正在运行":"未运行";
  $("engine").className=d.workerRunning?"good":"bad";
  const p=d.preflight||{};
  $("ready").textContent=d.halted?"已安全锁定":p.authenticated?"币安已认证":"待验证";
  $("ready").className=d.halted?"bad":p.authenticated?"good":"warn";
  $("blocker").textContent=d.workerError?"运行异常："+d.workerError:(d.halted?"实时交易已锁定，需要核对交易所订单和日志":(p.blocker||"开启时将进行真实账户仓位、订单和交易权限检查"));
  const assets=(d.futuresWallet||{}).assets||{},usdt=assets.USDT||{},usdc=assets.USDC||{};
  $("usdt").textContent=fmt(usdt.availableBalance)+" USDT";
  $("usdc").textContent=fmt(usdc.availableBalance)+" USDC";
  const prices=(d.latestPrices||{}).symbols||{};
  $("prices").innerHTML=(d.configuredSymbols||["BTCUSDT","ETHUSDT","BTCUSDC"]).map(k=>{
   const q=prices[k]||{};
   return '<div class="box"><small>'+esc(k)+'</small><b>'+fmt(q.price)+'</b><small>'+ (q.stale?"行情过期":"行情有效")+'</small></div>';
  }).join("");
  const poses=d.positionDetails||[];
  $("positions").innerHTML=poses.length?poses.map(p=>
   '<div class="box" style="margin:8px 0"><div class="row"><strong>'+esc(p.symbol)+'</strong><strong class="'+(p.side==="BUY"?"good":"bad")+'">'+(p.side==="BUY"?"多单":"空单")+'</strong></div>'+
   '<div class="grid"><div><small>实际开仓价</small><b>'+fmt(p.entryPrice)+'</b></div><div><small>实时标记价</small><b>'+fmt(p.markPrice)+'</b></div>'+
   '<div><small>止盈价</small><b class="good">'+fmt(p.takeProfitPrice)+'</b></div><div><small>止损价</small><b class="bad">'+fmt(p.stopPrice)+'</b></div>'+
   '<div><small>持仓数量</small><b>'+fmt(p.quantity)+'</b></div><div><small>估算浮盈亏</small><b>'+fmt(p.estimatedNetPnl)+'</b></div></div></div>').join(""):"当前没有机器人确认持有的实盘仓位";
  const hist=d.history||[];
  $("trades").innerHTML=hist.length?hist.slice().reverse().map(t=>
    '<div class="row"><span>'+esc(t.symbol)+'</span><small>'+esc(t.reason)+' · '+new Date(t.at*1000).toLocaleString()+'</small></div>').join(""):"暂无实盘平仓";
 }catch(e){$("engine").textContent="无法连接";$("message").textContent="获取状态失败："+e.message}
}
async function toggle(enabled){
 if(busy)return;
 if(enabled&&!confirm("确认开启真实币安合约自动交易？三个币对有信号即可按设置下实盘订单，可能损失本金。"))return;
 busy=true;$("start").disabled=true;$("stop").disabled=true;$("message").textContent="正在校验账户并保存…";
 try{
  const r=await fetch("/api/control",{method:"POST",credentials:"same-origin",
   headers:{"Content-Type":"application/json","X-ZL-Control":"v1"},
   body:JSON.stringify({action:enabled?"live_on":"live_off"})});
  const j=await r.json();if(!r.ok)throw Error(j.error||"操作失败");
  $("message").textContent=enabled?"实盘已授权开启；下一次有效信号可开单":"已关闭新的实盘开仓；现有保护单保留";
 }catch(e){$("message").textContent="操作失败："+e.message}
 finally{busy=false;await refresh()}
}
refresh();setInterval(refresh,5000);
</script></body></html>"""

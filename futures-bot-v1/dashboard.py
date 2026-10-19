"""Phone-friendly isolated paper-futures console. No live trading controls."""
PAGE=r"""<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b1020"><title>ZL 合约控制台 · 模拟</title>
<style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#151f33;--line:#273650;--dim:#9fb0c9;--fg:#eef4ff;--a:#5da8ff;--good:#47dbab;--bad:#ff8d98}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"PingFang SC",sans-serif;line-height:1.5}
main{max-width:760px;padding:20px 14px 70px;margin:auto}.top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
h1{font-size:23px;margin:0}h2{font-size:16px;margin:0 0 14px}.sub,small{color:var(--dim)}.pill{border:1px solid var(--line);padding:5px 12px;border-radius:20px;font-size:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;margin:14px 0}
.warn{border-left:3px solid #ffc978;padding-left:12px;color:#ffdba6;font-size:13px;margin:12px 0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.metric{border-radius:12px;background:#101a2b;padding:12px}.metric small{display:block}.metric strong{display:block;font-size:23px;margin-top:4px;font-variant-numeric:tabular-nums}
.good{color:var(--good)}.bad{color:var(--bad)}.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.buttons{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button{font:inherit;font-weight:650;color:var(--fg);background:#1d3659;border:1px solid #3b6ca0;border-radius:11px;padding:13px 10px;cursor:pointer;min-height:48px}
button.primary{background:#196bb6;border-color:#2786df}button.stop{background:#6b2733;border-color:#a94456}button:disabled{opacity:.43;cursor:not-allowed}
select,input{width:100%;background:#0d1728;color:var(--fg);border:1px solid #3c4d6e;border-radius:9px;padding:10px;font-size:16px}
.formgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}label{font-size:12px;color:var(--dim);display:block;margin-bottom:5px}
#message{min-height:25px;color:var(--dim)}.trade{display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0;font-size:13px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0d1728;border-radius:9px;padding:12px;font-size:12px}
.quotes .metric{border:1px solid #2c4564}.quoteprice{font-size:27px!important}.price-meta{font-size:12px;min-height:35px;margin-top:8px}
.levels{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}
.level{background:#101a2b;border:1px solid #2c3c54;border-radius:12px;padding:13px}
.level small{display:block}.level strong{font-size:21px;font-variant-numeric:tabular-nums}
.stopnum{color:#ff858c}.tpnum{color:#4adcac}.posfoot{font-size:12px;color:var(--dim);margin-top:12px}
@media(max-width:480px){.formgrid{grid-template-columns:1fr 1fr}.formgrid>div:last-child{grid-column:span 2}}

.bot-nav{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:16px 0}
.bot-nav a{display:block;padding:12px 8px;text-align:center;text-decoration:none;color:var(--fg);border:1px solid #3c4d6e;background:#142239;border-radius:11px;font-weight:650}
.bot-nav a.active{background:#196bb6;border-color:#2786df}
</style></head><body><main>
<div class="top"><div><h1>ZL 合约机器人</h1><div class="sub">阿里云 · BTC/ETH · USDT/USDC 永续实验</div></div><span class="pill">仅模拟 · 实盘关闭</span></div>

<nav class="bot-nav" aria-label="选择机器人">
<a href="/dashboard/" class="active" aria-current="page">合约机器人</a>
<a href="/prediction/">预测机器人</a>
<a href="/api-keys/">交易所 API 管理</a>
</nav>
<div class="warn">研究测试版：无真实下单。停止新开仓不代表立即平掉已有模拟仓位；“紧急停止”会锁定新开仓，恢复前需人工检查。</div>
<section class="card quotes">
<div class="row"><h2>最新合约价格</h2><small>币安标记价格 · 约15秒更新</small></div>
<div class="grid">
 <div class="metric"><small id="btc-label">BTCUSDT</small><strong class="quoteprice" id="btc-price">—</strong><div class="price-meta sub" id="btc-meta">等待行情…</div></div>
 <div class="metric"><small id="eth-label">ETHUSDT</small><strong class="quoteprice" id="eth-price">—</strong><div class="price-meta sub" id="eth-meta">等待行情…</div></div>
 <div class="metric"><small id="btcusdc-label">BTCUSDC</small><strong class="quoteprice" id="btcusdc-price">—</strong><div class="price-meta sub" id="btcusdc-meta">等待行情…</div></div>
</div>
<small>页面每5秒刷新；“策略监控”代表交易对已加入扫描。行情时间以服务器实际收到数据为准。行情超时会显示“已过期”，不能视为实时成交价。</small>
</section>
<section class="card"><div class="row"><h2>运行概况</h2><span id="worker" class="pill">检查中</span></div>
<div class="grid"><div class="metric"><small>模拟统一资金池余额（U）</small><strong id="balance">—</strong></div>
<div class="metric"><small>累计净盈亏</small><strong id="pnl">—</strong></div>
<div class="metric"><small>已平仓 / 盈利笔数</small><strong id="wins">—</strong></div>
<div class="metric"><small>模拟胜率</small><strong id="winrate">—</strong></div></div>
<div class="row" style="margin-top:12px"><small>开仓状态</small><b id="entry-status">—</b></div>
<div class="row"><small>行情诊断</small><b id="exchange">检测中</b></div>
<div class="row" style="align-items:start"><small>最后获取成功</small><span id="market-age" style="text-align:right;max-width:70%;font-size:12px">—</span></div>
<div id="error" class="warn" style="display:none"></div></section>
<section class="card"><h2>交易控制</h2>
<div class="buttons">
<button id="pause" onclick="act('pause')">暂停新开仓</button>
<button class="primary" id="resume" onclick="act('resume')">恢复模拟策略</button>
<button class="stop" id="stop" style="grid-column:span 2" onclick="stopNow()">紧急停止（锁定）</button>
</div><div id="message" aria-live="polite"></div>
<small>仅在模拟模式生效。若交易引擎异常退出或交易所封禁，点击“恢复模拟策略”不会绕过安全锁定，也不会重启失效进程。</small>
</section>
<section class="card"><h2>模拟风险参数</h2>
<div class="formgrid">
<div><label for="lev">杠杆场景</label><select id="lev"><option>1</option><option>2</option><option>3</option><option>5</option><option>10</option><option>15</option><option>20</option></select></div>
<div><label for="risk">单笔计划价格风险</label><select id="risk"><option value="0.005">0.5%</option><option value="0.01">1%</option><option value="0.015">1.5%</option><option value="0.02">2%</option></select></div>
<div><label for="margin">单笔保证金比例上限</label><select id="margin"><option value="0.05">5%</option><option value="0.1">10%</option><option value="0.15">15%</option><option value="0.2">20%</option></select></div>
</div><button class="primary" style="width:100%;margin-top:15px" onclick="saveParams()">保存模拟参数</button>
<small>模拟共用一个资金池，USDT和USDC按1:1记账，并非真实保证金余额。杠杆只改变仓位规模上限，并非收益倍增保证；止损可能因跳空、滑点产生额外亏损。</small></section>
<section class="card"><h2>当前模拟持仓</h2>
<div id="flat" class="sub">暂无持仓</div>
<div id="position-fields" style="display:none">
 <div class="row"><b id="pos-symbol">—</b><b id="pos-side">—</b></div>
 <div class="levels">
  <div class="level"><small>模拟开仓价格</small><strong id="entry-price">—</strong></div>
  <div class="level"><small>当前标记价格</small><strong id="mark-price">—</strong></div>
  <div class="level"><small>自动止盈目标</small><strong class="tpnum" id="tp-price">—</strong></div>
  <div class="level"><small>自动止损目标</small><strong class="stopnum" id="sl-price">—</strong></div>
  <div class="level"><small>估算浮动净盈亏</small><strong id="floating-pnl">—</strong></div>
  <div class="level"><small>持仓数量</small><strong id="pos-qty">—</strong></div>
 </div>
 <div class="posfoot" id="pos-time">—</div>
 <div class="posfoot" id="pos-distance">—</div>
 <div class="posfoot">仅模拟：止盈止损由机器人按周期检查标记价格，可能出现滑点。浮动盈亏扣除估算双边手续费，不含资金费率及真实成交滑点。</div>
</div>
</section>
<section class="card"><h2>各交易对模拟统计</h2>
<div id="symbol-stats" class="sub">正在读取…</div>
<div class="row" style="margin-top:12px;align-items:start"><small>为什么暂时没有其他开仓？</small><b id="entry-reason" style="text-align:right;max-width:69%;font-size:12px">正在读取…</b></div>
<small>全机器人只允许一个持仓，已有持仓期间不再新开其他币对；平仓后冷却30分钟。即使空仓，也要符合突破、成交量和趋势条件。这里展示真实记录，不代表每个交易对都必须成交。</small>
</section>
<section class="card"><h2>最近12笔模拟平仓（含交易对）</h2><div id="trades" class="sub">暂无记录</div></section>
<section class="card"><h2>安全与数据</h2><small id="storage">状态读取中</small><p class="sub" style="font-size:12px">2026年实验版 · 模拟成交基于标记价格估算，并非交易所真实成交结果。页面需HTTPS身份验证；请勿公开密码。</p></section>
</main><script>
const fmt=v=>typeof v==="number"&&Number.isFinite(v)?v.toFixed(2):"—";
const priceFmt=v=>fmt(v);
const qtyFmt=v=>typeof v==="number"&&Number.isFinite(v)?v.toLocaleString("en-US",{maximumFractionDigits:8}):"—";
const readableTime=t=>t?new Date(t).toLocaleString("zh-CN",{hour12:false}):"未知";
const elapsed=v=>typeof v==="number"?v+"秒前":"未获取";
const el=id=>document.getElementById(id);let init=false,working=false;
const safe=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function refresh(){
 try{
  const r=await fetch("/status",{cache:"no-store"});if(!r.ok)throw Error("HTTP "+r.status);
  const s=await r.json(),c=s.control||{};
  el("balance").textContent=fmt(s.simulatedBalance)+" U（模拟）";
  let v=s.simulatedPnL;el("pnl").textContent=(v>0?"+":"")+fmt(v)+" U（模拟）";el("pnl").className=v>0?"good":v<0?"bad":"";
  el("wins").textContent=(s.closedTrades||0)+" / "+(s.wins||0);
  el("winrate").textContent=s.closedTrades?((s.wins||0)*100/s.closedTrades).toFixed(1)+"%":"—";
  el("worker").textContent=s.workerRunning?"行情任务运行中":"行情任务未运行";
  el("entry-status").textContent=c.emergency_stop?"紧急锁定":c.entry_enabled?"允许模拟开仓":"暂停新开仓";
  const m=s.marketHealth||{};
  const labels={
    market_data_received:"行情数据更新正常",
    market_data_stale:"行情超时未刷新",
    waiting_first_market_data:"等待首次有效行情",
    request_failed:"行情接口请求异常",
    exchange_restricted:"交易所访问受限",
    engine_stopped:"行情任务已停止"
  };
  const state=m.status||s.exchangeAccess||"unverified";
  el("exchange").textContent=labels[state]||"行情未验证";
  el("exchange").className=state==="market_data_received"?"good":state==="waiting_first_market_data"?"":"bad";
  el("market-age").textContent=m.lastSuccessAt?
    (new Date(m.lastSuccessAt).toLocaleString("zh-CN",{hour12:false})+
      " · "+m.lastSuccessAgeSeconds+"秒前 · "+(m.symbol||"")+" "+(m.source||"")):
    "尚未收到有效行情";
  if(m.lastRequestError){el("market-age").textContent+=" · 最近请求错误："+m.lastRequestError}
  el("error").style.display=s.workerError?"block":"none";el("error").textContent=s.workerError||"";
  el("pause").disabled=working||!c.entry_enabled||c.emergency_stop;
  el("resume").disabled=working||c.entry_enabled||c.emergency_stop;
  el("stop").disabled=working||c.emergency_stop;
  const prices=(s.latestPrices&&s.latestPrices.symbols)||{};
  for(const [symbol,prefix] of [["BTCUSDT","btc"],["ETHUSDT","eth"],["BTCUSDC","btcusdc"]]){
    el(prefix+"-label").textContent=symbol+((s.configuredSymbols||[]).includes(symbol)?" · 策略监控":" · 仅行情");
    const q=prices[symbol]||{};
    el(prefix+"-price").textContent=priceFmt(q.price);
    el(prefix+"-price").className="quoteprice"+(q.stale?" bad":"");
    el(prefix+"-meta").textContent=q.price===null||q.price===undefined?
      "暂无有效价格":(q.stale?"已过期 · ":"更新正常 · ")+elapsed(q.ageSeconds)+" · "+readableTime(q.updatedAt);
  }
  const p=s.positionDetail;
  el("position-fields").style.display=p?"block":"none";
  el("flat").style.display=p?"none":"block";
  el("flat").textContent=s.position&&!p?"持仓数据不完整，请检查机器人状态":"当前空仓，未产生模拟开仓价和止盈止损价";
  if(p){
    el("pos-symbol").textContent=p.symbol;
    el("pos-side").textContent=p.side==="BUY"?"做多 / BUY":"做空 / SELL";
    el("pos-side").className=p.side==="BUY"?"good":"bad";
    el("entry-price").textContent=priceFmt(p.entryPrice);
    el("mark-price").textContent=priceFmt(p.markPrice);
    el("tp-price").textContent=priceFmt(p.takeProfitPrice);
    el("sl-price").textContent=priceFmt(p.stopPrice);
    el("pos-qty").textContent=qtyFmt(p.quantity);
    const profit=p.estimatedNetPnl;
    el("floating-pnl").textContent=profit===null?"—（行情过期）":(profit>0?"+":"")+fmt(profit)+" "+(p.marginAsset||"USDT")+"（估算）";
    el("floating-pnl").className=profit===null?"":profit>0?"good":profit<0?"bad":"";
    el("pos-time").textContent="开仓时间："+(p.openAt?readableTime(p.openAt*1000):"未知")+" · 标记价格："+elapsed(p.markAgeSeconds);
    el("pos-distance").textContent=p.markPriceStale?
      "最新价格尚未确认，不展示止盈止损的当前距离":
      "距止盈 "+fmt(p.distanceToTakeProfitPct)+"% · 距止损 "+fmt(p.distanceToStopPct)+"%";
  }
  const stats=s.symbolStats||{};
  el("symbol-stats").innerHTML=(s.configuredSymbols||["BTCUSDT","ETHUSDT","BTCUSDC"]).map(sym=>{
    const item=stats[sym]||{},closed=item.closed||0,wins=item.wins||0;
    const wr=closed?(wins*100/closed).toFixed(1)+"%":"—";
    const net=typeof item.net==="number"?((item.net>0?"+":"")+fmt(item.net)):"—";
    return '<div class="trade"><span><b>'+safe(sym)+'</b>'+(item.open?' · <b class="good">当前持仓</b>':' · 空仓')+
      '</span><span>平仓 '+closed+' · 胜 '+wins+' · '+wr+'</span><b>'+net+' U</b></div>';
  }).join("");
  const blocked=s.halted?"内部安全锁定":c.emergency_stop?"紧急锁定":!c.entry_enabled?"已暂停新开仓":
    s.position?"当前 "+safe(s.position.symbol)+" 已持仓，其他币对等待":
    s.cooldownRemainingSeconds>0?"平仓冷却中，剩余 "+Math.ceil(s.cooldownRemainingSeconds/60)+" 分钟":
    "允许扫描，等待符合策略条件的信号";
  el("entry-reason").textContent=blocked;
  el("storage").textContent=s.storageNote||"模拟数据";
  el("trades").innerHTML=(s.lastTrades||[]).length?s.lastTrades.slice().reverse().map(x=>
    '<div class="trade"><span>'+safe(new Date(x.at*1000).toLocaleString())+' · <b>'+safe(x.symbol||"未知币对")+
    '</b> · '+(x.side==="BUY"?"做多":x.side==="SELL"?"做空":"")+
    '</span><span>'+safe(x.reason)+'</span><b>'+fmt(x.net)+' '+safe(x.marginAsset||'USDT')+'</b></div>'
  ).join(""):"暂无已平仓交易";
  if(!init && Object.keys(c).length){
   el("lev").value=String(c.leverage);el("risk").value=String(c.risk_fraction);el("margin").value=String(c.max_margin_fraction);init=true;
  }
 }catch(e){el("worker").textContent="状态无法读取";el("error").style.display="block";el("error").textContent="前台与机器人连接失败"}
}
async function act(action,payload){
 if(working)return;working=true;el("message").textContent="正在保存，请稍候…";
 try{
  const r=await fetch("/api/control",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-ZL-Control":"v1"},body:JSON.stringify({action,payload})});
  const j=await r.json();
  if(!r.ok)throw Error(j.error||"更新失败");
  init=false;el("message").textContent="已保存："+({"pause":"暂停新开仓","resume":"恢复模拟策略","emergency_stop":"已锁定","set_params":"模拟参数已更新"}[action]||action);
 }catch(e){el("message").textContent="操作失败："+e.message}
 finally{working=false;await refresh()}
}
function stopNow(){if(confirm("确认紧急停止？会锁定新的模拟开仓，需要人工检查才能解除；已有模拟仓位仍受原止损/止盈规则管理。"))act("emergency_stop")}
function saveParams(){act("set_params",{leverage:Number(el("lev").value),risk_fraction:Number(el("risk").value),max_margin_fraction:Number(el("margin").value)})}
refresh();setInterval(refresh,5000);
</script></body></html>"""

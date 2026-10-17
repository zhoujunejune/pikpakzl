// Cloudflare Workers Free: independent read-only market retrieval and signal-monitoring UI.
// Never expose account credentials or balances. Does not mutate Railway or place trades.
import {bestMarket} from './provider-market.mjs';
const EDGE_URL='https://edge-5m-v1.zl528094-3ba.workers.dev/status';
const EDGE_MARKET_URL='https://edge-5m-v1.zl528094-3ba.workers.dev/market-check';
const BASE_URL='https://trade-control-panel-production.up.railway.app/api/postflip-official-stats?model=BREAKOUT20_RSI_MACD_RANGE_V1';
const reply=(body,code=200)=>Response.json(body,{status:code,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const number=n=>typeof n==='number'&&Number.isFinite(n)?n:null;
const error=e=>String(e?.message||e).slice(0,140);
async function read(url){const r=await fetch(url,{headers:{accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(4200)});
 if(!r.ok)throw Error('UPSTREAM_HTTP_'+r.status);
 return await r.json();}
// Read-only: prefer the already-active APAC Durable Object's verified provider observation.
// Our new Worker can run from an egress POP blocked by Bybit/OKX; never falsify quotes.
async function readEdge(env,path){
 if(!env?.EDGE5_SERVICE)throw Error('EDGE_SERVICE_BINDING_MISSING');
 const url='https://edge-5m-v1.zl528094-3ba.workers.dev'+path;
 const r=await env.EDGE5_SERVICE.fetch(new Request(url,{method:'GET',headers:{accept:'application/json'}}));
 if(!r.ok)throw Error('EDGE_SERVICE_HTTP_'+r.status);
 return await r.json();
}
async function market(env){
 const failures=[];
 try{
  const d=await readEdge(env,'/market-check'),now=Date.now();
  if(d.ok!==true||d.realData!==true||d.orders!==false||
    !['BYBIT','OKX','BINANCE'].includes(d.venue)||
    !Number.isFinite(Number(d.spotPrice))||Number(d.spotPrice)<=0||
    !Number.isFinite(Number(d.marketAt))||now-Number(d.marketAt)>3500||
    Number(d.marketAt)>now+300||
    !d.providers?.spot||!d.providers?.depth||!d.providers?.trades||!d.providers?.perp)
    throw Error('EDGE_MARKET_NOT_LIVE_OR_INVALID');
  return {ok:true,readOnly:true,realData:true,venue:d.venue,marketAt:Number(d.marketAt),
    spotPrice:Number(d.spotPrice),perpPrice:Number(d.perpPrice),
    providers:d.providers,source:'EDGE5_VERIFIED_READONLY_MARKET',
    depthLevels:null,trades:null};
 }catch(e){failures.push('EDGE:'+error(e));}
 try{
  const o=await bestMarket(),now=Date.now();
  if(now-o.at>3500||!Number.isFinite(o.spotPrice)||o.spotPrice<=0)
    throw Error('STALE_MARKET');
  return {ok:true,readOnly:true,realData:true,venue:o.venue,marketAt:o.at,
    spotPrice:o.spotPrice,perpPrice:o.perpPrice,
    depthLevels:{bids:o.bids.length,asks:o.asks.length},trades:o.trades.length,
    providers:o.providers,source:'DIRECT_CLOUDFLARE_PUBLIC_READ'};
 }catch(e){failures.push('DIRECT:'+error(e));}
 return {ok:false,readOnly:true,error:failures.join(';').slice(0,280)};
}

async function edge(env){try{
 const d=await readEdge(env,'/status');
 if(d.ok!==true||d.model!=='EDGE_5M_V1'||d.readOnly!==true||d.orders!==false)
   throw Error('EDGE_READ_ONLY_CONTRACT_MISMATCH');
 const r=d.results?.overall||{};
 const l=d.latest;
 return {ok:true,model:'EDGE_5M_V1',accuracy:number(r.accuracy),samples:Number(r.samples)||0,
  hits:Number(r.hits)||0,training:{samples:Number(d.training?.samples)||0,required:5000,
   ready:d.training?.ready===true},latest:l?{
    round:l.round,direction:l.direction,status:l.status,lockedAt:l.lockedAt,
    actual:l.actual,executionEligible:l.executionEligible===true}:null,
  lastGoodDataAt:d.timed?.lastGoodDataAt||null,
  marketError:d.health?.marketError||null,officialError:d.health?.officialError||null};
 }catch(e){return {ok:false,model:'EDGE_5M_V1',error:error(e)};}}
async function baseline(){try{
 const d=await read(BASE_URL);
 if(d.ok!==true||d.statsScope!=='RSI14_DIRECT_OFFICIAL_ONLY')
  throw Error('BASELINE_OFFICIAL_STATS_NOT_READY');
 const all=d.results?.overall||{};
 return {ok:true,model:'BREAKOUT20_RSI_MACD_RANGE_V1',
  accuracy:number(all.accuracy)??(Number(all.samples)>0?Number(all.hits)/Number(all.samples):null),
  samples:Number(all.samples)||0,hits:Number(all.hits)||0,
  resetAt:d.resetAt||null,readOnly:true};
 }catch(e){return {ok:false,model:'BREAKOUT20_RSI_MACD_RANGE_V1',error:error(e)};}}
export default {async fetch(request,env){
 const u=new URL(request.url);
 if(request.method!=='GET')return reply({ok:false,error:'READ_ONLY_NO_MUTATION'},405);
 if(u.pathname==='/')return new Response(HTML,{headers:{'content-type':'text/html; charset=utf-8',
   'cache-control':'no-store','x-content-type-options':'nosniff',
   'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"}});
 if(u.pathname==='/health')return reply({ok:true,readOnly:true,orders:false,service:'zl-free-market-hub',backend:'Cloudflare Workers Free'});
 if(u.pathname==='/api/market'||u.pathname==='/api/shadow-market-data'){
  const m=await market(env);
  if(u.pathname==='/api/shadow-market-data'&&m.ok)return reply({...m,
   latest:{lastPrice:m.spotPrice,eventMs:m.marketAt},
   compatibility:'RESEARCH_READ_ONLY_BYBIT_OR_OKX_NOT_BINANCE_ORIGINAL'},200);
  return reply(m,m.ok?200:503);}
 if(u.pathname==='/api/edge'){const d=await edge(env);return reply(d,d.ok?200:502);}
 if(u.pathname==='/api/baseline'){const d=await baseline();return reply(d,d.ok?200:502);}
 if(u.pathname==='/api/status'){
  const [m,b,e]=await Promise.all([market(env),baseline(),edge(env)]);
  return reply({ok:true,readOnly:true,orders:false,checkedAt:Date.now(),market:m,baseline:b,edge:e});
 }
 return reply({ok:false,error:'NOT_FOUND'},404);
}};

const HTML = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Cloudflare 免费版 · BTC 信号中心</title><style>\n:root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;background:#0b1120;color:#eff6ff}\n*{box-sizing:border-box}body{margin:0;padding:15px}main{max-width:820px;margin:auto}h1{font-size:23px;margin:7px 0}h2{font-size:17px;margin:0 0 10px}.sub{color:#94a3b8;font-size:13px;line-height:1.7}\n.card{background:#162237;border:1px solid #293951;border-radius:15px;margin:13px 0;padding:17px}\n.metric{font-size:25px;font-weight:750;margin:3px 0}.small{font-size:13px;color:#aabbd0;line-height:1.8}\n.tag{border-radius:8px;padding:4px 9px;background:#27364b;color:#a5d5ff;display:inline-block;font-size:12px}\n.grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.item{background:#0e192b;border-radius:9px;padding:12px}\nbutton{background:#24364e;color:white;border:1px solid #50627b;border-radius:9px;padding:10px 16px;margin-right:8px;font-size:14px;cursor:pointer}\nbutton.on{background:#176b55;border-color:#1a9873}a{color:#8bcafa}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;border-bottom:1px solid #344256;padding:7px 4px}\n.good{color:#4ade80}.bad{color:#fbbf24}@media(max-width:450px){.grid{grid-template-columns:1fr}.metric{font-size:23px}}\n</style></head><body><main>\n<span class=\"tag\">CLOUDFLARE FREE · 只读模式</span><h1>BTC 5分钟 · 信号观察中心</h1>\n<div class=\"sub\">已从 Railway 拆出独立网页展示和行情查询。这里不掌管 PIN、余额或订单；方向不是成交。数据来源会注明真实交易所。</div>\n<div class=\"card\"><h2>实时行情 · Cloudflare 独立获取</h2><div class=\"grid\">\n<div class=\"item\"><div class=\"small\">BTCUSDT 现货报价</div><div id=\"price\" class=\"metric\">读取中</div></div>\n<div class=\"item\"><div class=\"small\">交易所 / 最新数据年龄</div><div id=\"venue\" class=\"metric\">-</div></div></div>\n<div id=\"marketMeta\" class=\"small\">正在验证现货、永续、订单簿和成交记录</div></div>\n<div class=\"card\"><h2>信号模型 · 独立查看</h2><button id=\"b\" class=\"on\">BASELINE</button><button id=\"e\">EDGE_5M_V1</button><div id=\"modelText\" class=\"small\" style=\"margin-top:14px\">切换仅用于查看，不会改变 Railway 的生产下单模型。</div>\n<div class=\"grid\" style=\"margin-top:12px\">\n<div class=\"item\"><div class=\"small\">最新信号（非订单）</div><div id=\"direction\" class=\"metric\">-</div></div>\n<div class=\"item\"><div class=\"small\">官方已结算预测准确率</div><div id=\"accuracy\" class=\"metric\">-</div></div>\n<div class=\"item\"><div class=\"small\">已结算样本</div><div id=\"samples\" class=\"metric\">-</div></div>\n<div class=\"item\"><div class=\"small\">训练/数据状态</div><div id=\"training\" class=\"metric\" style=\"font-size:17px\">-</div></div></div>\n<div id=\"modelMeta\" class=\"small\">等待数据</div></div>\n<div class=\"card\"><h2>实际下单仍由原 Railway 控制</h2>\n<div class=\"small\">Cloudflare 免费版尚未迁移 Binance Prediction 的签名下单、Redis 幂等控制和官方结算持久化。这些在完成独立验证前继续由 Railway 承担。</div>\n<p><a href=\"https://trade-control-panel-production.up.railway.app/\" target=\"_blank\" rel=\"noreferrer\">进入原 Railway 交易前台（真实下单）↗</a></p></div>\n<div id=\"health\" class=\"small\">检查中...</div>\n</main><script>\nlet selection='BASELINE',snapshot=null;\nconst el=id=>document.getElementById(id),fmt=v=>typeof v==='number'&&Number.isFinite(v)?(v*100).toFixed(2)+'%':'暂无样本';\nfunction choose(x){selection=x;el('b').className=x==='BASELINE'?'on':'';el('e').className=x==='EDGE_5M_V1'?'on':'';render()}\nel('b').onclick=()=>choose('BASELINE');el('e').onclick=()=>choose('EDGE_5M_V1');\nfunction render(){if(!snapshot)return;const m=snapshot.market||{},d=selection==='BASELINE'?snapshot.baseline||{}:snapshot.edge||{};\nel('price').textContent=m.ok&&Number.isFinite(m.spotPrice)?m.spotPrice.toLocaleString('en-US',{maximumFractionDigits:2})+' USDT':'不可用';\nel('venue').textContent=m.ok?m.venue:'获取失败';\nel('venue').className='metric '+(m.ok?'good':'bad');\nel('marketMeta').textContent=m.ok?'现货及永续+订单簿+逐笔成交已校验 · 来源 '+m.venue+' · 数据时间 '+new Date(m.marketAt).toLocaleTimeString('zh-CN',{hour12:false}):'实时行情不可用：'+(m.error||'来源异常');\nel('accuracy').textContent=fmt(d.accuracy);el('samples').textContent=d.samples??'-';\nel('direction').textContent=selection==='BASELINE'?'基线统计':d.latest?.direction||'本轮未出信号';\nel('training').textContent=selection==='BASELINE'?'基线独立统计':(d.training?.samples??0)+'/5000';\nel('modelText').textContent='当前查看：'+selection+' · 仅观察，不控制实盘下单。';\nel('modelMeta').textContent=!d.ok?'接口未就绪：'+(d.error||'数据暂缺'):selection==='BASELINE'?'历史官方结算统计；这里不伪造未提供的基线实时锁定方向。':'最新锁定状态 '+(d.latest?.status||'无锁定')+' · 只读预测 · 未完成校准时不得当作自动下单信号';\nel('health').textContent='刷新时间 '+new Date(snapshot.checkedAt).toLocaleString('zh-CN',{hour12:false})+' · 行情 '+(m.ok?'正常':'异常')+' · BASELINE '+(snapshot.baseline?.ok?'可读':'不可读')+' · EDGE '+(snapshot.edge?.ok?'可读':'不可读');\n}\nasync function poll(){try{const r=await fetch('/api/status?ts='+Date.now(),{cache:'no-store'});snapshot=await r.json();render()}catch(e){el('health').textContent='刷新失败：'+String(e)}}\npoll();setInterval(poll,20000);\n</script></body></html>";

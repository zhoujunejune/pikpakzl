// EVENT10: standalone 10-minute DeepSeek signal monitor. No Binance trade API calls.
// Binance Event Contracts currently support trading via mobile apps only.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

export const MODEL_ID = "DEEPSEEK_EVENT10_V1";
export const PERIOD_MS = 600_000;
export const roundId = (now) => Math.floor(now / PERIOD_MS) * PERIOD_MS;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const rounded = (v, n = 4) => Number(v.toFixed(n));

export function marketFeatures(feed, now = Date.now()) {
  if (feed?.ok !== true || feed?.readOnly !== true || feed?.symbol !== "BTCUSDT")
    throw Error("INVALID_READONLY_BTCUSDT_FEED");
  const q = feed.latest || {};
  const observedAt = Number(q.eventMs);
  const price = Number(q.lastPrice);
  if (!Number.isSafeInteger(observedAt) || observedAt > now + 1000 ||
      now - observedAt > 20_000 || !finite(price) || price <= 0 ||
      q.marketFeedConnected === false) throw Error("MARKET_FEED_STALE");
  const bars = (interval, ms) => {
    const section = feed.candles?.[interval];
    const source = Array.isArray(section) ? section :
      (section?.rows || section?.items || section?.candles || []);
    if (!Array.isArray(source)) throw Error("INVALID_CANDLE_DATA");
    const cleaned = source.filter(x => {
      const t = Number(x.startMs ?? x.openTime);
      return x.closed === true && Number.isSafeInteger(t) && t >= 0 &&
        t + ms <= now &&
        ["open","high","low","close","volume"].every(k =>
          finite(Number(x[k])) && Number(x[k]) >= 0) &&
        Number(x.high) >= Number(x.low) && Number(x.close) > 0;
    }).map(x => ({time: Number(x.startMs ?? x.openTime), price: Number(x.close),
      high: Number(x.high), low: Number(x.low), volume: Number(x.volume)}));
    cleaned.sort((a,b) => a.time - b.time);
    return cleaned.slice(-50);
  };
  const one = bars("1m", 60_000), five = bars("5m", 300_000);
  if (one.length < 16 || five.length < 12) throw Error("INSUFFICIENT_CLOSED_CANDLES");
  const rsi = (rows, n = 14) => {
    const last = rows.slice(-(n + 1));
    let up = 0, down = 0;
    for (let i = 1; i < last.length; i++) {
      const d = last[i].price - last[i - 1].price;
      up += Math.max(0,d); down += Math.max(0,-d);
    }
    return down === 0 ? (up === 0 ? 50 : 100) : 100 - 100/(1 + up/down);
  };
  const close1 = one.at(-1).price, close5 = five.at(-1).price;
  return {
    symbol: "BTCUSDT",
    marketObservedAt: observedAt,
    source: "BINANCE_SPOT_OR_PUBLIC_PROXY_NOT_EVENT_INDEX",
    lastPrice: price,
    rsi1m14: rounded(rsi(one),2),
    momentum1m5Pct: rounded((close1/one.at(-6).price - 1)*100),
    momentum5m15Pct: rounded((close5/five.at(-4).price - 1)*100),
    high1m20: Math.max(...one.slice(-20).map(x => x.high)),
    low1m20: Math.min(...one.slice(-20).map(x => x.low)),
    volume1mLatest: one.at(-1).volume,
    closed1m: one.length,
    closed5m: five.length,
    eventContractPayout: null,
    eventContractIndexPrice: null,
    caveat: "Public BTC market price is not the official Binance Event Contracts index."
  };
}

export function parseDecision(body) {
  if (typeof body !== "string" || body.length > 5000) throw Error("MODEL_RESPONSE_INVALID");
  let data;
  try { data = JSON.parse(body); }
  catch { throw Error("MODEL_JSON_INVALID"); }
  if (!["UP","DOWN","WAIT"].includes(data?.direction)) throw Error("MODEL_DIRECTION_INVALID");
  return {
    direction: data.direction,
    confidence: finite(data.confidence) && data.confidence >= 0 && data.confidence <= 1
      ? data.confidence : null,
    reason: String(data.reason || "").slice(0,200)
  };
}

function modelPayload(features, start) {
  return {
    model: "deepseek-flash",
    response_format: {type: "json_object"},
    messages: [
      {role:"system",content:[
        "Analyze only the next potential 10-minute Binance Event Contract direction.",
        "You are producing a signal, not placing an order. Actual contracts expire",
        "10 minutes after the Binance-confirmed opening time; do not assume",
        "fixed UTC round boundaries equal the exchange's contract expiry.",
        "Use only supplied observed data; it is a spot/public market proxy and",
        "NOT the official event index, payout quote or guaranteed entry price.",
        "Never invent event quotes, implied odds, payout ratio or execution fills.",
        "Reply JSON only: direction UP, DOWN or WAIT; confidence 0..1; reason <=200 chars.",
        "WAIT when data is uncertain. Confidence is not a calibrated probability.",
        "Do not claim a profitable strategy or an actionable event order without a quote."
      ].join(" ")},
      {role:"user",content:JSON.stringify({analysisCycleStart:start,
        analysisPeriodMinutes:10,market:features})}
    ]
  };
}

function safeRead(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file,"utf8"));
    return Array.isArray(value) ? value.filter(x => Number.isSafeInteger(x.round)).slice(-300) : [];
  } catch { return []; }
}
function persist(file, records) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o750});
  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp,JSON.stringify(records),{mode:0o640});
  fs.renameSync(temp,file);
}

export function createEngine({env=process.env, clock=Date.now, fetcher=fetch}={}) {
  const key = String(env.DEEPSEEK_API_KEY || "");
  const model = String(env.EVENT10_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL || "deepseek-flash");
  const endpoint = String(env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions");
  const feedUrl = String(env.EVENT10_READONLY_FEED || "http://127.0.0.1:13003/api/shadow-market-data");
  const file = String(env.EVENT10_STATE_FILE || "/var/lib/zl-event10/history.json");
  let history = safeRead(file), busy = false, error = null, nextTryAt = 0, attempts = 0;
  let attemptedRound = null, latencyMs = null, marketAt = null;
  const status = () => {
    const r = roundId(clock()), latest = history.at(-1) || null;
    return {
      ok:true,bot:"EVENT10",modelId:MODEL_ID,providerModel:model,
      configured: Boolean(key),running:true,analysisPeriodMinutes:10,round:r,
      currentSignal: history.findLast(x => x.round === r) || null,
      lastSignal:latest,
      marketObservedAt:marketAt,modelLatencyMs:latencyMs,busy,error,
      attempts:attemptedRound === r ? attempts : 0,
      autoSignalEnabled:Boolean(key),
      autoTradingRequested:true,
      autoTradingEnabled:false,
      executionAvailable:false,
      executionBlocker:"BINANCE_EVENT_CONTRACTS_HAVE_NO_OFFICIAL_TRADING_API",
      officialEventContractResultsAvailable:false,
      historyCount:history.length
    };
  };
  async function tick() {
    const now=clock(), r=roundId(now);
    if (attemptedRound !== r) {attemptedRound=r;attempts=0;nextTryAt=0;error=null;}
    if (!key || busy || history.some(x => x.round === r) || attempts >= 3 ||
        now < r + 5_000 || now >= r + 180_000 || now < nextTryAt) return status();
    busy=true;attempts++;
    try {
      const a=await fetcher(feedUrl,{signal:AbortSignal.timeout(5000),headers:{Accept:"application/json"}});
      if (!a.ok) throw Error("MARKET_HTTP_" + a.status);
      const features=marketFeatures(await a.json(),clock());
      marketAt=features.marketObservedAt;
      const p=modelPayload(features,r);p.model=model;
      const start=clock();
      const b=await fetcher(endpoint,{method:"POST",signal:AbortSignal.timeout(35_000),
        headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
        body:JSON.stringify(p)});
      latencyMs=clock()-start;
      if (!b.ok) throw Error("MODEL_HTTP_" + b.status);
      const result=await b.json();
      if (result?.choices?.[0]?.finish_reason === "length") throw Error("MODEL_TRUNCATED");
      const decision=parseDecision(result?.choices?.[0]?.message?.content);
      if (roundId(clock()) !== r || clock() >= r + 180_000)
        throw Error("ANALYSIS_WINDOW_EXPIRED");
      if (decision.direction === "WAIT") {
        error="MODEL_WAIT: "+decision.reason;
        nextTryAt=clock()+30_000;
        return status();
      }
      const record={round:r,generatedAt:clock(),direction:decision.direction,
        confidence:decision.confidence,reason:decision.reason,providerModel:model,
        observedMarketAt:features.marketObservedAt,observedProxyPrice:features.lastPrice,
        orderPlaced:false,executionStatus:"UNSUPPORTED_NO_EVENT_CONTRACT_API",
        officialOutcome:null};
      history=[...history.filter(x=>x.round!==r),record].slice(-300);
      persist(file,history);
      error=null;
    } catch(e) {error=String(e?.message || e).slice(0,150);nextTryAt=clock()+25_000;}
    finally {busy=false;}
    return status();
  }
  return {status,tick,history: (limit=50) => history.slice(-Math.max(1,Math.min(Number(limit)||50,300))).reverse()};
}

export function serve(engine,{port=Number(process.env.EVENT10_PORT || 13020),host="127.0.0.1"}={}) {
  if (host !== "127.0.0.1") throw Error("LOOPBACK_ONLY");
  const dir=path.dirname(fileURLToPath(import.meta.url));
  const page=fs.readFileSync(path.join(dir,"panel.html"),"utf8");
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,"http://localhost").pathname;
    const send=(code,body,type="application/json; charset=utf-8")=>{
      const out=type.startsWith("application/json")?JSON.stringify(body):body;
      res.writeHead(code,{"Content-Type":type,"Cache-Control":"no-store",
        "X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});
      res.end(out);
    };
    if(req.method!=="GET")return send(405,{ok:false,error:"READ_ONLY_NO_TRADING_ENDPOINT"});
    if (pathname==="/"||pathname==="/event10/"||pathname==="/index.html")
      return send(200,page,"text/html; charset=utf-8");
    if(pathname==="/healthz")return send(200,{ok:true,service:"zl-event10-deepseek"});
    if(pathname==="/api/status")return send(200,engine.status());
    if(pathname==="/api/history")return send(200,{ok:true,records:engine.history()});
    return send(404,{ok:false,error:"NOT_FOUND"});
  });
  server.listen(port,host);return server;
}

if(process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  const engine=createEngine();
  serve(engine);
  void engine.tick();
  setInterval(()=>void engine.tick(),5000);
  console.log("EVENT10_LISTENING_ON_LOOPBACK AUTO_TRADING=false");
}

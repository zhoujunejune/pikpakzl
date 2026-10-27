// BINANCE_DUAL5_PAIR_V1: BTC 5-minute binary complement quote monitor.
// Production service, execution-capable but OFF until owner explicitly arms it.
// Both legs are independent transactions, NOT an atomic arbitrage. Fail closed.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
const BASE='https://api.binance.com';
const PORT=Number(process.env.DUAL5_PORT||13048);
const FILE=process.env.DUAL5_CONFIG||'/var/lib/zl-prediction/dual5/config.json';
const APIKEY=process.env.BINANCE_PREDICTION_API_KEY||'';
const SECRET=process.env.BINANCE_PREDICTION_API_SECRET||'';
const MODEL='BINANCE_DUAL5_PAIR_V1';
const MIN_EDGE=0.08; // $0.08 minimum remaining after conservative fee and execution reserve
const MAX_SIDE_USDT=1.60,MAX_DAILY_SPEND=12.80,ROUND_MS=300000,DEADLINE_BUFFER_MS=45000;
const timeout=(ms=7500)=>AbortSignal.timeout(ms);
const roundOf=(t)=>Math.floor(t/ROUND_MS)*ROUND_MS;
const finite=v=>Number.isFinite(Number(v));
const safeErr=e=>String(e?.message||e).slice(0,140);
function wei(n){const s=String(n);if(!/^\d+(\.\d{1,18})?$/.test(s))throw Error('INVALID_AMOUNT');
 const [a,b='']=s.split('.');return(BigInt(a)*10n**18n+BigInt(b.padEnd(18,'0'))).toString();}
function decimal(s){
 if(s==null)return NaN;
 if(typeof s==='number')return Number.isFinite(s)?s:NaN;
 if(/^\d+$/.test(String(s)))return Number(s)/1e18;
 return Number(s);
}
function signedParams(params={}){
 const q=new URLSearchParams();
 for(const [k,v] of Object.entries(params))if(v!==undefined&&v!==null)q.append(k,String(v));
 q.append('timestamp',String(Date.now()));q.append('recvWindow','5000');
 q.append('signature',crypto.createHmac('sha256',SECRET).update(q.toString()).digest('hex'));
 return q;
}
async function call(kind,path,args={}){
 if(!APIKEY||!SECRET)throw Error('BINANCE_PREDICTION_CREDS_NOT_AVAILABLE');
 const q=signedParams(kind==='GET'?args:{});
 const u=BASE+path+'?'+q.toString();
 const opts={method:kind,headers:{'X-MBX-APIKEY':APIKEY},cache:'no-store',signal:timeout()};
 if(kind==='POST'){const b=new URLSearchParams();
  for(const [k,v] of Object.entries(args))if(v!=null)b.append(k,String(v));
  const body=b.toString();
  // Binance signed POST covers timestamp, recvWindow and body as in existing trade service.
  q.set('signature',crypto.createHmac('sha256',SECRET)
    .update('timestamp='+q.get('timestamp')+'&recvWindow='+q.get('recvWindow')+body).digest('hex'));
  opts.headers['content-type']='application/x-www-form-urlencoded';opts.body=body;
 }
 const target=kind==='POST'?BASE+path+'?'+q.toString():u;
 const resp=await fetch(target,opts);
 const raw=await resp.text();
 let data;try{data=JSON.parse(raw)}catch{data={}}
 if(!resp.ok)throw Error('BINANCE_'+resp.status+'_'+String(data.msg||data.message||'API_REJECTED').slice(0,95));
 return data;
}
function loadConfig(){
 try{const d=JSON.parse(fs.readFileSync(FILE,'utf8'));
  return {armed:d.armed===true,createdAt:d.createdAt||null,
    dailyDate:d.dailyDate||null,dailySpend:finite(d.dailySpend)?Number(d.dailySpend):0,
    lastOrderRound:Number(d.lastOrderRound)||0,blocked:d.blocked===true};}
 catch{return {armed:false,dailyDate:null,dailySpend:0,lastOrderRound:0,blocked:false,createdAt:null};}
}
let config=loadConfig(),state={model:MODEL,at:null,health:'BOOT',round:null,
 lastOpportunity:null,lastOrder:null,lastError:null,checked:0,quoteChecks:0,attempts:0,
 wallet:null,marketTopicId:null,lastScanAt:null};
function persist(){fs.mkdirSync(new URL('.', 'file://'+FILE).pathname,{recursive:true});
 const temp=FILE+'.tmp';fs.writeFileSync(temp,JSON.stringify(config,null,2),{mode:0o600});fs.renameSync(temp,FILE);}
function safePublic(){return {ok:true,model:MODEL,mode:config.armed?'LIVE_ARMED':'PRODUCTION_IDLE',
  active:config.armed&&!config.blocked,blocked:config.blocked,
  dailySpend:config.dailySpend,dailySpendMax:MAX_DAILY_SPEND,maxPerSide:MAX_SIDE_USDT,
  minNetEdgeUSDT:MIN_EDGE,configUpdatedAt:config.createdAt,
  ...state,wallet:undefined};}
function norm(s){return String(s||'').toUpperCase().trim();}
function complimentaryTokens(topic){
 const ms=Array.isArray(topic?.markets)?topic.markets:[];
 const possible=[];
 for(const m of ms){
  const os=Array.isArray(m.outcomes)?m.outcomes:[];
  const yes=os.find(x=>norm(x.name)==='YES'&&x.tokenId);
  const no=os.find(x=>norm(x.name)==='NO'&&x.tokenId);
  const up=os.find(x=>norm(x.name)==='UP'&&x.tokenId);
  const down=os.find(x=>norm(x.name)==='DOWN'&&x.tokenId);
  if(up&&down&&String(up.tokenId)!==String(down.tokenId))
   possible.push({up:{...up,marketId:m.marketId},down:{...down,marketId:m.marketId}});
  if(yes&&no&&String(yes.tokenId)!==String(no.tokenId)){
   const title=norm(m.title+' '+m.question);
   if(title.includes('UP')&&!title.includes('DOWN'))
    possible.push({up:{...yes,marketId:m.marketId},down:{...no,marketId:m.marketId}});
   if(title.includes('DOWN')&&!title.includes('UP'))
    possible.push({up:{...no,marketId:m.marketId},down:{...yes,marketId:m.marketId}});
  }
 }
 // Two different YES markets are NOT automatically complementary.
 return possible.length===1?possible[0]:null;
}
function bestAsk(book){
 const a=Array.isArray(book?.asks)?book.asks:[];
 const r=a.map(x=>Array.isArray(x)?{price:Number(x[0]),size:Number(x[1])}:
   {price:Number(x?.price),size:Number(x?.size)})
 .filter(x=>x.price>0&&x.price<1&&x.size>0)
 .sort((x,y)=>x.price-y.price);
 return r[0]||null;
}
function calcPair(qUp,qDown,stake=MAX_SIDE_USDT){
 const a=decimal(qUp?.minReceive??qUp?.amountOut);
 const b=decimal(qDown?.minReceive??qDown?.amountOut);
 const f1=decimal(qUp?.feeAmount??'0'),f2=decimal(qDown?.feeAmount??'0');
 if(![a,b,f1,f2].every(Number.isFinite)||a<=0||b<=0||f1<0||f2<0)
  return {ok:false,reason:'BAD_BINANCE_QUOTES'};
 const shares=Math.min(a,b);
 // Subtract fee again as an intentionally conservative upper-cost estimate:
 // Binance response does not guarantee how feeAmount impacts amountOut.
 const conservativeNet=shares-2*stake-f1-f2-0.025;
 return {ok:true,sharesUp:a,sharesDown:b,pairedShares:shares,
  feeUp:f1,feeDown:f2,conservativeNet:Math.round(conservativeNet*10000)/10000,
  feasible:conservativeNet>=MIN_EDGE};
}
async function discover(now){
 const list=await call('GET','/sapi/v1/w3w/wallet/prediction/market/list',{
  l1Category:'crypto',l2Category:'up-down',sortBy:'CREATED_TIME',orderBy:'DESC',offset:0,limit:100});
 const xs=Array.isArray(list.marketTopics)?list.marketTopics:[];
 const ts=roundOf(now);
 const matches=xs.filter(x=>norm(x.symbol)==='BTCUSDT'&&
  Number(x.startDate)===ts&&Number(x.endDate)===ts+ROUND_MS);
 if(matches.length!==1)throw Error('EXACT_BTC5_ROUND_NOT_UNIQUE_'+matches.length);
 const t=await call('GET','/sapi/v1/w3w/wallet/prediction/market/detail',
  {marketTopicId:matches[0].marketTopicId});
 if(String(t.marketTopicId)!==String(matches[0].marketTopicId))
  throw Error('TOPIC_DETAIL_ID_MISMATCH');
 if(norm(t.symbol)!=='BTCUSDT'||Number(t.startDate)!==ts||
    Number(t.endDate)!==ts+ROUND_MS)throw Error('TOPIC_BOUNDARIES_MISMATCH');
 const pair=complimentaryTokens(t);
 if(!pair)throw Error('COMPLEMENTARY_UP_DOWN_TOKEN_MAPPING_NOT_PROVEN');
 return {topic:t,pair};
}
async function bookFor(topic,leg){
 const b=await call('GET','/sapi/v1/w3w/wallet/prediction/order-book',{
  vendor:'predict_fun',marketId:leg.marketId,tokenId:leg.tokenId});
 if(String(b.tokenId)!==String(leg.tokenId))throw Error('ORDERBOOK_TOKEN_MISMATCH');
 if(!finite(b.timestamp)||Math.abs(Date.now()-Number(b.timestamp))>3500)
  throw Error('STALE_ORDERBOOK');
 return bestAsk(b);
}
async function quoteFor(topic,leg,wallet,sideAmount=MAX_SIDE_USDT){
 const body={walletAddress:wallet.walletAddress,tokenId:leg.tokenId,side:'BUY',
 amountIn:wei(sideAmount),orderType:'MARKET',slippageBps:Math.min(1000,Number(topic.slippageBps||1200)),
 chainId:topic.chainId||'56',feeRateBps:topic.feeRateBps||200,fundingSource:'MPC'};
 const q=await call('POST','/sapi/v1/w3w/wallet/prediction/trade/get-quote',body);
 if(String(q.tokenId)!==String(leg.tokenId)||!q.quoteId||q.side!=='BUY')
  throw Error('WRONG_QUOTE_TOKEN_OR_SIDE');
 if(!finite(q.expireAt)||Number(q.expireAt)<Date.now()+2200)throw Error('EXPIRING_QUOTE');
 return q;
}
async function walletInfo(){
 const w=await call('GET','/sapi/v1/w3w/wallet/prediction/wallet/list');
 const row=Array.isArray(w.wallets)?w.wallets.find(x=>x.walletAddress&&x.walletId):null;
 if(!row)throw Error('WALLET_NOT_REGISTERED');return row;
}
async function confirmOrder(wallet,id,topic){
 for(let i=0;i<4;i++){
  const [live,past]=await Promise.all([
   call('GET','/sapi/v1/w3w/wallet/prediction/order/list',
    {walletAddress:wallet.walletAddress,offset:0,limit:100}),
   call('GET','/sapi/v1/w3w/wallet/prediction/order/history',
    {walletAddress:wallet.walletAddress,offset:0,limit:100})]);
  const all=[...(live.orders||[]),...(past.orders||[])];
  const order=all.find(x=>String(x.orderId)===String(id)&&
    String(x.marketTopicId)===String(topic.marketTopicId));
  if(order&&Number(order.filledShareQty)>0){
   return {status:order.status,shares:Number(order.filledShareQty),
    spent:Number(order.filledUsdtAmount),orderId:String(id)};
  }
  await new Promise(r=>setTimeout(r,350));
 }
 return null;
}
async function place(wallet,topic,quote){
 return call('POST','/sapi/v1/w3w/wallet/prediction/trade/place-order-bundle',{
  walletAddress:wallet.walletAddress,walletId:wallet.walletId,
  quoteId:quote.quoteId,timeInForce:'FOK',accountType:'SPOT',
  orderType:'MARKET',slippageBps:Math.min(1000,Number(topic.slippageBps||1200)),
  fundingSource:'MPC'});
}
async function attemptPair(round,topic,pair,q1,q2,analysis,wallet){
 if(!config.armed||config.blocked||config.lastOrderRound===round)return;
 // Persistent pre-commit disables any duplicate re-entry on restarts, even for uncertain HTTP.
 config.lastOrderRound=round;config.dailySpend+=MAX_SIDE_USDT*2;persist();
 const record={round,phase:'PREPARED',first:null,second:null,at:Date.now(),
  estimatedNetUSDT:analysis.conservativeNet};
 state.lastOrder=record;state.at=Date.now();state.attempts++;
 try{
  if(!q1.quoteId||!q2.quoteId)throw Error('PAIR_QUOTES_INCOMPLETE');
  record.phase='SUBMITTING_UP';
  const up=await place(wallet,topic,q1);
  if(!up.orderId)throw Error('UP_ORDER_ID_MISSING');
  record.first={orderId:String(up.orderId),status:'SUBMITTED'};
  record.phase='VERIFYING_UP';
  const u=await confirmOrder(wallet,up.orderId,topic);
  if(!u||u.shares<=0)throw Error('UP_FILL_UNVERIFIED_STOP_NO_SECOND');
  record.first=u;
  // Re-price DOWN after UP fills: never blindly send a stale second quote.
  const down=await quoteFor(topic,pair.down,wallet);
  const reassess=calcPair(q1,down);
  if(!reassess.feasible || Number(down.expireAt)<Date.now()+1800)
   throw Error('DOWN_QUOTE_EDGE_DISAPPEARED');
  record.phase='SUBMITTING_DOWN';
  const dn=await place(wallet,topic,down);
  if(!dn.orderId)throw Error('DOWN_ORDER_ID_MISSING');
  record.second={orderId:String(dn.orderId),status:'SUBMITTED'};
  record.phase='VERIFYING_DOWN';
  const d=await confirmOrder(wallet,dn.orderId,topic);
  if(!d)throw Error('DOWN_FILL_UNVERIFIED');
  record.second=d;
  const guaranteed=Math.min(u.shares,d.shares)-u.spent-d.spent-0.025;
  record.phase='FILLED_BOTH';record.actualPairWorstCaseUSDT=Math.round(guaranteed*10000)/10000;
  // Trade success is not a guarantee of eventual profit: fees and claim friction remain.
  if(guaranteed<0)record.warning='POST_FILL_NET_NEGATIVE';
 }catch(e){
  record.phase='UNHEDGED_OR_UNKNOWN_STOPPED';record.error=safeErr(e);
  config.armed=false;config.blocked=true;persist();state.lastError=record.error;
  // Never duplicate an unknown order or automatically chase a missing leg.
 }
}
let cached=null,busy=false;
async function tick(){
 if(busy)return;busy=true;
 try{
  const now=Date.now(),round=roundOf(now);
  const day=new Date(now).toISOString().slice(0,10);
  if(config.dailyDate!==day){config.dailyDate=day;config.dailySpend=0;persist();}
  state.round=round;state.at=now;
  if(now-round>ROUND_MS-DEADLINE_BUFFER_MS){
   state.health='ROUND_CLOSING_WAIT';return;
  }
  if(config.blocked){state.health='UNHEDGED_OR_UNKNOWN_MANUAL_REVIEW';return}
  if(config.dailySpend+2*MAX_SIDE_USDT>MAX_DAILY_SPEND){
   state.health='DAILY_BUDGET_STOP';return;
  }
  if(config.lastOrderRound===round){state.health='ROUND_ALREADY_ATTEMPTED';return}
  if(!cached||cached.round!==round){
   const v=await discover(now);cached={...v,round};
  }
  const {topic,pair}=cached;
  state.marketTopicId=topic.marketTopicId;
  const [up,down]=await Promise.all([bookFor(topic,pair.up),bookFor(topic,pair.down)]);
  state.checked++;state.lastScanAt=Date.now();
  if(!up||!down)throw Error('ONE_SIDE_NO_LIQUIDITY');
  const fee=(Number(topic.feeRateBps)||200)/10000;
  const raw=up.price+down.price;
  state.lastOpportunity={round,topicId:topic.marketTopicId,
   upAsk:up.price,downAsk:down.price,askSum:Number(raw.toFixed(5)),
   rawSpread:Number((1-raw).toFixed(5)),feeRatePerSide:fee,at:Date.now(),status:'NO_EDGE'};
  if(raw>=1-2*fee-MIN_EDGE/3.2){state.health='BOTH_ASKS_TOO_EXPENSIVE';return}
  const wallet=await walletInfo();
  const [q1,q2]=await Promise.all([quoteFor(topic,pair.up,wallet),quoteFor(topic,pair.down,wallet)]);
  state.quoteChecks++;
  const estimate=calcPair(q1,q2);
  state.lastOpportunity={...state.lastOpportunity,
    quoteNetUSDT:estimate.conservativeNet,pairedShares:estimate.pairedShares,
    status:estimate.feasible?'NET_EDGE_AVAILABLE':'FEES_OR_IMBALANCE_NEGATIVE'};
  if(!estimate.feasible){state.health='QUOTE_NET_EDGE_TOO_SMALL';return}
  if(!config.armed){state.health='OPPORTUNITY_OBSERVED_TRADING_OFF';return}
  state.health='LIVE_PAIR_SUBMISSION';await attemptPair(round,topic,pair,q1,q2,estimate,wallet);
 }catch(e){
  state.lastError=safeErr(e);state.health='NO_VALID_PAIR_'+state.lastError;
 }finally{busy=false}
}
function reply(res,code,json){
 const s=JSON.stringify(json);
 res.writeHead(code,{'content-type':'application/json; charset=utf-8',
  'cache-control':'no-store','content-length':Buffer.byteLength(s)});
 res.end(s);
}
const site='https://prediction.47-237-188-69.sslip.io';
if(process.env.DUAL5_TEST!=='1')http.createServer(async(req,res)=>{
 if(req.method==='GET'&&req.url==='/api/status')return reply(res,200,safePublic());
 if(req.method==='GET'&&req.url==='/healthz')return reply(res,200,{ok:true,model:MODEL});
 if(req.method==='POST'&&req.url==='/api/arm'){
  // Browser owner only; cross-site form and direct no-origin scripts disallowed.
  if(req.headers.origin!==site||req.headers['sec-fetch-site']!=='same-origin')
   return reply(res,403,{ok:false,error:'OWNER_ORIGIN_REQUIRED'});
  let body='';for await (const chunk of req){body+=chunk;if(body.length>3000)break}
  try{
   const d=JSON.parse(body);
   if(typeof d.armed!=='boolean')throw Error('INVALID_ARM_VALUE');
   if(d.armed===true&&config.blocked)throw Error('MANUAL_RECONCILIATION_REQUIRED');
   config.armed=d.armed;config.createdAt=new Date().toISOString();persist();
   return reply(res,200,{ok:true,armed:config.armed,blocked:config.blocked});
  }catch(e){return reply(res,400,{ok:false,error:safeErr(e)})}
 }
 return reply(res,404,{ok:false,error:'NOT_FOUND'});
}).listen(PORT,'127.0.0.1',()=>console.log(JSON.stringify({event:'dual5_listening',port:PORT,mode:config.armed?'armed':'off'})));
if(process.env.DUAL5_TEST!=='1'){setInterval(()=>void tick(),19000).unref();void tick();}
export {complimentaryTokens,bestAsk,calcPair};

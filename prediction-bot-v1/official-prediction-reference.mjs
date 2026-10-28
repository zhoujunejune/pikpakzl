// Read-only Binance Prediction current-round Chainlink start-price reference.
// Runs in a separate loopback-only, non-trading process with signed GET credentials.
// NEVER reports a Chainlink live quote (the market/detail response does not supply one).
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const M=300000;
const symbol='BTCUSDT';
const BASE='https://api.binance.com';
const listPath='/sapi/v1/w3w/wallet/prediction/market/list';
const detailPath='/sapi/v1/w3w/wallet/prediction/market/detail';
const pval=x=>typeof x==='number'&&Number.isFinite(x)?x:
  typeof x==='string'&&x.trim()!==''&&Number.isFinite(Number(x))?Number(x):null;
const integer=x=>Number.isSafeInteger(x);
const roundOf=now=>Math.floor(now/M)*M;
const send=(res,code,v)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(v))};

export function validateOfficialReference(detail,round,observedAt) {
 const d=detail?.data?.marketTopicId?detail.data:detail;
 const v=d?.variantData||d?.variant_data;
 const start=Number(d?.startDate),end=Number(d?.endDate);
 const p=pval(v?.startPrice??v?.start_price);
 const provider=String(v?.priceFeedProvider||v?.price_feed_provider||'').toUpperCase();
 const feedSymbol=String(v?.priceFeedSymbol||v?.price_feed_symbol||'').toUpperCase();
 const feedId=String(v?.priceFeedId||v?.price_feed_id||'');
 if(!integer(round)||round%M||!integer(observedAt)||observedAt<round||
   observedAt>=round+M||!integer(start)||start!==round||
   !integer(end)||end-start!==M||String(d?.symbol||'').toUpperCase()!==symbol||
   !integer(Number(d?.marketTopicId))||p===null||!(p>0)||
   provider!=='CHAINLINK'||feedSymbol!==symbol||
   !feedId||!/^0x[0-9a-f]+$/i.test(feedId)||
   !['REGISTERED','TRADING','OPEN','ACTIVE'].includes(String(d?.status||'').toUpperCase()))
   return null;
 return {ok:true,schema:'OFFICIAL_PREDICTION_START_CHAINLINK_V1',
   roundStartMs:round,roundEndMs:end,marketTopicId:Number(d.marketTopicId),
   source:'BINANCE_PREDICTION_SIGNED_MARKET_DETAIL',
   priceFeedProvider:provider,priceFeedId:feedId,priceFeedSymbol:feedSymbol,
   officialStartPrice:p,officialPriceObservedAt:observedAt,
   officialLivePrice:null,officialLivePriceAvailable:false,
   note:'Start price from registered current Binance Prediction topic only. No live Chainlink quote is available; BTCUSDT spot lastPrice is NOT the Chainlink oracle quote.'};
}

export function createOfficialReferenceServer({env=process.env,fetcher=fetch,clock=Date.now}={}) {
 const key=String(env.BINANCE_PREDICTION_API_KEY||'');
 const secret=String(env.BINANCE_PREDICTION_API_SECRET||'');
 let current=null,attemptAt=0,busy=null,lastError=null;
 async function signedGet(route,params){
  const query=new URLSearchParams({...params,timestamp:String(clock()),recvWindow:'5000'});
  const sig=crypto.createHmac('sha256',secret).update(query.toString()).digest('hex');
  const url=BASE+route+'?'+query+'&signature='+sig;
  const res=await fetcher(url,{headers:{'X-MBX-APIKEY':key,Accept:'application/json'},
   signal:AbortSignal.timeout(4500)});
  if(!res.ok)throw Error('BINANCE_READONLY_HTTP_'+res.status);
  const j=await res.json();
  if(typeof j?.code==='number'&&j.code<0)throw Error('BINANCE_READONLY_CODE_'+j.code);
  return j?.data||j;
 }
 async function fresh(round){
  if(!key||!secret)throw Error('REFERENCE_KEYS_UNCONFIGURED');
  const market=await signedGet(listPath,{l1Category:'crypto',l2Category:'up-down',
   sortBy:'CREATED_TIME',orderBy:'DESC',offset:0,limit:100});
  const items=market?.marketTopics||[];
  if(!Array.isArray(items))throw Error('INVALID_MARKET_LIST');
  // Exact matching round only: never use a near match or adjacent 5m round.
  const topic=items.find(x=>String(x?.symbol||'').toUpperCase()===symbol&&
    Number(x?.startDate)===round&&Number(x?.endDate)===round+M&&
    integer(Number(x?.marketTopicId)));
  if(!topic)throw Error('CURRENT_ROUND_TOPIC_NOT_FOUND');
  const details=await signedGet(detailPath,{marketTopicId:topic.marketTopicId});
  const result=validateOfficialReference(details,round,clock());
  if(!result||Number(result.marketTopicId)!==Number(topic.marketTopicId))
    throw Error('CHAINLINK_TOPIC_REFERENCE_NOT_VALID');
  return result;
 }
 async function reference(round) {
  const now=clock();
  if(!integer(round)||round!==roundOf(now)||now<round||now>=round+45000)
   return {ok:false,error:'REFERENCE_NOT_CURRENT_DECISION_ROUND'};
  if(current?.roundStartMs===round)return current;
  if(busy)return busy;
  if(attemptAt&&now-attemptAt<3000)return {ok:false,error:lastError||'REFERENCE_REFRESH_THROTTLED'};
  attemptAt=now;
  busy=fresh(round).then(v=>{current=v;lastError=null;return v},
    e=>{lastError=String(e?.message||e).slice(0,90);return {ok:false,error:lastError}})
    .finally(()=>{busy=null});
  return busy;
 }
 function serve(port=Number(env.OFFICIAL_REFERENCE_PORT||13044)){
  const server=http.createServer(async (req,res)=>{
   let u;try{u=new URL(req.url,'http://localhost')}catch{return send(res,400,{ok:false,error:'BAD_PATH'})}
   if(req.method!=='GET')return send(res,405,{ok:false,error:'GET_ONLY'});
   if(u.pathname==='/healthz')return send(res,200,{ok:true,schema:'OFFICIAL_PREDICTION_START_CHAINLINK_V1',configured:!!(key&&secret),bind:'loopback-only',trading:false});
   if(u.pathname!=='/api/reference')return send(res,404,{ok:false,error:'NOT_FOUND'});
   const round=Number(u.searchParams.get('round'));
   const info=await reference(round);
   return send(res,info.ok?200:503,info);
  });
  server.listen(port,'127.0.0.1');
  return server;
 }
 return {serve,reference};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const server=createOfficialReferenceServer();
 server.serve();
 console.log('OFFICIAL_PREDICTION_START_REFERENCE_READ_ONLY_LOOPBACK_RUNNING');
}

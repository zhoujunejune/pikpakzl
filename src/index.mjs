// "突破20%即可" — independent, read-only, BTC 5-minute shadow on Cloudflare Free.
// Does not import, call or affect any Binance order API or production model.
import { DurableObject } from 'cloudflare:workers';
import { NAME, VERSION, FEATURE_SET, parseKline, features, baseline, probability, prospectiveStats } from './model.mjs';

const PERIOD=300000, LOCK_OFFSET=6250, DEADLINE=8000;
const FIXED_MODEL='BASELINE';
const TRAINING_POLICY='BASELINE_FROZEN_WEIGHTS_NO_RETRAIN';
const initialTraining=(at=Date.now())=>({
  at,ok:false,adopted:false,reason:'TRAINING_DISABLED_KEEP_FIXED_BASELINE_IF_NO_SAVED_WEIGHTS',
  featureSet:FEATURE_SET,model:FIXED_MODEL,
  source:'HISTORICAL_SPOT_OPEN_CLOSE_PROXY_NOT_OFFICIAL'
});
const RAILWAY_MARKET_URL='https://signal-diagnostic-v3-production.up.railway.app/api/shadow-market-data';
let marketCache=null,marketInFlight=null;
const nowRound=t=>Math.floor(t/PERIOD)*PERIOD;
const fixedNextAlarm=now=>{
  const thisSlot=nowRound(now)+LOCK_OFFSET;
  return thisSlot>now?thisSlot:thisSlot+PERIOD;
};
const blank=()=>({version:VERSION,featureSet:FEATURE_SET,startedAt:Date.now(),seed:[],rows:[],weights:null,
  model:FIXED_MODEL,training:initialTraining(),trainAttempted:false,effectiveFromRound:null,
  settlementsSinceTrain:0,lastFailure:null,lastTickAt:null,lastGoodDataAt:null,firstRound:null});
const safelySerializable=e=>String(e?.message||e||'UnknownError').slice(0,500);
const json=(v,status=200)=>Response.json(v,{status,headers:{'cache-control':'no-store'}});

async function marketFeed(){
  const timestamp=Date.now();
  if(marketCache&&timestamp-marketCache.at<900)return marketCache.payload;
  if(!marketInFlight){
    marketInFlight=(async()=>{
      const response=await fetch(RAILWAY_MARKET_URL,{
        method:'GET',cache:'no-store',
        signal:AbortSignal.timeout(5500),
        headers:{accept:'application/json'}
      });
      if(!response.ok)throw Error('RAILWAY_MARKET_HTTP_'+response.status);
      const payload=await response.json();
      if(payload?.ok!==true||payload?.readOnly!==true||payload?.symbol!=='BTCUSDT'||
         payload?.integrity?.complete!==true)throw Error('RAILWAY_MARKET_INTEGRITY_FAILED');
      const fresh=Date.now();
      if(!Number.isFinite(Number(payload.generatedAtMs))||
         fresh-Number(payload.generatedAtMs)>12000||
         fresh-Number(payload.generatedAtMs)<-3000)throw Error('RAILWAY_MARKET_SNAPSHOT_STALE');
      if(!Number.isFinite(Number(payload.latest?.eventMs))||
         fresh-Number(payload.latest.eventMs)>12000||
         !Number.isFinite(Number(payload.latest?.lastPrice))||
         Number(payload.latest.lastPrice)<=0)throw Error('RAILWAY_MARKET_PRICE_STALE');
      marketCache={at:Date.now(),payload};
      return payload;
    })().finally(()=>{marketInFlight=null;});
  }
  return marketInFlight;
}

async function candles(period,limit){
  const payload=await marketFeed();
  const rows=payload?.candles?.[period]?.rows;
  if(!Array.isArray(rows))throw Error('RAILWAY_'+period+'_CANDLES_MISSING');
  if(rows.length<Math.min(limit,period==='1m'?200:120))
    throw Error('RAILWAY_'+period+'_INSUFFICIENT_CANDLES_'+rows.length);
  const bars=rows.map(k=>parseKline([
    k.startMs,k.open,k.high,k.low,k.close,k.volume,k.endMs
  ]));
  if(bars.some(k=>!k))throw Error('RAILWAY_'+period+'_INVALID_OHLCV');
  const newest=bars.at(-1);
  const maxDelay=period==='1m'?125000:610000;
  if(Date.now()-newest.t>maxDelay||Date.now()-newest.t< -3000)
    throw Error('RAILWAY_'+period+'_CANDLE_STALE');
  bars.endpoint=RAILWAY_MARKET_URL;
  bars.marketEventMs=Number(payload.latest.eventMs);
  bars.spotPrice=Number(payload.latest.lastPrice);
  return bars;
}

function settleExistingRows(rows, historicalBars, until){
  let additions=0;
  for(const row of rows){
    if(!row.direction||row.actual||row.status!=='LOCKED')continue;
    const candle=historicalBars.find(k=>k.t===row.t&&k.closed&&k.end<until);
    if(!candle)continue;
    if(candle.c===candle.o){row.status='TIE_UNRESOLVED';continue;}
    row.actual=candle.c>candle.o?'UP':'DOWN';
    row.status='SETTLED';row.settledAt=until;row.open=candle.o;row.close=candle.c;
    additions++;
  }
  return additions;
}

export class Breakout20 extends DurableObject {
  constructor(ctx,env){super(ctx,env);}
  async retire(){ const s=await this.state();s.retired=true;await this.ctx.storage.put('state',s);await this.ctx.storage.deleteAlarm();return true;}
  async state(){
    const s=await this.ctx.storage.get('state')||blank();
    // One-time migration for the four-factor BASELINE. Old predictions remain
    // immutable; old 10-dimensional vectors and LOGISTIC weights cannot be reused.
    if(s.featureSet!==FEATURE_SET){
      s.previousTraining=s.training||null;
      s.featureSet=FEATURE_SET;
      s.seed=[];
      s.weights=null;
      s.model=FIXED_MODEL;
      s.training=initialTraining();
      s.trainAttempted=false;
      s.effectiveFromRound=null;
      s.settlementsSinceTrain=0;
      await this.ctx.storage.put('state',s);
    }else if(s.model!==FIXED_MODEL){
      s.model=FIXED_MODEL;
      await this.ctx.storage.put('state',s);
    }
    return s;
  }
  async fetch(req){
    const path=new URL(req.url).pathname;
    if(path!=='/status'&&path!=='/latest'&&path!=='/health'&&path!=='/market-check'&&path!=='/model-history')return new Response('Not Found',{status:404});
    const s=await this.state();
    if(await this.ctx.storage.getAlarm()===null){
      const alarm=fixedNextAlarm(Date.now());
      await this.ctx.storage.setAlarm(alarm);
      if(s.firstRound===null){s.firstRound=nowRound(alarm);await this.ctx.storage.put('state',s);}
    }
    if(path==='/model-history'){
      // Read-only audit of previously persisted signal rows. No model changes.
      // firstUse is the first historical LOCKED signal, not the training-completion time.
      const rows=s.rows.filter(r=>(r.direction==='UP'||r.direction==='DOWN') &&
        Number.isFinite(r.lockedAt) &&
        (r.model==='BASELINE'||r.model==='LOGISTIC_L2_V1'||r.model==='BASELINE_UNTRAINED'))
        .sort((a,b)=>a.t-b.t);
      const segments=[];
      for(const r of rows){
        let segment=segments.at(-1);
        if(!segment||segment.model!==r.model){
          segment={model:r.model,firstRoundMs:r.t,firstLockMs:r.lockedAt,
            lastRoundMs:r.t,lastLockMs:r.lockedAt,signals:0};
          segments.push(segment);
        }
        segment.lastRoundMs=r.t;
        segment.lastLockMs=r.lockedAt;
        segment.signals++;
      }
      const firstLogistic=rows.find(r=>r.model==='LOGISTIC_L2_V1');
      const prior=firstLogistic?rows.filter(r=>r.t<firstLogistic.t).at(-1):null;
      const summarize=r=>r?{roundStartMs:r.t,lockedAtMs:r.lockedAt,
        model:r.model,direction:r.direction}:null;
      return json({ok:true,readOnly:true,currentModel:FIXED_MODEL,
        retainedSignals:rows.length,earliestRetained:summarize(rows[0]),
        latestRetained:summarize(rows.at(-1)),
        firstLogisticSignal:summarize(firstLogistic),
        precedingSignal:summarize(prior),
        transitions:segments});
    }
    if(path==='/market-check'){
      try{
        const [one,five]=await Promise.all([candles('1m',1000),candles('5m',240)]);
        // Diagnostics are read-only: no new training samples or weight updates.
        return json({ok:true,observedAt:Date.now(),oneMinuteSource:one.endpoint,fiveMinuteSource:five.endpoint,
          indicators:features(one.filter(x=>x.closed),five.filter(x=>x.closed),one.at(-1).c)?.indicators,
          trainedModel:FIXED_MODEL,featureSet:FEATURE_SET,trainingEnabled:false,
          weightsFrozen:true,training:s.training,seedSamples:s.seed.length});
      }catch(e){return json({ok:false,error:safelySerializable(e)},502);}
    }
    if(path==='/health')return json({ok:true,name:NAME,version:VERSION,featureSet:FEATURE_SET,activated:true,orders:false,
      trainedModel:FIXED_MODEL,trainingEnabled:false,weightsFrozen:true,
      retrainCompleted:s.trainAttempted===true,trainedWeightsActive:Array.isArray(s.weights),
      lastTickAt:s.lastTickAt,error:s.lastFailure});
    if(path==='/latest')return json({name:NAME,latest:s.rows.at(-1)||null});
    return json({name:NAME,version:VERSION,featureSet:FEATURE_SET,readOnly:true,orders:false,
      productionIntegration:false,officialSettlement:false,
      resolution:'BTCUSDT_SPOT_5MIN_CLOSE_VS_OPEN_PROXY',
      timed:{targetLockMs:LOCK_OFFSET,deadlineMs:DEADLINE,firstRound:s.firstRound,
        lastTickAt:s.lastTickAt,lastGoodDataAt:s.lastGoodDataAt,nextAlarm:await this.ctx.storage.getAlarm()},
      training:{historicalApproxSamples:s.seed.length,trainedModel:FIXED_MODEL,
        trainingEnabled:false,weightsFrozen:true,policy:TRAINING_POLICY,featureSet:FEATURE_SET,
        trainingSource:'HISTORICAL_SPOT_OPEN_CLOSE_PROXY_NOT_OFFICIAL',
        completed:s.trainAttempted===true,weightsActive:Array.isArray(s.weights),
        effectiveFromRound:s.effectiveFromRound,latestTraining:s.training},
      results:prospectiveStats(s.rows.filter(r=>r.featureSet===FEATURE_SET)),
      lastFailure:s.lastFailure,latest:s.rows.at(-1)||null,
      recent:s.rows.slice(-12).map(({t,direction,actual,status,lockedAt,reason})=>({t,direction,actual,status,lockedAt,reason}))});
  }
  async alarm(){
    // Schedule next alarm before I/O; a thrown network error never stops future sampling.
    if((await this.state()).retired)return;
    const scheduledAt=Date.now();
    await this.ctx.storage.setAlarm(fixedNextAlarm(scheduledAt));
    const t=nowRound(scheduledAt),elapsed=scheduledAt-t;
    const s=await this.state();
    s.lastTickAt=scheduledAt;
    if(s.firstRound===null)s.firstRound=t;
    try{
      const [one,five]=await Promise.all([candles('1m',1000),candles('5m',240)]);
      settleExistingRows(s.rows,five,Date.now());
      if(!s.rows.some(r=>r.t===t)){
        const current1=one.find(k=>k.t===t),current5=five.find(k=>k.t===t);
        const receivedAt=Date.now();
        const price=one.marketEventMs>=t && one.marketEventMs<=receivedAt ? one.spotPrice : null;
        // Strict causal validation: no bar at or after t is used as a completed feature.
        const a=one.filter(x=>x.closed&&x.end<t),b=five.filter(x=>x.closed&&x.end<t);
        const sufficient=current1&&current5&&Number.isFinite(price)&&
          receivedAt-t<DEADLINE&&elapsed<DEADLINE;
        const f=sufficient?features(a,b,price):null;
        // Retrained BASELINE coefficients activate no earlier than the next round.
        const trained=Array.isArray(s.weights)&&s.weights.length===5&&
          Number.isFinite(s.effectiveFromRound)&&t>=s.effectiveFromRound;
        const p=f?(trained?probability(s.weights,f.vector):baseline(f.vector)):null;
        const direction=Number.isFinite(p)?p>=.5?'UP':'DOWN':null;
        s.rows.push({t,status:direction?'LOCKED':'DATA_GAP',direction,
          pUp:p,lockedAt:receivedAt,delayMs:receivedAt-t,
          vector:f?.vector??null,indicators:f?.indicators??null,actual:null,
          source:'RAILWAY_BINANCE_SPOT_READONLY_RELAY',model:FIXED_MODEL,featureSet:FEATURE_SET,
          coefficientSource:trained?'CHRONOLOGICAL_RETRAINED':'FIXED_FOUR_FACTOR_BASELINE',
          reason:direction?null:receivedAt-t>=DEADLINE?'LOCKED_LATE_OR_FETCH_SLOW':'MARKET_DATA_UNAVAILABLE'});
      }
      // Automatic and manual retraining are disabled. Historical training
      // coefficients remain persisted and continue to drive inference after
      // effectiveFromRound; no new weights or model versions are created.
      s.lastGoodDataAt=Date.now();s.lastFailure=null;
    }catch(err){
      s.lastFailure=safelySerializable(err);
      if(!s.rows.some(r=>r.t===t))s.rows.push({t,status:'DATA_GAP',direction:null,actual:null,
        lockedAt:Date.now(),reason:s.lastFailure,featureSet:FEATURE_SET,
        source:'RAILWAY_BINANCE_SPOT_READONLY_RELAY'});
    }
    s.rows=s.rows.slice(-1300);
    await this.ctx.storage.put('state',s);
  }
}

export default {
  async fetch(request,env){
    // Stable one-instance experiment; public read-only endpoints only.
    const path=new URL(request.url).pathname;
    if(!['/status','/latest','/health','/market-check','/model-history'].includes(path))return new Response('Not Found',{status:404});
    const old=env.BREAKOUT20.idFromName('breakout20-single-shadow');
    await env.BREAKOUT20.get(old).retire();
    const id=env.BREAKOUT20.idFromName('breakout20-apac-shadow');
    return env.BREAKOUT20.get(id,{locationHint:'apac'}).fetch(request);
  }
};

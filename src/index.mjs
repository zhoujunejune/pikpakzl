// "突破20%即可" — independent, read-only, BTC 5-minute shadow on Cloudflare Free.
// Does not import, call or affect any Binance order API or production model.
import { DurableObject } from 'cloudflare:workers';
import { NAME, VERSION, parseKline, features, baseline, probability, train, prospectiveStats } from './model.mjs';

const PERIOD=300000, LOCK_OFFSET=6250, DEADLINE=8000;
const MARKETS=['https://data-api.binance.vision/api/v3/klines','https://api.binance.com/api/v3/klines','https://api1.binance.com/api/v3/klines'];
const nowRound=t=>Math.floor(t/PERIOD)*PERIOD;
const fixedNextAlarm=now=>{
  const thisSlot=nowRound(now)+LOCK_OFFSET;
  return thisSlot>now?thisSlot:thisSlot+PERIOD;
};
const blank=()=>({version:VERSION,startedAt:Date.now(),seed:[],rows:[],weights:null,
  model:'BASELINE_UNTRAINED',training:null,settlementsSinceTrain:0,
  lastFailure:null,lastTickAt:null,lastGoodDataAt:null,firstRound:null});
const safelySerializable=e=>String(e?.message||e||'UnknownError').slice(0,500);
const json=(v,status=200)=>Response.json(v,{status,headers:{'cache-control':'no-store'}});

async function candles(period, limit){
  return Promise.any(MARKETS.map(async endpoint=>{
    const url=`${endpoint}?symbol=BTCUSDT&interval=${period}&limit=${limit}`;
    const result=await fetch(url,{signal:AbortSignal.timeout(1800),headers:{'accept':'application/json'}});
    if(!result.ok)throw Error(`MARKET_HTTP_${result.status}_${period}_${new URL(endpoint).host}`);
    const body=await result.json();
    if(!Array.isArray(body))throw Error(`INVALID_KLINE_RESPONSE_${period}`);
    const bars=body.map(parseKline).filter(Boolean);
    if(!bars.length)throw Error(`EMPTY_KLINES_${period}`);
    bars.endpoint=endpoint;return bars;
  })).catch(e=>{throw Error((e.errors||[e]).map(safelySerializable).join(';'));});
}

function seeds(one, five){
  const result=[];
  // Historical approximation: 5-minute OPEN price; NOT exact T+6.25s state.
  for(const target of five.filter(k=>k.closed)){
    const a=one.filter(x=>x.closed&&x.end<target.t);
    const b=five.filter(x=>x.closed&&x.end<target.t);
    if(target.c===target.o)continue;
    const f=features(a,b,target.o);
    if(f)result.push({t:target.t,x:f.vector,y:Number(target.c>target.o),source:'HISTORICAL_OPEN_APPROXIMATION'});
  }
  return result;
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
  async state(){return await this.ctx.storage.get('state')||blank();}
  async fetch(req){
    const path=new URL(req.url).pathname;
    if(path!=='/status'&&path!=='/latest'&&path!=='/health'&&path!=='/market-check')return new Response('Not Found',{status:404});
    const s=await this.state();
    if(await this.ctx.storage.getAlarm()===null){
      const alarm=fixedNextAlarm(Date.now());
      await this.ctx.storage.setAlarm(alarm);
      if(s.firstRound===null){s.firstRound=nowRound(alarm);await this.ctx.storage.put('state',s);}
    }
    if(path==='/market-check'){
      try{
        const [one,five]=await Promise.all([candles('1m',1000),candles('5m',240)]);
        s.seed=seeds(one,five);
        const out=train(s.seed,{minimum:100});
        if(out.ok){s.weights=out.weights;s.model=out.adopted?'LOGISTIC_L2_V1':'BASELINE';}
        s.training={at:Date.now(),...out};
        await this.ctx.storage.put('state',s);
        return json({ok:true,observedAt:Date.now(),oneMinuteSource:one.endpoint,fiveMinuteSource:five.endpoint,
          indicators:features(one.filter(x=>x.closed),five.filter(x=>x.closed),one.at(-1).c)?.indicators,
          training:s.training,seedSamples:s.seed.length});
      }catch(e){return json({ok:false,error:safelySerializable(e)},502);}
    }
    if(path==='/health')return json({ok:true,name:NAME,version:VERSION,activated:true,orders:false,
      lastTickAt:s.lastTickAt,error:s.lastFailure});
    if(path==='/latest')return json({name:NAME,latest:s.rows.at(-1)||null});
    return json({name:NAME,version:VERSION,readOnly:true,orders:false,
      productionIntegration:false,officialSettlement:false,
      resolution:'BTCUSDT_SPOT_5MIN_CLOSE_VS_OPEN_PROXY',
      timed:{targetLockMs:LOCK_OFFSET,deadlineMs:DEADLINE,firstRound:s.firstRound,
        lastTickAt:s.lastTickAt,lastGoodDataAt:s.lastGoodDataAt,nextAlarm:await this.ctx.storage.getAlarm()},
      training:{historicalApproxSamples:s.seed.length,trainedModel:s.model,
        latestTraining:s.training},results:prospectiveStats(s.rows),
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
      const settled=settleExistingRows(s.rows,five,Date.now());
      s.settlementsSinceTrain+=settled;
      if(!s.rows.some(r=>r.t===t)){
        const current1=one.find(k=>k.t===t),current5=five.find(k=>k.t===t);
        const receivedAt=Date.now();
        const price=current1?.c;
        // Strict causal validation: no bar at or after t is used as a completed feature.
        const a=one.filter(x=>x.closed&&x.end<t),b=five.filter(x=>x.closed&&x.end<t);
        const sufficient=current1&&current5&&receivedAt-t<DEADLINE&&elapsed<DEADLINE;
        const f=sufficient?features(a,b,price):null;
        const p=f?(s.weights?probability(s.weights,f.vector):baseline(f.vector)):null;
        const direction=Number.isFinite(p)?p>=.5?'UP':'DOWN':null;
        s.rows.push({t,status:direction?'LOCKED':'DATA_GAP',direction,
          pUp:p,lockedAt:receivedAt,delayMs:receivedAt-t,
          vector:f?.vector??null,indicators:f?.indicators??null,actual:null,
          source:'BINANCE_PUBLIC_MARKET_REST',model:s.model,
          reason:direction?null:receivedAt-t>=DEADLINE?'LOCKED_LATE_OR_FETCH_SLOW':'MARKET_DATA_UNAVAILABLE'});
      }
      if(s.seed.length===0)s.seed=seeds(one,five);
      if(s.training===null||s.settlementsSinceTrain>=20){
        const live=s.rows.filter(r=>r.vector&&['UP','DOWN'].includes(r.actual))
          .map(r=>({t:r.t,x:r.vector,y:Number(r.actual==='UP'),source:'LIVE_8S_FROZEN'}));
        const out=train([...s.seed,...live],{minimum:100});
        if(out.ok){s.weights=out.weights;s.model=out.adopted?'LOGISTIC_L2_V1':'BASELINE';}
        s.training={at:Date.now(),...out};s.settlementsSinceTrain=0;
      }
      s.lastGoodDataAt=Date.now();s.lastFailure=null;
    }catch(err){
      s.lastFailure=safelySerializable(err);
      if(!s.rows.some(r=>r.t===t))s.rows.push({t,status:'DATA_GAP',direction:null,actual:null,
        lockedAt:Date.now(),reason:s.lastFailure,source:'BINANCE_PUBLIC_MARKET_REST'});
    }
    s.rows=s.rows.slice(-1300);
    await this.ctx.storage.put('state',s);
  }
}

export default {
  async fetch(request,env){
    // Stable one-instance experiment; public read-only endpoints only.
    const path=new URL(request.url).pathname;
    if(!['/status','/latest','/health','/market-check'].includes(path))return new Response('Not Found',{status:404});
    const old=env.BREAKOUT20.idFromName('breakout20-single-shadow');
    await env.BREAKOUT20.get(old).retire();
    const id=env.BREAKOUT20.idFromName('breakout20-apac-shadow');
    return env.BREAKOUT20.get(id,{locationHint:'apac'}).fetch(request);
  }
};

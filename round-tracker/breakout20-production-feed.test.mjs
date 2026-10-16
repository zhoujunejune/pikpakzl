import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {BREAKOUT20_MODE,BREAKOUT20_MODEL,BREAKOUT20_SOURCE,BREAKOUT20_URL,
  validateBreakout20Lock,createBreakout20ProductionFeed} from './breakout20-production-feed.mjs';

const start=Math.floor(Date.now()/300000)*300000;
const make=({round=start,lockedAt=round+6800,direction='UP',status='LOCKED',
  lastGoodDataAt=lockedAt,version=BREAKOUT20_MODEL}={})=>({
  name:'突破20%即可',version,readOnly:true,orders:false,productionIntegration:false,
  latest:{t:round,direction,status,lockedAt},
  timed:{lastGoodDataAt},results:{overall:{samples:3,hits:1,accuracy:1/3}}
});

test('accepts only current-round Cloudflare direction before T+8 seconds',()=>{
  const valid=validateBreakout20Lock(make(),{now:start+7200,round:start});
  assert.equal(valid.ok,true);assert.equal(valid.direction,'UP');
  assert.equal(valid.delayMs,6800);assert.equal(valid.source,BREAKOUT20_SOURCE);
  assert.equal(BREAKOUT20_MODE,'BREAKOUT20_FAST8');
  assert.equal(BREAKOUT20_URL,'https://breakout20-shadow.zl528094-3ba.workers.dev/status');
});

test('reject stale, cross-round, forged, late or incomplete production signals',()=>{
 const cases=[
  [make({round:start-300000}),start+7200,'CURRENT_ROUND_NOT_LOCKED'],
  [make({lockedAt:start+8000}),start+8100,'SHADOW_LOCK_TIME_INVALID'],
  [make(),start+8000,'PRODUCTION_EIGHT_SECOND_DEADLINE_EXPIRED'],
  [make({direction:'WAIT'}),start+7200,'SHADOW_NOT_LOCKED'],
  [make({status:'DATA_GAP'}),start+7200,'SHADOW_NOT_LOCKED'],
  [make({lastGoodDataAt:start-1}),start+7200,'SHADOW_MARKET_NOT_FRESH'],
  [make({version:'ANOTHER_MODEL'}),start+7200,'UNTRUSTED_SHADOW_PAYLOAD'],
  [{...make(),orders:true},start+7200,'UNTRUSTED_SHADOW_PAYLOAD'],
  [{...make(),productionIntegration:true},start+7200,'UNTRUSTED_SHADOW_PAYLOAD'],
 ];
 for(const [payload,at,reason] of cases) {
   const result=validateBreakout20Lock(payload,{now:at,round:start});
   assert.equal(result.ok,false,reason);
   assert.equal(result.reason,reason);
 }
});

test('read-only polling is bounded, single-round, no order API and does not fill missing rounds',async()=>{
  let now=start+5600,calls=[],events=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    if(now<start+6800)return {ok:true,json:async()=>make({round:start-300000})};
    return {ok:true,json:async()=>make()};
  };
  const feed=createBreakout20ProductionFeed({clock:()=>now,fetcher,onDecision:d=>events.push(d)});
  assert.equal(await feed.checkOnce(),null);
  assert.equal(calls.length,0);
  now=start+6200;
  assert.equal(await feed.checkOnce(),null);
  assert.equal(events.length,0);
  now=start+7100;
  assert.equal((await feed.checkOnce()).direction,'UP');
  assert.equal(events.length,1);
  assert.equal(await feed.checkOnce(),null);
  assert.equal(calls.length,2);
  assert.ok(calls.every(c=>c.url===BREAKOUT20_URL&&c.options.method==='GET'));
  assert.equal(feed.latestFor(start,now).direction,'UP');
  now=start+300000+7200;
  assert.equal(feed.latestFor(start+300000,now),null);
  assert.equal(await feed.checkOnce(),null);
  assert.equal(events.length,1);
  feed.stop();
});

test('full production integration remains feature-flagged; no edits to order execution',()=>{
 const source=fs.readFileSync(new URL('./index-rest.mjs',import.meta.url),'utf8');
 assert.match(source,/createBreakout20ProductionFeed/);
 assert.match(source,/PRODUCTION_SIGNAL_SOURCE_MODE === BREAKOUT20_MODE/);
 assert.match(source,/return breakout20ProductionSignalPayload/);
 assert.match(source,/source:BREAKOUT20_SOURCE,model:BREAKOUT20_MODEL/);
 assert.match(source,/onlyOneActive:true,deadlineMs:BREAKOUT20_DEADLINE_MS/);
 assert.match(source,/model: SIGNAL_MODEL_NAME/);
 assert.doesNotMatch(source,/BREAKOUT20_MODE.*POST \/api\/confirm/);
});

test('staggered read-only requests accept the first valid lock, without duplicate decisions',async()=>{
  let now=start+6000,responders=[],requests=[],decisions=[];
  const fetcher=(url,opts)=>{requests.push({url,opts});return new Promise(resolve=>responders.push(resolve));};
  const feed=createBreakout20ProductionFeed({fetcher,clock:()=>now,onDecision:d=>decisions.push(d)});
  const slow=feed.checkOnce();
  now=start+6310;
  const fast=feed.checkOnce();
  assert.equal(requests.length,2);
  assert.ok(requests.every(x=>x.opts.method==='GET'));
  now=start+7200;
  responders[1]({ok:true,json:async()=>make({lockedAt:start+6800})});
  assert.equal((await fast).direction,'UP');
  now=start+7300;
  responders[0]({ok:true,json:async()=>make({lockedAt:start+6800})});
  assert.equal(await slow,null);
  assert.equal(decisions.length,1);
  assert.equal(feed.report().pendingRequests,0);
  assert.equal(feed.report().lastError,null);
  feed.stop();
});

test('even a valid delayed response never publishes after the immutable eight-second deadline',async()=>{
  let now=start+7600,respond,decisions=[];
  const feed=createBreakout20ProductionFeed({
    clock:()=>now,fetcher:()=>new Promise(resolve=>{respond=resolve}),
    onDecision:d=>decisions.push(d),
  });
  const task=feed.checkOnce();
  now=start+8100;
  respond({ok:true,json:async()=>make({lockedAt:start+6800})});
  assert.equal(await task,null);
  assert.equal(feed.report().acceptedRound,null);
  assert.equal(decisions.length,0);
  feed.stop();
});

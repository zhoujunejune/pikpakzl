import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewVip75Signal} from './vip75-trust-review.mjs';
const start=1791600000000;
function sample(){
  return {row:{roundStartMs:start,shadowObservedAt:start+15000,
    shadowFacts:{dataFresh:true,absorptionRisk:false,predictionMarketUpMid:0.57,
      currentScore:0.8,gateFailures:[]}},
    vip:{ready:true,direction:'UP',generatedAt:start+15000},
    v2Review:{pass:true,decision:'UP',reasons:[],predictionSupport:0.07},
    forwardStats:{recent40:{samples:40,accuracy:0.75},
      up:{samples:50,accuracy:0.72},down:{samples:30,accuracy:0.67}},
    now:start+16000};
}
test('valid frozen VIP direction requires independent V2 and forward quality',()=>{
  assert.equal(reviewVip75Signal(sample()).pass,true);
});
test('V2 rejection blocks VIP75 and records reason',()=>{
  const q=sample();q.v2Review.pass=false;q.v2Review.decision='WAIT';
  assert(reviewVip75Signal(q).reasons.includes('VIP75_V2_MARKET_REVIEW_REJECTED'));
});
test('recent 47.5% strict-forward cannot pass a strong V2 quality signal',()=>{
  const q=sample();q.forwardStats.recent40.accuracy=0.475;
  assert(reviewVip75Signal(q).reasons.includes('VIP75_RECENT_FORWARD_ACCURACY_BELOW_60'));
});
test('weak UP does not borrow DOWN accuracy',()=>{
  const q=sample();q.forwardStats.up.accuracy=0.5;
  assert(reviewVip75Signal(q).reasons.includes('VIP75_DIRECTION_FORWARD_ACCURACY_BELOW_60'));
});
test('missing settlement data, absorbed/stale and changed snapshots fail closed',()=>{
  const variants=[
    q=>{q.forwardStats={};},
    q=>{q.row.shadowFacts.absorptionRisk=true;},
    q=>{q.row.shadowFacts.dataFresh=false;},
    q=>{q.row.shadowFacts.predictionMarketUpMid=null;},
    q=>{q.row.shadowFacts.currentScore=null;},
    q=>{q.row.shadowFacts.gateFailures=['STALE_BOOK'];},
    q=>{q.row.shadowObservedAt+=1000;},
    q=>{q.now=start+14000;},
    q=>{q.row.settledAt=start+300000;},
  ];
  for(const modify of variants){const q=sample();modify(q);
    assert.equal(reviewVip75Signal(q).pass,false);}
});
test('DOWN accuracy judged independently',()=>{
  const q=sample();q.vip.direction='DOWN';q.v2Review.decision='DOWN';
  q.row.shadowFacts.predictionMarketUpMid=0.43;
  assert.equal(reviewVip75Signal(q).pass,true);
  q.forwardStats.down.accuracy=0.5;
  assert.equal(reviewVip75Signal(q).pass,false);
});

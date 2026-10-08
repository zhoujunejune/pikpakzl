import test from 'node:test';
import assert from 'node:assert/strict';
import {createEdgeRescueExpansion} from './edge-rescue-expansion.mjs';
import {isFrozenFinalBaselineWait} from './edge-rescue-expansion-proof.mjs';

const V='SELECTIVE_V2_EDGE_EXPANSION_SHADOW_V1',MS=1800000000000;
const cfg={id:'test',relaxationRank:1,supportMin:0.1,currentMin:0.1,scoreMin:0.1,maxDelayMs:30000};
const gate=()=>createEdgeRescueExpansion({version:V,startMs:MS,configs:[cfg],lockPredictionSupport:()=>0.8,minSamples:60,targetSamples:60,targetAccuracy:0.75,recentWindow:20,recentAccuracy:0.75,directionMinSamples:10,directionRecentWindow:6,directionAccuracy:0.70,maxMissStreak:2,minIncrementalCoverage:0.02});
function row(i,dir,{baseline=false,hit=true,evidence=true,frozen=true,certifiedWait=true}={}){
 const start=MS+i*300000,actual=hit?dir:(dir==='UP'?'DOWN':'UP');
 return {
   roundStartMs:start,roundEndMs:start+299999,predictedAt:start+10000,settledAt:start+350000,
   prediction:dir,predictionDelayMs:10000,predictionScore:1,predictionFacts:{currentScore:1},
   actual,officialDirection:actual,actualSource:'BINANCE_PREDICTION_OFFICIAL_RESOLUTION',
   resolutionEvidence:evidence?`OFFICIAL_${actual}:RESOLVED:STRICT_ROUND_ALIGNED_TOPIC`:`OFFICIAL_${actual}:PERSISTED_EVIDENCE`,
   predictionMarketTopicId:600000+i,result:hit?'HIT':'MISS',
   lockQualitySelectiveV2:{pass:false},
   selectiveV2EdgeExpansionShadow:{version:V,evaluatedAt:frozen?start+20000:start+400000,baseDirection:dir,candidates:{test:{decision:dir}}},
   expansionBaselineWaitAt:certifiedWait?start+30000:null,
   productionPrediction:baseline?dir:null,
   productionSource:baseline?'SELECTIVE_V2_EDGE_RESCUE_PRIMARY':null,
   productionGeneratedAt:baseline?start+15000:null,
   productionLockedAt:baseline?start+20000:null,
   productionResult:baseline?(hit?'HIT':'MISS'):'NO_DECISION'
 };
}
const cohort=(n=60)=>[...Array.from({length:20},(_,i)=>row(i,'UP',{baseline:true})),...Array.from({length:n},(_,i)=>row(i+20,i%2?'UP':'DOWN'))];
test('20 initial screen and 30-59 shadow cannot auto qualify',()=>{
 for(const n of [20,30,59]){const s=gate().summary(cohort(n));assert.equal(s.candidates[0].strictForwardSamples,n);assert.notEqual(s.candidates[0].status,'AUTO_QUALIFIED');}
});
test('60 certified independent decisions can qualify',()=>{
 const s=gate().summary(cohort());
 assert.equal(s.candidates[0].strictForwardSamples,60);
 assert.equal(s.candidates[0].up.samples,30);
 assert.equal(s.candidates[0].down.samples,30);
 assert.equal(s.candidates[0].prospectiveCombined.accuracy,1);
 assert.equal(s.candidates[0].status,'AUTO_QUALIFIED');
});
test('rescue that degrades perfect baseline fails gate',()=>{
 const a=cohort();const x=a[20];x.actual='UP';x.officialDirection='UP';x.result='MISS';x.resolutionEvidence='OFFICIAL_UP:RESOLVED:STRICT_ROUND_ALIGNED_TOPIC';
 const s=gate().summary(a);assert.notEqual(s.candidates[0].status,'AUTO_QUALIFIED');assert.equal(s.candidates[0].prospectiveCombined.notWorseThanBaseline,false);
});
test('missing official evidence or frozen WAIT reduces samples',()=>{
 const a=cohort();a[20].resolutionEvidence='OFFICIAL_DOWN:PERSISTED_EVIDENCE';a[21].expansionBaselineWaitAt=null;
 const s=gate().summary(a);assert.equal(s.candidates[0].strictForwardSamples,58);assert.notEqual(s.candidates[0].status,'AUTO_QUALIFIED');
});
test('evaluation recorded after settlement is never strict-forward',()=>{
 const a=cohort();a[20].selectiveV2EdgeExpansionShadow.evaluatedAt=a[20].settledAt+1;
 assert.equal(isFrozenFinalBaselineWait(a[20],V),false);
 assert.equal(gate().summary(a).candidates[0].strictForwardSamples,59);
});
test('missing prediction support cannot coerce null to valid zero',()=>{
 const g=createEdgeRescueExpansion({version:V,startMs:MS,configs:[cfg],lockPredictionSupport:()=>null});
 const r=row(10,'UP');delete r.selectiveV2EdgeExpansionShadow;
 const output=g.evaluate(r,{pass:false,reasons:['WAIT']},null);
 assert.equal(output.candidates.test.pass,false);
 assert.ok(output.candidates.test.reasons.includes('MISSING_PREDICTION_SUPPORT'));
});
test('missing score and delay are rejected',()=>{
 const g=createEdgeRescueExpansion({version:V,startMs:MS,configs:[cfg],lockPredictionSupport:()=>0.9});
 for(const key of ['currentScore','predictionScore','predictionDelayMs']){
   const r=row(11,'UP');delete r.selectiveV2EdgeExpansionShadow;
   if(key==='currentScore')r.predictionFacts.currentScore=null;else r[key]=null;
   assert.equal(g.evaluate(r,{pass:false,reasons:['WAIT']},null).candidates.test.pass,false,key);
 }
});
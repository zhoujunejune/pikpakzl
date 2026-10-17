import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
 MODEL,ROUND_MS,roundStart,extractFeatures,decide,
 aggregate,fitOnOfficialProbes,wilsonLower,RETRAIN_EVERY_SETTLED
} from './dynamic-entry-shadow-core.mjs';
const ROUND=roundStart(1792248600000);
function market(at=ROUND+1000){
 const first=Math.floor(at/60000)*60000-35*60000;
 const rows=Array.from({length:35},(_,i)=>({
  startMs:first+i*60000,open:59980+i*4,close:59984+i*4,
  high:60000+i*4,low:59960+i*4,closed:true
 }));
 return {readOnly:true,generatedAtMs:at-100,
  latest:{eventMs:at-100,lastPrice:60125,roundStartMs:ROUND,
   roundOpenPrice:60098},
  candles:{'1m':{rows},'5m':null}};
}
test('any in-round second including T+1 is eligible for evaluating fresh prices',()=>{
 const early=ROUND+1000,late=ROUND+289000;
 for(const at of [early,ROUND+53000,ROUND+145000,late]){
  const payload=market(at);
  const f=extractFeatures(payload,at);
  assert.ok(f,'fresh features exist at '+at);
  assert.equal(f.round,ROUND);
  assert.equal(f.elapsedMs,at-ROUND);
  const d=decide(f);
  assert.ok(['UP','DOWN'].includes(d.direction));
  assert.notEqual(d.direction,'WAIT');
  assert.equal(typeof d.eligible,'boolean');
 }
});
test('moderate aligned shadow direction enters while genuinely weak evidence stays unentered',()=>{
 const aligned={values:[0.10,0.13,0.15,0.17,0],elapsedMs:62000};
 const ready=decide(aligned);
 assert.equal(ready.direction,'UP');
 assert.equal(ready.eligible,true);
 assert.equal(ready.entryReason,'SIGNAL_READY');
 assert.equal(ready.modelVersion,'HEURISTIC_V2_ADAPTIVE_GATE');
 const weak=decide({values:[0.005,0.005,0.005,0.005,0],elapsedMs:85000});
 assert.equal(weak.eligible,false);
 assert.equal(weak.entryReason,'LOW_SIGNAL_STRENGTH');
});

test('does not invent trade entries from stale or unauthenticated market data',()=>{
 const at=ROUND+11000;
 assert.equal(extractFeatures({...market(at),readOnly:false},at),null);
 assert.equal(extractFeatures({...market(at),generatedAtMs:at-12000},at),null);
 assert.equal(extractFeatures({...market(at),latest:null},at),null);
 assert.equal(decide(null),null);
});
test('official hit rate is based only on virtual entries, never nonentry direction estimates',()=>{
 const rows=[
  {round:ROUND,probe:{values:[0,1,0,0,0]},entry:{direction:'UP'},actual:'DOWN'},
  {round:ROUND+ROUND_MS,probe:{values:[0,1,0,0,0]},entry:null,actual:'UP'},
  {round:ROUND+ROUND_MS*2,probe:{values:[0,1,0,0,0]},entry:{direction:'DOWN'},actual:'DOWN'},
  {round:ROUND+ROUND_MS*3,probe:{values:[0,1,0,0,0]},entry:{direction:'UP'},actual:null},
 ];
 const stats=aggregate(rows);
 assert.equal(stats.overall.samples,2);
 assert.equal(stats.overall.hits,1);
 assert.equal(stats.pending,1);
 assert.equal(stats.officialLabeledProbes,3);
 assert.equal(stats.qualified,false);
 assert.equal(wilsonLower(0,0),null);
});
test('training uses strictly before-settlement vectors and time-ordered holdout',()=>{
 const rows=Array.from({length:90},(_,i)=>{
  const round=ROUND+i*ROUND_MS;
  const signal=i%4<2?1:-1;
  return {round,probe:{at:round+1000,values:[signal,signal,signal,signal,0.2]},
    entry:null,actual:signal>0?'UP':'DOWN',settledAt:round+ROUND_MS+5000};
 });
 const fit=fitOnOfficialProbes(rows);
 assert.ok(['VALIDATED_CANDIDATE','BELOW_TARGET'].includes(fit.status));
 assert.equal(fit.samples,90);
 assert.ok(fit.holdout.samples>=20);
 assert.equal(fit.model.weights.length,6);
 assert.ok(fit.model.weights.every(Number.isFinite));
 assert.ok(fit.model.trainingEndRound<rows.at(-20).round);
 assert.equal(RETRAIN_EVERY_SETTLED,5);
 const before=fitOnOfficialProbes(rows.slice(0,59));
 assert.equal(before.status,'COLLECTING');
 assert.equal(before.model,null);
});
test('read-only UI route does not alter order execution paths',()=>{
 const shell=fs.readFileSync(new URL('./panel-stats-shell.mjs',import.meta.url),'utf8');
 const service=fs.readFileSync(new URL('./dynamic-entry-shadow.mjs',import.meta.url),'utf8');
 const ui=fs.readFileSync(new URL('./shadow-breakout20-dashboard.mjs',import.meta.url),'utf8');
 assert.match(shell,/dynamicEntryShadow\.handler\(res\)/);
 assert.match(shell,/dynamicEntryShadow\.start\(\)/);
 assert.match(ui,/DYNAMIC_ENTRY_5M_SHADOW_V1/);
 assert.doesNotMatch(service,/fetcher\([^)]*method:\s*['"]POST/);
 assert.doesNotMatch(service,/\/api\/confirm|\/api\/order\/submit/);
 assert.ok(service.includes('productionIntegration:false'));
});

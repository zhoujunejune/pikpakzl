import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selectiveV2HardFuseSummary } from '../selective-v2-hard-fuse.mjs';
const START = Date.parse('2026-10-11T13:00:00Z');
const ACTIVATION = START + 20*300000;
function settled(i, dir, hit, live=true, shadow=false) {
  const roundStartMs=START+i*300000;
  const actual=hit?dir:(dir==='UP'?'DOWN':'UP');
  const row={
    roundStartMs,actual,officialDirection:actual,
    resolutionEvidence:'OFFICIAL_'+actual+':variantData.startPrice_endPrice:STRICT_ROUND_ALIGNED_TOPIC',
    officialSettlementAudit:{
      sourceEndpoint:'/sapi/v1/w3w/wallet/prediction/market/detail',
      observedAt:new Date(roundStartMs+301000).toISOString(),
    },
    productionSource:live?'LOCK_QUALITY_SELECTIVE_V2_PRIMARY':null,
    productionPrediction:live?dir:null,
    productionResult:live?(hit?'HIT':'MISS'):'NO_DECISION',
    productionLockedAt:live?roundStartMs+20000:null,
  };
  if(shadow)row.selectiveV2HardFuseShadow={direction:dir,frozenAt:roundStartMs+22000};
  return row;
}
const status=(rows,dir)=>selectiveV2HardFuseSummary(rows,dir,{
  activationMs:ACTIVATION,shadowStartMs:ACTIVATION,
});
test('no manual pause: healthy direction passes immediately, weak direction fuses',()=>{
  const up=Array.from({length:10},(_,i)=>settled(i,'UP',i!==3&&i!==7));
  const down=Array.from({length:10},(_,i)=>settled(i+10,'DOWN',i===1||i===4||i===6));
  const rows=[...up,...down];
  const u=status(rows,'UP'),d=status(rows,'DOWN');
  assert.equal(u.blocked,false);
  assert.equal(u.requiresManualApproval,false);
  assert.equal(d.blocked,true);
  assert.equal(d.shadow.remainingTo20,20);
});
test('DOWN automatically returns after 20 NEW official frozen paper results',()=>{
  const hist=Array.from({length:10},(_,i)=>settled(i,'DOWN',i===1||i===4||i===6));
  const paper=Array.from({length:20},(_,i)=>settled(i+20,'DOWN',i%5!==3,false,true));
  assert.equal(status([...hist,...paper.slice(0,19)],'DOWN').blocked,true);
  const r=status([...hist,...paper],'DOWN');
  assert.equal(r.blocked,false);
  assert.equal(r.autoReleases,1);
  assert.equal(r.shadow.recovery20.samples,20);
  assert.equal(r.shadow.recovery20.accuracy,0.8);
  assert.equal(r.requiresManualApproval,false);
});
test('frozen record after official settlement never counts toward recovery',()=>{
  const hist=Array.from({length:10},(_,i)=>settled(i,'DOWN',i===1||i===4||i===6));
  const paper=Array.from({length:20},(_,i)=>settled(i+20,'DOWN',true,false,true));
  paper[4].selectiveV2HardFuseShadow.frozenAt=paper[4].roundStartMs+302000;
  const r=status([...hist,...paper],'DOWN');
  assert.equal(r.blocked,true);
  assert.equal(r.shadow.samples,19);
  assert.equal(r.shadow.remainingTo20,1);
});
test('a new 3-miss streak after automatic release fuses again and needs fresh recovery',()=>{
  const hist=Array.from({length:10},(_,i)=>settled(i,'DOWN',i===1||i===4||i===6));
  const paper=Array.from({length:20},(_,i)=>settled(i+20,'DOWN',true,false,true));
  const losses=Array.from({length:3},(_,i)=>settled(40+i,'DOWN',false,true,true));
  let r=status([...hist,...paper,...losses],'DOWN');
  assert.equal(r.blocked,true);
  assert.equal(r.tripCount,2);
  assert.equal(r.autoReleases,1);
  assert.equal(r.shadow.samples,0); // cannot recycle earlier proof
  const newPaper=Array.from({length:20},(_,i)=>settled(i+44,'DOWN',true,false,true));
  r=status([...hist,...paper,...losses,...newPaper],'DOWN');
  assert.equal(r.blocked,false);
  assert.equal(r.autoReleases,2);
});
test('global deterioration does not stop a healthy opposite side',()=>{
  const up=Array.from({length:10},(_,i)=>settled(i,'UP',true));
  const down=Array.from({length:10},(_,i)=>settled(i+10,'DOWN',false));
  const r=status([...up,...down],'UP');
  assert.equal(r.production.global10.accuracy,0);
  assert.equal(r.blocked,false);
});
test('sub-70% Edge Rescue is permanently disabled while Selective V2 fuse and independent recovery remain intact',()=>{
  const code=fs.readFileSync(new URL('../index-rest.mjs',import.meta.url),'utf8');
  assert.match(code,/'SELECTIVE_V2_EDGE_RESCUE_PRIMARY', 'SELECTIVE_V2_EDGE_RESCUE_V1'/);
  assert.match(code,/const edgeRescue = !isPermanentlyRetiredProductionSignal\('SELECTIVE_V2_EDGE_RESCUE_PRIMARY', SELECTIVE_V2_EDGE_RESCUE_VERSION\)/);
  assert.match(code,/const edgeFuse = edgeRescue\?\.decision === baseDirection\s*\? selectiveV2EdgeRescueFuseState\(baseDirection\)/);
  assert.match(code,/if \(\s*row.productionSource === 'LOCK_QUALITY_SELECTIVE_V2_PRIMARY' &&\s*selectiveV2LiveRisk/);
  assert.match(code,/const liveRisk = baseDirection \? selectiveV2LiveRisk\(baseDirection, row.roundStartMs\) : null/);
  assert.match(code,/v2FuseRescue = evaluateV2HardFuseRescue\(row\)/);
});

// Selective V2 only. Edge Rescue and promoted 15s strategies use their own fuses.
export const SELECTIVE_V2_FUSE_VERSION = 'SELECTIVE_V2_AUTO_RECOVERY_V2';
const DEFAULT_ACTIVATION = Date.parse('2026-10-11T13:26:00Z');
const DEFAULT_SHADOW_START = Date.parse('2026-10-11T12:55:00Z');
const directionOk = x => x === 'UP' || x === 'DOWN';
const outcome = d => d === 'HIT' || d === 'MISS';
const strictOfficial = row =>
  directionOk(row?.actual) &&
  row?.officialDirection === row.actual &&
  String(row?.resolutionEvidence || '').includes('STRICT_ROUND_ALIGNED_TOPIC') &&
  row?.officialSettlementAudit?.sourceEndpoint === '/sapi/v1/w3w/wallet/prediction/market/detail';
const stat = rows => {
  const samples = rows.length;
  const hits = rows.filter(x => x.hit).length;
  return {samples,hits,misses:samples-hits,accuracy:samples?Number((hits/samples).toFixed(4)):null};
};
const last = (xs,n) => xs.slice(-n);
const missStreak = xs => {
  let misses=0;
  for(let i=xs.length-1;i>=0 && !xs[i].hit;i--) misses++;
  return misses;
};
const degraded = xs => (xs.length >= 10 && stat(last(xs,10)).accuracy < 0.60) ||
  missStreak(xs) >= 3;
const isLive = row => row?.productionSource === 'LOCK_QUALITY_SELECTIVE_V2_PRIMARY' &&
  directionOk(row.productionPrediction) && outcome(row.productionResult) &&
  strictOfficial(row) &&
  Number.isFinite(Number(row.productionLockedAt || row.productionGeneratedAt)) &&
  Number(row.productionLockedAt || row.productionGeneratedAt) >= Number(row.roundStartMs) &&
  Number(row.productionLockedAt || row.productionGeneratedAt) < Number(row.roundStartMs)+300000;
const isPaper = (row,d,shadowStartMs) => {
  const paper = row?.selectiveV2HardFuseShadow;
  const officialObservedAt = Date.parse(String(row?.officialSettlementAudit?.observedAt || ''));
  const frozenAt = Number(paper?.frozenAt);
  return directionOk(paper?.direction) && paper.direction === d &&
    Number(row.roundStartMs) >= shadowStartMs &&
    Number.isFinite(frozenAt) && frozenAt >= Number(row.roundStartMs) &&
    frozenAt < Number(row.roundStartMs)+300000 &&
    Number.isFinite(officialObservedAt) && frozenAt < officialObservedAt &&
    strictOfficial(row);
};
function verifiedRecovery(xs) {
  const r20=stat(last(xs,20)),r10=stat(last(xs,10));
  return r20.samples===20 && r20.accuracy>=0.75 &&
    r10.accuracy>=0.70 && missStreak(xs)<3;
}

// Evaluate a deterministic round-aligned state machine, not a permanent live
// accuracy check: frozen losing production history must not block recovery forever.
// On each fuse, only fresh pre-settlement paper records AFTER that fuse can rearm.
// No manual unlock, no global cross-direction kill switch.
export function selectiveV2HardFuseSummary(rounds,direction,{
  activationMs=DEFAULT_ACTIVATION,
  shadowStartMs=DEFAULT_SHADOW_START,
  excludeRound=null,
}={}) {
  const rows=Array.from(rounds||[])
    .filter(x => x && Number.isFinite(Number(x.roundStartMs)) &&
      Number(x.roundStartMs)!==Number(excludeRound))
    .sort((a,b)=>Number(a.roundStartMs)-Number(b.roundStartMs));
  const live=rows.filter(isLive).map(x=>({
    direction:x.productionPrediction,hit:x.productionResult==='HIT',round:Number(x.roundStartMs),
  }));
  const global10=stat(last(live,10));
  const ofDirection=live.filter(x=>x.direction===direction);
  const direction10=stat(last(ofDirection,10));
  const consecutiveMisses=missStreak(ofDirection);
  if(!directionOk(direction)) return {
    version:SELECTIVE_V2_FUSE_VERSION,direction,blocked:true,reasons:['INVALID_DIRECTION'],
    production:{global10,direction10,consecutiveMisses},shadow:{recoveryReady:false},
  };

  const liveBefore=ofDirection.filter(x=>x.round<activationMs);
  let window=last(liveBefore,10);
  let blocked=degraded(window);
  let trippedAt=blocked?activationMs-1:null;
  let recoveredAt=null;
  let autoReleases=0,tripCount=blocked?1:0;
  let recoveryProof=[];
  let latestQualifiedProof=[];
  const byRound=new Map(ofDirection.map(x=>[x.round,x]));
  for(const row of rows) {
    const round=Number(row.roundStartMs);
    if(round<activationMs) continue;
    const liveRow=byRound.get(round);
    if(liveRow && !blocked) {
      window.push(liveRow);
      window=last(window,10);
      if(degraded(window)) {
        blocked=true;trippedAt=round;tripCount++;
        recoveryProof=[];
      }
    }
    // Paper and live observations for the same round cannot reverse that round's fuse.
    if(blocked && round>trippedAt && isPaper(row,direction,shadowStartMs)) {
      recoveryProof.push({hit:row.selectiveV2HardFuseShadow.direction===row.actual,round});
      if(verifiedRecovery(recoveryProof)) {
        blocked=false;
        recoveredAt=round;
        autoReleases++;
        latestQualifiedProof=last(recoveryProof,20);
        recoveryProof=[];
        window=[]; // reset stale loss window; new real orders form a fresh rolling window
      }
    }
  }
  const proofWindow=blocked?recoveryProof:latestQualifiedProof;
  const recovery20=stat(last(proofWindow,20));
  const recovery10=stat(last(proofWindow,10));
  const recoveryReady=!blocked || verifiedRecovery(proofWindow);
  const reasons=blocked?['SELECTIVE_V2_DIRECTION_FUSED','WAITING_NEW_OFFICIAL_SHADOW_RECOVERY']:[];
  if(global10.samples===10 && global10.accuracy<0.60) reasons.push('GLOBAL_DRIFT_WARNING_ONLY');
  return {
    version:SELECTIVE_V2_FUSE_VERSION,direction,blocked,reasons,
    production:{global10,direction10,consecutiveMisses,postResetWindow:stat(window),
      recentLiveMissStreak:missStreak(window)},
    shadow:{startMs:shadowStartMs,samples:proofWindow.length,recovery20,recovery10,
      recoveryReady,remainingTo20:blocked?Math.max(0,20-proofWindow.length):0},
    trippedAt,recoveredAt,tripCount,autoReleases,
    requiresManualApproval:false,
    policy:'AUTO_DIRECTION_FUSE_AND_AUTO_RELEASE_ON_NEW_OFFICIAL_PAPER_20_75_RECENT10_70',
  };
}

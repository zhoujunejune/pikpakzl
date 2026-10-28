#!/usr/bin/env node
// Offline-only replay; no network or exchange order APIs.
import fs from 'node:fs';
import {compareQuoteReplay,GUARDIAN_ADAPTIVE_V2} from './guardian-adaptive-exit-v2.mjs';
const fail=reason=>{console.error('GUARDIAN_ADAPTIVE_REPLAY_BLOCKED '+reason);process.exitCode=2};
const arg=process.argv[2];
if(!arg){fail('HISTORICAL_SELL_QUOTE_FILE_REQUIRED')}
else{
 try{
  const stats=fs.statSync(arg);
  if(!stats.isFile()||stats.size>16_000_000)throw Error('INVALID_QUOTE_EVIDENCE_FILE');
  const positions=JSON.parse(fs.readFileSync(arg,'utf8'));
  if(!Array.isArray(positions)||positions.length>1000)throw Error('INVALID_POSITION_HISTORY');
  const rows=positions.map(compareQuoteReplay);
  const invalid=rows.filter(r=>!r.ok);
  const paired=rows.filter(r=>r.ok&&r.bothExit);
  const diffs=paired.map(r=>r.proxyDifferenceBothExits);
  const result={ok:invalid.length===0,model:GUARDIAN_ADAPTIVE_V2,
   evidencePositions:positions.length,validPositions:rows.length-invalid.length,
   invalidPositions:invalid.length,quoteObservations:rows.reduce((n,r)=>n+(r.observations||0),0),
   baselineHypotheticalExits:rows.filter(r=>r.ok&&r.baseline).length,
   adaptiveHypotheticalExits:rows.filter(r=>r.ok&&r.adaptive).length,
   pairedHypotheticalExits:paired.length,
   meanQuoteProxyDifferenceOnPairedExits:diffs.length?
     diffs.reduce((a,b)=>a+b,0)/diffs.length:null,
   actualFillVerified:false,netTradingProfit:null,performanceValidated:false,
   limitation:'Quote-based comparison only, not actual fills, settlement or out-of-sample net PnL.'};
  console.log(JSON.stringify(result));
  if(invalid.length)process.exitCode=2;
 }catch(e){fail(String(e.message||e).slice(0,120))}
}

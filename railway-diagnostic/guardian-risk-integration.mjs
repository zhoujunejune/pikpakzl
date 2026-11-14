// Only orders explicitly registered after Binance accepted a GUARDIAN BUY
// are eligible for this exit policy. All prices are executable SELL proceeds,
// never BTC spot prices. Defaults to OFF until a separate production signoff.
import fs from 'node:fs';
import path from 'node:path';
import {dynamicExit,registeredGuardianToken,GUARDIAN_MODEL} from './guardian-dynamic-exit.mjs';

export const GUARDIAN_RISK_ENABLED=/^(1|true)$/i.test(String(process.env.GUARDIAN_DYNAMIC_EXIT_ENABLED||'false'));
const REGISTRY=process.env.GUARDIAN_REGISTRY_FILE || '/var/lib/zl-prediction/rounds/guardian5/guardian-live-orders.json';
const PEAKS=process.env.GUARDIAN_PEAKS_FILE || '/var/lib/zl-prediction/guardian5/guardian-sell-peaks.json';
const READY=process.env.GUARDIAN_RISK_READY_FILE || '/tmp/guardian-risk-ready.json';

function readPeaks(file){
  try{
    const raw=JSON.parse(fs.readFileSync(file,'utf8'));
    if(raw?.model!==GUARDIAN_MODEL||!Array.isArray(raw.entries))throw Error('GUARDIAN_PEAK_STATE_UNTRUSTED');
    return raw.entries;
  }catch(e){if(e?.code==='ENOENT')return [];throw e}
}
function writeAtomic(file,data){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o750});
  const tmp=file+'.'+process.pid+'.tmp';
  try{fs.writeFileSync(tmp,JSON.stringify(data),{mode:0o640});fs.renameSync(tmp,file)}
  finally{try{fs.unlinkSync(tmp)}catch{}}
}

export function guardianRiskQuote({tokenId,cost,current,at=Date.now()},opts={}){
  const enabled=opts.enabled??GUARDIAN_RISK_ENABLED;
  if(!enabled)return null;
  const registryFile=opts.registryFile||REGISTRY,peakFile=opts.peakFile||PEAKS;
  let orders;
  try{orders=JSON.parse(fs.readFileSync(registryFile,'utf8'))}
  catch(e){if(e?.code==='ENOENT')return null;throw e}
  if(orders?.model!==GUARDIAN_MODEL||!Array.isArray(orders.entries))
    throw Error('GUARDIAN_ORDER_REGISTRY_UNTRUSTED');
  const row=orders.entries.find(e=>e?.tokenId===tokenId&&
    Number.isSafeInteger(e.round)&&e.round<=at&&at<e.round+300000&&
    registeredGuardianToken(orders,tokenId,e.round));
  if(!row)return null;
  if(!Number.isFinite(cost)||cost<=0||!Number.isFinite(current)||current<0)
    return {ok:false,error:'GUARDIAN_REAL_SELL_QUOTE_INVALID'};
  const peaks=readPeaks(peakFile);
  const old=peaks.find(e=>e.tokenId===tokenId&&e.round===row.round);
  const peak=Math.max(current,old?.peak??current);
  if(!old||peak>old.peak){
    const clean=peaks.filter(e=>e.tokenId!==tokenId&&
      Number.isSafeInteger(e.round)&&e.round>=at-900000&&Number.isFinite(e.peak));
    clean.push({tokenId,round:row.round,peak});
    writeAtomic(peakFile,{model:GUARDIAN_MODEL,entries:clean});
  }
  const result=dynamicExit({round:row.round,now:at,cost,current,peak});
  return {ok:true,dynamic:true,currentSellAmount:current,
    triggered:result.triggered,reason:result.reason,
    kind:result.kind||null,targetAmount:result.target??null,
    tpTriggered:result.kind==='TAKE_PROFIT',
    slTriggered:result.kind==='STOP_LOSS'};
}

export function guardianRiskHeartbeat(healthy,opts={}){
  const enabled=opts.enabled??GUARDIAN_RISK_ENABLED;
  if(!enabled)return;
  const file=opts.file||READY,at=opts.at??Date.now();
  // This is process health, NOT a guarantee that Binance will fill a SELL.
  writeAtomic(file,{model:GUARDIAN_MODEL,at,enabled:Boolean(healthy),
    realSellQuote:true,orderRegistry:true});
}

// Independent, append-only display journal. Never used as DeepSeek model input.
// Records every observed five-minute round and only attaches verified official results.
import fs from 'node:fs';
import path from 'node:path';
const ROUND_MS=300000;
const LOCK_DEADLINE_MS=15000; // DeepSeek AI-only production decision window
const SIDES=new Set(['UP','DOWN']);
const SOURCE='BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY';
const validRound=x=>Number.isSafeInteger(x)&&x>0&&x%ROUND_MS===0;
const safeTime=x=>Number.isSafeInteger(x)&&x>0;
export function createRoundResultsJournal({
 file='/var/lib/zl-prediction/deepseek5/round-results-only.ndjson',
 clock=()=>Date.now()
}={}){
 const rows=new Map();
 let readError=null,writeError=null,settlementLastAt=null,settlementCount=0;
 try{
  if(fs.existsSync(file)){
   for(const [idx,line] of fs.readFileSync(file,'utf8').split('\n').entries()){
    if(!line.trim())continue;
    let event;
    try{event=JSON.parse(line)}catch{throw Error('INVALID_JOURNAL_LINE_'+(idx+1))}
    if(event?.schema!==1||!validRound(event.round))throw Error('INVALID_JOURNAL_EVENT_'+(idx+1));
    if(event.kind==='ROUND'){
     if(rows.has(event.round))continue;
     if(!['LOCKED','NO_SIGNAL','NOT_OBSERVED'].includes(event.status))throw Error('BAD_ROUND_STATUS');
     if(event.status==='LOCKED'&&(!SIDES.has(event.direction)||
      !safeTime(event.lockedAt)||event.lockedAt<event.round||event.lockedAt>=event.round+LOCK_DEADLINE_MS))
      throw Error('BAD_LOCKED_ROW');
     rows.set(event.round,{round:event.round,status:event.status,
      direction:event.status==='LOCKED'?event.direction:null,
      lockedAt:event.lockedAt??null,
      latencyMs:event.status==='LOCKED'?event.lockedAt-event.round:null,
      decisionMethod:event.status==='LOCKED'?event.decisionMethod:null,
      recordedAt:event.recordedAt,actual:null,settledAt:null,hit:null});
    }else if(event.kind==='SETTLED'){
     const existing=rows.get(event.round);
     if(existing&&SIDES.has(event.actual)&&safeTime(event.settledAt)&&
        event.settledAt>=event.round+ROUND_MS){
       existing.actual=event.actual;existing.settledAt=event.settledAt;
       existing.hit=existing.status==='LOCKED'?(existing.direction===event.actual):null;
     }
    }else throw Error('UNKNOWN_EVENT');
   }
  }
 }catch(e){readError=String(e?.message||e).slice(0,160)}
 const append=(event)=>{
  if(readError)throw Error('JOURNAL_READ_ERROR_'+readError);
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o750});
  fs.appendFileSync(file,JSON.stringify({schema:1,...event})+'\n',{encoding:'utf8',mode:0o640});
 };
 function recordSignal(signal){
  const round=signal?.round,at=signal?.latest?.lockedAt,dir=signal?.latest?.direction;
  if(!validRound(round)||!safeTime(at)||at<round||at>=round+LOCK_DEADLINE_MS||
     !SIDES.has(dir)||signal?.model!=='DEEPSEEK_5M_V1')return false;
  if(rows.has(round))return false;
  const allowedMethods=new Set(['DEEPSEEK_SINGLE_CALL_5S','DEEPSEEK_SINGLE_CALL_15S',
   'REAL_PRICE_ONLY_BACKUP_NOT_DEEPSEEK']);
  const decisionMethod=String(signal.latest.decisionMethod||'');
  if(!allowedMethods.has(decisionMethod))return false;
  const event={kind:'ROUND',round,status:'LOCKED',direction:dir,lockedAt:at,
   decisionMethod,recordedAt:clock()};
  try{append(event);writeError=null}catch(e){writeError=String(e?.message||e).slice(0,120);throw e}
  rows.set(round,{round,status:'LOCKED',direction:dir,lockedAt:at,latencyMs:at-round,
   decisionMethod,recordedAt:event.recordedAt,actual:null,settledAt:null,hit:null});
  return true;
 }
 function finishRound(round,{observed=false}={}){
  if(!validRound(round)||rows.has(round)||clock()<round+LOCK_DEADLINE_MS)return false;
  const event={kind:'ROUND',round,status:observed?'NO_SIGNAL':'NOT_OBSERVED',recordedAt:clock()};
  try{append(event);writeError=null}catch(e){writeError=String(e?.message||e).slice(0,120);throw e}
  rows.set(round,{round,status:event.status,direction:null,lockedAt:null,
   latencyMs:null,decisionMethod:null,recordedAt:event.recordedAt,
   actual:null,settledAt:null,hit:null});
  return true;
 }
 function settle(payload){
  if(payload?.ok!==true||payload?.settlementSource!==SOURCE||
     !Array.isArray(payload.records))throw Error('UNTRUSTED_OFFICIAL_SETTLEMENT_SOURCE');
  const official=new Map();
  for(const item of payload.records){
   const round=Number(item?.roundStartMs),actual=item?.productionActual;
   const settledAt=Number(item?.productionSettledAt??item?.settledAt);
   if(validRound(round)&&SIDES.has(actual)&&safeTime(settledAt)&&
      settledAt>=round+ROUND_MS&&(item?.officialSettlementAudit!=null||
       item?.resolutionEvidence!=null)){
    official.set(round,{actual,settledAt});
   }
  }
  let n=0;
  for(const [round,row] of rows){
   if(row.actual!==null||clock()<round+ROUND_MS)continue;
   const resolved=official.get(round);
   if(!resolved)continue;
   append({kind:'SETTLED',round,...resolved,recordedAt:clock()});
   row.actual=resolved.actual;row.settledAt=resolved.settledAt;
   row.hit=row.status==='LOCKED'?(row.direction===resolved.actual):null;n++;
  }
  settlementCount+=n;settlementLastAt=clock();writeError=null;return n;
 }
 function history(limit=100){
  const n=Math.max(1,Math.min(300,Number.parseInt(limit,10)||100));
  const all=[...rows.values()].sort((a,b)=>a.round-b.round);
  const locked=all.filter(r=>r.status==='LOCKED');
  const settled=locked.filter(r=>r.actual!==null);
  const hits=settled.filter(r=>r.hit===true).length;
  const recent=settled.slice(-20),recentHits=recent.filter(r=>r.hit).length;
  return {ok:readError==null,model:'DEEPSEEK_5M_V1',schema:'ROUND_RESULTS_DISPLAY_ONLY_V1',
   learningDisabled:true,usedForAnalysis:false,source:SOURCE,
   generatedAt:clock(),readError,writeError,settlementLastAt,settlementUpdates:settlementCount,
   summary:{rounds:all.length,signals:locked.length,noSignal:all.filter(r=>r.status==='NO_SIGNAL').length,
    notObserved:all.filter(r=>r.status==='NOT_OBSERVED').length,
    pending:locked.length-settled.length,settled:settled.length,wins:hits,
    losses:settled.length-hits,
    accuracy:settled.length?Number((hits/settled.length*100).toFixed(2)):null,
    last20Accuracy:recent.length?Number((recentHits/recent.length*100).toFixed(2)):null,
    last20SampleSize:recent.length},
   records:all.slice(-n).reverse().map(x=>({...x,hit:x.hit??null}))};
 }
 return {recordSignal,finishRound,settle,history};
}

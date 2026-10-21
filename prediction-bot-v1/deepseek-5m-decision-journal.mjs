// Local-only, sanitized, per-attempt DeepSeek decision journal. Never log secrets,
// prompts, authentication headers, personal data, or raw model responses.
import fs from 'node:fs';
import path from 'node:path';
const asNumber=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
const short=x=>typeof x==='string'?x.slice(0,100):null;
export function newDecisionJournal(dir){
 let written=0,lastError=null;
 const fileAt=at=>path.join(dir,'attempts-'+new Date(at).toISOString().slice(0,10)+'.jsonl');
 function append(event){
  const at=asNumber(event?.at)||Date.now();
  const row={at,round:asNumber(event?.round),attempt:asNumber(event?.attempt),
   outcome:short(event?.outcome),direction:short(event?.direction),
   confidence:asNumber(event?.confidence),reason:short(event?.reason),
   marketAt:asNumber(event?.marketAt),lastPrice:asNumber(event?.lastPrice),
   roundOpenPrice:asNumber(event?.roundOpenPrice),elapsedMs:asNumber(event?.elapsedMs),
   latencyMs:asNumber(event?.latencyMs),tokens:asNumber(event?.tokens),
   error:short(event?.error)};
  try{
   fs.mkdirSync(dir,{recursive:true,mode:0o750});
   fs.appendFileSync(fileAt(at),JSON.stringify(row)+'\n',{encoding:'utf8',mode:0o640});
   written++;lastError=null;return true;
  }catch(e){lastError=String(e?.code||e?.message||'AUDIT_WRITE_FAILED').slice(0,70);return false;}
 }
 function history(limit=40,now=Date.now()){
  const n=Math.max(1,Math.min(200,Math.trunc(Number(limit)||40)));
  try{
   const p=fileAt(now);
   if(!fs.existsSync(p))return {ok:true,records:[],source:'LOCAL_DECISION_JOURNAL'};
   const size=fs.statSync(p).size;
   // Never read arbitrarily large files through an API. Daily files remain append-only.
   const handle=fs.openSync(p,'r');
   let text='';
   try{const bytes=Math.min(size,250000),buffer=Buffer.alloc(bytes);
    fs.readSync(handle,buffer,0,bytes,size-bytes);text=buffer.toString('utf8');}
   finally{fs.closeSync(handle)}
   let lines=text.split('\n').filter(Boolean);
   if(size>250000)lines=lines.slice(1);
   const records=lines.slice(-n).map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(Boolean);
   return {ok:true,records:records.reverse(),source:'LOCAL_DECISION_JOURNAL'};
  }catch{return {ok:false,error:'DECISION_JOURNAL_UNAVAILABLE',records:[]}}
 }
 return {append,history,status:()=>({enabled:true,recordedSinceProcessStart:written,lastError})};
}

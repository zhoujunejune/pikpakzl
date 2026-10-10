// Independent read-only audit. Run in a separate process with Binance API credentials.
// Input: JSON array of frozen round records; NEVER use recorded HIT/MISS as truth.
import fs from 'node:fs';
import crypto from 'node:crypto';
const input = process.argv[2];
if (!input) throw Error('Usage: node independent-binance-settlement.mjs rounds.json');
const key=process.env.BINANCE_PREDICTION_API_KEY;
const secret=process.env.BINANCE_PREDICTION_API_SECRET;
if(!key||!secret) throw Error('Missing read-only Binance prediction API credentials');
const rows=JSON.parse(fs.readFileSync(input,'utf8'));
if(!Array.isArray(rows)) throw Error('Input must be an array');
const seen=new Set();
const report=[];
async function detail(id) {
  const q=new URLSearchParams({marketTopicId:String(id),timestamp:String(Date.now()),recvWindow:'5000'});
  q.set('signature',crypto.createHmac('sha256',secret).update(q.toString()).digest('hex'));
  const response=await fetch('https://api.binance.com/sapi/v1/w3w/wallet/prediction/market/detail?'+q,{headers:{'X-MBX-APIKEY':key},signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error('BINANCE_HTTP_'+response.status);
  const body=await response.json();
  if(body.code && Number(body.code)!==200 && Number(body.code)!==0)throw Error('BINANCE_CODE_'+body.code);
  return body.data??body;
}
function resolve(topic) {
  // Price observations alone do not establish that Binance finalized a market.
  const status=String(topic.status??topic.marketStatus??topic.settlementStatus??'').toUpperCase();
  const finalized=new Set(['SETTLED','RESOLVED','FINISHED','CLOSED','COMPLETED']);
  if(!finalized.has(status)) return null;
  const v=topic.variantData??topic.variant_data??{};
  const start=Number(v.startPrice??v.start_price),end=Number(v.endPrice??v.end_price);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<=0||end<=0)return null;
  if(end===start)return 'FLAT';
  return end>start?'UP':'DOWN';
}
for(const row of rows) {
  const round=Number(row.roundStartMs),topicId=row.predictionMarketTopicId??row.officialSettlementAudit?.marketTopicId;
  const entry={roundStartMs:round,marketTopicId:topicId??null,status:'UNVERIFIED'};
  if(!Number.isSafeInteger(round)||round%300000!==0||seen.has(round)){entry.reason='INVALID_OR_DUPLICATE_ROUND';report.push(entry);continue;}
  seen.add(round);
  const direction=row.productionPrediction;
  const lock=Number(row.productionLockedAt);
  if(!topicId){entry.reason='MISSING_MARKET_TOPIC_ID';report.push(entry);continue;}
  if(!['UP','DOWN'].includes(direction)||!Number.isFinite(lock)||lock<round||lock>=round+300000){entry.reason='NO_VALID_FROZEN_PRODUCTION_SIGNAL';report.push(entry);continue;}
  try {
    const topic=await detail(topicId);
    const start=Number(topic.startDate),end=Number(topic.endDate);
    if(!Number.isFinite(start)||!Number.isFinite(end)||Math.abs(start-round)>30000||Math.abs(end-(round+300000))>30000){entry.reason='MARKET_ROUND_MISMATCH';report.push(entry);continue;}
    const official=resolve(topic);
    if(!['UP','DOWN'].includes(official)){entry.reason='MISSING_OR_FLAT_SETTLEMENT';report.push(entry);continue;}
    entry.status='VERIFIED';entry.officialDirection=official;
    entry.result=official===direction?'HIT':'MISS';
    entry.matchesStored=official===(row.officialDirection??row.productionActual);
    entry.detailPayloadSha256=crypto.createHash('sha256').update(JSON.stringify(topic)).digest('hex');
    entry.matchesStoredHash=entry.detailPayloadSha256===row.officialSettlementAudit?.detailPayloadSha256;
  }catch(e){entry.reason=String(e?.message??e);}
  report.push(entry);
}
const verified=report.filter(r=>r.status==='VERIFIED');
const hits=verified.filter(r=>r.result==='HIT').length;
const out={generatedAt:new Date().toISOString(),source:'DIRECT_BINANCE_SIGNED_MARKET_DETAIL_INDEPENDENT_REFETCH',totalRows:rows.length,uniqueRoundIds:seen.size,verified:verified.length,hits,misses:verified.length-hits,accuracy:verified.length?hits/verified.length:null,storedDirectionDisagreements:verified.filter(r=>!r.matchesStored).length,storedHashDisagreements:verified.filter(r=>!r.matchesStoredHash).length,rounds:report};
process.stdout.write(JSON.stringify(out,null,2)+'\n');
if(report.some(r=>r.status!=='VERIFIED'||!r.matchesStored))process.exitCode=2;

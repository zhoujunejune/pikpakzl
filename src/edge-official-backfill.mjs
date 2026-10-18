// Validate read-only Binance Prediction market-detail resolution from Render V3.
// Never replace missing official labels with spot candles or presumed outcomes.
const ms=value=>{
 const n=Number(value);
 if(Number.isFinite(n)&&n>1e12)return n;
 const parsed=typeof value==='string'?Date.parse(value):NaN;
 return Number.isFinite(parsed)?parsed:null;
};
export function verifiedDirectOfficialResolution(payload,round){
 if(payload?.ok!==true||payload?.resolved!==true||
    !['UP','DOWN'].includes(payload.direction)||!Number.isSafeInteger(round)||
    round%300000!==0)return null;
 const audit=payload.auditEvidence;
 if(audit?.sourceEndpoint!=='/sapi/v1/w3w/wallet/prediction/market/detail'||
   audit?.evidenceSchemaVersion!==1||
   !/^[a-f0-9]{64}$/i.test(String(audit?.detailPayloadSha256||''))||
   !audit?.marketTopicId||
   !String(payload.evidence||'').endsWith(':STRICT_ROUND_ALIGNED_TOPIC')||
   !audit.resolutionField)return null;
 const start=ms(audit.topicStartDate),end=ms(audit.topicEndDate);
 if(start===null||end===null||
   Math.abs(start-round)>30000||
   Math.abs(end-(round+300000))>30000)return null;
 return payload.direction;
}

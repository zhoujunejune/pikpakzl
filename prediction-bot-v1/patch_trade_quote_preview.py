#!/usr/bin/env python3
"""Add bounded authenticated current-round Binance quote preview for DeepSeek only."""
from pathlib import Path
import sys
assert len(sys.argv)==3
src,dst=map(Path,sys.argv[1:])
s=src.read_text()
def once(a,b,tag):
 global s
 n=s.count(a)
 if n!=1:raise RuntimeError('%s expected once, found %d'%(tag,n))
 s=s.replace(a,b,1)
preview="""// Current-round executable quote previews for DeepSeek's existing 25s analysis.
// Uses Binance get-quote only; NEVER calls place-order-bundle.
let aiQuotePreviewCache=null;
async function getLiveAiQuotePreview(round){
 const now=Date.now(),actualRound=currentRoundMs();
 if(!enabled||!tradeAmountText||round!==actualRound||now<round||now>=round+25000)
  return {ok:false,round,reason:'CURRENT_ROUND_OR_FOLLOW_UNAVAILABLE'};
 if(!aiQuotePreviewCache||aiQuotePreviewCache.round!==round||
    aiQuotePreviewCache.amount!==tradeAmountText){
   aiQuotePreviewCache={round,amount:tradeAmountText,attempts:0,
     busy:false,lastAttemptAt:0,snapshot:null};
 }
 const c=aiQuotePreviewCache;
 if(!c.busy&&c.attempts<2&&
     (c.attempts===0||(now-round>=10000&&now-c.lastAttemptAt>4000))){
   c.busy=true;c.attempts++;c.lastAttemptAt=now;
   void (async()=>{
     try{
       const quotes=await Promise.all(['UP','DOWN'].map(async direction=>{
         const intent=await prepareIntent({round,direction});
         if(!intent?.ok)return null;
         const q=await getFreshQuote(intent);
         if(!q?.ok)return null;
         const chance=Number(q.quote?.chance);
         const at=Number(q.receivedAt);
         const expires=Number(q.quote?.expireAt||0);
         if(!Number.isFinite(chance)||chance<=0||chance>=1||
            !Number.isSafeInteger(at)||at<round||at>round+25000)return null;
         return {chance:Number(chance.toFixed(6)),at,
           expireAt:Number.isSafeInteger(expires)&&expires>0?expires:null};
       }));
       if(quotes.every(Boolean))
         c.snapshot={UP:quotes[0],DOWN:quotes[1],
           round,generatedAt:Math.max(quotes[0].at,quotes[1].at)};
     }catch(e){
       console.log(JSON.stringify({event:'deepseek_quote_preview_unavailable',
         round,reason:String(e?.message||e).slice(0,55)}));
     }finally{c.busy=false}
   })();
 }
 const snap=c.snapshot;
 if(!snap||Date.now()-snap.generatedAt>2600||
    ['UP','DOWN'].some(direction=>Date.now()-snap[direction].at>2800||
      (snap[direction].expireAt&&snap[direction].expireAt<=Date.now()+1500)))
    return {ok:false,round,reason:c.busy?'QUOTE_FETCHING':'QUOTE_NOT_CURRENT'};
 return {ok:true,...snap};
}

"""
once("const EV_FILTER_ENABLED = false;",
     preview+"const EV_FILTER_ENABLED = false;",'BACKEND_QUOTE_PREVIEW')
bt=chr(96)
route="const aiQuoteRoute=String.raw"+bt+"""  if (req.method === 'GET' && url.pathname === '/api/ai-quote-context') {
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))
      return send(res,403,{ok:false,reason:'LOCAL_ONLY'});
    const round=Number(url.searchParams.get('round'));
    if(!Number.isSafeInteger(round)||round%300000!==0)
      return send(res,400,{ok:false,reason:'INVALID_ROUND'});
    return send(res,200,await getLiveAiQuotePreview(round));
  }

"""+bt+";\nsource=source.replace(marker,aiQuoteRoute+marker);\n"
once("source=source.replace(marker,route+marker);",
     "source=source.replace(marker,route+marker);\n"+route,'INJECT_QUOTE_PREVIEW_ROUTE')
assert 'deepseek_live_trade_value' in s,'PRODUCTION_ORDER_GATE_MISSING'
assert "const EV_FILTER_ENABLED = false;" in s
dst.write_text(s)
print('BINANCE_SIGNED_DUAL_QUOTE_PREVIEW_ROUTE_PATCH_READY=true')

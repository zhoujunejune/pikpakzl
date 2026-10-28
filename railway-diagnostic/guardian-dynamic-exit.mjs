// GUARDIAN real-SELL-quote dynamic exit rules, limited to explicitly registered
// tokenId/round. These calculations do not execute orders.
export const GUARDIAN_MODEL='ZL_GUARDIAN_5M_V1';
const n=x=>typeof x==='number'&&Number.isFinite(x);
export function dynamicExit({cost,current,peak,now=Date.now(),round}={}){
 if(!n(cost)||cost<=0||!n(current)||current<0||!n(peak)||peak<0||
    !Number.isSafeInteger(round)||round%300000!==0||now<round||now>=round+300000)
  return {triggered:false,reason:'INVALID_GUARDIAN_POSITION_OR_QUOTE'};
 const high=Math.max(peak,current),pnl=(current-cost)/cost;
 if(current<=cost*0.90)
  return {triggered:true,reason:'GUARDIAN_DYNAMIC_STOP_LOSS',kind:'STOP_LOSS',pnl,peak:high,target:cost*0.90};
 if(high>=cost*1.08&&high-current>=cost*0.04)
  return {triggered:true,reason:'GUARDIAN_DYNAMIC_TRAILING_TAKE_PROFIT',kind:'TAKE_PROFIT',pnl,peak:high,target:Math.max(cost,high-cost*0.04)};
 if(round+300000-now<12000&&current<cost)
  return {triggered:true,reason:'GUARDIAN_EXIT_BEFORE_SETTLEMENT',kind:'STOP_LOSS',pnl,peak:high,target:current};
 return {triggered:false,reason:'HOLD',pnl,peak:high};
}
export function registeredGuardianToken(fileContents,tokenId,round){
 if(fileContents?.model!==GUARDIAN_MODEL||!Array.isArray(fileContents.entries)||
    !Number.isSafeInteger(round)||round%300000!==0||!tokenId)return false;
 return fileContents.entries.some(x=>x?.round===round&&x.tokenId===tokenId&&
  x.status==='SUBMITTED'&&typeof x.orderId==='string'&&x.orderId.length>0&&Number.isSafeInteger(x.createdAt)&&x.createdAt>=round);
}

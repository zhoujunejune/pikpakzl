// Authenticated, on-demand read-only diagnostic from the SAME Railway trading process.
// Never passes Binance credentials; never submits any trading request.
import {isIP} from 'node:net';
const clean=(x,n=100)=>typeof x==='string'?x.trim().slice(0,n):'';
async function ipInfo(fetchImpl){
 const r=await fetchImpl('https://ipinfo.io/json',{method:'GET',cache:'no-store',
   signal:AbortSignal.timeout(5500)});
 if(!r.ok)throw Error('IPINFO_HTTP_'+r.status);
 const x=await r.json(),ip=clean(x?.ip,60);
 if(!isIP(ip))throw Error('IPINFO_INVALID_IP');
 return {provider:'ipinfo.io',ip,country:clean(x.country,3),
   region:clean(x.region),city:clean(x.city),org:clean(x.org)};
}
async function cloudflare(fetchImpl){
 const r=await fetchImpl('https://www.cloudflare.com/cdn-cgi/trace',{method:'GET',cache:'no-store',
   signal:AbortSignal.timeout(5500)});
 if(!r.ok)throw Error('CLOUDFLARE_HTTP_'+r.status);
 const text=await r.text();
 const entries=Object.fromEntries(text.split('\n').filter(x=>x.includes('='))
   .map(x=>[x.slice(0,x.indexOf('=')),x.slice(x.indexOf('=')+1)]));
 const ip=clean(entries.ip,60);
 if(!isIP(ip))throw Error('CLOUDFLARE_INVALID_IP');
 return {provider:'Cloudflare',ip,country:clean(entries.loc,3)};
}
export async function probeRailwayEgress({fetchImpl=fetch}={}){
 const results=await Promise.allSettled([ipInfo(fetchImpl),cloudflare(fetchImpl)]);
 const ok=results.filter(x=>x.status==='fulfilled').map(x=>x.value);
 if(!ok.length)return {ok:false,error:'公网出口检测服务暂不可用，请稍后重试'};
 const first=ok.find(x=>x.provider==='ipinfo.io')||ok[0];
 const second=ok.find(x=>x.provider!==first.provider);
 return {ok:true,ip:first.ip,country:first.country||null,region:first.region||null,
   city:first.city||null,org:first.org||null,provider:first.provider,
   secondProvider:second?.provider||null,secondProviderIp:second?.ip||null,
   secondProviderCountry:second?.country||null,
   consistency:ok.length===2?(ok[0].ip===ok[1].ip?'MATCH':'DIFFERENT_EGRESS_IPS'):'SINGLE_PROVIDER',
   checkedAt:new Date().toISOString(),
   note:'第三方服务观察到的 Railway 公网出口 IP；地理定位不等于币安账户或产品资格认定。'};
}

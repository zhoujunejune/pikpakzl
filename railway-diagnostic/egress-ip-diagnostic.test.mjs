import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {probeRailwayEgress} from './egress-ip-diagnostic.mjs';
const spy=({first='203.0.113.9',second='203.0.113.9',country='SG'}={})=>{
 const urls=[];
 const fetchImpl=async(url,opts)=>{urls.push({url,method:opts.method});
  if(url.includes('ipinfo.io'))return {ok:true,json:async()=>({ip:first,country,region:'Singapore',org:'Test'})};
  return {ok:true,text:async()=> 'ip='+second+'\\nloc='+country+'\\n'};
 };
 return {urls,fetchImpl};
};
test('same outbound IP from both read-only providers and no Binance API usage',async()=>{
 const f=spy(),v=await probeRailwayEgress({fetchImpl:f.fetchImpl});
 assert.equal(v.ok,true);assert.equal(v.country,'SG');assert.equal(v.ip,'203.0.113.9');
 assert.equal(v.consistency,'MATCH');assert.equal(f.urls.length,2);
 assert.ok(f.urls.every(x=>x.method==='GET'&&!x.url.includes('binance')));
});
test('different NAT egress IPs are not silently treated as one',async()=>{
 const f=spy({second:'203.0.113.10'}),v=await probeRailwayEgress({fetchImpl:f.fetchImpl});
 assert.equal(v.consistency,'DIFFERENT_EGRESS_IPS');
 assert.equal(v.secondProviderIp,'203.0.113.10');
});
test('invalid provider output is rejected',async()=>{
 const v=await probeRailwayEgress({fetchImpl:async url=>url.includes('ipinfo')
  ? {ok:true,json:async()=>({ip:'<script>'})}
  : {ok:true,text:async()=>'<html>error</html>'}});
 assert.equal(v.ok,false);
});
test('PIN protected diagnostic route never reads Binance private APIs or places trades',()=>{
 const source=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
 const wrapper=fs.readFileSync(new URL('./wrapper.mjs',import.meta.url),'utf8');
 const start=source.indexOf("if (req.method === 'POST' && url.pathname === '/api/egress-ip')");
 const end=source.indexOf("if (req.method === 'GET' && url.pathname === '/healthz')",start);
 assert.ok(start>0&&end>start);
 const route=source.slice(start,end);
 assert.match(route,/pinOK\\(body\\.pin\\)/);
 assert.match(route,/probeRailwayEgress\\(\\)/);
 assert.doesNotMatch(route,/signedGet|signedPost|prepareWorker|submitPendingOrder|enabled\\s*=/);
 assert.match(source,/onclick="checkEgressIp\\(\\)"/);
 assert.match(wrapper,/window\\.checkEgressIp=function\\(\\)/);
 assert.match(wrapper,/request\\('POST','\\/api\\/egress-ip'/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';

function listen(server,port=0){
 return new Promise((resolve,reject)=>{
  server.once('error',reject);
  server.listen(port,'127.0.0.1',()=>{
   server.off('error',reject);
   resolve(server.address().port);
  });
 });
}
function close(server){
 return new Promise(resolve=>{
  if(!server.listening)return resolve();
  server.close(()=>resolve());
 });
}
async function unusedPort(){
 const candidate=http.createServer();
 const port=await listen(candidate);
 await close(candidate);
 return port;
}
async function checkProxy(path,begin,end,fnName,portSymbol,options){
 const source=fs.readFileSync(new URL(path,import.meta.url),'utf8');
 const a=source.indexOf(begin),b=source.indexOf(end,a);
 assert.ok(a>=0&&b>a,'Expected proxy function region');
 const port=await unusedPort();
 const logs=[];
 const context={
  http,Buffer,setTimeout,
  [portSymbol]:port,
  injectRiskControls:html=>html,
  injectStats:html=>html,
  log:(event,details)=>logs.push({event,...details}),
  sendJson:(res,status,body)=>{
   res.writeHead(status,{'content-type':'application/json'});
   res.end(JSON.stringify(body));
  },
 };
 vm.createContext(context);
 vm.runInContext(source.slice(a,b),context);
 const upstream=http.createServer((req,res)=>{
  if(req.method==='POST')upstream.posts=(upstream.posts||0)+1;
  res.writeHead(200,{'content-type':'text/html'});
  res.end('<h1>内部程序就绪</h1>');
 });
 const outer=http.createServer((req,res)=>{
  if(options)
   context[fnName](req,res,options);
  else context[fnName](req,res,true);
 });
 let timer=null;
 try{
  const outerPort=await listen(outer);
  const base='http://127.0.0.1:'+outerPort;
  const invalidPost=await fetch(base+'/api/confirm',{
   method:'POST',headers:{'content-type':'application/json'},body:'{}',
   signal:AbortSignal.timeout(5000)
  });
  assert.equal(invalidPost.status,503,'Cannot retry real-money POSTs');
  const fail=await invalidPost.json();
  assert.equal(fail.reason,'ECONNREFUSED');
  const delayed=new Promise((resolve,reject)=>{
   timer=setTimeout(()=>{listen(upstream,port).then(resolve,reject)},1050);
  });
  const start=Date.now();
  const request=await fetch(base+'/',{signal:AbortSignal.timeout(8000)});
  const html=await request.text();
  assert.equal(request.status,200);
  assert.match(html,/内部程序就绪/);
  assert.ok(Date.now()-start>=500,'Request should wait for delayed inner program');
  await delayed;
  assert.equal(upstream.posts||0,0,'No replayed POST');
  assert.ok(logs.some(x=>x.event.includes('proxy_recovered')),'Recovered startup is logged');
 }finally{
  if(timer)clearTimeout(timer);
  await close(outer);
  await close(upstream);
 }
}

test('Render control proxy waits through port 3001 startup but never retries order POST',async()=>{
 await checkProxy('./control-shell.mjs',
  'function proxy(req, res, { transformHtml = false } = {}) {',
  '\\n\\nstartInner();',
  'proxy','INNER_PORT',{transformHtml:true});
});

test('Render public panel proxy waits for port 3002 startup and rejects non-idempotent retries',async()=>{
 await checkProxy('./panel-stats-shell.mjs',
  'function proxyInner(req, res, transformHtml = false) {',
  '\\n\\nasync function fetchStatsOrigin',
  'proxyInner','INNER_PANEL_PORT',null);
});

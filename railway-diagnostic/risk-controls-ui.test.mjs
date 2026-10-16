import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('./control-shell.mjs',import.meta.url),'utf8');
function extract(label){
 const m=source.match(new RegExp('^const '+label+' = (.+);$', 'm'));
 assert.ok(m,'missing '+label);
 return JSON.parse(m[1]);
}
const html=extract('riskCards'), script=extract('riskScript');
const embedded=script.replace(/^<script>/,'').replace(/<\/script>$/,'');
new vm.Script(embedded,{filename:'risk-control-ui.js'});

function simulate(){
 const dom=new Map();
 const ids=['tpState','slState','tpValue','slValue','tpMeta','slMeta',
  'tpEditor','slEditor','tpPercent','slPercent','tpRange','slRange','tpPin','slPin','pin','tpNotice','slNotice'];
 for(const id of ids)dom.set(id,{value:'',innerHTML:'',textContent:'',open:false,className:''});
 const cfg={ok:true,takeProfitEnabled:false,takeProfitPercent:50,
  stopLossEnabled:true,stopLossPercent:25,source:'runtime'};
 const requests=[];
 const context={
  document:{readyState:'complete',getElementById:id=>dom.get(id)||null},
  setInterval:cb=>{if(!context.tick)context.tick=cb;return 0;},
  Date,Math,JSON,Number,String,Object,Array,Error,Boolean,isFinite,
 };
 class XHR{
  open(method,url){this.method=method;this.url=url}
  setRequestHeader(){}
  send(raw){
   const body=raw?JSON.parse(raw):null;
   requests.push({method:this.method,url:this.url,body});
   this.status=200;
   if(this.method==='POST'){
    if(body.pin!=='test-pin') {this.status=401;this.responseText=JSON.stringify({error:'PIN 错误'})}
    else {
     const copy={...body};delete copy.pin;
     Object.assign(cfg,copy);
     this.responseText=JSON.stringify(cfg);
    }
   } else this.responseText=JSON.stringify(cfg);
   this.readyState=4;
   this.onreadystatechange();
  }
 }
 context.XMLHttpRequest=XHR;
 context.window=context;
 vm.runInNewContext(embedded,context);
 return {dom,cfg,requests,context};
}
test('one combined risk-control column contains two independently clickable settings',()=>{
 assert.match(html,/id="riskControlsCard"/);
 assert.equal((html.match(/class="c risk-combined"/g)||[]).length,1);
 assert.match(html,/自动止盈止损/);
 assert.ok(html.indexOf('id="tp50Card"')<html.indexOf('id="slCard"'));
 for(const [side,label] of [['tp','止盈'],['sl','止损']]){
  assert.match(html,new RegExp('id="'+side+'Editor"'));
  assert.match(html,new RegExp('点此调整'+label+'比例'));
  assert.match(html,new RegExp('id="'+side+'Range"'));
  assert.match(html,new RegExp('id="'+side+'Percent"'));
  assert.match(html,new RegExp('id="'+side+'Pin"'));
  assert.ok(html.includes("riskPreset('"+side+"',25)"));
 }
 assert.match(html,/保存比例不会开启或关闭止盈/);
});
test('opening one row closes the other editor without changing saved settings',()=>{
 const {dom,cfg,context,requests}=simulate();
 context.riskOpen('tp');dom.get('tpEditor').open=true;
 dom.get('tpPercent').value='72';
 context.riskOpen('sl');dom.get('slEditor').open=true;
 assert.equal(dom.get('tpEditor').open,false);
 assert.equal(dom.get('tpPercent').value,50);
 assert.equal(cfg.takeProfitPercent,50);
 assert.equal(cfg.stopLossPercent,25);
 assert.equal(requests.filter(x=>x.method==='POST').length,0);
});

test('editing take-profit writes only takeProfitPercent, preserving stop loss and enabled flags',()=>{
 const {dom,cfg,requests,context}=simulate();
 assert.equal(dom.get('tpValue').textContent,'50%');
 assert.equal(dom.get('slValue').textContent,'25%');
 context.riskOpen('tp');dom.get('tpEditor').open=true;
 context.riskPreset('tp',75);
 assert.equal(dom.get('tpPercent').value,75);
 dom.get('tpPin').value='test-pin';
 context.saveTpPercent();
 const post=requests.filter(x=>x.method==='POST');
 assert.equal(post.length,1);
 assert.deepEqual(Object.keys(post[0].body).sort(),['pin','takeProfitPercent']);
 assert.equal(cfg.takeProfitPercent,75);
 assert.equal(cfg.stopLossPercent,25);
 assert.equal(cfg.takeProfitEnabled,false);
 assert.equal(cfg.stopLossEnabled,true);
 assert.equal(dom.get('tpValue').textContent,'75%');
 assert.equal(dom.get('slValue').textContent,'25%');
 assert.equal(dom.get('tpEditor').open,false);
 assert.equal(dom.get('tpPin').value,'');
});
test('editing stop-loss writes only stopLossPercent; opening one does not alter the other',()=>{
 const {dom,cfg,requests,context}=simulate();
 context.riskOpen('sl');
 dom.get('slEditor').open=true;
 dom.get('slPercent').value='12.5';
 context.riskSync('sl','number');
 assert.equal(dom.get('slRange').value,'12.5');
 dom.get('slPin').value='test-pin';
 context.saveSlPercent();
 assert.deepEqual(Object.keys(requests.filter(x=>x.method==='POST')[0].body).sort(),['pin','stopLossPercent']);
 assert.equal(cfg.stopLossPercent,12.5);
 assert.equal(cfg.takeProfitPercent,50);
 assert.equal(dom.get('slValue').textContent,'12.5%');
});
test('enabled toggles do not silently save an unsaved percentage edit',()=>{
 const {dom,cfg,requests,context}=simulate();
 context.riskOpen('tp');dom.get('tpEditor').open=true;
 dom.get('tpPercent').value='88';
 dom.get('tpPin').value='test-pin';
 context.setTp(true);
 const post=requests.filter(x=>x.method==='POST')[0].body;
 assert.deepEqual(Object.keys(post).sort(),['pin','takeProfitEnabled']);
 assert.equal(cfg.takeProfitEnabled,true);
 assert.equal(cfg.takeProfitPercent,50);
 assert.equal(cfg.stopLossEnabled,true);
});
test('missing PIN and invalid percentage do not send any write',()=>{
 const {dom,requests,context}=simulate();
 context.riskOpen('sl');dom.get('slEditor').open=true;
 dom.get('slPercent').value='75';
 context.saveSlPercent();
 assert.equal(requests.filter(x=>x.method==='POST').length,0);
 assert.match(dom.get('slNotice').textContent,/PIN/);
 dom.get('slPin').value='test-pin';
 dom.get('slPercent').value='0';
 context.saveSlPercent();
 assert.equal(requests.filter(x=>x.method==='POST').length,0);
 assert.match(dom.get('slNotice').textContent,/1%到100%/);
});
test('refresh does not overwrite unsaved text while its details editor is expanded',()=>{
 const {dom,context,cfg}=simulate();
 context.riskOpen('tp');dom.get('tpEditor').open=true;
 dom.get('tpPercent').value='72.5';
 cfg.takeProfitPercent=53;
 context.tick();
 assert.equal(dom.get('tpPercent').value,'72.5');
 assert.equal(dom.get('tpValue').textContent,'53%');
 dom.get('tpEditor').open=false;
 context.tick();
 assert.equal(dom.get('tpPercent').value,53);
});
test('existing read/write risk API contract and page injection markers stay unchanged',()=>{
 assert.match(source,/url\.pathname === '\/api\/risk-control'/);
 assert.match(source,/if \(!pinOK\(body.pin\)\)/);
 assert.match(source,/validPercent\(next\.takeProfitPercent\)/);
 assert.match(source,/validPercent\(next\.stopLossPercent\)/);
 assert.match(source,/\$\{riskCards\}\$\{marker\}/);
 assert.match(source,/\$\{riskScript\}<\/body>/);
 assert.doesNotMatch(source,/\/risk-monitor-client\.js/);
});

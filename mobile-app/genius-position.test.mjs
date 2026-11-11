import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const source=fs.readFileSync(path.join(here,'genius.js'),'utf8');
const html=fs.readFileSync(path.join(here,'genius.html'),'utf8');
const position={
 id:'paper-test-001',symbol:'BTCUSDT',side:'LONG',entry:50000,qty:.0002,
 marginUsdt:5,leverage:2,horizon:'MEDIUM',openedAt:Date.now()-30000
};
function setup({withPosition=true,historyFails=true,legacyHtml=false}={}){
 const ids=['connection','marketStream','markPrice','engineState','lastAnalysis','marketLag',
  'aiLatency','aiTrigger','microWindow','recentError','aiDecision','balance','tradeCount',
  'toggle','position','positionState','leverage','marginUsdt','saveStatus','save','stop','history'];
 if(!legacyHtml)ids.push('multiTrend');
 const elements=Object.fromEntries(ids.map(id=>[id,{
  id,textContent:'',value:'',children:[],
  replaceChildren(...nodes){this.children=nodes;this.textContent='';},
  append(...nodes){this.children.push(...nodes);},
  addEventListener(){}
 }]));
 const document={
  getElementById(id){return elements[id]||null;},
  createElement(tag){return {tag,textContent:'',children:[],append(...nodes){this.children.push(...nodes);}}}
 };
 const status={ok:true,mode:'PAPER_ONLY',realTradingEnabled:false,aiModel:'deepseek-flash',
  aiConfigured:true,aiStatus:'SUCCESS',settings:{enabled:true,emergencyStop:false,
    leverage:2,marginUsdt:5},paperBalance:199,totalClosed:13,
  position:withPosition?position:null,
  marketSnapshots:[{symbol:'BTCUSDT',markPrice:50500,checkedAt:Date.now()}],
  lastMarket:{symbol:'BTCUSDT',markPrice:50500,checkedAt:Date.now()},
  metrics:{perSymbol:{BTCUSDT:{trades:{w10:{changePct:.1,buyRatio:.6}},higherComplete:false}}}};
 const fetch=async url=>{
  if(url.endsWith('/status'))return {ok:true,json:async()=>status};
  if(url.endsWith('/history')){
    if(historyFails)throw Error('simulated history service unavailable');
    return {ok:true,json:async()=>({ok:true,records:[]})};
  }
  throw Error('unexpected endpoint');
 };
 const context=vm.createContext({document,fetch,AbortSignal,setInterval(){},Date,Number,Math,Error,
  String,Array,Object,Boolean,console});
 vm.runInContext(source,context,{filename:'genius.js'});
 return {elements};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,25));
test('current paper position renders despite broken history service and missing optional old-HTML element',async()=>{
 const {elements}=setup({legacyHtml:true,historyFails:true});
 await settle();
 assert.equal(elements.positionState.textContent,'模拟持仓中');
 const rows=elements.position.children.map(r=>r.children.map(x=>x.textContent).join(':'));
 assert.ok(rows.some(x=>x.includes('BTCUSDT / 看涨 LONG')));
 assert.ok(rows.some(x=>x.includes('模拟开仓价:50,000')));
 assert.ok(rows.some(x=>x.includes('浮动盈亏')));
 assert.ok(rows.some(x=>x.includes('AI 持仓周期:中线')));
 assert.match(elements.history.textContent,/历史记录读取失败/);
});
test('no simulated position is clearly distinguished from history and real Binance balance',async()=>{
 const {elements}=setup({withPosition:false,historyFails:false});
 await settle();
 assert.equal(elements.positionState.textContent,'当前空仓');
 assert.match(elements.position.textContent,/当前没有未平仓/);
});
test('position is located above analysis and has explicit paper-only scope',()=>{
 assert.ok(html.indexOf('id="positionCard"')<html.indexOf('class="card hero"'));
 assert.match(html,/不同步币安账户中的真实仓位/);
 assert.match(source,/api\('status'\)\.then\(renderStatus\)/);
});

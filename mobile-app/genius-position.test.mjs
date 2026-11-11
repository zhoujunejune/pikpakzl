import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const source=fs.readFileSync(path.join(here,'genius.js'),'utf8');
const html=fs.readFileSync(path.join(here,'genius.html'),'utf8');
const NOW=Date.now();
const positions=[
 {id:'paper-test-btc',symbol:'BTCUSDT',side:'LONG',entry:50000,qty:.0002,marginUsdt:5,
   leverage:2,horizon:'MEDIUM',openedAt:NOW-30000},
 {id:'paper-test-eth',symbol:'ETHUSDT',side:'SHORT',entry:3300,qty:.003,marginUsdt:5,
   leverage:2,horizon:'LONG',openedAt:NOW-30000},
 {id:'paper-test-sol',symbol:'SOLUSDT',side:'LONG',entry:180,qty:.05,marginUsdt:5,
   leverage:2,horizon:'SHORT',openedAt:NOW-30000}
];
function el(tag='div'){
 return {
  tag,children:[],textContent:'',value:'',className:'',dataset:{},style:{},
  clientWidth:320,scrollLeft:0,hidden:false,events:{},attrs:{},
  replaceChildren(...nodes){this.children=nodes;this.textContent='';},
  append(...nodes){this.children.push(...nodes);},
  addEventListener(name,handler){this.events[name]=handler;},
  setAttribute(key,value){this.attrs[key]=value;},
  querySelector(selector){return selector==='strong'?this.children.find(v=>v.tag==='strong')||null:null;},
  scrollTo({left}){this.scrollLeft=left;this.events.scroll?.();},
  classList:{toggle(){}}
 };
}
function setup({withPositions=positions.slice(0,1),historyFails=true,historyRecords=[]}={}){
 const ids=['connection','marketStream','markPrice','engineState','lastAnalysis','marketLag',
  'aiLatency','aiTrigger','microWindow','recentError','aiDecision','balance','tradeCount',
  'toggle','positionState','positionTrack','positionDots','positionEmpty',
  'positionCount','positionTotalPnl','positionPage',
  'cumulativePnl','realizedPnl','unrealizedPnl','cumulativePnlNote',
  'leverage','marginUsdt','saveStatus','save','stop','history','multiTrend'];
 const elements=Object.fromEntries(ids.map(id=>[id,el()]));
 let status={ok:true,mode:'PAPER_ONLY',realTradingEnabled:false,aiModel:'deepseek-flash',
  aiConfigured:true,aiStatus:'SUCCESS',settings:{enabled:true,emergencyStop:false,
    leverage:2,marginUsdt:5},paperBalance:199,totalClosed:13,
  positions:withPositions,position:withPositions[0]||null,
  pnlSummary:{realizedNetPnl:-3.25,openGrossPnl:0.5,
    estimatedOpenNetPnl:0.42,estimatedCumulativePnl:-2.83,complete:true},
  marketSnapshots:[
   {symbol:'BTCUSDT',markPrice:50500,checkedAt:NOW},
   {symbol:'ETHUSDT',markPrice:3270,checkedAt:NOW},
   {symbol:'SOLUSDT',markPrice:182,checkedAt:NOW}],
  lastMarket:{symbol:'BTCUSDT',markPrice:50500,checkedAt:NOW},
  metrics:{perSymbol:{BTCUSDT:{trades:{w10:{changePct:.1,buyRatio:.6}},higherComplete:false}}}};
 const fetch=async url=>{
  if(url.endsWith('/status'))return {ok:true,json:async()=>status};
  if(url.endsWith('/history')){
    if(historyFails)throw Error('simulated history service unavailable');
    return {ok:true,json:async()=>({ok:true,records:historyRecords})};
  }
  throw Error('unexpected endpoint');
 };
 const document={getElementById(id){return elements[id]||null;},createElement:tag=>el(tag)};
 let refresh;
 const context=vm.createContext({document,fetch,AbortSignal,setInterval(fn){refresh=fn;},Date,Number,Math,Error,
  String,Array,Object,Boolean,console});
 vm.runInContext(source,context,{filename:'genius.js'});
 return {elements,runRefresh:async()=>{refresh();await settle();},
  updatePositions:next=>{status={...status,positions:next,position:next[0]||null};}};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,25));
test('one paper position renders despite broken history and not as real Binance balance',async()=>{
 const {elements}=setup();
 await settle();
 assert.equal(elements.positionState.textContent,'模拟持仓中');
 assert.equal(elements.positionCount.textContent,'1 / 3');
 assert.equal(elements.positionTrack.children.length,1);
 const lines=elements.positionTrack.children[0].children
   .map(r=>r.children.map(x=>x.textContent).join(':'));
 assert.ok(lines.some(s=>s.includes('BTCUSDT / 看涨 LONG')));
 assert.ok(lines.some(s=>s.includes('AI 持仓周期:中线')));
 assert.match(elements.history.textContent,/历史记录读取失败/);
});
test('zero positions shows empty state, not history or simulated fake account',async()=>{
 const {elements}=setup({withPositions:[],historyFails:false});
 await settle();
 assert.equal(elements.positionState.textContent,'当前空仓');
 assert.equal(elements.positionTrack.children.length,0);
 assert.match(elements.positionEmpty.textContent,/当前没有未平仓/);
 assert.equal(elements.positionCount.textContent,'0 / 3');
});
test('three positions display distinct cards, total floating PnL and swipe pagination',async()=>{
 const {elements,runRefresh,updatePositions}=setup({withPositions:positions,historyFails:false});
 await settle();
 const track=elements.positionTrack;
 assert.equal(track.children.length,3);
 assert.equal(elements.positionCount.textContent,'3 / 3');
 assert.match(elements.positionTotalPnl.textContent,/\+/);
 track.scrollLeft=320;track.events.scroll();
 assert.equal(elements.positionPage.textContent,'2 / 3 · 左右滑动');
 const secondCard=track.children[1];
 await runRefresh();
 assert.equal(track.children[1],secondCard,'refresh should not rebuild carousel');
 assert.equal(elements.positionPage.textContent,'2 / 3 · 左右滑动','refresh should retain viewed page');
 assert.ok(secondCard.children[0].children[1].textContent.includes('ETHUSDT / 看跌 SHORT'));
 updatePositions(positions.slice(0,2));
 await runRefresh();
 assert.equal(track.children.length,2);
 assert.equal(elements.positionPage.textContent,'2 / 2 · 左右滑动');
});
test('position carousel remains above main analysis and paper-only is explicit',()=>{
 assert.ok(html.indexOf('id="positionCard"')<html.indexOf('class="card hero"'));
 assert.match(html,/不代表真实币安仓位/);
 assert.match(html,/id="positionTrack"/);
 assert.match(html,/id="positionTotalPnl"/);
 assert.match(source,/api\('status'\)\.then\(renderStatus\)/);
});

test('cumulative PnL is distinct from realized and live floating PnL and formatted as negative',async()=>{
 const {elements}=setup({withPositions:positions.slice(0,1),historyFails:true});
 await settle();
 assert.match(elements.realizedPnl.textContent,/-3.25 USDT/);
 assert.match(elements.unrealizedPnl.textContent,/\+0.50 USDT/);
 assert.match(elements.cumulativePnl.textContent,/-2.83 USDT/);
 assert.match(elements.cumulativePnlNote.textContent,/模拟开平仓手续费/);
 assert.match(html,/模拟交易累计盈亏/);
 assert.ok(html.indexOf('id="cumulativePnlCard"')<html.indexOf('class="card hero"'));
});

test('closed trade history is compact, excludes model explanations, and preserves internal scroll',async()=>{
 const records=[
  {symbol:'SOLUSDT',side:'LONG',netPnl:-0.16,
   openedAt:Date.parse('2026-11-11T13:22:00Z'),closedAt:Date.parse('2026-11-11T13:24:45Z'),
   aiExitReason:'这是一段非常长的AI研究推理分析文字，不应该出现在简洁的历史列表中'},
  {symbol:'ETHUSDT',side:'SHORT',netPnl:0.38,
   openedAt:Date.parse('2026-11-11T13:10:00Z'),closedAt:Date.parse('2026-11-11T13:14:00Z'),
   aiExitReason:'另一条多余的平仓原因'}
 ];
 const {elements,runRefresh}=setup({withPositions:[],historyFails:false,historyRecords:records});
 await settle();
 const history=elements.history;
 assert.equal(history.children.length,2);
 const first=history.children[0];
 assert.match(first.children[0].textContent,/盈亏 -0\\.16 USDT/);
 assert.match(first.children[1].children[0].textContent,/开仓：2026/);
 assert.match(first.children[1].children[1].textContent,/平仓：2026/);
 assert.equal(first.children.length,2);
 assert.doesNotMatch(first.textContent+first.children[0].textContent+first.children[1].children.map(x=>x.textContent).join(''),/研究推理|多余|AI 自主平仓/);
 assert.match(history.children[1].children[0].textContent,/\\+0\\.38 USDT/);
 history.scrollTop=130;
 await runRefresh();
 assert.equal(history.scrollTop,130,'internal scroll position must not reset on polling');
 assert.match(html,/height:288px;overflow-y:auto/);
 assert.match(html,/id="history" role="region" tabindex="0"/);
 assert.match(html,/仅显示盈亏及开仓、平仓时间/);
});

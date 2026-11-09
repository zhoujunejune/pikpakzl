import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
const js=fs.readFileSync(new URL('./app.js',import.meta.url),'utf8');
const native=fs.readFileSync(new URL('../android-app/app/src/main/java/com/zlcontrol/android/TradeJournal.java',import.meta.url),'utf8');
const main=fs.readFileSync(new URL('../android-app/app/src/main/java/com/zlcontrol/android/MainActivity.java',import.meta.url),'utf8');
const start=js.indexOf('// User-declared actual trade tally');
const end=js.indexOf('for(const btn of document.querySelectorAll("[data-go]"))',start);
assert.ok(start>0&&end>start,'manual-trade module must be independent of signal polling');
const moduleCode=js.slice(start,end);

function makeUi(bridge){
 const elements=new Map();
 function element(id){
  if(!elements.has(id))elements.set(id,{
   disabled:false,childNodes:[],textContent:'',listeners:{},
   addEventListener(type,callback){this.listeners[type]=callback;},
   replaceChildren(){this.childNodes=[];},
   append(...children){this.childNodes.push(...children);}
  });
  return elements.get(id);
 }
 const sandbox={
  window:{HaipaiRealTrades:bridge},
  $:element,
  put:(id,text)=>{element(id).textContent=String(text);},
  node:(tag,cls,value)=>({tag,cls,textContent:value,childNodes:[],
    append(...nodes){this.childNodes.push(...nodes);}}),
  JSON,Number
 };
 vm.createContext(sandbox);
 vm.runInContext(moduleCode,sandbox);
 return {elements,sandbox,element};
}

test('one confirmed trade increments count and undo removes only latest local entry',()=>{
 let count=0;
 const data=()=>JSON.stringify({ok:true,date:'2026-11-09',count,limit:10,
  canUndo:count>0,history:[{date:'2026-11-09',count}]});
 const bridge={getSnapshot:data,confirmRealTrade:()=>{count++;return data();},
  undoLastToday:()=>{count--;return data();}};
 const {element,sandbox}=makeUi(bridge);
 assert.equal(element('tradeTodayCount').textContent,'0');
 element('tradeRecordButton').listeners.click();
 assert.equal(element('tradeTodayCount').textContent,'1');
 assert.match(element('tradeJournalNotice').textContent,/登记成功/);
 assert.equal(element('tradeUndoButton').disabled,false);
 element('tradeUndoButton').listeners.click();
 assert.equal(element('tradeTodayCount').textContent,'0');
 assert.equal(element('tradeUndoButton').disabled,true);
 assert.equal(element('tradeHistoryList').childNodes.length,1);
});

test('PWA without native bridge cannot pretend to register real orders',()=>{
 const {element}=makeUi(null);
 assert.equal(element('tradeRecordButton').disabled,true);
 assert.equal(element('tradeUndoButton').disabled,true);
 assert.match(element('tradeJournalNotice').textContent,/正式安卓/);
});

test('day snapshot rolls over by Beijing date, historical rows remain',()=>{
 let date='2026-11-09',count=9;
 const bridge={
  getSnapshot:()=>JSON.stringify({ok:true,date,count,limit:10,canUndo:count>0,
   history:[{date,count},{date:'2026-11-08',count:5}]}),
  confirmRealTrade:()=>'',undoLastToday:()=>''
 };
 const {element,sandbox}=makeUi(bridge);
 assert.equal(element('tradeTodayCount').textContent,'9');
 date='2026-11-10';count=0;
 vm.runInContext('refreshTradeJournal()',sandbox);
 assert.equal(element('tradeTodayCount').textContent,'0');
 assert.match(element('tradeTodayDate').textContent,/2026-11-10/);
 assert.equal(element('tradeHistoryList').childNodes.length,2);
});

test('native journal persists manual timestamps, throttles double taps, and has undo',()=>{
 assert.match(native,/Asia\/Shanghai/);
 assert.match(native,/DOUBLE_TAP_GUARD_MS=1200L/);
 assert.match(native,/\.commit\(\)/);
 assert.match(native,/undoLastToday/);
 assert.match(native,/MANUAL_USER_CONFIRMED_LOCAL_ONLY/);
 assert.doesNotMatch(native,/createOrder|placeOrder|api\/order|Binance.*API/i);
 assert.match(main,/addJavascriptInterface\(new RealTradeBridge\(\),"HaipaiRealTrades"\)/);
 for(const field of ['tradeRecordButton','tradeTodayCount','tradeUndoButton','tradeHistoryList'])
  assert.ok(html.includes('id="'+field+'"'));
 assert.match(js,/APP_VERSION="1\.3\.8"/);
 assert.ok(!js.includes('localStorage')&&!js.includes('sessionStorage'));
});

/* ZL EVENT10-only app — browser-only client; no exchange credentials or order calls. */
"use strict";
const APP_DEPLOY_SHA="__ZL_APP_RELEASE_SHA__"; // Replaced with immutable commit SHA at Alibaba deployment.
const APP_VERSION="1.3.1"; // Ten-minute-signal-only UI release.
const $=id=>document.getElementById(id);
const state={busy:false,manualBusy:false,lastEvent:[],eventRecords:[],eventTotal:0,eventPageSize:25,eventHistoryBusy:false,eventHistorySignature:'',eventHistoryError:null,eventRefreshBusy:false,eventOnline:false};
let EVENT10_FREQ_OPTIMIZED_VERSION=null; // Adopt only the version confirmed by both live APIs.
function put(id,value){
 const el=$(id);if(el)el.textContent=value===null||value===undefined||value===""?"—":String(value);
}
function stamp(ms){
 const n=Number(ms);
 if(!Number.isFinite(n)||n<=0)return "—";
 return new Date(n).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
}
function dir(x){
 return x==="UP"?"看涨 ↑":x==="DOWN"?"看跌 ↓":x==="WAIT"?"观望":x==="THINKING"?"分析中":x==="OBSERVED"?"已记录":"无信号";
}
function pct(n,d){
 return Number.isInteger(n)&&Number.isInteger(d)&&d>0&&n>=0&&n<=d?(100*n/d).toFixed(1)+"%":"—";
}
function pill(id,tone,text){
 const el=$(id);if(!el)return;
 el.className="pill"+(tone==="good"?" good":tone==="bad"?" bad":"");
 el.textContent=text;
}
function node(tag,cls,t){
 const el=document.createElement(tag);
 if(cls)el.className=cls;
 if(t!==undefined)el.textContent=String(t);
 return el;
}
// These are public-index reference prices, NOT event-contract strike/settlement prices.
function eventIndexPrice(v){
 const value=Number(v);
 return v===null||v===undefined||v===""||!Number.isFinite(value)||value<=0?
   "—":value.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:8});
}
function eventPriceComparison(r){
 const open=Number(r?.openPrice),close=Number(r?.closePrice);
 const goodOpen=r?.openPrice!==null&&r?.openPrice!==undefined&&Number.isFinite(open)&&open>0;
 const goodClose=r?.closePrice!==null&&r?.closePrice!==undefined&&Number.isFinite(close)&&close>0;
 if(!goodOpen||!goodClose){
  if(r?.settlementStatus==="UNVERIFIABLE_PRICE_NEAR_EXPIRY")
   return {ready:false,outcome:"到期数据不足，无法核验",change:"—",tone:"warning"};
  return {ready:false,outcome:Number.isFinite(r?.expiresAt)&&Date.now()>r.expiresAt?
    "到期核验处理中":"等待10分钟到期核验",change:"—",tone:"warning"};
 }
 const delta=(close/open-1)*100;
 const change=(delta>0?"+":"")+delta.toFixed(5)+"%";
 const known=r?.settlementStatus!==null&&r?.settlementStatus!==undefined;
 if(!known)return {ready:false,outcome:"到期价格已采集，核验尚未确认",change,tone:"warning"};
 if(r.proxyOutcome==="FLAT"||close===open)
  return {ready:true,outcome:"指数价格持平（不计胜率）",change,tone:"warning"};
 if(r.proxyHit===true)return {ready:true,outcome:"指数代理命中",change,tone:"uptext"};
 if(r.proxyHit===false)return {ready:true,outcome:"指数代理未命中",change,tone:"downtext"};
 return {ready:false,outcome:"核验结果尚未确认",change,tone:"warning"};
}
function renderRecords(id,items){
 const root=$(id);root.replaceChildren();
 if(!items.length){
  root.append(node("div","mini","当前策略暂无已保存的有效方向信号。"));
  return;
 }
 for(const r of items){
  const wrap=node("div","record"),head=node("div","record-head");
  wrap.dataset.eventId=String(r.id);
  const title=node("div","record-title",dir(r.direction));
  if(r.direction==="UP")title.classList.add("uptext");
  if(r.direction==="DOWN")title.classList.add("downtext");
  head.append(title,node("span","mini",stamp(r.openedAt||r.checkedAt)));
  wrap.append(head);
  const pricePair=node("div","record-signal-grid");
  for(const [label,value] of [["信号锁定指数价",eventIndexPrice(r.openPrice)],
    ["10分钟后指数价",eventIndexPrice(r.closePrice)]]){
   const block=node("div","record-price-block");
   block.append(node("div","record-price-label",label),node("div","record-price-value",value));
   pricePair.append(block);
  }
  wrap.append(pricePair);
  const info=eventPriceComparison(r),comparison=node("div","record-comparison");
  comparison.append(node("span","record-change",info.change),
    node("span","record-outcome "+info.tone,info.outcome));
  wrap.append(comparison);
  const planned=Number.isFinite(r.expiresAt)?stamp(r.expiresAt):"—";
  const sampled=Number.isFinite(r.closeObservedAt)?stamp(r.closeObservedAt):"—";
  const motion=typeof r.change3mPct==="number"?r.change3mPct.toFixed(5)+"%":"—";
  const trigger=r.trigger==="AUTO"?"自动":"手动";
  wrap.append(node("div","record-note",trigger+" · 3分钟净涨跌 "+motion));
  wrap.append(node("div","record-note","信号时间 "+stamp(r.openedAt)+" · 非事件合约真实下单价格"));
  wrap.append(node("div","record-note","预定核验 "+planned+
    " · 实际采样 "+sampled+" · 仅币安指数代理对比，非事件合约官方结算"));
  root.append(wrap);
 }
}
async function api(url,timeout=6500){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeout);
 try{
  const res=await fetch(url,{cache:"no-store",credentials:"same-origin",signal:controller.signal,
   headers:{"Accept":"application/json"}});
  if(!res.ok)throw Error("HTTP "+res.status);
  const value=await res.json();
  if(!value||value.ok!==true)throw Error("服务响应无效");
  return value;
 }finally{clearTimeout(timer);}
}
// The ten-minute app is a CURRENT-STRATEGY ONLY view.
// Old signal files stay on the server for audit, but are never displayed or counted.
function eventVersion(r){
 return r?.strategyVersion||r?.decisionReviewVersion||r?.ruleChecks?.strategyVersion||null;
}
function currentEventRecord(e){
 if(e?.active&&eventVersion(e.active)===EVENT10_FREQ_OPTIMIZED_VERSION)return e.active;
 return [e?.lastCheck,e?.lastSession]
  .filter(r=>r&&eventVersion(r)===EVENT10_FREQ_OPTIMIZED_VERSION)
  .sort((a,b)=>Number(b.checkedAt??b.openedAt??0)-Number(a.checkedAt??a.openedAt??0))[0]||null;
}
function mergeEventRecords(ledger){
 // Fail closed: a cached, old-version or missing ledger must never repopulate old rows.
 if(ledger?.version!==EVENT10_FREQ_OPTIMIZED_VERSION||!Array.isArray(ledger.records))return [];
 const rows=new Map();
 for(const r of ledger.records){
  if(!r||eventVersion(r)!==EVENT10_FREQ_OPTIMIZED_VERSION||
     !["UP","DOWN"].includes(r.direction)||!Number.isFinite(r.openedAt)||!r.id)continue;
  rows.set(r.id,r);
 }
 return Array.from(rows.values()).sort((a,b)=>b.openedAt-a.openedAt);
}
// Current-version ledger is durable on Alibaba; the WebView merely pages through it.
function mergeEventRecordPages(current,incoming){
 return mergeEventRecords({version:EVENT10_FREQ_OPTIMIZED_VERSION,
  records:[...(Array.isArray(current)?current:[]),...(Array.isArray(incoming)?incoming:[])]});
}
function eventHistoryFingerprint(records){
 return JSON.stringify(records.map(r=>[r.id,r.direction,r.openedAt,r.openPrice,
  r.closePrice,r.closeObservedAt,r.settlementStatus,r.proxyOutcome,r.proxyHit,r.expiresAt,
  r.eventTag,r.change3mPct,r.trigger,r.signalQuality]));
}
function drawEventHistory(){
 const viewport=$("eRecordScroll"),root=$("eRecords");
 if(!viewport||!root)return;
 const signature=eventHistoryFingerprint(state.eventRecords);
 if(signature!==state.eventHistorySignature){
  const oldTop=viewport.scrollTop,scrolled=oldTop>14;
  const first=scrolled?Array.from(root.children).find(el=>
   el.dataset?.eventId&&el.offsetTop+el.offsetHeight>oldTop):null;
  const id=first?.dataset?.eventId||null,gap=first?first.offsetTop-oldTop:0;
  renderRecords("eRecords",state.eventRecords);
  if(scrolled){
   const after=id?Array.from(root.children).find(el=>el.dataset?.eventId===id):null;
   viewport.scrollTop=after?Math.max(0,after.offsetTop-gap):oldTop;
  }else viewport.scrollTop=0;
  state.eventHistorySignature=signature;
 }
 put("eTotal","新策略 "+state.eventTotal+" 条 · 已加载 "+state.eventRecords.length+" 条");
 let status;
 if(state.eventHistoryBusy)status="正在加载更多历史信号…";
 else if(state.eventHistoryError)status="加载遇到问题，请再向下滑动重试："+state.eventHistoryError;
 else if(state.eventTotal===0)status="暂无新版信号";
 else if(state.eventRecords.length>=state.eventTotal)status="已展示全部 "+state.eventTotal+" 条";
 else status="向下滑动加载更多 · 已加载 "+state.eventRecords.length+" / "+state.eventTotal+" 条";
 put("eRecordStatus",status);
}
function updateEventHistory(ledger){
 if(ledger?.version!==EVENT10_FREQ_OPTIMIZED_VERSION||!Array.isArray(ledger.records))
  return false;
 state.eventRecords=mergeEventRecordPages(state.eventRecords,ledger.records);
 state.lastEvent=state.eventRecords;
 const count=Number.isInteger(ledger.total)&&ledger.total>=0?ledger.total:0;
 state.eventTotal=Math.max(count,state.eventRecords.length);
 state.eventHistoryError=null;
 drawEventHistory();
 return true;
}
async function loadMoreEventSignals(){
 if(state.eventHistoryBusy||document.hidden||
    state.eventRecords.length>=state.eventTotal||
    !$("panel-event10").classList.contains("active"))return;
 state.eventHistoryBusy=true;
 state.eventHistoryError=null;
 drawEventHistory();
 try{
  // Small page overlap protects against new top-of-list signals shifting offsets.
  const offset=Math.max(0,state.eventRecords.length-3);
  const page=await api("/event10/api/signals?limit="+state.eventPageSize+"&offset="+offset,9500);
  if(page?.version!==EVENT10_FREQ_OPTIMIZED_VERSION||!Array.isArray(page.records))
   throw Error("返回的策略版本不匹配");
  const before=state.eventRecords.length;
  updateEventHistory(page);
  if(state.eventRecords.length===before&&state.eventTotal>before)
   state.eventHistoryError="未读到新增历史，检查网络后再试";
 }catch(e){state.eventHistoryError=String(e?.message||e).slice(0,110);}
 finally{state.eventHistoryBusy=false;drawEventHistory();}
}
function onEventHistoryScroll(){
 const v=$("eRecordScroll");
 if(v&&!state.eventHistoryBusy&&v.scrollHeight-v.scrollTop-v.clientHeight<170)
  void loadMoreEventSignals();
}
function event(e,ledger){
 if(e?.decisionReviewVersion!==EVENT10_FREQ_OPTIMIZED_VERSION)
  throw Error("十分钟服务尚未确认运行最新版信号策略，旧版统计不会显示");
 const currentLedger=ledger?.version===EVENT10_FREQ_OPTIMIZED_VERSION&&Array.isArray(ledger.records);
 if(!currentLedger)throw Error("新策略历史接口未就绪，旧版记录不予回填");
 const s=currentEventRecord(e);
 // The status fallback is safe only after verifying the server's strategy version.
 const stats=ledger.stats||{};
 const records=currentLedger?mergeEventRecords(ledger):[];
 const active=!!e.active&&eventVersion(e.active)===EVENT10_FREQ_OPTIMIZED_VERSION;
 put("eSignal",dir(s?.direction||null));
 put("ePhase",s?.status||"暂无新版信号");
 const validDirections=stats.validDirections??stats.total??"—";
 put("eCounts",validDirections+" / "+(stats.proxySettled??"—"));
 const accuracy=pct(stats.proxyHits,stats.proxySettled);
 const servicePct=typeof stats.proxyAccuracyPct==="number"&&Number.isFinite(stats.proxyAccuracyPct)?stats.proxyAccuracyPct:null;
 const proxyDisplay=accuracy!=="—"?accuracy:(servicePct!==null?servicePct.toFixed(1)+"%":"—（新版暂无已核对样本）");
 put("eProxyAccuracy",proxyDisplay);
 const audit=e.scanDiagnostics?.lastHour;
 const produced=(audit?.strictSignals||0)+(audit?.standardSignals||0);
 put("eScanAudit",audit?"最近1小时检查 "+audit.checks+"次，产生方向信号 "+produced+"条，无信号 "+audit.noSignal+"次，数据异常 "+audit.dataErrors+"次。":"当前暂无扫描统计。");
 const reasons={trend5m:"5分钟趋势",trend1m:"1分钟趋势",momentum:"动量",structure:"K线结构",volume:"成交量",rsi:"RSI",persistence15m:"15分钟趋势",bounceGuard:"看跌反弹风险",V11_MIN_SIGNAL_GAP:"4分钟信号间隔"};
 const reasonList=Object.entries(audit?.byReason||{}).sort((a,b)=>b[1]-a[1]).slice(0,6);
 put("eScanGates",reasonList.length?"未通过的主要条件："+reasonList.map(([k,v])=>(reasons[k]||k)+" "+v+"次").join("、")+"（一次检测可有多项不通过）":"本小时暂无拒绝原因。");
 const lastScan=e.lastSuccessfulScanAt,elapsed=Number.isFinite(lastScan)?Math.round((Date.now()-lastScan)/1000):null;
 put("eFreshness",elapsed!==null&&elapsed>=0&&elapsed<=90?"最近有效行情扫描 "+elapsed+"秒前 · "+stamp(lastScan):"行情扫描新鲜度未确认；请检查后台连接");

 const review=s?.aiReview||e?.lastCheck?.aiReview||null;
 const outcomes=e?.aiReviewStats||{};
 put("eAiReview","AI 方向复核："+(
   e?.aiInProgress?"AI高强度分析正在进行，等待完整结果，请勿重复点击":
   review?.analysisCompleted===true&&review?.status==="AI_REVIEWED"?"完整分析已通过校验（高强度思考）":
   review?.status==="AI_INCOMPLETE_FALLBACK"||review?.status==="AI_FALLBACK"?"AI分析未完成，本轮无信号（不计胜率）":
   review?.status==="NO_KEY_OR_DISABLED"?"AI未运行，本轮无信号":
   e?.aiInProgress?"高强度思考进行中，暂未给出完整AI结论":
   e?.aiReviewConfigured?"已就绪，等待符合条件的信号":"尚未启用")+
   " · "+(e?.aiReviewModel||"—")+
   " · 成功 "+(outcomes.reviewed||0)+" / "+(outcomes.calls||0)+" 次"+
   " · 已结算失败 "+(e?.aiLearningProfile?.lossCount||0)+" 条 / 参考 "+(e?.aiLearningProfile?.settledSamples||0)+" 条，供下次经验复盘（非模型权重训练）");
 put("eReason",s?.direction?(s?.reason||"方向已确认；10分钟后核验。"):
   (s?.reason||"当前没有符合规则的方向信号。"));
 pill("eStatus",e.configured===true?"good":"bad",active?"新版信号待核对":e.configured===true?"就绪":"未就绪");
 if(currentLedger){
  updateEventHistory(ledger);
 }else if(state.eventRecords.length){
  state.eventHistoryError="无法刷新，已加载记录仍然可看";
  drawEventHistory();
 }else{
  put("eTotal","新版记录接口暂不可用");
  put("eRecordStatus","服务暂不可用，已存记录不会丢失");
  $("eRecords").replaceChildren(node("div","mini","记录暂时无法读取，请稍后重试"));
 }
 $("manualCheck").disabled=e.configured!==true||state.manualBusy;
}
function eventError(error){
 state.eventHistoryError="状态读取失败，已加载记录仍然保留";
 drawEventHistory();
 pill("eStatus","bad","暂不可用");
 for(const id of ["eSignal","ePhase","eCounts","eProxyAccuracy","eScanAudit","eScanGates","eFreshness","eAiReview"])put(id,"不可用");
 put("eReason","EVENT10状态读取失败："+String(error).slice(0,130)+"。请进入原信号控制台核实。");
 if(!state.eventRecords.length){
  put("eTotal","记录接口暂时不可用");
  put("eRecordStatus","数据未能读取，不能判断为空");
  $("eRecords").replaceChildren(node("div","mini","连接异常，稍后重试"));
 }
 $("manualCheck").disabled=true;
}
// Only EVENT10 status contributes to the App connection indicator.
function refreshConnectionBadge(){
 $("healthDot").className="dot "+(state.eventOnline?"up":"down");
 put("healthText",state.eventOnline?"信号服务已连接":"信号服务连接异常");
}
async function refreshEvent10Only(){
 if(state.eventRefreshBusy||document.hidden)return;
 state.eventRefreshBusy=true;
 try{
  const [er,lr]=await Promise.allSettled([
   api("/event10/api/status",3500),
   api("/event10/api/signals?limit="+state.eventPageSize+"&offset=0",4500)
  ]);
  const e=er.status==="fulfilled"?er.value:null;
  const ledger=lr.status==="fulfilled"?lr.value:null;
  // Adopt a new strategy only after status and ledger agree on the same version.
  const currentVersion=e?.decisionReviewVersion;
  if(typeof currentVersion==="string"&&/^EVENT10_[A-Z0-9_]{8,100}$/.test(currentVersion)&&
     ledger?.version===currentVersion&&Array.isArray(ledger.records)&&
     currentVersion!==EVENT10_FREQ_OPTIMIZED_VERSION){
    EVENT10_FREQ_OPTIMIZED_VERSION=currentVersion;
    state.eventRecords=[];state.lastEvent=[];state.eventTotal=0;
    state.eventHistorySignature="";state.eventHistoryError=null;
  }
  try{if(e)event(e,ledger);else throw er.reason||Error("无数据");}
  catch(err){eventError(err);}
  const currentLedger=ledger?.version===EVENT10_FREQ_OPTIMIZED_VERSION;
  const currentService=e?.decisionReviewVersion===EVENT10_FREQ_OPTIMIZED_VERSION;
  state.eventOnline=Boolean(e&&currentLedger&&currentService);
  refreshConnectionBadge();
 }finally{state.eventRefreshBusy=false;}
}
async function refresh(){
 if(state.busy||document.hidden)return;
 state.busy=true;
 try{await refreshEvent10Only();}
 finally{state.busy=false;}
}

/**
 * The APK is a stable shell. Public UI/JS is delivered via authenticated,
 * no-store HTTPS from Alibaba. Poll a release marker, never exchange APIs.
 * Only auto-activate on return to foreground; don't interrupt manual checks.
 */
async function checkHotUpdate(onReturn=false){
 try{
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);
  let response;
  try{response=await fetch("/app/version.json",{cache:"no-store",credentials:"same-origin",
    headers:{"Accept":"application/json","Cache-Control":"no-cache"},signal:controller.signal});}
  finally{clearTimeout(timeout);}
  if(!response.ok)throw Error("HTTP "+response.status);
  const meta=await response.json();
  if(!meta||typeof meta.commit!=="string"||!/^[a-f0-9]{40}$/.test(meta.commit))throw Error("INVALID_VERSION");
  put("appBuildVersion","v"+APP_VERSION+" · "+APP_DEPLOY_SHA.slice(0,8));
  if(meta.commit===APP_DEPLOY_SHA){
   $("hotUpdateBanner").hidden=true;
   put("appUpdateState","已经是最新网页版本 · 无须更新APK");
   return;
  }
  if(onReturn&&!state.manualBusy&&!state.busy){window.location.reload();return;}
  $("hotUpdateBanner").hidden=false;
  put("hotUpdateText","发现新版网页功能 · 点击刷新即可使用，不需要卸载或重装");
  put("appUpdateState","检测到新版本："+meta.commit.slice(0,8)+" · 等待应用");
 }catch(error){
  // An offline/version-service error must never hide trading signal data.
  put("appUpdateState","热更新检查暂不可用，现有页面继续运行");
 }
}
function navigate(page){
 for(const el of document.querySelectorAll(".section-panel"))el.classList.toggle("active",el.id==="panel-"+page);
 for(const el of document.querySelectorAll(".tab"))el.classList.toggle("selected",el.dataset.go===page);
 history.replaceState(null,"","#"+page);
 window.scrollTo({top:0,behavior:"instant"});
}
for(const btn of document.querySelectorAll("[data-go]"))btn.addEventListener("click",()=>navigate(btn.dataset.go));
$("refresh").addEventListener("click",()=>void refresh());
$("eRecordScroll").addEventListener("scroll",onEventHistoryScroll,{passive:true});
$("hotUpdateButton").addEventListener("click",()=>window.location.reload());
$("manualCheck").addEventListener("click",async()=>{
 if(state.manualBusy)return;
 state.manualBusy=true;$("manualCheck").disabled=true;
 const result=$("manualResult");
 result.hidden=false;result.textContent="正在检测实时行情；符合信号条件时，AI会进行高强度思考及完整性校验，可能需要数十秒。未完成前不会标记AI分析成功…";
 try{
  const requestId=crypto.randomUUID();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),90000);
  let res;
  try{
   res=await fetch("/event10/api/start",{method:"POST",credentials:"same-origin",
    cache:"no-store",headers:{"X-Event10-Action":"manual-open","X-Event10-Request-Id":requestId,
    "Accept":"application/json"},signal:controller.signal});
  }finally{clearTimeout(timer);}
  const data=await res.json();
  if(!res.ok||data.ok!==true)throw Error(data.error||"HTTP "+res.status);
  result.textContent=data.session?.aiReview?.analysisCompleted===true?"AI高强度分析已完成并通过校验；请查看本轮方向。":"检查已结束；AI未完成时本轮无信号，不显示UP/DOWN，不会触发信号提醒。";
  await refreshEvent10Only();
 }catch(err){
  result.textContent="检测未确认："+String(err).slice(0,180)+"。请先核实当前状态，避免重复点击。";
 }finally{state.manualBusy=false;$("manualCheck").disabled=false;}
});
document.addEventListener("visibilitychange",()=>{
 if(!document.hidden){
  void checkHotUpdate(true);
  void refresh();
 }
});
const initial=location.hash.replace("#","");
navigate(["event10","more"].includes(initial)?initial:"event10");
void refresh();
void checkHotUpdate();
setInterval(()=>void refresh(),10000);
// On the 10-minute screen, show server-confirmed signals in around 3s while visible.
// Native Android notification service works independently when this page is hidden.
setInterval(()=>{if(location.hash==="#event10")void refreshEvent10Only();},3000);
setInterval(()=>{if(!document.hidden)void checkHotUpdate();},60000);
if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("/app/sw.js",{scope:"/app/"}).catch(()=>{}));

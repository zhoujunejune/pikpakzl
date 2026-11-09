/* ZL EVENT10-only app — browser-only client; no exchange credentials or order calls. */
"use strict";
const APP_DEPLOY_SHA="__ZL_APP_RELEASE_SHA__"; // Replaced with immutable commit SHA at Alibaba deployment.
const APP_VERSION="1.3.8"; // Stable signal + on-device manual real-trade journal.
const $=id=>document.getElementById(id);
const state={busy:false,manualBusy:false,lastEvent:[],eventRecords:[],eventTotal:0,eventPageSize:25,eventHistoryBusy:false,eventHistorySignature:'',homeHistorySignature:'',eventHistoryError:null,eventRefreshBusy:false,eventOnline:false,eventLedgerOnline:false,eventLastStatus:null,eventLastStatusAt:null,eventLastError:null,eventEpoch:0,eventFetchController:null,eventRetryTimer:null,eventRetryDelayMs:1200,eventLastResumeAt:0,eventLifecycle:"foreground"};
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
// A WebView may abort an in-flight fetch when switching to another app.
// Distinguish that expected lifecycle cancellation from an actual server error.
function isExpectedCancellation(error){
 const text=String(error?.message||error||"").toLowerCase();
 return error?.name==="AbortError"||error?.name==="TimeoutError"||
   text.includes("aborted")||text.includes("aborterror")||
   text.includes("cancelled")||text.includes("canceled");
}
async function api(url,timeout=6500,lifecycleSignal=null){
 const controller=new AbortController();
 const cancel=()=>controller.abort();
 if(lifecycleSignal?.aborted){
  const error=new Error("PAGE_BACKGROUNDED");error.name="AbortError";throw error;
 }
 if(lifecycleSignal)lifecycleSignal.addEventListener("abort",cancel,{once:true});
 let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
 try{
  const res=await fetch(url,{cache:"no-store",credentials:"same-origin",signal:controller.signal,
   headers:{"Accept":"application/json"}});
  if(!res.ok)throw Error("HTTP "+res.status);
  const value=await res.json();
  if(!value||value.ok!==true)throw Error("服务响应无效");
  return value;
 }catch(error){
  // Don't show Android WebView's misleading "signal is aborted without reason".
  if(lifecycleSignal?.aborted){
   const expected=new Error("PAGE_BACKGROUNDED");expected.name="AbortError";throw expected;
  }
  if(timedOut)throw Error("请求超时，请检查网络");
  if(isExpectedCancellation(error))throw Error("网络请求被中断，请重新连接");
  throw error;
 }finally{
  clearTimeout(timer);
  if(lifecycleSignal)lifecycleSignal.removeEventListener("abort",cancel);
 }
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
 const homeSignature=eventHistoryFingerprint(state.eventRecords.slice(0,2));
 if(homeSignature!==state.homeHistorySignature){
  renderRecords("eHomeRecords",state.eventRecords.slice(0,2));
  state.homeHistorySignature=homeSignature;
 }
 put("eHomeTotal",state.eventTotal);
 const recentSettled=state.eventRecords.filter(x=>typeof x.proxyHit==="boolean").slice(0,10);
 const lastTen=recentSettled.length?recentSettled.filter(x=>x.proxyHit===true).length+"/"+recentSettled.length:"—";
 put("eLastTen",lastTen);
 put("eLastTenDetail",lastTen);
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
    !$("panel-records").classList.contains("active"))return;
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
 // Live rule direction must NEVER be blocked by optional signal-history paging.
 // A missing/mismatched ledger is NOT a service outage; it must not repopulate old rows.
 const s=currentEventRecord(e);
 // The status fallback is safe only after verifying the server's strategy version.
 const stats=(currentLedger?ledger?.stats:e?.stats)||{};
 const records=currentLedger?mergeEventRecords(ledger):[];
 const active=!!e.active&&eventVersion(e.active)===EVENT10_FREQ_OPTIMIZED_VERSION;
 const direction=s?.direction==="UP"||s?.direction==="DOWN"?s.direction:null;
 put("eSignal",direction?dir(direction):"等待新信号");
 $("eHero").dataset.direction=direction||"WAIT";
 put("ePhase",direction?"V19 纯规则 · "+(s?.status||"方向已确认"):
   "V19 纯规则 · "+(e.configured?"正在监控 BTC 行情":"服务未就绪"));
 const validDirections=stats.validDirections??stats.total??"—";
 put("eCounts",validDirections+" / "+(stats.proxySettled??"—"));
 const accuracy=pct(stats.proxyHits,stats.proxySettled);
 const servicePct=typeof stats.proxyAccuracyPct==="number"&&Number.isFinite(stats.proxyAccuracyPct)?stats.proxyAccuracyPct:null;
 const proxyDisplay=accuracy!=="—"?accuracy:(servicePct!==null?servicePct.toFixed(1)+"%":"—（新版暂无已核对样本）");
 put("eProxyAccuracy",proxyDisplay);
 put("eProxyAccuracyDetail",proxyDisplay);
 put("eHomeTotal",validDirections);
 const audit=e.scanDiagnostics?.lastHour;
 const produced=(audit?.strictSignals||0)+(audit?.standardSignals||0);
 put("eScanAudit",audit?"最近1小时检查 "+audit.checks+"次，产生方向信号 "+produced+"条，无信号 "+audit.noSignal+"次，数据异常 "+audit.dataErrors+"次。":"当前暂无扫描统计。");
 const reasons={trend5m:"5分钟趋势",trend1m:"1分钟趋势",momentum:"动量",structure:"K线结构",volume:"成交量",rsi:"RSI",persistence15m:"15分钟趋势",bounceGuard:"看跌反弹风险",V11_MIN_SIGNAL_GAP:"4分钟信号间隔"};
 const reasonList=Object.entries(audit?.byReason||{}).sort((a,b)=>b[1]-a[1]).slice(0,6);
 put("eScanGates",reasonList.length?"未通过的主要条件："+reasonList.map(([k,v])=>(reasons[k]||k)+" "+v+"次").join("、")+"（一次检测可有多项不通过）":"本小时暂无拒绝原因。");
 const lastScan=e.lastSuccessfulScanAt,elapsed=Number.isFinite(lastScan)?Math.round((Date.now()-lastScan)/1000):null;
 put("eFreshness",elapsed!==null&&elapsed>=0&&elapsed<=90?"最近有效行情扫描 "+elapsed+"秒前 · "+stamp(lastScan):"行情扫描新鲜度未确认；请检查后台连接");

 put("eAiReview","信号来源：纯规则 V19 · 不调用AI · 仍按原有技术指标筛选并进行5分钟EMA方向校正。");
 put("eReason",s?.direction?(s?.reason||"方向已确认；10分钟后核验。"):
   (s?.reason||"当前没有符合规则的方向信号。"));
 pill("eStatus",e.configured===true?"good":"bad",active?"信号待核对":e.configured===true?(currentLedger?"已连接":"已连接·记录同步中"):"服务未就绪");
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
 for(const id of ["eSignal","ePhase","eCounts","eProxyAccuracy","eProxyAccuracyDetail","eHomeTotal","eLastTen","eLastTenDetail","eScanAudit","eScanGates","eFreshness","eAiReview"])put(id,"不可用");
 $("eHero").dataset.direction="WAIT";
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
 put("healthText",state.eventOnline?"已连接":"连接异常");
 put("eMiniConnection",state.eventOnline?"● 已连接":"● 连接异常");
 const live=$("eConnectionDetail");
 if(live){
  const t=state.eventLastStatusAt;
  live.textContent=state.eventOnline?
   ("实时信号接口正常 · 最近成功 "+stamp(t)+(state.eventLedgerOnline?"":" · 历史接口稍后重试")):
   ("无法读取最新信号"+(state.eventLastError?"："+state.eventLastError:"")+"；不会将连接故障误判为无信号");
 }
}
// Cancel stale requests when Android suspends the page. This also unblocks
// the next foreground request instead of waiting for the old 9s/11s timeout.
function cancelEventRefresh(){
 state.eventEpoch++;
 if(state.eventFetchController)state.eventFetchController.abort();
 state.eventFetchController=null;
 state.eventRefreshBusy=false;
 state.busy=false;
}
function clearEventRetry(){
 if(state.eventRetryTimer!==null)clearTimeout(state.eventRetryTimer);
 state.eventRetryTimer=null;
 state.eventRetryDelayMs=1200;
}
function scheduleEventRetry(){
 if(document.hidden||state.eventRetryTimer!==null)return;
 const delay=state.eventRetryDelayMs;
 state.eventRetryDelayMs=Math.min(12000,Math.round(delay*1.8));
 state.eventRetryTimer=setTimeout(()=>{
  state.eventRetryTimer=null;
  if(!document.hidden)void refreshEvent10Only();
 },delay);
}
async function refreshEvent10Only(){
 if(state.eventRefreshBusy||document.hidden)return;
 const epoch=++state.eventEpoch;
 const controller=new AbortController();
 state.eventFetchController=controller;
 state.eventRefreshBusy=true;
 let service=null,serviceError=null;
 const outdated=()=>epoch!==state.eventEpoch||controller.signal.aborted||document.hidden;
 try{
  // Live status is primary; optional history must not block current signals.
  try{
   service=await api("/event10/api/status",9000,controller.signal);
   if(outdated())return;
   const version=service?.decisionReviewVersion;
   if(typeof version!=="string"||!/^EVENT10_[A-Z0-9_]{8,100}$/.test(version))
     throw Error("服务返回的策略版本无效");
   if(version!==EVENT10_FREQ_OPTIMIZED_VERSION){
    EVENT10_FREQ_OPTIMIZED_VERSION=version;
    state.eventRecords=[];state.lastEvent=[];state.eventTotal=0;
    state.eventHistorySignature="";state.homeHistorySignature="";state.eventHistoryError=null;
    state.eventLedgerOnline=false;
   }
   state.eventOnline=true;state.eventLastError=null;
   state.eventLastStatus=service;state.eventLastStatusAt=Date.now();
   event(service,null);
   refreshConnectionBadge();
   clearEventRetry();
  }catch(error){
   if(outdated())return; // Intentional Android backgrounding is not a disconnect.
   service=null;serviceError=String(error?.message||error).slice(0,105);
   state.eventOnline=false;state.eventLedgerOnline=false;
   state.eventLastError=serviceError;
   if(state.eventLastStatus?.decisionReviewVersion===EVENT10_FREQ_OPTIMIZED_VERSION){
    event(state.eventLastStatus,null);
    put("eReason","最新信号刷新未成功："+serviceError+"；正在重连。当前显示历史快照，不代表实时方向。");
    pill("eStatus","bad","重新连接中·历史快照");
   }else eventError(serviceError);
   refreshConnectionBadge();
   scheduleEventRetry();
  }
  if(!service||outdated())return;
  try{
   const ledger=await api("/event10/api/signals?limit="+state.eventPageSize+"&offset=0",11000,controller.signal);
   if(outdated())return;
   if(ledger?.version!==EVENT10_FREQ_OPTIMIZED_VERSION||!Array.isArray(ledger.records))
    throw Error("历史接口策略版本不一致");
   state.eventLedgerOnline=true;
   state.eventHistoryError=null;
   event(service,ledger);
  }catch(error){
   if(outdated())return;
   state.eventLedgerOnline=false;
   state.eventHistoryError="历史记录暂未同步："+String(error?.message||error).slice(0,100);
   drawEventHistory();
  }
  if(!outdated())refreshConnectionBadge();
 }finally{
  // An old aborted request must not unlock a NEW foreground refresh.
  if(epoch===state.eventEpoch){
   state.eventRefreshBusy=false;
   state.eventFetchController=null;
  }
 }
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
  // Never auto-reload on Android foreground resume: reloading while requests
  // are recovering is the main cause of aborted fetches and stale UI badges.
  // Still show an explicit hot-update button so new code can be applied safely.
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
 if(page==="records")void loadMoreEventSignals();
 if(page==="stats"||page==="event10")refreshTradeJournal();
 history.replaceState(null,"","#"+page);
 window.scrollTo({top:0,behavior:"instant"});
}
// Native Android background poller alone owns alarm-direction inversion.
// Use only a boolean bridge, never persist an imitation toggle in the web PWA.
function configureReverseAlertSetting(){
 const toggle=$("reverseAlertToggle");
 const status=$("reverseAlertState");
 if(!toggle||!status)return;
 const bridge=window.HaipaiAlertPrefs;
 if(!bridge||typeof bridge.getReverseAlertsEnabled!=="function"||
    typeof bridge.setReverseAlertsEnabled!=="function"){
  toggle.checked=false;
  toggle.disabled=true;
  status.textContent="当前网页环境不支持原生信号反向提醒。请安装海派事件合约 v1.3.5 或更新安卓安装包。";
  return;
 }
 try{
  toggle.checked=Boolean(bridge.getReverseAlertsEnabled());
  toggle.disabled=false;
  status.textContent=toggle.checked?
   "已开启：仅手机通知和悬浮弹窗反向；原始规则信号与胜率不变。":
   "已关闭：手机提醒原始规则方向。";
 }catch(error){
  toggle.checked=false;
  toggle.disabled=true;
  status.textContent="本机开关读取失败，未修改原始信号。";
  return;
 }
 toggle.addEventListener("change",()=>{
  const previous=!toggle.checked;
  const next=toggle.checked;
  try{
   if(bridge.setReverseAlertsEnabled(next)!==true)throw Error("保存失败");
   toggle.checked=Boolean(bridge.getReverseAlertsEnabled());
   if(toggle.checked!==next)throw Error("保存验证失败");
   status.textContent=next?
    "反向提醒已开启：UP提醒DOWN，DOWN提醒UP（只影响之后的新提醒）。":
    "反向提醒已关闭：后续提醒与模型方向相同。";
  }catch(error){
   toggle.checked=previous;
   status.textContent="保存本机提醒设置失败，请重试；模型信号没有改变。";
  }
 });
}

// User-declared actual trade tally, kept in native Android preferences.
// Never infer completed trades from strategy signals or send trades to the server.
let tradeActionBusy=false;
function realTradeBridge(){
 const bridge=window.HaipaiRealTrades;
 return bridge&&typeof bridge.getSnapshot==="function"&&
  typeof bridge.confirmRealTrade==="function"&&typeof bridge.undoLastToday==="function"
  ?bridge:null;
}
function tradeNotice(text){put("tradeJournalNotice",text);}
function applyTradeJournal(data,notice=""){
 if(!data||data.ok!==true||!/^\\d{4}-\\d{2}-\\d{2}$/.test(data.date)||
    !Number.isSafeInteger(data.count)||data.count<0)throw Error("INVALID_TRADE_JOURNAL");
 put("tradeTodayDate","北京时间 "+data.date);
 put("tradeTodayCount",String(data.count));
 put("tradeLimitState",data.count>=10?"已达每天10单目标上限":"目标≤10单/天");
 const add=$("tradeRecordButton"),undo=$("tradeUndoButton");
 add.disabled=tradeActionBusy;
 undo.disabled=tradeActionBusy||!data.canUndo;
 tradeNotice(notice||(data.count>=10?
  "已登记 "+data.count+" 单 · 建议今天停止交易":"已登记 "+data.count+" 单 · 本机保存"));
 const history=$("tradeHistoryList");
 history.replaceChildren();
 for(const entry of (Array.isArray(data.history)?data.history:[])){
  if(!entry||typeof entry.date!=="string"||!Number.isSafeInteger(entry.count))continue;
  const row=node("div","trade-history-row");
  row.append(node("span","",entry.date),node("strong","",entry.count+" 单"));
  history.append(row);
 }
 if(!history.childNodes.length)history.append(node("div","mini","暂无手动交易记录"));
}
function refreshTradeJournal(){
 if(tradeActionBusy)return;
 const bridge=realTradeBridge();
 if(!bridge){
  $("tradeRecordButton").disabled=true;
  $("tradeUndoButton").disabled=true;
  put("tradeTodayCount","—");
  tradeNotice("仅正式安卓 App 支持本机记录，请升级安装包");
  put("tradeHistoryList","当前浏览器不支持手机本地交易计数");
  return;
 }
 try{applyTradeJournal(JSON.parse(bridge.getSnapshot()));}
 catch(error){
  $("tradeRecordButton").disabled=true;
  $("tradeUndoButton").disabled=true;
  tradeNotice("本机记录读取失败，已停止登记，请检查 App");
 }
}
function doTradeJournalAction(action){
 const bridge=realTradeBridge();
 if(tradeActionBusy||!bridge)return;
 tradeActionBusy=true;
 $("tradeRecordButton").disabled=true;
 $("tradeUndoButton").disabled=true;
 try{
  const reply=JSON.parse(action==="add"?bridge.confirmRealTrade():bridge.undoLastToday());
  if(reply?.ok!==true){
   const messages={DUPLICATE_TAP:"已忽略短时间重复点击，次数未增加",
    NOTHING_TO_UNDO:"今天没有可撤销的登记",SAVE_FAILED:"保存失败，未确认计数",
    UNDO_FAILED:"撤销失败，请核对计数"};
   const message=messages[reply?.error]||"登记未成功，请核对后重试";
   tradeActionBusy=false;
   refreshTradeJournal();
   tradeNotice(message);
   return;
  }
  tradeActionBusy=false;
  applyTradeJournal(reply,action==="add"?"登记成功 · 今日第 "+reply.count+" 单":
   "已撤销最后一笔 · 今日 "+reply.count+" 单");
 }catch(error){
  tradeActionBusy=false;
  refreshTradeJournal();
  tradeNotice("操作未确认，请核对计数，勿连续点击");
 }
}
$("tradeRecordButton").addEventListener("click",()=>doTradeJournalAction("add"));
$("tradeUndoButton").addEventListener("click",()=>doTradeJournalAction("undo"));
refreshTradeJournal();

for(const btn of document.querySelectorAll("[data-go]"))btn.addEventListener("click",()=>navigate(btn.dataset.go));
configureReverseAlertSetting();
$("refresh").addEventListener("click",()=>void refresh());
$("eRecordScroll").addEventListener("scroll",onEventHistoryScroll,{passive:true});
$("hotUpdateButton").addEventListener("click",()=>window.location.reload());
$("manualCheck").addEventListener("click",async()=>{
 if(state.manualBusy)return;
 state.manualBusy=true;$("manualCheck").disabled=true;
 const result=$("manualResult");
 result.hidden=false;result.textContent="正在获取行情并检查现有规则条件，符合条件立即给出方向（不调用AI）。";
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
  result.textContent=data.session?.direction==="UP"?"规则判断完成：看涨 UP。":data.session?.direction==="DOWN"?"规则判断完成：看跌 DOWN。":"规则检查结束：当前条件不满足，未产生信号。";
  await refreshEvent10Only();
 }catch(err){
  result.textContent="检测未确认："+String(err).slice(0,180)+"。请先核实当前状态，避免重复点击。";
 }finally{state.manualBusy=false;$("manualCheck").disabled=false;}
});
// Android reliably calls the native entrypoint onResume; browsers also fire
// visibilitychange/pageshow/focus. Debounce duplicate foreground notifications.
function foregroundResume(source="foreground"){
 if(document.hidden)return;
 const now=Date.now();
 if(now-state.eventLastResumeAt<500)return;
 state.eventLastResumeAt=now;
 state.eventLifecycle=source;
 refreshTradeJournal();
 cancelEventRefresh();
 clearEventRetry();
 pill("eStatus","",state.eventLastStatus?"正在恢复实时连接":"正在连接信号服务");
 put("eConnectionDetail","已返回应用，正在重新同步最新信号…");
 void refreshEvent10Only();
 void checkHotUpdate(true);
}
window.ZLForegroundResume=foregroundResume;
document.addEventListener("visibilitychange",()=>{
 if(document.hidden){
  state.eventLifecycle="background";
  cancelEventRefresh();
  clearEventRetry();
 }else foregroundResume("visibility");
});
window.addEventListener("pageshow",event=>{
 if(event.persisted)foregroundResume("pageshow");
});
window.addEventListener("focus",()=>foregroundResume("focus"));
window.addEventListener("online",()=>foregroundResume("network-online"));
const initial=location.hash.replace("#","");
navigate(["event10","stats","records","more"].includes(initial)?initial:"event10");
void refresh();
void checkHotUpdate();
setInterval(()=>void refresh(),10000);
// Date changes at Beijing midnight; no change to the remote V19 model or signal polling.
setInterval(()=>{if(!document.hidden)refreshTradeJournal();},60000);
// On the 10-minute screen, show server-confirmed signals in around 3s while visible.
// Native Android notification service works independently when this page is hidden.
setInterval(()=>{if(location.hash==="#event10")void refreshEvent10Only();},3000);
setInterval(()=>{if(!document.hidden)void checkHotUpdate();},60000);
if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("/app/sw.js",{scope:"/app/"}).catch(()=>{}));

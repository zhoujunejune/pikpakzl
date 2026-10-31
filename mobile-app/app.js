/* ZL unified phone app — browser-only client, never receives exchange credentials. */
"use strict";
const APP_DEPLOY_SHA="__ZL_APP_RELEASE_SHA__"; // Replaced with immutable commit SHA at Alibaba deployment.
const $=id=>document.getElementById(id);
const state={busy:false,manualBusy:false,lastGuardian:[],lastEvent:[],timer:null};
const EVENT10_FREQ_OPTIMIZED_VERSION="EVENT10_FREQ_OPTIMIZED_6GATES_V2_20261101";
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
function setHeading(id,direction){
 const el=$(id);if(!el)return;
 el.textContent=dir(direction);
 el.className="v "+(direction==="UP"?"uptext":direction==="DOWN"?"downtext":"");
}
function node(tag,cls,t){
 const el=document.createElement(tag);
 if(cls)el.className=cls;
 if(t!==undefined)el.textContent=String(t);
 return el;
}
function renderRecords(id,items,kind){
 const root=$(id);root.replaceChildren();
 if(!items.length){
  root.append(node("div","mini","暂无可核实的已保存信号记录。"));
  return;
 }
 for(const r of items.slice(0,12)){
  const d=kind==="guardian"?r.predictedDirection:r.direction;
  const wrap=node("div","record"),head=node("div","record-head");
  const version=kind==="event10"?(r.strategyVersion||r.decisionReviewVersion||r.ruleChecks?.strategyVersion):null;
  const edition=version===EVENT10_FREQ_OPTIMIZED_VERSION?"六项频率优化策略":"旧版信号";
  const title=node("div","record-title",kind==="event10"?dir(d)+" · "+edition:dir(d));
  if(d==="UP")title.classList.add("uptext");
  if(d==="DOWN")title.classList.add("downtext");
  const when=kind==="guardian"?(r.at||r.round):(r.openedAt||r.checkedAt);
  head.append(title,node("span","mini",stamp(when)));
  wrap.append(head);
  let outcome="待10分钟核对";
  if(kind==="guardian"&&r.status==="SETTLED")outcome=r.hit===true?"官方方向命中":r.hit===false?"官方方向未命中":"状态待核实";
  if(kind==="event10"){
   if(typeof r.proxyHit==="boolean")outcome=r.proxyHit?"指数代理命中":"指数代理未命中";
   else if(r.settlementStatus==="UNVERIFIABLE_PRICE_NEAR_EXPIRY")outcome="到期数据不足，未核验";
   else if(r.proxyOutcome==="FLAT")outcome="指数持平（不计命中率）";
  }
  const desc=kind==="guardian"?
    ("轮次 "+stamp(r.round)+" · "+outcome+" · "+(r.subjectiveConfidence==null?"置信度未提供":"模型主观置信度 "+Math.round(100*Number(r.subjectiveConfidence))+"%")):
    (outcome+" · "+(r.status||"已保存")+" · 非实际事件订单");
  wrap.append(node("div","record-note",desc));
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
function guardian(g,t){
 if(!g||g.model!=="ZL_GUARDIAN_5M_V1")throw Error("GUARDIAN模型不匹配");
 const records=Array.isArray(g.records)?g.records:[],m=g.stats||{};
 const current=records.find(x=>Number(x.round)===Number(g.round));
 const direction=current?.predictedDirection||g.latest?.direction;
 setHeading("gDirection",direction);
 put("gSignal",dir(direction));
 put("gRound",stamp(g.round));
 put("gCounts",(m.shadowPredictions??"—")+" / "+(m.settled??"—"));
 put("gAccuracy",pct(m.correct,m.settled));
 put("gReason",(g.latest?.reason||"暂无分析说明")+(g.error?"；错误："+String(g.error).slice(0,120):""));
 state.lastGuardian=records;
 renderRecords("gRecords",records.slice().sort((a,b)=>Number(b.round)-Number(a.round)),"guardian");
 pill("gBadge","good","分析可用");
 pill("gStatus","good","已连接");
 if(!t||t.ok!==true){
  put("gFollow","状态未知");put("gFollowLong","状态接口不可用");
  put("gOrder","未获取");put("gOrderFull","—");put("gError","生产状态读取失败");
  return;
 }
 const follow=t.enabled===true?"已开启":t.enabled===false?"已关闭":"未知";
 put("gFollow",follow);put("gFollowLong",follow);
 const order=t.pendingAction||t.lastOrder||null;
 const orderState=order?.state||"暂无可核实记录";
 put("gOrder",orderState);
 put("gOrderFull",order?(String(orderState)+(order.round?" · "+stamp(order.round):"")):"暂无可核实记录");
 put("gError",order?.blockReason||order?.error||t.lastError||"接口没有报告当前阻断原因");
}
function guardianError(error){
 pill("gBadge","bad","连接异常");pill("gStatus","bad","暂不可用");
 put("gReason","GUARDIAN数据读取失败："+String(error).slice(0,130)+"。请进入原交易控制台核实。");
 for(const id of ["gDirection","gSignal","gAccuracy","gFollow","gFollowLong","gOrder","gOrderFull","gError","gRound","gCounts"])put(id,"不可用");
 $("gRecords").replaceChildren(node("div","mini","当前未能读取信号数据，不能据此判断没有信号。"));
}
function currentEventRecord(e){
 const a=e.active||null;
 const b=e.lastCheck||null;
 const c=e.lastSession||null;
 return a||((Number(b?.checkedAt||b?.openedAt||0)>=Number(c?.openedAt||0))?b:c)||null;
}
function eventVersion(r){
 return r?.strategyVersion||r?.decisionReviewVersion||r?.ruleChecks?.strategyVersion||null;
}
function mergeEventRecords(ledger,historyData){
 const rows=new Map();
 for(const r of (Array.isArray(historyData?.records)?historyData.records:[])){
  if(!r||!["UP","DOWN"].includes(r.direction)||!Number.isFinite(r.openedAt)||!r.id)continue;
  rows.set(r.id,r);
 }
 // Ledger authoritative for duplicate IDs.
 for(const r of (Array.isArray(ledger?.records)?ledger.records:[])){
  if(!r||!["UP","DOWN"].includes(r.direction)||!Number.isFinite(r.openedAt)||!r.id)continue;
  rows.set(r.id,r);
 }
 return Array.from(rows.values()).sort((a,b)=>b.openedAt-a.openedAt);
}
function event(e,ledger,historyData){
 const s=currentEventRecord(e);
 const stats=ledger?.stats||e.strategyStats||{};
 const records=mergeEventRecords(ledger,historyData);
 const legacy=records.filter(r=>eventVersion(r)!==EVENT10_FREQ_OPTIMIZED_VERSION);
 const oldSignal=!!s&&["UP","DOWN"].includes(s.direction)&&eventVersion(s)!==EVENT10_FREQ_OPTIMIZED_VERSION;
 const direction=s?.direction||null;
 setHeading("eDirection",direction);put("eSignal",dir(direction));
 put("ePhase",(oldSignal?"旧策略 · ":"")+(s?.status||"尚无已保存状态"));
 put("eActive",e.active?(oldSignal?"旧信号等待核对":"新信号等待核对"):"待机");
 put("eCount",stats.validDirections??"—");
 put("eCounts",(stats.validDirections??"—")+" / "+(stats.proxySettled??"—"));
 const accuracy=pct(stats.proxyHits,stats.proxySettled);
 const servicePct=typeof stats.proxyAccuracyPct==="number"&&Number.isFinite(stats.proxyAccuracyPct)?stats.proxyAccuracyPct:null;
 const proxyDisplay=accuracy!=="—"?accuracy:(servicePct!==null?servicePct.toFixed(1)+"%":"—（暂无已核对样本）");
 put("eAccuracy",proxyDisplay);put("eProxyAccuracy",proxyDisplay);
 put("eReason",(oldSignal?"这是旧版策略的历史信号，不属于当前Excel六项频率优化策略。\n":"")+(s?.reason||"暂无新策略有效信号；六项条件未全部通过时返回WAIT。"));
 pill("eBadge",e.configured===true?"good":"bad",e.configured===true?"运行中 · 六项频率优化策略":"数据不可用");
 pill("eStatus",e.configured===true?"good":"bad",e.active?(oldSignal?"旧信号待核对":"新信号待核对"):e.configured===true?"就绪":"未就绪");
 const newTotal=Number.isInteger(ledger?.total)?ledger.total:(stats.total??0);
 if(historyData&&Array.isArray(historyData.records)){
  put("eTotal","新版 "+newTotal+" 条 · 最近旧版 "+legacy.length+" 条");
 }else if(ledger){
  put("eTotal","新版 "+newTotal+" 条 · 旧版历史暂不可用");
 }else{
  put("eTotal","信号记录暂不可用");
 }
 state.lastEvent=records;
 renderRecords("eRecords",records,"event10");
 $("manualCheck").disabled=e.configured!==true||Boolean(e.active)||state.manualBusy;
}
function eventError(error){
 pill("eBadge","bad","连接异常");pill("eStatus","bad","暂不可用");
 for(const id of ["eDirection","eSignal","ePhase","eActive","eCount","eCounts","eAccuracy","eProxyAccuracy","eTotal"])put(id,"不可用");
 put("eReason","EVENT10状态读取失败："+String(error).slice(0,130)+"。请进入原信号控制台核实。");
 $("eRecords").replaceChildren(node("div","mini","记录接口当前不可用，不代表历史记录为空。"));
 $("manualCheck").disabled=true;
}
async function refresh(){
 if(state.busy||document.hidden)return;
 state.busy=true;
 try{
  const [gr,tr,er,lr,hr]=await Promise.allSettled([
   api("/guardian/api/status",7500),
   api("/api/status",7500),
   api("/event10/api/status",7500),
   api("/event10/api/signals?limit=25&offset=0",9500),
   api("/event10/api/history",9500)
  ]);
  const g=gr.status==="fulfilled"?gr.value:null;
  const t=tr.status==="fulfilled"?tr.value:null;
  const e=er.status==="fulfilled"?er.value:null;
  const ledger=lr.status==="fulfilled"?lr.value:null;
  const legacyHistory=hr.status==="fulfilled"?hr.value:null;
  try{if(g)guardian(g,t);else throw gr.reason||Error("无数据");}catch(err){guardianError(err);}
  try{if(e)event(e,ledger,legacyHistory);else throw er.reason||Error("无数据");}catch(err){eventError(err);}
  // Do not claim that a bot is online when one of its API calls failed.
  const count=Number(Boolean(g&&t))+Number(Boolean(e&&ledger));
  $("healthDot").className="dot "+(count===2?"up":count===0?"down":"");
  put("healthText",count===2?"双服务已连接":count===0?"连接异常":"部分接口异常");
  put("updatedAt","刷新于 "+new Date().toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}));
 }finally{state.busy=false;}
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
  put("appBuildVersion",APP_DEPLOY_SHA.slice(0,8));
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
$("hotUpdateButton").addEventListener("click",()=>window.location.reload());
$("manualCheck").addEventListener("click",async()=>{
 if(state.manualBusy)return;
 state.manualBusy=true;$("manualCheck").disabled=true;
 const result=$("manualResult");
 result.hidden=false;result.textContent="已发出检测请求，正在等待服务端确认…";
 try{
  const requestId=crypto.randomUUID();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  let res;
  try{
   res=await fetch("/event10/api/start",{method:"POST",credentials:"same-origin",
    cache:"no-store",headers:{"X-Event10-Action":"manual-open","X-Event10-Request-Id":requestId,
    "Accept":"application/json"},signal:controller.signal});
  }finally{clearTimeout(timer);}
  const data=await res.json();
  if(!res.ok||data.ok!==true)throw Error(data.error||"HTTP "+res.status);
  result.textContent="服务端已接受手动检测请求；请查看下方状态。此操作不会提交交易订单。";
  await refresh();
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
navigate(["overview","guardian","event10","more"].includes(initial)?initial:"overview");
void refresh();
void checkHotUpdate();
setInterval(()=>void refresh(),10000);
// On the 10-minute screen, show server-confirmed signals in around 3s while visible.
// Native Android notification service works independently when this page is hidden.
setInterval(()=>{if(location.hash==="#event10")void refresh();},3000);
setInterval(()=>{if(!document.hidden)void checkHotUpdate();},60000);
if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("/app/sw.js",{scope:"/app/"}).catch(()=>{}));

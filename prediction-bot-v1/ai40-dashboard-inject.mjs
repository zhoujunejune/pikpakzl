// Strict new-version 5m dashboard: no legacy 5-second records or analytics are rendered.
// Read-only local statistics; never submits an order, modifies training, or exports private keys.
import fs from 'node:fs';
export const AI40_CUTOVER_ROUND_MS=1792902300000; // Oct 25 2026 12:25 Asia/Shanghai first full 5m round.
const DEFAULT_LEARNING='/var/lib/zl-prediction/deepseek5/learning.json';
const DEFAULT_WAITS='/var/lib/zl-prediction/deepseek5/wait-rounds.json';
const OLD_CARD='<section class="c" id="roundResultsOnlyCard" style="margin:14px 0">';
const isSide=s=>s==='UP'||s==='DOWN';
const isValidRound=r=>Number.isSafeInteger(r)&&r%300000===0&&r>=AI40_CUTOVER_ROUND_MS;
const classifyWait=x=>{
 const s=String(x?.detail||x?.reason||'').slice(0,110);
 return s==='DEEPSEEK_CHOSE_WAIT'?'AI主动WAIT':
   s==='NO_VALID_CURRENT_ROUND_DEEPSEEK_REVIEW'?'缺少有效当轮AI复核':
   /^(DEEPSEEK_|INPUT_|MARKET_|FEED_)/.test(s)?'数据或模型调用异常':
   /EXPIRED|TIMEOUT|DEADLINE/.test(s)?'决策超时':
   '其他技术性WAIT';
};
const freshRecord=x=>({round:x.round,direction:x.direction,
 status:x.direction==='WAIT'?'WAIT':'LOCKED',source:x.source||'DEEPSEEK_AI40',
 reason:x.reason||null,detail:x.detail||null,category:x.category||null,
 latencyMs:x.signalLatencyMs??null,actual:isSide(x.actual)?x.actual:null,
 hit:isSide(x.actual)?x.direction===x.actual:null});
export function statsFromFiles(learningPath=DEFAULT_LEARNING,waitPath=DEFAULT_WAITS,now=Date.now()){
 let state,waits;
 try{state=JSON.parse(fs.readFileSync(learningPath,'utf8'))}
 catch(e){return {ok:false,error:'LEARNING_FILE_UNREADABLE',detail:e.code||e.name||'ERR'}}
 try{waits=JSON.parse(fs.readFileSync(waitPath,'utf8'))}
 catch(e){return {ok:false,error:'WAIT_FILE_UNREADABLE',detail:e.code||e.name||'ERR'}}
 if(state?.schema!==1||!Array.isArray(state.predictions)||waits?.schema!==1||!Array.isArray(waits.records))
  return {ok:false,error:'STATS_SCHEMA_MISMATCH'};
 const byRound=new Map();
 for(const x of state.predictions){
  if(!isValidRound(x?.round)||!isSide(x?.direction))continue;
  // Legacy and non-current releases MUST NOT pollute this strategy's ledger.
  const latency=Number(x.signalLatencyMs);
  if(!(latency>=15000&&latency<40000)||x.provider!=='deepseek-flash')continue;
  byRound.set(x.round,{...x,source:'DEEPSEEK_AI40'});
 }
 for(const x of waits.records){
  if(!isValidRound(x?.round)||x?.direction!=='WAIT'||byRound.has(x.round))continue;
  byRound.set(x.round,{...x,source:'DEEPSEEK_AI40',category:classifyWait(x)});
 }
 const rows=[...byRound.values()].sort((a,b)=>b.round-a.round).map(freshRecord);
 const signals=rows.filter(x=>isSide(x.direction));
 const settled=signals.filter(x=>isSide(x.actual));
 const hits=settled.filter(x=>x.hit).length;
 const aiWait=rows.filter(x=>x.category==='AI主动WAIT').length;
 const technicalWait=rows.filter(x=>x.direction==='WAIT'&&x.category!=='AI主动WAIT').length;
 const finishedSlots=Math.max(0,Math.floor((now-40000-AI40_CUTOVER_ROUND_MS)/300000)+1);
 const recordedFinished=rows.filter(x=>x.round+40000<=now).length;
 return {ok:true,schema:'DEEPSEEK_AI40_INDEPENDENT_FORWARD_V1',
  model:'DEEPSEEK_5M_V1',cutoverRound:AI40_CUTOVER_ROUND_MS,
  summary:{rounds:rows.length,signals:signals.length,
   aiWait,technicalWait,wait:aiWait+technicalWait,
   settled:settled.length,hits,misses:settled.length-hits,
   pending:signals.length-settled.length,
   accuracy:settled.length?Math.round(hits/settled.length*10000)/100:null,
   finishedSlots,unrecordedFinishedSlots:Math.max(0,finishedSlots-recordedFinished)},
  records:rows.slice(0,60),
  source:'Original local official-settlement learner + AI40 WAIT journal, filtered from verified release cutoff',
  caveat:'Version attribution uses the verified cutover round and valid +15..40s DeepSeek latency; raw signals remain archived.',
  generatedAt:now};
}
const CARD=[
'<section class="c" id="zlDeepSeek40Card" style="margin:14px 0">',
'<div class="k">5分钟预测 · DeepSeek 40秒方案</div>',
'<div class="big" id="zlAi40Main" style="margin:9px 0">读取大模型状态中...</div>',
'<div class="muted" id="zlAi40Timeline">提前120秒预分析 → 开轮0～15秒观察 → 15～40秒AI正式复核 → 第45秒停止提交</div>',
'<div class="grid" style="margin:12px 0">',
'<div class="kv"><div class="k">本轮DeepSeek调用</div><div class="v" id="zlAi40Calls">--</div></div>',
'<div class="kv"><div class="k">模型与深度思考</div><div class="v" id="zlAi40Model">--</div></div>',
'<div class="kv"><div class="k">本轮AI决策</div><div class="v" id="zlAi40Deadline">--</div></div>',
'<div class="kv"><div class="k">实盘自动跟随</div><div class="v" id="zlAi40Follow">--</div></div>',
'</div>',
'<div class="muted" id="zlAi40Passes">提前分析 / 当轮复核：读取中...</div>',
'<div class="muted" id="zlAi40Reason">WAIT原因：读取中...</div>',
'<div class="k" style="margin-top:16px">40秒新版本独立胜率（从10月25日12:25起）</div>',
'<div class="big" id="zlAi40WinRate" style="margin:7px 0">正在统计...</div>',
'<div class="grid" style="margin:12px 0">',
'<div class="kv"><div class="k">已记录轮次 / 有效信号</div><div class="v" id="zlAi40Total">--</div></div>',
'<div class="kv"><div class="k">已结算胜 / 负</div><div class="v" id="zlAi40WinLoss">--</div></div>',
'<div class="kv"><div class="k">DeepSeek主动WAIT</div><div class="v" id="zlAi40AIWait">--</div></div>',
'<div class="kv"><div class="k">技术性WAIT / 缺复核</div><div class="v" id="zlAi40TechWait">--</div></div>',
'</div>',
'<div class="muted" id="zlAi40StatsNote">新版数据独立统计。未结算的有效方向不计入命中率；不把WAIT当作输。</div>',
'<div style="overflow-x:auto;margin-top:12px"><table style="width:100%;font-size:13px;border-collapse:collapse">',
'<thead><tr><th>轮次</th><th>结果</th><th>WAIT原因</th><th>官方结算</th></tr></thead>',
'<tbody id="zlAi40Rows"><tr><td colspan="4">读取中...</td></tr></tbody></table></div>',
'<div class="muted" id="zlAi40Error" style="margin-top:10px"></div>',
'</section>'
].join('');
const SCRIPT=[
'<script>(function(){',
"'use strict';",
" var el=function(id){return document.getElementById(id)};",
" var put=function(id,value){var n=el(id);if(n)n.textContent=String(value)};",
" var phase=function(s){return s>=180?'下一轮预分析':s<15?'开轮行情观察':s<40?'当轮DeepSeek正式复核':s<45?'订单提交缓冲':'本轮已过45秒'};",
" var label=function(d){return d==='UP'?'UP（涨）':d==='DOWN'?'DOWN（跌）':d==='WAIT'?'WAIT（跳过）':'无';};",
" var state=function(x){return x==='LOCKED'?'已锁定AI信号':x==='WAIT'?'本轮WAIT':x==='ANALYZING'?'AI分析中':'等待AI结论'};",
" var cell=function(tr,s){var td=document.createElement('td');td.style.padding='7px';td.style.borderBottom='1px solid #344155';td.textContent=String(s);tr.appendChild(td)};",
" var ts=function(ms){return new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})};",
" async function load(){try{",
"  var urls=['/deepseek/api/status','/api/status','/api/ai40-round-stats'];",
"  var raw=await Promise.all(urls.map(function(u){return fetch(u+'?ts='+Date.now(),{cache:'no-store'})}));",
"  if(raw.some(function(r){return !r.ok}))throw Error('数据接口 '+raw.map(function(x){return x.status}).join('/'));",
"  var values=await Promise.all(raw.map(function(r){return r.json()})),s=values[0],trade=values[1],v=values[2];",
"  if(s.ok!==true||s.decisionRule!=='PREWARM120_NEW_ROUND15_LIVE_DEEPSEEK_ONLY40S'||!v.ok||v.schema!=='DEEPSEEK_AI40_INDEPENDENT_FORWARD_V1')throw Error('前台与DeepSeek40生产版不匹配');",
"  var age=Math.max(0,Math.floor((Date.now()-s.round)/1000)),d=s.roundDecision||{};",
"  put('zlAi40Main',state(d.status)+(d.status==='LOCKED'?' · '+label(d.direction):''));",
"  put('zlAi40Timeline',phase(age)+' · 120秒提前分析 · 开轮15～40秒AI最终复核 · 45秒交易截止');",
"  put('zlAi40Calls',String(s.analysisModelCalls??s.tries??0)+' / '+String(s.maxCallsPerRound??5));",
"  put('zlAi40Model',String(s.providerModel||'未知')+' / '+(s.reasoning?.enabled===true?'High思考已开启':'思考状态未知'));",
"  put('zlAi40Deadline','AI +40秒 / 下单 +45秒');",
"  put('zlAi40Follow',trade.enabled===true?'开启':trade.enabled===false?'关闭':'未知');",
"  put('zlAi40Passes','提前分析 '+label(s.analysisFirstDirection)+' · 提前复核 '+label(s.analysisReviewDirection)+' · 本轮AI '+label(s.analysisCurrentDirection));",
"  put('zlAi40Reason',d.status==='WAIT'?'WAIT原因：'+String(s.lastDecision?.detail||s.waitReason||'未形成有效AI信号'):s.error?'AI诊断：'+String(s.error):'仅本轮真实DeepSeek有效结论能用于下单');",
"  var q=v.summary||{};",
"  put('zlAi40WinRate',q.accuracy==null?'新版暂无已结算有效方向样本':'新版独立胜率 '+q.accuracy.toFixed(2)+'%');",
"  put('zlAi40Total',(q.rounds||0)+' / '+(q.signals||0));",
"  put('zlAi40WinLoss',(q.hits||0)+' / '+(q.misses||0));",
"  put('zlAi40AIWait',q.aiWait||0);put('zlAi40TechWait',q.technicalWait||0);",
"  put('zlAi40StatsNote','待结算 '+(q.pending||0)+' 轮，另有 '+(q.unrecordedFinishedSlots||0)+' 个未记录结束轮次需诊断；独立统计起点：'+ts(v.cutoverRound)+'。不混入旧版成绩。');",
"  var body=el('zlAi40Rows');if(body){body.replaceChildren();var rows=(v.records||[]).slice(0,18);",
"   if(!rows.length){var tr=document.createElement('tr');cell(tr,'暂无新版记录');body.appendChild(tr)}",
"   for(var i=0;i<rows.length;i++){var r=rows[i],tr=document.createElement('tr');",
"    cell(tr,ts(r.round));cell(tr,label(r.direction));cell(tr,r.category||'-');",
"    cell(tr,r.actual?(r.hit?'正确':'错误')+' · '+label(r.actual):r.direction==='WAIT'?'不参与胜率':'待结算');body.appendChild(tr)}}",
"  put('zlAi40Error',s.error?'AI诊断：'+String(s.error).slice(0,100):'当前模型 '+s.model+' · 真实行情 '+(s.featureReady?'正常':'需检查'));",
" }catch(e){put('zlAi40Main','无法验证当前AI分析状态');put('zlAi40WinRate','新版独立统计暂不可用');put('zlAi40Error','读取异常：'+String(e?.message||e).slice(0,130))}}",
" void load();setInterval(load,4000);",
'})();</script>'
].join('\n');

export function injectAi40Dashboard(html){
 if(typeof html!=='string'||!html.includes('</body>'))return html;
 if(html.includes('id="zlDeepSeek40Card"'))return html;
 const start=html.indexOf(OLD_CARD);
 if(start<0)return html;
 const end=html.indexOf('</section>',start);
 if(end<0)return html; // do not corrupt an unfamiliar page
 let out=html.slice(0,start)+CARD+html.slice(end+'</section>'.length);
 // Remove ONLY the legacy read-only five-second result collector and its script,
 // preserving all existing trade controls, menus, amounts, and TP/SL controls.
 out=out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,tag=>
  tag.includes('/api/deepseek-round-results?limit=')&&tag.includes('rrMeta')?'':tag);
 return out.replace('</body>',SCRIPT+'</body>');
}

// Read-only AI40/45 presentation for the current Alibaba five-minute prediction page.
// No trading endpoint calls, no state mutations, no exchange credentials.
const OLD_CARD = '<section class="c" id="roundResultsOnlyCard" style="margin:14px 0">';
const CARD = [
'<section class="c" id="zlDeepSeek40Card" style="margin:14px 0">',
'<div class="k">5分钟预测 · DeepSeek AI 分析状态</div>',
'<div class="big" id="zlAi40Main" style="margin:9px 0">正在读取大模型...</div>',
'<div class="muted" id="zlAi40Timeline">提前120秒预分析 → 开轮0～15秒观察 → 15～40秒AI复核 → 45秒停止订单提交</div>',
'<div class="grid" style="margin:12px 0">',
'<div class="kv"><div class="k">本轮已用AI调用</div><div class="v" id="zlAi40Calls">--</div></div>',
'<div class="kv"><div class="k">模型与深度思考</div><div class="v" id="zlAi40Model">--</div></div>',
'<div class="kv"><div class="k">本轮决策截止</div><div class="v" id="zlAi40Deadline">--</div></div>',
'<div class="kv"><div class="k">开始跟随</div><div class="v" id="zlAi40Follow">--</div></div>',
'</div>',
'<div class="muted" id="zlAi40Passes">预分析 / 预复核 / 新轮正式分析：读取中...</div>',
'<div class="muted" id="zlAi40Feedback" style="margin-top:8px">官方历史学习统计读取中...</div>',
'<div class="muted" id="zlAi40Separation" style="margin-top:6px">新版40秒方案的独立胜率尚待积累；不得将旧模型混合命中率当成新版成绩。历史经验用于提示词反馈，不等于微调DeepSeek权重。</div>',
'<div class="muted" id="zlAi40Error" style="margin-top:6px"></div>',
'<button id="zlAi40OldToggle" type="button" style="margin-top:12px;background:#344155;color:#fff">展开旧版5秒记录（已停用）</button>',
'</section>'
].join('');
const SCRIPT = [
'<script>(function(){',
"  'use strict';",
"  var g=function(id){return document.getElementById(id)};",
"  var put=function(id,value){var n=g(id);if(n)n.textContent=String(value)};",
"  var old=g('roundResultsOnlyCard');",
"  if(old){old.style.display='none';old.setAttribute('data-legacy-five-second','true')}",
"  var toggle=g('zlAi40OldToggle');",
"  if(toggle)toggle.addEventListener('click',function(){if(!old)return;var show=old.style.display==='none';old.style.display=show?'':'none';toggle.textContent=show?'收起旧版5秒记录':'展开旧版5秒记录（已停用）'});",
"  var phase=function(sec){if(sec>=300-120)return '下一轮预分析阶段';if(sec<15)return '新轮观察中（前15秒禁止锁定）';if(sec<40)return 'DeepSeek 正式复核中';if(sec<45)return 'AI决策结束，订单提交缓冲';return '本轮已超过45秒提交截止'};",
"  var abbr=function(s){return s==='UP'?'UP（上涨）':s==='DOWN'?'DOWN（下跌）':s==='WAIT'?'WAIT（跳过）':'尚无';};",
"  var readable=function(s){return s==='LOCKED'?'已锁定：真实AI结论':s==='WAIT'?'WAIT：本轮不交易':s==='ANALYZING'?'DeepSeek 分析中':s==='UNAVAILABLE'?'无有效AI结论':'等待本轮AI状态'};",
"  async function load(){",
"   try{",
"    var results=await Promise.all([fetch('/deepseek/api/status?ts='+Date.now(),{cache:'no-store'}),fetch('/api/status?ts='+Date.now(),{cache:'no-store'}),fetch('/deepseek/api/history?limit=3&ts='+Date.now(),{cache:'no-store'})]);",
"    if(!results[0].ok||!results[1].ok||!results[2].ok)throw Error('AI或历史接口不可用（HTTP '+results.map(function(x){return x.status}).join('/')+'）');",
"    var s=await results[0].json(),trade=await results[1].json(),history=await results[2].json();",
"    if(s.ok!==true||s.model!=='DEEPSEEK_5M_V1'||history.ok!==true)throw Error('AI模型或历史统计未就绪');",
"    if(s.decisionRule!=='PREWARM120_NEW_ROUND15_LIVE_DEEPSEEK_ONLY40S'||s.aiDirectionalRequired!==true)throw Error('运行版本不是DeepSeek 40秒强制复核版');",
"    var now=Date.now(),seconds=Math.max(0,Math.floor((now-s.round)/1000)),round=s.roundDecision||{};",
"    put('zlAi40Main',readable(round.status)+(round.status==='LOCKED'&&['UP','DOWN'].includes(round.direction)?' · '+abbr(round.direction):''));",
"    put('zlAi40Timeline',phase(seconds)+' · 预分析提前120秒 · 当轮15～40秒AI锁定 · 45秒停止订单提交');",
"    put('zlAi40Calls',String(s.analysisModelCalls??s.tries??0)+' / '+String(s.maxCallsPerRound??5));",
"    put('zlAi40Model',String(s.providerModel||'未知')+' / '+(s.reasoning?.enabled===true?'High深度思考开启':'深度思考状态未知'));",
"    put('zlAi40Deadline','AI +40秒 / 提交 +45秒');",
"    put('zlAi40Follow',trade.enabled===true?'开启（实盘风险）':trade.enabled===false?'关闭':'未知');",
"    put('zlAi40Passes','提前预分析：'+abbr(s.analysisFirstDirection)+' · 提前复核：'+abbr(s.analysisReviewDirection)+' · 当轮AI：'+abbr(s.analysisCurrentDirection)+' · 决策来源以当轮正式分析为准');",
"    var l=s.learning||history.summary||{}; var n=Number(l.allOfficialSamples)||0,h=Number(l.allOfficialHits)||0;",
"    put('zlAi40Feedback','官方历史已结算 '+n+' 轮 / 命中 '+h+' 轮 / 混合历史胜率 '+(n?(h/n*100).toFixed(2)+'%':'暂无')+'（包含旧版，仅供参考） · 结算反馈：'+(s.learning?.autoFeedback===true?'开启':'未知'));",
"    put('zlAi40Error',s.error?'AI异常：'+String(s.error).slice(0,110):s.waitReason?'最新WAIT线索：'+String(s.waitReason).slice(0,110):'行情状态：'+(s.featureReady?'新鲜':'请检查数据时效')+'；无AI结论不下单');",
"   }catch(err){put('zlAi40Main','AI状态无法验证 · 禁止将旧5秒记录视为当前信号');put('zlAi40Error','读取失败：'+String(err&&err.message||err).slice(0,140))}",
"  }",
"  void load();setInterval(load,3500);",
'})();</script>'
].join('\n');
export function injectAi40Dashboard(html){
 if(typeof html!=='string'||!html.includes(OLD_CARD)||!html.includes('</body>'))return html;
 if(html.includes('id="zlDeepSeek40Card"'))return html;
 return html.replace(OLD_CARD,CARD+OLD_CARD).replace('</body>',SCRIPT+'</body>');
}

// GUARDIAN analysis component of the existing 5-minute single bot.
// Shadow-only: it has no order submission, position access, exchange credentials or trading controls.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {extractFeatures} from './deepseek-5m-features.mjs';
import {MODEL,roundOf,safeCandidate,parseAI,wilsonLower,evaluateQuote,exitPolicy} from './guardian5-core.mjs';

const FEED='http://127.0.0.1:13003/api/shadow-market-data';
const OFFICIAL='http://127.0.0.1:13002/api/round-stats';
const STATE=process.env.GUARDIAN_STATE_FILE||'/var/lib/zl-prediction/guardian5/observations.json';
const API=process.env.DEEPSEEK_API_URL||'https://api.deepseek.com/chat/completions';
const MODEL_PROVIDER=process.env.DEEPSEEK_MODEL||'deepseek-flash';
const API_KEY=String(process.env.DEEPSEEK_API_KEY||'');
const PORT=Number(process.env.GUARDIAN_PORT||13049);
const MAX_CALLS=3;
const local={records:[],currentRound:null,latest:{direction:'WAIT',reason:'等待实时数据'},error:null,
 feedAt:null,lastOfficialAt:null,lastAIAt:null,modelLatencyMs:null,provider:MODEL_PROVIDER,
 lastTickAt:null,busy:false,aiCalls:0,lastSettleAt:0,nextAnalysisAt:0};
try{
 const old=JSON.parse(fs.readFileSync(STATE,'utf8'));
 if(old.model===MODEL&&Array.isArray(old.records))local.records=old.records.filter(x=>Number.isSafeInteger(x.round)).slice(-1500);
}catch{}
function save(){
 const dir=path.dirname(STATE);fs.mkdirSync(dir,{recursive:true,mode:0o750});
 const tmp=STATE+'.'+process.pid+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify({model:MODEL,records:local.records}),{mode:0o640});
 fs.renameSync(tmp,STATE);
}
function recent(){return local.records.slice(-80).reverse();}
function metrics(){
 const settled=local.records.filter(x=>x.status==='SETTLED'&&x.predictedDirection&&x.officialDirection);
 const won=settled.filter(x=>x.predictedDirection===x.officialDirection).length;
 return {observedRounds:local.records.length,shadowPredictions:local.records.filter(x=>!!x.predictedDirection).length,
  settled: settled.length,correct:won,directionAccuracy:settled.length?won/settled.length:null,
  wilsonLower:settled.length?wilsonLower(won,settled.length):null,
  quoteBacktestedTrades:0,netTradingPnl:null,validated:false,
  reason:'影子方向准确率不等于可成交胜率；实际赔率、费用和卖出报价未经过验证'};
}
function view(){
 const m=metrics();
 return {ok:true,model:MODEL,mode:'SHADOW_ANALYSIS_FOR_EXISTING_SINGLE_BOT',
  configured:Boolean(API_KEY),provider:MODEL_PROVIDER,reasoning:'enabled',
  readOnly:true,orders:false,productionIntegration:false,realOrderEnabled:false,autoTP_SL:false,
  exitPolicyConfigured:true,exitExecutionEnabled:false,
  automaticTradeEligibility:evaluateQuote({calibration:{samples:m.settled,wilsonLower:m.wilsonLower},hasOfficialFeed:false}),
  round:roundOf(Date.now()),latest:local.latest,observedAt:local.feedAt,
  latestOfficialPollAt:local.lastOfficialAt,lastAIAt:local.lastAIAt,modelLatencyMs:local.modelLatencyMs,
  aiCallsCurrentRound:local.aiCalls,lastTickAt:local.lastTickAt,busy:local.busy,error:local.error,
  stats:m,records:recent(),policy:{candidate:'ATR距离+同向动能+市场数据新鲜',deepseek:'最终裁决',
   quote:'缺官方结算价格源/真实盘口/校准则只记录不交易',entry:'轮内动态入场，距结算至少25秒',
   exit:'10%应急止损，8%盈利后4百分点回撤追踪（待验证）',dailyLoss:'2%预算（待实盘验证）'}};
}
async function jsonGet(url,timeout=6500){
 const r=await fetch(url,{signal:AbortSignal.timeout(timeout),cache:'no-store'});
 if(!r.ok)throw Error('HTTP_'+r.status);
 return await r.json();
}
function settleOutcome(row){
 if(!row||!Number.isSafeInteger(Number(row.roundStartMs)))return null;
 const result=row.productionActual??row.officialDirection??null;
 const validated=Number(row.productionSettledAt||row.settledAt||0)>0 &&
  (row.resolutionEvidence!=null||row.actualSource!=null||row.officialSettlementAudit!=null);
 return validated&&['UP','DOWN'].includes(result)?result:null;
}
async function pollOfficial(now){
 if(now-local.lastSettleAt<45000)return;
 local.lastSettleAt=now;
 const info=await jsonGet(OFFICIAL,8500);
 if(info.ok!==true||!Array.isArray(info.records))throw Error('OFFICIAL_STATS_UNTRUSTED');
 local.lastOfficialAt=Date.now();
 const official=new Map(info.records.map(x=>[Number(x.roundStartMs),settleOutcome(x)]));
 let changed=false;
 for(const record of local.records){
  if(record.status!=='PREDICTED')continue;
  const actual=official.get(record.round);
  if(!actual)continue;
  record.officialDirection=actual;record.status='SETTLED';
  record.hit=actual===record.predictedDirection;record.settledAt=Date.now();changed=true;
 }
 if(changed)save();
}
function recordDecision(candidate,decision,now){
 const record={round:candidate.round,at:now,marketAt:candidate.observedAt,status:'PREDICTED',
  candidateDirection:candidate.direction,predictedDirection:decision.direction,
  subjectiveConfidence:decision.confidence,reason:decision.reason,
  evidence:candidate.evidence,entryQuote:null,exitQuote:null,realizedPnl:null,
  virtualRiskPlan:{stopLoss:-0.10,trailStart:0.08,trailGiveback:0.04},
  tradeEligible:false,tradeGate:'CALIBRATION_AND_REAL_QUOTE_MISSING',
  note:'仅记录未来官方方向，不代表真实成交或盈利'};
 local.records.push(record);local.records=local.records.slice(-1500);save();
 return record;
}
async function judge(candidate,f){
 if(!API_KEY)return {direction:'WAIT',confidence:null,reason:'DeepSeek API 密钥未配置'};
 const remaining=roundOf(Date.now())+300000-Date.now();
 if(remaining<25000)return {direction:'WAIT',confidence:null,reason:'模型剩余计算时间不足'};
 const evidence={round:candidate.round,elapsedSec:f.elapsedSec,remainingSec:f.remainingSec,
  candidateDirection:candidate.direction,evidence:candidate.evidence,
  btcLast:f.lastPrice,roundOpen:f.roundOpenPrice,
  oneMinute:f.oneMinute,fiveMinute:f.fiveMinute,
  officialSettlementReferenceVerified:false,predictionMarketExecutableQuoteAvailable:false,
  calibratedProbabilityAvailable:false,
  note:'不能将现货价格直接认作预测市场官方结算价，不能宣称有正的期望收益'};
 const body={model:MODEL_PROVIDER,max_tokens:1500,thinking:{type:'enabled'},response_format:{type:'json_object'},
  messages:[{role:'system',content:[
   'You control a READ-ONLY research signal for the existing Binance five-minute BTC prediction bot.',
   'You MUST decide UP DOWN or WAIT from supplied causal observed data only.',
   'WAIT is preferred when uncertain. Never invent settlement price feeds, order books, quote prices, funding or calibrated probabilities.',
   'Subjective confidence must NOT be represented as a calibrated win rate.',
   'If technical direction conflicts with evidence return WAIT. Do not chase trades.',
   'Output one JSON object: {"direction":"UP|DOWN|WAIT","confidence":0.0,"reason":"brief Chinese rationale"}.',
   'No order authorization is possible; independent hard-gates always forbid real trades until calibrated and real quotes verified.'
  ].join(' ')},{role:'user',content:JSON.stringify(evidence)}]};
 const start=Date.now();
 const res=await fetch(API,{method:'POST',headers:{Authorization:'Bearer '+API_KEY,'Content-Type':'application/json'},
  body:JSON.stringify(body),signal:AbortSignal.timeout(Math.min(43000,Math.max(2000,remaining-24000)))});
 local.modelLatencyMs=Date.now()-start;local.lastAIAt=Date.now();
 if(!res.ok)throw Error('DEEPSEEK_HTTP_'+res.status);
 const response=await res.json();
 if(response?.choices?.[0]?.finish_reason==='length')throw Error('DEEPSEEK_TRUNCATED');
 return parseAI(response?.choices?.[0]?.message?.content);
}
async function tick(){
 if(local.busy)return;
 local.busy=true;local.lastTickAt=Date.now();
 try{
  const now=Date.now(),r=roundOf(now);
  if(local.currentRound!==r){
   local.currentRound=r;local.aiCalls=0;local.nextAnalysisAt=0;
   local.latest={direction:'WAIT',round:r,reason:'新一轮等待机会'};
  }
  try{await pollOfficial(now)}catch(e){local.error='结算读取:'+String(e?.message||e).slice(0,90)}
  const m=await jsonGet(FEED,6500);
  const f=extractFeatures(m,Date.now());
  local.feedAt=f.observedAt;
  if(local.records.some(x=>x.round===r)){
   local.latest={direction:'OBSERVED',round:r,reason:'本轮已记录一次AI信号；不重复追单'};
   return;
  }
  const c=safeCandidate(f,Date.now());
  if(c.direction==='WAIT'){
   local.latest={direction:'WAIT',round:r,reason:c.reason};return;
  }
  if(Date.now()<local.nextAnalysisAt||local.aiCalls>=MAX_CALLS){
   local.latest={direction:'WAIT',round:r,reason:local.aiCalls>=MAX_CALLS?'本轮AI调用达到上限':'下一次分析尚未到时'};
   return;
  }
  local.aiCalls+=1;local.nextAnalysisAt=Date.now()+25000;
  local.latest={direction:'THINKING',round:r,candidate:c.direction,reason:'DeepSeek正在分析，尚未形成信号'};
  const result=await judge(c,f);
  if(roundOf(Date.now())!==r){
   local.latest={direction:'WAIT',round:roundOf(Date.now()),reason:'模型回复跨轮次，放弃旧信号'};return;
  }
  if(!['UP','DOWN'].includes(result.direction)||result.direction!==c.direction){
   local.latest={direction:'WAIT',round:r,reason:result.direction==='WAIT'?result.reason:'DeepSeek与量化候选方向冲突'};return;
  }
  // Revalidate the market at execution time: never use a slow model's stale snapshot.
  const fresh=extractFeatures(await jsonGet(FEED,6500),Date.now());
  const check=safeCandidate(fresh,Date.now());
  if(check.direction!==c.direction||fresh.round!==r){
   local.latest={direction:'WAIT',round:r,reason:'DeepSeek判断后行情改变，信号已失效'};return;
  }
  const row=recordDecision(c,result,Date.now());
  local.latest={direction:row.predictedDirection,round:r,reason:row.reason,
   confidence:row.subjectiveConfidence,status:'SHADOW_OBSERVATION',
   tradeEligible:false,risk:'无预测市场真实报价与校准，不执行实盘'};
  local.error=null;
 }catch(e){
  local.error=String(e?.message||e).slice(0,140);
  local.latest={direction:'WAIT',round:roundOf(Date.now()),reason:'输入/模型错误，安全跳过：'+local.error};
 }finally{local.busy=false}
}
const HTML=String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GUARDIAN · 5分钟策略研究</title><style>
*{box-sizing:border-box}body{background:#0b1019;color:#e8edf5;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;margin:0;padding:24px}main{max-width:980px;margin:0 auto}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}h1{font-size:23px;font-weight:650;margin:0}.muted{color:#8592a5;font-size:13px}.pill{padding:5px 11px;border:1px solid #36536d;border-radius:18px;color:#8fd0ff;font-size:12px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:12px;margin:22px 0}.card{background:#121b29;border:1px solid #26364a;border-radius:13px;padding:16px}.k{font-size:12px;color:#9baabc}.value{font-size:26px;font-weight:700;margin:8px 0}.green{color:#78ddb1}.yellow{color:#ffd18d}.bad{color:#f5a8a4}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:10px 8px;text-align:left;border-bottom:1px solid #243449}th{color:#a3b0c3;font-weight:550}.scroll{overflow-x:auto}.reason{line-height:1.8;white-space:pre-wrap}a{color:#9bd3ff;text-decoration:none}.sub{font-size:13px;line-height:1.75;color:#9daec3}footer{margin-top:25px}.title{font-size:16px;font-weight:600;margin:0 0 13px}</style></head><body><main><div class="top"><div><h1>GUARDIAN <span style="color:#78ccff">5M</span></h1><div class="muted">同一台5分钟单边机器人 · DeepSeek 智能策略研究</div></div><span class="pill">影子模式 · 严禁实盘</span></div>
<div class="cards"><div class="card"><div class="k">当前 AI 决策</div><div class="value" id="direction">WAIT</div><div class="muted" id="round">-</div></div><div class="card"><div class="k">已记录信号</div><div class="value" id="signals">-</div><div class="muted">不强制每轮交易</div></div><div class="card"><div class="k">官方已结算</div><div class="value" id="settled">-</div><div class="muted">仅独立样本</div></div><div class="card"><div class="k">方向准确率</div><div class="value" id="accuracy">-</div><div class="muted">不是可交易净收益率</div></div></div>
<div class="card"><h2 class="title">实时判断</h2><div class="reason" id="reason">正在读取...</div><div class="sub" id="meta">-</div></div>
<div class="card" style="margin-top:14px"><h2 class="title">真实风控状态</h2><div class="sub">动态止盈止损算法已实现，但必须取得真实可卖报价并通过历史校准后才能接管实盘。目前没有放行交易的资格，不会偷偷买卖。</div><p class="sub" id="risk">-</p></div>
<div class="card" style="margin-top:14px"><h2 class="title">GUARDIAN 独立记录</h2><div class="scroll"><table><thead><tr><th>轮次</th><th>AI预测</th><th>置信度（主观）</th><th>官方结果</th><th>验证</th></tr></thead><tbody id="rows"></tbody></table></div></div>
<footer class="muted"><a href="/">返回单边机器人</a> · 每5秒刷新 · 价格、模型判断不代表盈利保证</footer></main><script>
const e=x=>document.getElementById(x);
function val(x){return x==null?'-':String(x)}
function tm(x){return new Date(Number(x)).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}
async function tick(){try{const r=await fetch('./api/status',{cache:'no-store'}),s=await r.json();if(!s.ok)throw Error(s.error||'接口失败');
 const x=s.latest||{},m=s.stats||{};e('direction').textContent=x.direction||'WAIT';e('direction').className='value '+(['UP','DOWN'].includes(x.direction)?'green':'yellow');e('round').textContent='当前轮 '+tm(s.round);
 e('signals').textContent=val(m.shadowPredictions);e('settled').textContent=val(m.settled);e('accuracy').textContent=m.directionAccuracy==null?'-':(m.directionAccuracy*100).toFixed(1)+'%';
 e('reason').textContent=val(x.reason);e('meta').textContent='DeepSeek：'+(s.configured?'已连接':'未配置')+' · 模型 '+s.provider+' · 最后行情 '+(s.observedAt?tm(s.observedAt):'-')+(s.error?' · 错误：'+s.error:'');
 e('risk').textContent='实盘资格：未开放；方向样本 '+m.settled+' 笔；Wilson胜率下限 '+(m.wilsonLower==null?'-':(m.wilsonLower*100).toFixed(1)+'%')+'；实际交易净盈亏：暂无。';
 e('rows').replaceChildren(...(s.records||[]).slice(0,45).map(x=>{const tr=document.createElement('tr');[tm(x.round),x.predictedDirection||'-',x.subjectiveConfidence==null?'-':Math.round(x.subjectiveConfidence*100)+'%',x.officialDirection||'待结算',x.status==='SETTLED'?(x.hit?'命中':'未命中'):'研究中'].forEach(y=>{const td=document.createElement('td');td.textContent=y;tr.appendChild(td)});return tr}));
}catch(e2){e('reason').textContent='数据读取失败：'+String(e2.message||e2)}}
tick();setInterval(tick,5000);</script></body></html>`;
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(req.method!=='GET'){res.writeHead(405);return res.end()}
 if(u.pathname==='/'||u.pathname==='/index.html'){
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(HTML);
 }
 if(['/api/status','/status','/healthz'].includes(u.pathname)){
  res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});return res.end(JSON.stringify(view()));
 }
 if(u.pathname==='/api/history'){
  res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  return res.end(JSON.stringify({ok:true,model:MODEL,records:recent(),stats:metrics()}));
 }
 res.writeHead(404);res.end('not found');
});
server.listen(PORT,'127.0.0.1',()=>console.log('GUARDIAN5_SHADOW_START port='+PORT+' configured='+Boolean(API_KEY)));
void tick();
setInterval(()=>void tick(),5000).unref();

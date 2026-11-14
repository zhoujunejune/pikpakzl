// Display-only simplified-Chinese translations. Original forecasts and settlement
// files remain unchanged. Translations are cached in a separate sidecar.
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
const FIELDS=["reason","upCase","downCase","decisiveEvidence","uncertainty"];
export const hasHan=value=>typeof value==="string"&&/[\u3400-\u9fff]/u.test(value);
const originalFields=s=>({
 reason:String(s?.reason||"").slice(0,300),
 upCase:String(s?.analysisArguments?.upCase||"").slice(0,240),
 downCase:String(s?.analysisArguments?.downCase||"").slice(0,240),
 decisiveEvidence:String(s?.analysisArguments?.decisiveEvidence||"").slice(0,240),
 uncertainty:String(s?.analysisArguments?.uncertainty||"").slice(0,240)
});
const fingerprint=fields=>createHash("sha256").update(JSON.stringify(fields)).digest("hex");
export function requiresChineseDisplay(session){
 const src=originalFields(session);
 return FIELDS.some(k=>src[k]&&/[A-Za-z]{4,}/.test(src[k])&&!hasHan(src[k]));
}
export function createChineseDisplay({env=process.env,fetcher=fetch,cacheFile="/var/lib/zl-event10/chinese-display-cache.json"}={}){
 let cache={};
 try{const parsed=JSON.parse(fs.readFileSync(cacheFile,"utf8"));if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))cache=parsed;}
 catch(e){if(e.code!=="ENOENT")cache={};}
 const busy=new Map();
 const key=String(env.DEEPSEEK_API_KEY||"");
 const model=String(env.EVENT10_DEEPSEEK_MODEL||env.DEEPSEEK_MODEL||"deepseek-flash");
 const endpoint=String(env.DEEPSEEK_API_URL||"https://api.deepseek.com/chat/completions");
 function existing(session){
  if(!session?.id)return null;
  const src=originalFields(session),fp=fingerprint(src),entry=cache[session.id];
  return entry?.fp===fp?entry.zh:null;
 }
 function overlay(session){
  if(!session)return session;
  const zh=existing(session);
  return zh?{...session,displayChinese:zh}:session;
 }
 function store(){
  fs.mkdirSync(path.dirname(cacheFile),{recursive:true,mode:0o750});
  const tmp=cacheFile+"."+process.pid+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(cache),{encoding:"utf8",mode:0o600});
  fs.renameSync(tmp,cacheFile);
 }
 async function translate(session){
  if(!session||!session.id||!["PREDICTED","FAILED"].includes(session.status))throw Error("NO_FINISHED_FORECAST");
  if(!requiresChineseDisplay(session))return {ok:true,alreadyChinese:true};
  const done=existing(session);
  if(done)return {ok:true,displayChinese:done,cached:true};
  if(!key)throw Error("DEEPSEEK_NOT_CONFIGURED");
  if(busy.has(session.id))return busy.get(session.id);
  const task=(async()=>{
   const src=originalFields(session);
   const payload={
    model,response_format:{type:"json_object"},
    messages:[
     {role:"system",content:[
       "你是简体中文翻译工具，只处理已完成的历史预测解释文本，不做任何新的行情预测。",
       "将输入 JSON 里的非空英语说明准确翻译成自然、简洁的简体中文，保持事实、否定、",
       "不确定性、价格、数量、技术指标、UP/DOWN和原有方向完全不变。不得添加新的预测、",
       "胜率、交易建议或事实。只返回同名字段的 JSON 对象：",
       "reason、upCase、downCase、decisiveEvidence、uncertainty。",
       "原字段为空字符串时保持为空；有内容的每个字段必须包含简体中文，允许 RSI/MACD 等技术缩写。"
     ].join("")},
     {role:"user",content:JSON.stringify(src)}
    ]
   };
   const response=await fetcher(endpoint,{method:"POST",signal:AbortSignal.timeout(25000),
     headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
     body:JSON.stringify(payload)});
   if(!response.ok)throw Error("CHINESE_TRANSLATION_HTTP_"+response.status);
   const data=await response.json();
   if(data?.choices?.[0]?.finish_reason==="length")throw Error("CHINESE_TRANSLATION_TRUNCATED");
   let parsed;
   try{parsed=JSON.parse(data?.choices?.[0]?.message?.content||"");}
   catch{throw Error("CHINESE_TRANSLATION_JSON_INVALID");}
   const zh={};
   for(const field of FIELDS){
    if(!src[field]){zh[field]="";continue;}
    if(typeof parsed?.[field]!=="string"||!hasHan(parsed[field]))
      throw Error("CHINESE_TRANSLATION_MISSING_"+field);
    zh[field]=parsed[field].slice(0,450);
   }
   cache[session.id]={fp:fingerprint(src),zh};
   // Keep sidecar bounded; never erase original historical records.
   const ids=Object.keys(cache);
   if(ids.length>500)for(const x of ids.slice(0,ids.length-500))delete cache[x];
   store();
   return {ok:true,displayChinese:zh,cached:false};
  })();
  busy.set(session.id,task);
  try{return await task;}finally{busy.delete(session.id);}
 }
 return {overlay,translate,requiresChineseDisplay};
}

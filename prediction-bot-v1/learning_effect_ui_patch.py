#!/usr/bin/env python3
"""Patch only the existing DeepSeek stats card with read-only learning evidence.
No trade controls or strategy logic are touched. Safe repeat aborts on mismatch.
"""
from pathlib import Path
import sys
assert len(sys.argv)==3
source=Path(sys.argv[1]).read_text()
old='<div class="muted" id="rsMeta">只统计 DEEPSEEK_5M_V1 自身预测与币安官方结算；不继承 Selective V2 / Edge 数据。</div>'
assert source.count(old)==1,'LEARNING_UI_STATS_CARD_MISSING'
insert='''<div class="c" id="learningEvidenceCard" style="margin-top:14px">
<div class="k">DeepSeek AI 学习证据 · 只读</div>
<div class="grid" style="margin-top:10px">
<div class="kv"><div class="k">已结算原始行情快照</div><div class="v" id="leSnapshots">-</div></div>
<div class="kv"><div class="k">已记录经验输入的预测轮次</div><div class="v" id="leAudited">-</div></div>
<div class="kv"><div class="k">提供相似历史案例的轮次</div><div class="v" id="leCases">-</div></div>
<div class="kv"><div class="k">提供错误模式的轮次</div><div class="v" id="leErrors">-</div></div>
</div>
<div class="muted" id="leVerdict" style="margin-top:8px">正在验证历史经验是否进入模型请求。效果对照尚未启动。</div>
<div class="muted">这些是历史经验已提供给模型的证据，不代表DeepSeek已真正吸收，也不代表胜率提升；未额外调用任何付费模型。严格A/B验证仍需额外额度。</div>
</div>'''
source=source.replace(old,old+'\n'+insert)
anchor='async function renderDeepSeekRoundStats(){'
assert source.count(anchor)==1,'DEEPSEEK_RENDERER_MISSING'
fn='''async function renderDeepSeekLearningEvidence(){
  var byId=function(id){return document.getElementById(id);};
  var put=function(id,v){var n=byId(id);if(n)n.textContent=String(v);};
  try{
    var res=await fetch('/deepseek/api/learning-effect?ts='+Date.now(),{cache:'no-store'});
    if(!res.ok)throw Error('学习证据接口尚未连接');
    var data=await res.json();
    if(data.ok!==true||data.model!=='DEEPSEEK_5M_V1')throw Error('返回的模型不匹配');
    var e=data.evidence||{};
    put('leSnapshots',e.settledFeatureSnapshots??0);
    put('leAudited',e.modelRequestsAuditedRounds??0);
    put('leCases',e.roundsWithSimilarCasesOffered??0);
    put('leErrors',e.roundsWithErrorPatternsOffered??0);
    put('leVerdict',data.controlledComparisonVerdict==='NOT_PROVEN'?
      '已记录经验输入；严格A/B对照未启动，暂不能声称学习提高了准确率。':
      '学习效果状态：'+String(data.controlledComparisonVerdict||'未知'));
  }catch(err){
    put('leVerdict','学习证据暂不可用：'+String(err?.message||err));
  }
}
'''
source=source.replace(anchor,fn+anchor+'\n void renderDeepSeekLearningEvidence();')
assert 'var expired=Date.now()>=currentRound+25000;' in source,'PRODUCTION_25S_UI_RULE_MISSING'
Path(sys.argv[2]).write_text(source)
print('LEARNING_UI_READONLY_PATCH_READY=true')

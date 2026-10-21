#!/usr/bin/env python3
"""Add the live quote profitability gate to the existing AUTO_CONFIRM path only.
No second bot, no simulator, no change to the user direction or follow switch.
"""
from pathlib import Path
import sys
assert len(sys.argv)==3,'USAGE: patch_live_trade_value.py wrapper.mjs patched.mjs'
s=Path(sys.argv[1]).read_text()
key="let source = fs.readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');"
assert s.count(key)==1,'LIVE_WRAPPER_ENTRY_DRIFT'
assert s.count('  if (EV_FILTER_ENABLED) {')==1,'LIVE_QUOTE_GATE_DRIFT'
assert 'live-trade-value-policy.mjs' not in s,'POLICY_ALREADY_INSTALLED'
assert "const EV_FILTER_ENABLED = false;" in s,'LEGACY_EV_CONFIG_DRIFT'
s=s.replace(key,key+"""\n// Imported into generated trade-control-fixed.mjs, not into the wrapper process.
source = "import {decideLiveTradeValue} from './live-trade-value-policy.mjs';\\n" + source;""",1)
needle='  if (EV_FILTER_ENABLED) {'
block="""  // DeepSeek-only real AUTO_CONFIRM order-value decision. It runs after the
  // Binance executable Quote is retrieved and before any real order POST.
  // No trade on stale/unverifiable statistics; manual confirmation stays user-controlled.
  if (isAuto && p.signalModelChoice===SELECTIVE8_MODEL) {
    let liveDecision;
    try{
      const memRes=await fetch('http://127.0.0.1:13029/api/status',
        {signal:AbortSignal.timeout(950),headers:{Accept:'application/json'}});
      if(!memRes.ok)throw Error('OFFICIAL_LEARNER_HTTP_'+memRes.status);
      const mem=await memRes.json();
      if(mem?.model!=='DEEPSEEK_5M_V1'||mem?.learning?.autoFeedback!==true||
         mem?.learning?.lastError||!mem?.learning?.readyForAnalysis)
        throw Error('LEARNER_NOT_VERIFIED');
      liveDecision=decideLiveTradeValue({
        learning:mem.learning,
        originalDirection:p.productionSignal,
        orderDirection:p.signal,
        quoteChance:Number(quote.chance),
        sourceOk:true});
    }catch(e){
      liveDecision={decision:'NO_TRADE',reason:'OFFICIAL_LEARNING_DATA_UNAVAILABLE',
        detail:String(e?.message||e).slice(0,60)};
    }
    p.tradeValueDecision=liveDecision.decision;
    p.tradeValueReason=liveDecision.reason;
    p.tradeValueSamples=liveDecision.samples??null;
    p.conservativeNetEdge=liveDecision.conservativeNetEdge??null;
    p.tradeValueQuote=liveDecision.quoteChance??null;
    console.log(JSON.stringify({event:'deepseek_live_trade_value',
      round:p.round,productionDirection:p.productionSignal,
      orderDirection:p.signal,decision:liveDecision.decision,
      reason:liveDecision.reason,samples:liveDecision.samples??null,
      quoteChance:liveDecision.quoteChance??null,
      conservativeNetEdge:liveDecision.conservativeNetEdge??null,
      probabilityNotCalibrated:true}));
    if(liveDecision.decision!=='TRADE'){
      p.state='EV_FILTERED';
      p.blockReason='DEEPSEEK_AI_NO_TRADE';
      p.error='AI决策 NO_TRADE：'+liveDecision.reason+
        '；真实行情有方向，但当前成交价或官方历史证据不足，不提交币安订单。';
      return {status:409,body:{ok:false,decision:'NO_TRADE',
        reason:liveDecision.reason,error:p.error,
        samples:liveDecision.samples??0,quoteChance:liveDecision.quoteChance??null,
        conservativeNetEdge:liveDecision.conservativeNetEdge??null}};
    }
  }

"""
s=s.replace(needle,block+needle,1)
assert "source = \"import {decideLiveTradeValue} from './live-trade-value-policy.mjs';\\n\" + source;" in s
assert s.count("if (isAuto && p.signalModelChoice===SELECTIVE8_MODEL)")==1
assert s.count(needle)==1
Path(sys.argv[2]).write_text(s)
print('LIVE_DEEPSEEK_VALUE_GATE_ADDED=true')

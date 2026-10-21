#!/usr/bin/env python3
"""Remove the two newer economic decision vetoes from the existing Binance order submit.
The restored DeepSeek files are taken from the actual pre-upgrade server backup,
not an unrelated checkout. Quote freshness/duplicate-submission rules remain.
"""
from pathlib import Path
import sys
assert len(sys.argv)==3,'USAGE: patch_restore_25s_direction_orders.py LIVE_WRAPPER OUT_WRAPPER'
src,dst=map(Path,sys.argv[1:])
s=src.read_text()
ai_begin="  // DeepSeek alone makes the economic decision to TRADE or NO_TRADE."
next_step="  if (remainingMs !== null && remainingMs < 1200) {"
assert s.count(ai_begin)==1,'UNKNOWN_AI_GATE_SOURCE'
assert s.count(next_step)==1,'UNKNOWN_ORDER_QUOTE_FLOW'
a=s.index(ai_begin);b=s.index(next_step,a)
assert 0<b-a<5500,'UNKNOWN_AI_GATE_LENGTH'
block=s[a:b]
assert 'deepseek_direct_trade_choice' in block and 'MODEL_OR_QUOTE_EVIDENCE_UNVERIFIED' in block
s=s[:a]+"""  // Genuine DeepSeek 25s UP/DOWN signal triggers normal order handling.
  // Fresh Binance quote, signal/round integrity, quote TTL and duplicate protection stay active.
"""+s[b:]
# This preview was introduced only for the now-removed economic decision and
# could generate extra signed quote calls. Remove it rather than leaving it live.
start='// Current-round executable quote previews for DeepSeek\'s existing 25s analysis.'
end='// Economic TRADE / NO_TRADE decisions are now solely made by DeepSeek.'
assert s.count(start)==1 and s.count(end)==1,'QUOTE_PREVIEW_CODE_DRIFT'
a=s.index(start);b=s.index(end,a)
assert 0<b-a<6500,'UNKNOWN_PREVIEW_BODY'
s=s[:a]+s[b+len(end):]
# Remove associated loopback quote endpoint injection without touching /healthz.
start='const aiQuoteRoute=String.raw'
end='source=source.replace(marker,aiQuoteRoute+marker);'
assert s.count(start)==1 and s.count(end)==1,'QUOTE_PREVIEW_ROUTE_DRIFT'
a=s.index(start);b=s.index(end,a)
assert 0<b-a<1800
s=s[:a]+s[b+len(end):]
# Obsolete error state belongs solely to the removed DeepSeek veto.
start="}else if(currentPending.state==='AI_NO_TRADE'||currentPending.state==='AI_UNAVAILABLE'){"
end="}else if(currentPending.state==='PREPARE_ERROR'"
assert s.count(start)==1 and s.count(end)==1,'AI_GATE_UI_DRIFT'
a=s.index(start);b=s.index(end,a)
assert 0<b-a<850
s=s[:a]+s[b:]
# The previous statistical edge filter was already removed and must stay gone.
for v in ('deepseek_direct_trade_choice','deepseek_live_trade_value',
          'MODEL_OR_QUOTE_EVIDENCE_UNVERIFIED','decideLiveTradeValue',
          'EV_FILTER_ENABLED','getLiveAiQuotePreview','aiQuoteRoute',
          'AI_NO_TRADE','AI_UNAVAILABLE'):
 assert v not in s,'REMOVAL_INCOMPLETE_'+v
for v in ('getFreshQuote(p._internal)','selectedSignalMatches(p)',
          'claimOrderSubmitAttempt','orderSubmitWindowOpen',
          'quoteRemainingMs','if (remainingMs !== null && remainingMs < 1200)'):
 assert v in s,'IMPORTANT_ORDER_SAFETY_RULE_MISSING_'+v
dst.write_text(s)
print('RESTORE_DIRECTION_ONLY_25S_ORDER_GATE_PATCH_READY=true')

#!/usr/bin/env python3
"""Strict additive upgrade to deployed lifetime-counter learner.
Protect totalPredictions/totalSettled/totalHits and existing official records.
"""
from pathlib import Path
import sys
if len(sys.argv)!=2:raise SystemExit('USAGE: learner_lifetime_compatible_patch.py local-file')
p=Path(sys.argv[1]);s=p.read_text()
def replace_exact(old,new):
 global s
 count=s.count(old)
 if count!=1:raise SystemExit('LEARNER_LIVE_ANCHOR_MISMATCH count='+str(count)+' needle='+old[:55])
 s=s.replace(old,new,1)
assert 'function ensureLifetimeCounters(data)' in s,'NOT_LIFETIME_COUNTERS_BASELINE'
assert 'state.totalPredictions++' in s and 'state.totalSettled++' in s and 'state.totalHits++' in s
assert 'caseSnapshot(' not in s and 'retrieveOfficialCases(' not in s,'EXISTING_EPISODIC_CODE_ABORT'
replace_exact("import path from 'node:path';","import path from 'node:path';\nimport {caseSnapshot,retrieveOfficialCases} from './deepseek-5m-episodic-memory.mjs';")
replace_exact("   attemptCount:attempts,\n   actual:null,settledAt:null",
 "   attemptCount:attempts,\n   // Original lock-time feature vector, never reconstructed from future prices.\n   caseFeatures:caseSnapshot(features),reason:String(signal.latest.reason||'').slice(0,100),\n   actual:null,settledAt:null")
replace_exact("   predictions:state.predictions.length,unsettled:state.predictions.length-settled.length,",
 "   predictions:state.predictions.length,unsettled:state.predictions.length-settled.length,\n   comparableOfficialCases:settled.filter(x=>Array.isArray(x.caseFeatures)&&x.caseFeatures.length===12).length,\n   similarCaseMinimum:50,")
replace_exact("  const key=regime(features),subset=stats.regimes[key];",
 "  const key=regime(features),subset=stats.regimes[key];\n  const episodicMemory=retrieveOfficialCases(state.predictions,features);")
replace_exact("  return {usable:true,samples:stats.officialSamples,regime:key,",
 "  return {usable:true,samples:stats.officialSamples,regime:key,episodicMemory,")
replace_exact(" function history(limit=80){",
 " function qualitySnapshotEvidence(){\n  return state.predictions.filter(p=>Array.isArray(p.caseFeatures)&&p.caseFeatures.length===12).map(p=>({\n   round:p.round,direction:p.direction,signalAt:p.signalAt,caseFeatures:p.caseFeatures.slice()}));\n }\n function history(limit=80){")
replace_exact(" return {record,settle,summary,feedback,history};",
 " return {record,settle,summary,feedback,history,qualitySnapshotEvidence};")
assert 'allOfficialHits:state.totalHits' in s and 'allOfficialAccuracy:' in s
assert 'state.totalPredictions++' in s and 'state.totalSettled++' in s and 'state.totalHits++' in s
p.write_text(s)
print('LIVE_LEARNER_LIFETIME_COUNTERS_PRESERVED=true')
print('LIVE_LEARNER_EPISODIC_AND_SNAPSHOT_SUPPORT_ADDED=true')

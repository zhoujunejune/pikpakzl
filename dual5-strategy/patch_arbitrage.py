#!/usr/bin/env python3
"""Patch only independent Binance dual5 execution file. Never touch the single bot."""
from pathlib import Path
import argparse
import os
import sys

MARKER = "DUAL5_ARB_EDGE_GATE_V2_20261028"

def patch(src: str) -> str:
    if MARKER in src:
        return src
    replacements = [
        (
            "const MIN_EDGE=0.08; // $0.08 minimum remaining after conservative fee and execution reserve",
            "const MIN_EDGE=0.02; // $0.02 minimum net after quoted fees and execution reserve; see 1% stake gate",
        ),
        (
            "const ENTRY_WINDOW_MS=15000,CONFIRM_WINDOW_MS=12000;",
            "const ENTRY_WINDOW_MS=ROUND_MS-DEADLINE_BUFFER_MS,CONFIRM_WINDOW_MS=12000;",
        ),
        (
            "const cadence=elapsed<15000?700:(elapsed<60000?3000:19000);",
            "const cadence=elapsed<15000?700:(elapsed<60000?1800:2500);",
        ),
        (
            "   if(!estimate.ok){state.health='INVALID_PAIR_QUOTES';return}\n   if(!config.armed){state.health='OPPORTUNITY_OBSERVED_TRADING_OFF';return}",
            "   if(!estimate.ok){state.health='INVALID_PAIR_QUOTES';return}\n"
            "   // " + MARKER + ": never buy two sides without sufficient conservative paired edge.\n"
            "   const requiredEdge=Math.max(MIN_EDGE,0.01*(config.amounts.UP+config.amounts.DOWN));\n"
            "   state.lastOpportunity.requiredNetEdgeUSDT=Number(requiredEdge.toFixed(4));\n"
            "   state.lastOpportunity.strategyMode='ARBITRAGE';\n"
            "   state.lastOpportunity.status=(estimate.feasible&&estimate.conservativeNet>=requiredEdge)?'POSITIVE_EDGE':'EDGE_BELOW_REQUIRED';\n"
            "   if(!config.armed){state.health='OPPORTUNITY_OBSERVED_TRADING_OFF';return}\n"
            "   if(!estimate.feasible||estimate.conservativeNet<requiredEdge){state.health='ARBITRAGE_EDGE_TOO_LOW_NO_ORDER';return;}",
        ),
    ]
    for old, new in replacements:
        count=src.count(old)
        if count!=1:
            raise ValueError(f"PATCH_CONTEXT_MISMATCH expected 1 got {count} anchor={old[:45]!r}")
        src=src.replace(old,new,1)
    return src

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('target')
    parser.add_argument('--dry-run',action='store_true')
    args=parser.parse_args()
    target=Path(args.target)
    if target.resolve()!=Path('/opt/zl-prediction-dual5/binance_dual5_pairs.mjs'):
        print('DUAL_ONLY_TARGET_REQUIRED')
        return 2
    original=target.read_text(encoding='utf-8')
    updated=patch(original)
    if updated==original:
        print('DUAL_PATCH_ALREADY_INSTALLED')
        return 0
    if args.dry_run:
        print('DUAL_PATCH_CONTEXT_VALID',len(original),len(updated))
        return 0
    tmp=target.with_suffix('.mjs.stage-v2')
    tmp.write_text(updated,encoding='utf-8')
    tmp.chmod(target.stat().st_mode & 0o777)
    os.chown(tmp,target.stat().st_uid,target.stat().st_gid)
    os.replace(tmp,target)
    print('DUAL_PATCH_APPLIED',MARKER)
    return 0

if __name__=='__main__':
    sys.exit(main())

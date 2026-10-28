#!/usr/bin/env python3
"""V3: repair the literal-backslash-n comment bug in the isolated dual5 execution path."""
from pathlib import Path
import argparse
import os
import re
import sys

OLD = "DUAL5_ARB_EDGE_GATE_V2_20261028"
NEW = "DUAL5_ARB_EDGE_GATE_V3_20261028"
GUARD = """  // DUAL5_ARB_EDGE_GATE_V3_20261028: second invariant immediately before any live buy.
  const minimumEdgeAtSubmit=Math.max(MIN_EDGE,0.01*(config.amounts.UP+config.amounts.DOWN));
  if(!analysis?.ok||analysis.feasible!==true||!Number.isFinite(analysis.conservativeNet)||
     analysis.conservativeNet<minimumEdgeAtSubmit){
    state.health='ARBITRAGE_EDGE_TOO_LOW_NO_ORDER';return;
  }
"""

def repair(src: str) -> str:
    if NEW in src:
        verify(src)
        return src
    if src.count(OLD) != 1:
        raise ValueError("EXPECTED_EXACT_V2_BROKEN_MARKER")
    rows = src.splitlines(keepends=True)
    index = next((i for i, row in enumerate(rows) if OLD in row), None)
    if index is None:
        raise ValueError("MISSING_V2_BROKEN_ROW")
    broken = rows[index]
    if not broken.lstrip().startswith("//"):
        raise ValueError("V2_MARKER_NOT_IN_COMMENT")
    if broken.count(r"\n") != 6:
        raise ValueError("V2_COMMENT_ESCAPE_COUNT_UNEXPECTED")
    for expected in ("const requiredEdge=", "if(!estimate.feasible||estimate.conservativeNet<requiredEdge)",
                     "if(!config.armed)", "ARBITRAGE_EDGE_TOO_LOW_NO_ORDER"):
        if expected not in broken:
            raise ValueError("INCOMPLETE_BROKEN_V2_GUARD_"+expected[:16])
    rows[index] = broken.replace(r"\n", "\n")
    fixed = "".join(rows)
    old_gate = "  if(!config.armed||config.blocked||config.lastOrderRound===round)return;"
    if fixed.count(old_gate) != 1:
        raise ValueError("SUBMIT_ENTRY_ANCHOR_NOT_UNIQUE")
    fixed = fixed.replace(old_gate, old_gate + "\n" + GUARD.rstrip("\n"), 1)
    verify(fixed)
    return fixed

def verify(src: str) -> None:
    if src.count(NEW) != 1 or src.count(OLD) != 1:
        raise ValueError("V3_DUAL_MARKERS_INVALID")
    rows=src.splitlines()
    if any(r"\n" in row for row in rows if OLD in row or NEW in row):
        raise ValueError("GUARD_STILL_COMMENTED_BY_LITERAL_NEWLINES")
    required=[r"^\s*const requiredEdge=Math\.max\(MIN_EDGE,",
              r"^\s*if\(!estimate\.feasible\|\|estimate\.conservativeNet<requiredEdge\)",
              r"^\s*const minimumEdgeAtSubmit=Math\.max\(MIN_EDGE,",
              r"^\s*if\(!analysis\?\.ok\|\|analysis\.feasible!==true"]
    for pattern in required:
        matches=re.findall(pattern,src,re.M)
        if len(matches)!=1:
            raise ValueError("LIVE_GUARD_NOT_EXECUTABLE_OR_DUPLICATED_"+pattern[:27])
    if src.index("const minimumEdgeAtSubmit") > src.index("const up=await place(wallet,topic,q1,fundingSource)"):
        raise ValueError("GUARD_AFTER_LIVE_ORDER")
    if src.index("const requiredEdge") > src.index("await attemptPair(round,topic,pair,q1,q2,estimate,wallet)"):
        raise ValueError("SCAN_GUARD_AFTER_LIVE_ORDER")
    if "const conservativeNet=shares-upAmount-downAmount-f1-f2-0.025;" not in src:
        raise ValueError("ESTIMATE_FORMULA_CHANGED")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--dry-run",action="store_true")
    args=ap.parse_args()
    p=Path(args.target)
    if p.resolve()!=Path("/opt/zl-prediction-dual5/binance_dual5_pairs.mjs"):
        print("DUAL5_SCOPE_VIOLATION_ABORT");return 2
    orig=p.read_text(encoding="utf-8")
    patched=repair(orig)
    if args.dry_run:
        print("DUAL5_V3_PATCH_PREFLIGHT_OK",len(orig),len(patched));return 0
    if patched==orig:
        print("DUAL5_V3_PATCH_ALREADY_PRESENT");return 0
    tmp=p.with_suffix(".mjs.stage-v3")
    tmp.write_text(patched,encoding="utf-8")
    os.chmod(tmp,p.stat().st_mode & 0o777)
    os.chown(tmp,p.stat().st_uid,p.stat().st_gid)
    os.replace(tmp,p)
    print("DUAL5_V3_PATCH_APPLIED")
    return 0

if __name__=="__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Read-only independent settlement reconciliation. No network, trades or credentials.

Usage: python3 scripts/audit_strict_forward.py locks.csv official.csv
Required locks columns: round_id,model,direction,locked_at
Required official columns: round_id,official_direction,settled_at,source_reference
All timestamps ISO-8601 with timezone. Official source must be collected independently.
"""
import csv
import datetime as dt
import json
import sys
from collections import Counter, defaultdict

def timestamp(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timezone required")
    return parsed.astimezone(dt.timezone.utc)

def read(path, fields):
    with open(path, newline="", encoding="utf-8-sig") as stream:
        reader = csv.DictReader(stream)
        if not fields.issubset(set(reader.fieldnames or [])):
            raise ValueError(f"{path}: missing columns {sorted(fields - set(reader.fieldnames or []))}")
        return list(reader)

def audit(locks, settlements):
    official = defaultdict(list)
    for row in settlements:
        official[row["round_id"]].append(row)
    lock_ids = Counter(row["round_id"] for row in locks)
    outcomes = []
    for row in locks:
        rid = row["round_id"]
        matches = official.get(rid, [])
        issues = []
        if lock_ids[rid] != 1:
            issues.append("DUPLICATE_LOCK")
        if len(matches) != 1:
            issues.append("MISSING_OFFICIAL" if not matches else "DUPLICATE_OFFICIAL")
        if row["direction"] not in ("UP", "DOWN"):
            issues.append("INVALID_LOCK_DIRECTION")
        if matches:
            settlement = matches[0]
            if settlement["official_direction"] not in ("UP", "DOWN"):
                issues.append("INVALID_OFFICIAL_DIRECTION")
            if not settlement["source_reference"].strip():
                issues.append("MISSING_OFFICIAL_PROVENANCE")
            try:
                if timestamp(row["locked_at"]) >= timestamp(settlement["settled_at"]):
                    issues.append("LOCK_NOT_BEFORE_SETTLEMENT")
            except ValueError:
                issues.append("INVALID_TIMESTAMP")
        result = "UNVERIFIED" if issues else ("HIT" if row["direction"] == matches[0]["official_direction"] else "MISS")
        outcomes.append(dict(round_id=rid, model=row["model"], direction=row["direction"], result=result, issues=issues))
    summary = defaultdict(Counter)
    for row in outcomes:
        summary[(row["model"], row["direction"])][row["result"]] += 1
    return {"records": outcomes, "summary": [
        {"model": model, "direction": direction, **dict(counts)}
        for (model, direction), counts in sorted(summary.items())
    ], "unmatched_official_rounds": sorted(set(official) - set(lock_ids))}

def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: audit_strict_forward.py locks.csv official.csv")
    locks = read(sys.argv[1], {"round_id", "model", "direction", "locked_at"})
    official = read(sys.argv[2], {"round_id", "official_direction", "settled_at", "source_reference"})
    result = audit(locks, official)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if any(row["result"] == "UNVERIFIED" for row in result["records"]):
        raise SystemExit(2)

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Read-only, privacy-bounded DeepSeek 5m forward-performance inspector.

No orders, deployment, secrets, service restarts, or modifications to production.
Run from GitHub Actions with pre-existing panel credentials. Only summaries print.
"""
from __future__ import annotations

import base64
import json
import math
import os
import sys
import urllib.request

OFFICIAL = "BINANCE_PREDICTION_OFFICIAL_RESOLUTION_ONLY"
ROOT = "https://prediction.47-237-188-69.sslip.io"
TIME_BANDS = ((0, 60), (60, 120), (120, 180), (180, 240), (240, 270))


def number(x):
    return isinstance(x, (float, int)) and not isinstance(x, bool) and math.isfinite(x)


def wilson95(hits, count):
    if not count:
        return None
    z = 1.96
    p = hits / count
    center = (p + z * z / (2 * count)) / (1 + z * z / count)
    half = z * math.sqrt((p * (1 - p) + z * z / (4 * count)) / count) / (1 + z * z / count)
    return [round(max(0, center - half), 4), round(min(1, center + half), 4)]


def scalar(row, name):
    v = row.get(name)
    # The production API supplies epoch milliseconds as integers.
    return int(v) if number(v) else None


def assess(history, model_status, choice):
    records = history.get("records")
    if not isinstance(records, list):
        raise ValueError("HISTORY_RECORDS_MISSING")
    source = history.get("officialSource")
    if source != OFFICIAL:
        raise ValueError("UNKNOWN_OFFICIAL_RESOLUTION_SOURCE")
    if model_status.get("model") != "DEEPSEEK_5M_V1" or choice.get("model") != "DEEPSEEK_5M_V1":
        raise ValueError("PRODUCTION_MODEL_MISMATCH")
    if model_status.get("configured") is not True:
        raise ValueError("DEEPSEEK_NOT_CONFIGURED")
    seen = set()
    valid = []
    rejected = {"duplicateRound": 0, "invalidOrNonCausalRecord": 0, "unsettled": 0}
    providers = set()
    for row in records:
        if not isinstance(row, dict):
            rejected["invalidOrNonCausalRecord"] += 1
            continue
        r, at, settled = (scalar(row, k) for k in ("round", "signalAt", "settledAt"))
        direction, actual = row.get("direction"), row.get("actual")
        if not number(r) or r % 300000 != 0 or not number(at) or not (r <= at < r + 270000) or direction not in ("UP", "DOWN"):
            rejected["invalidOrNonCausalRecord"] += 1
            continue
        if r in seen:
            rejected["duplicateRound"] += 1
            continue
        seen.add(r)
        if actual not in ("UP", "DOWN") or not number(settled):
            rejected["unsettled"] += 1
            continue
        if settled < r + 300000:
            rejected["invalidOrNonCausalRecord"] += 1
            continue
        elapsed = (at - r) / 1000
        valid.append((elapsed, direction, actual))
        if isinstance(row.get("provider"), str):
            providers.add(row["provider"][:40])
    def group(items):
        n = len(items)
        hits = sum(d == a for _, d, a in items)
        return {"n": n, "hits": hits, "hitRate": round(hits / n, 4) if n else None,
                "wilson95": wilson95(hits, n), "insufficientSample": n < 30}
    timing = [{"windowSec": [lo, hi], **group([item for item in valid if lo <= item[0] < hi])}
              for lo, hi in TIME_BANDS]
    learning = model_status.get("learning") or {}
    end, beginning = model_status.get("decisionWindowEndMs"), model_status.get("round")
    decision_window = int(end - beginning) if number(end) and number(beginning) else None
    return {
        "auditMode": "READ_ONLY_NO_ORDERS",
        "model": model_status.get("model"),
        "provider": model_status.get("providerModel"),
        "dynamicWindowMs": decision_window,
        "maxCallsPerRound": model_status.get("maxCallsPerRound"),
        "recordsExamined": len(records),
        "recordsLimitWarning": "History endpoint is capped at 100; results may omit older outcomes",
        "causalSettled": group(valid),
        "timingByLockSecond": timing,
        "up": group([x for x in valid if x[1] == "UP"]),
        "down": group([x for x in valid if x[1] == "DOWN"]),
        "rejectedOrUnavailable": rejected,
        "providerVersionsPresent": sorted(providers),
        "learning": {
            "officialSamplesReported": learning.get("allOfficialSamples"),
            "predictionsReported": learning.get("predictions"),
            "deepseekWeightsFineTuned": learning.get("modelWeightsFineTuned"),
            "shadowWeightTrainingConfirmed": False
        },
        "tradeEconomics": {
            "netProfit": None, "expectedValue": None,
            "reason": "No verified executable prediction quote, calibrated probability, or exchange-confirmed fill joined by immutable order ID."
        },
        "caveats": [
            "Time bands are observational; selection effects mean higher late hit-rate need not improve profits.",
            "LLM confidence is NOT a calibrated win probability.",
            "Research-only aggregate results NEVER authorize model promotion or real-order changes."
        ]
    }


def authorized_get(route, password):
    token = base64.b64encode(("zl:" + password).encode()).decode()
    request = urllib.request.Request(ROOT + route, headers={
        "Authorization": "Basic " + token,
        "Accept": "application/json",
        "Cache-Control": "no-store",
        "User-Agent": "ZL-DeepSeek-ReadOnly-Audit/1"
    }, method="GET")
    with urllib.request.urlopen(request, timeout=22) as response:
        if response.status != 200:
            raise RuntimeError("NON_OK_READ")
        return json.load(response)


def main():
    secret = os.environ.get("ZL_PANEL_PASSWORD")
    if not secret:
        raise ValueError("PANEL_PASSWORD_NOT_SET")
    status = authorized_get("/deepseek/api/status", secret)
    history = authorized_get("/deepseek/api/history?limit=100", secret)
    choice = authorized_get("/api/order-signal-model", secret)
    report = assess(history, status, choice)
    print("DEEPSEEK_SHADOW_READONLY_REPORT=" + json.dumps(report, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Never log raw network responses or Authorization header.
        print("DEEPSEEK_SHADOW_READONLY_FAILED=" + type(e).__name__, file=sys.stderr)
        sys.exit(1)

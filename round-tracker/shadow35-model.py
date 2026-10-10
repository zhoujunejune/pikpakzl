#!/usr/bin/env python3
"""Frozen, calibrated five-minute probability candidate; never affects production.

Protocol: python3 shadow35-model.py train|predict; JSON on stdin, one final
SHADOW35_RESULT=<JSON> line on stdout. All persisted paths are local artifacts.
Training labels come only from strictly aligned official settlement events.
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import os
import sys
import tempfile
import time

ENGINE_VERSION = "LOCK_QUALITY_SELECTIVE_V7_5"
FEATURE_VERSION = "shadow35-features-v1"
SCHEMA_VERSION = 1
ROUND_MS = 300000
DEADLINE_MS = 35000
CHECKPOINTS_MS = (15000, 20000, 25000, 30000, 35000)
FREEZE_MS = 30 * 24 * 60 * 60 * 1000
MIN_ROUNDS = 300
MAX_FACT_AGE_MS = 1000
OFFICIAL_SOURCE = "BINANCE_PREDICTION_OFFICIAL_RESOLUTION"
PRODUCTION_EFFECT = "NONE_SHADOW_ONLY"
RAW_FEATURE_NAMES = (
    "currentScore", "currentTrendScore", "microScore", "regimeScore",
    "regimeAgreement", "liveScore", "distanceFromOpenBps",
    "normalizedMomentum5s", "normalizedMomentum15s", "normalizedMomentum30s",
    "normalizedMomentum60s", "normalizedMomentum180s", "normalizedMomentum300s",
    "tradePressure15s", "tradePressure60s", "ofiNormalized5s",
    "rangePosition180", "predictionMarketUpMid", "tradeCount5s", "tradeCount15s",
    "vol5sRms60", "vol5sRms300", "spreadBps", "absorptionRisk",
)
FEATURE_NAMES = ("elapsedSeconds",) + RAW_FEATURE_NAMES
SCHEMA_FINGERPRINT = hashlib.sha256(json.dumps({
    "featureVersion": FEATURE_VERSION, "featureNames": FEATURE_NAMES,
    "checkpointsMs": CHECKPOINTS_MS, "deadlineMs": DEADLINE_MS,
    "labelSource": OFFICIAL_SOURCE, "policy": "FIRST_QUALIFIED_CHECKPOINT",
}, sort_keys=True).encode()).hexdigest()


def finite(value):
    """JSON null, booleans and numeric-looking strings are not measurements."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def epoch_ms(value):
    number = finite(value)
    return int(number) if number is not None and number >= 0 and number.is_integer() else None


def valid_round(value):
    number = epoch_ms(value)
    return number if number is not None and number % ROUND_MS == 0 else None


def vector(features, checkpoint_ms):
    checkpoint = finite(checkpoint_ms)
    if not isinstance(features, dict) or checkpoint not in CHECKPOINTS_MS:
        return None
    values = [finite(features.get(name)) for name in RAW_FEATURE_NAMES]
    # A no-direction V6 round is welcome; an entirely absent feed is not.
    if sum(value is not None for value in values) < 4:
        return None
    return [checkpoint / 1000.0] + [float("nan") if x is None else x for x in values]


def snapshot_vector(event):
    if not isinstance(event, dict) or event.get("type") != "snapshot":
        return None, "INVALID_EVENT_TYPE"
    if event.get("schemaVersion") != SCHEMA_VERSION:
        return None, "UNSUPPORTED_SCHEMA"
    if event.get("valid") is not True:
        return None, "INPUT_MARKED_INVALID"
    start = valid_round(event.get("roundStartMs"))
    observed = epoch_ms(event.get("observedAt"))
    calculated = epoch_ms(event.get("factsCalculatedAt"))
    checkpoint = finite(event.get("checkpointMs"))
    if None in (start, observed, calculated) or checkpoint not in CHECKPOINTS_MS:
        return None, "INVALID_TIMING"
    # Collection may happen just before the nominal checkpoint to reserve time
    # for inference. It cannot borrow a later snapshot or pass the hard deadline.
    elapsed = observed - start
    window_start = checkpoint if checkpoint < DEADLINE_MS else DEADLINE_MS - 1000
    if elapsed < window_start or elapsed > min(checkpoint + 1000, DEADLINE_MS):
        return None, "OUTSIDE_CHECKPOINT_DEADLINE"
    if calculated > observed or calculated < start + window_start - 1000 or observed - calculated > MAX_FACT_AGE_MS:
        return None, "STALE_OR_FUTURE_FACTS"
    result = vector(event.get("features"), checkpoint)
    if result is not None:
        result[0] = elapsed / 1000.0
    return (result, None) if result is not None else (None, "INSUFFICIENT_FEATURES")


def read_events(path, as_of):
    """Every official settled round counts, including rounds with no snapshots."""
    records = collections.defaultdict(lambda: {"label": None, "snapshots": []})
    diagnostics = collections.Counter()
    conflicts = set()
    with open(path, "r", encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except (ValueError, TypeError):
                diagnostics["invalidJson"] += 1
                continue
            if not isinstance(event, dict):
                diagnostics["invalidEvents"] += 1
                continue
            start = valid_round(event.get("roundStartMs"))
            if start is None:
                diagnostics["invalidRounds"] += 1
                continue
            item = records[start]
            if event.get("type") == "settlement":
                actual = event.get("actual")
                evidence = event.get("resolutionEvidence")
                settled = epoch_ms(event.get("settledAt"))
                recorded = epoch_ms(event.get("recordedAt", event.get("settledAt")))
                if (actual not in ("UP", "DOWN") or event.get("actualSource") != OFFICIAL_SOURCE
                        or not isinstance(evidence, str) or "STRICT_ROUND_ALIGNED_TOPIC" not in evidence
                        or ("OFFICIAL_" + str(actual) + ":") not in evidence
                        or settled is None or recorded is None or settled < start + ROUND_MS):
                    diagnostics["invalidOfficialLabels"] += 1
                    continue
                if max(settled, recorded) > as_of:
                    diagnostics["futureLabelsRejected"] += 1
                    continue
                label = {"actual": actual, "y": int(actual == "UP"), "settledAt": max(settled, recorded)}
                if item["label"] and item["label"]["actual"] != actual:
                    conflicts.add(start)
                    diagnostics["conflictingOfficialLabels"] += 1
                elif item["label"] is None or label["settledAt"] < item["label"]["settledAt"]:
                    item["label"] = label
            elif event.get("type") == "snapshot":
                row, reason = snapshot_vector(event)
                observed = epoch_ms(event.get("observedAt"))
                if row is None or observed is None or observed > as_of:
                    diagnostics["invalidSnapshots"] += 1
                    diagnostics[reason or "FUTURE_SNAPSHOT"] += 1
                    continue
                item["snapshots"].append({"x": row, "checkpointMs": int(event["checkpointMs"]),
                                          "observedAt": observed})
            elif event.get("type") == "round_final":
                # The official settlement is still required; a round_final never
                # supplies a label and never removes a WAIT from the denominator.
                diagnostics["finalEvents"] += 1
            else:
                diagnostics["unknownEventTypes"] += 1
    # Calendar-complete denominator across the expired observed history span.
    # A missing or conflicting official label is an explicit unknown/WAIT,
    # never silently deleted and never replaced with a spot-price label.
    expired = sorted(start for start in records if start + ROUND_MS <= as_of)
    rounds = []
    if expired:
        span = (expired[-1] - expired[0]) // ROUND_MS + 1
        if span > 200000:
            raise ValueError("UNREASONABLE_CALENDAR_SPAN")
        for start in range(expired[0], expired[-1] + ROUND_MS, ROUND_MS):
            item = records.get(start)
            label = item["label"] if item is not None and start not in conflicts else None
            if label is None:
                diagnostics["unknownLabelRounds"] += 1
                rounds.append({"roundStartMs": start, "actual": None, "y": None,
                               "settledAt": None, "snapshots": []})
                continue
            snapshots = sorted(item["snapshots"], key=lambda s: (s["checkpointMs"], s["observedAt"]))
            unique = {}
            for snap in snapshots:
                unique.setdefault(snap["checkpointMs"], snap)
            rounds.append({"roundStartMs": start, **label, "snapshots": list(unique.values())})
    diagnostics["unsettledFutureRounds"] = sum(start + ROUND_MS > as_of for start in records)
    diagnostics["officialSettledRounds"] = sum(r["actual"] in ("UP", "DOWN") for r in rounds)
    diagnostics["calendarRounds"] = len(rounds)
    diagnostics["roundsWithoutValidSnapshots"] = sum(not r["snapshots"] for r in rounds)
    return rounds, dict(diagnostics)


def purge_before(rounds, next_start):
    # Both nominal label horizon and actual label availability must precede the
    # next fold. Strict inequality drops at least one full 5-minute boundary.
    return [r for r in rounds if r["roundStartMs"] + ROUND_MS < next_start
            and (r["settledAt"] is None or r["settledAt"] < next_start)]


def chronological_split(rounds):
    n = len(rounds)
    first, second = int(n * 0.6), int(n * 0.8)
    train, calibration, holdout = rounds[:first], rounds[first:second], rounds[second:]
    if not train or not calibration or not holdout:
        raise ValueError("INSUFFICIENT_CHRONOLOGICAL_FOLDS")
    train = purge_before(train, calibration[0]["roundStartMs"])
    calibration = purge_before(calibration, holdout[0]["roundStartMs"])
    # Probability calibration is internal to the 60% training fold. The outer
    # 20% calibration fold is used solely to choose the first-pass policy.
    cut = int(len(train) * 0.8)
    probability_calibration = train[cut:]
    fit = purge_before(train[:cut], probability_calibration[0]["roundStartMs"])
    if not fit or not probability_calibration:
        raise ValueError("INSUFFICIENT_PROBABILITY_CALIBRATION_FOLD")
    return {"train": train, "fit": fit, "probabilityCalibration": probability_calibration,
            "calibration": calibration, "holdout": holdout}


def fold_range(rounds):
    return {"rounds": len(rounds), "roundsWithSnapshots": sum(bool(r["snapshots"]) for r in rounds),
            "startRoundMs": rounds[0]["roundStartMs"] if rounds else None,
            "endRoundMs": rounds[-1]["roundStartMs"] if rounds else None,
            "latestSettledAt": max((r["settledAt"] for r in rounds if r["settledAt"] is not None), default=None)}


def flatten(rounds):
    rows, labels, weights = [], [], []
    for item in rounds:
        if item["y"] is None:
            continue
        count = len(item["snapshots"])
        for snap in item["snapshots"]:
            rows.append(snap["x"])
            labels.append(item["y"])
            weights.append(1.0 / count)
    return rows, labels, weights


def wilson(hits, count):
    if not count:
        return None
    z = 1.959963984540054
    p, z2 = hits / count, z * z
    middle = (p + z2 / (2 * count)) / (1 + z2 / count)
    radius = z * math.sqrt(p * (1 - p) / count + z2 / (4 * count * count)) / (1 + z2 / count)
    return [max(0.0, middle - radius), min(1.0, middle + radius)]


def replay(rounds, probabilities, threshold):
    """Lock the first qualifying checkpoint, never the most accurate one."""
    predictions = []
    for item in rounds:
        decision = None
        for snap, probability in zip(item["snapshots"] if item["actual"] in ("UP", "DOWN") else [], probabilities.get(item["roundStartMs"], [])):
            p = finite(probability)
            if p is None or not 0 <= p <= 1:
                continue
            if max(p, 1 - p) >= threshold:
                decision = {"direction": "UP" if p >= 0.5 else "DOWN", "probability": p,
                            "checkpointMs": snap["checkpointMs"]}
                break
        predictions.append({"roundStartMs": item["roundStartMs"], "actual": item["actual"],
                            "decision": decision})
    return metrics(predictions)


def metrics(predictions):
    decisions = [p for p in predictions if p["decision"] is not None]
    hits = sum(p["decision"]["direction"] == p["actual"] for p in decisions)
    n, d = len(predictions), len(decisions)
    by_day = collections.defaultdict(lambda: {"rounds": 0, "decisions": 0, "hits": 0})
    by_direction = {}
    checkpoints = collections.Counter()
    for p in predictions:
        day = dt.datetime.fromtimestamp(p["roundStartMs"] / 1000, tz=dt.timezone.utc).date().isoformat()
        row = by_day[day]
        row["rounds"] += 1
        if p["decision"] is not None:
            row["decisions"] += 1
            row["hits"] += int(p["decision"]["direction"] == p["actual"])
            checkpoints[str(p["decision"]["checkpointMs"])] += 1
    for direction in ("UP", "DOWN"):
        subset = [p for p in decisions if p["decision"]["direction"] == direction]
        correct = sum(p["actual"] == direction for p in subset)
        by_direction[direction] = {"decisions": len(subset), "hits": correct,
                                   "accuracy": correct / len(subset) if subset else None}
    labelled = sum(p["actual"] in ("UP", "DOWN") for p in predictions)
    return {"rounds": n, "officialLabelRounds": labelled, "unknownLabelRounds": n - labelled,
            "decisions": d, "hits": hits, "waitRounds": n - d,
            "accuracy": hits / d if d else None, "coverage": d / n if n else None,
            "accuracyWilson95": wilson(hits, d), "coverageWilson95": wilson(d, n),
            "byDirection": by_direction, "checkpointDecisions": dict(checkpoints),
            "byDay": dict(sorted(by_day.items())), "dailyBlockBootstrap95": daily_block_interval(by_day),
            "replayPolicy": "FIRST_QUALIFIED_CHECKPOINT", "denominator": "ALL_EXPIRED_CALENDAR_ROUNDS_WITH_MISSING_LABELS_AS_WAIT",
            "timingBasis": "CAPTURED_SNAPSHOT_WITHIN_35S_REQUIRES_FORWARD_INFERENCE_VALIDATION"}


def daily_block_interval(by_day):
    # This is a descriptive uncertainty interval, not a guarantee of stationarity.
    if len(by_day) < 7:
        return {"status": "INSUFFICIENT_DAILY_BLOCKS", "days": len(by_day),
                "accuracy": None, "coverage": None}
    import numpy as np
    rows = np.asarray([[x["rounds"], x["decisions"], x["hits"]] for x in by_day.values()], dtype=float)
    rng = np.random.default_rng(20261010)
    indices = rng.integers(0, len(rows), size=(1024, len(rows)))
    totals = rows[indices].sum(axis=1)
    accuracy = totals[:, 2] / np.maximum(totals[:, 1], 1)
    coverage = totals[:, 1] / np.maximum(totals[:, 0], 1)
    return {"status": "AVAILABLE", "days": len(rows), "resamples": 1024,
            "accuracy": np.quantile(accuracy, [0.025, 0.975]).tolist(),
            "coverage": np.quantile(coverage, [0.025, 0.975]).tolist()}


def select_threshold(rounds, probabilities, target_accuracy=0.8, target_coverage=0.5):
    candidates = []
    for i in range(50, 100):
        threshold = i / 100.0
        result = replay(rounds, probabilities, threshold)
        candidates.append({"threshold": threshold, "accuracy": result["accuracy"],
                           "coverage": result["coverage"], "rounds": result["rounds"],
                           "decisions": result["decisions"], "hits": result["hits"]})
    eligible = [row for row in candidates if row["accuracy"] is not None
                and row["accuracy"] >= target_accuracy and row["coverage"] >= target_coverage]
    if eligible:
        chosen = max(eligible, key=lambda row: (row["coverage"], row["accuracy"], row["threshold"]))
        status = "MET_ON_CALIBRATION_ONLY"
    else:
        # An unmet curve does not justify forcing trades or choosing a sparse,
        # lucky point. Continue observing a declared fixed 80% confidence policy.
        chosen = next(row for row in candidates if row["threshold"] == 0.8)
        status = "UNMET"
    frontier = [row for row in candidates if not any(
        other["accuracy"] is not None and row["accuracy"] is not None
        and other["accuracy"] >= row["accuracy"] and other["coverage"] >= row["coverage"]
        and (other["accuracy"] > row["accuracy"] or other["coverage"] > row["coverage"])
        for other in candidates)]
    return {"threshold": chosen["threshold"], "status": status, "selected": chosen,
            "coverageFrontier": frontier, "grid": candidates}


def dependencies():
    try:
        import joblib
        import numpy as np
        from sklearn.impute import SimpleImputer
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import StandardScaler
    except ImportError as exc:
        raise RuntimeError("MISSING_MODEL_DEPENDENCY: " + str(exc)) from exc
    return joblib, np, SimpleImputer, LogisticRegression, Pipeline, StandardScaler


def calibrated_probabilities(model, rows, np):
    base = model["classifier"].predict_proba(np.asarray(rows, dtype=float))[:, 1]
    logits = np.log(np.clip(base, 1e-6, 1 - 1e-6) / np.clip(1 - base, 1e-6, 1 - 1e-6))
    return model["probabilityCalibrator"].predict_proba(logits.reshape(-1, 1))[:, 1]


def predict_rounds(model, rounds, np):
    result = {}
    for item in rounds:
        rows = [snap["x"] for snap in item["snapshots"]]
        result[item["roundStartMs"]] = calibrated_probabilities(model, rows, np).tolist() if rows else []
    return result


def qualification(calibration, holdout, accuracy, coverage):
    block = holdout["dailyBlockBootstrap95"]
    reasons = []
    if holdout["unknownLabelRounds"]:
        reasons.append("HOLDOUT_HAS_UNKNOWN_OFFICIAL_LABELS")
    if calibration["status"] != "MET_ON_CALIBRATION_ONLY":
        reasons.append("CALIBRATION_DUAL_TARGET_UNMET")
    if holdout["accuracy"] is None or holdout["accuracy"] < accuracy:
        reasons.append("HOLDOUT_ACCURACY_UNMET")
    if holdout["coverage"] is None or holdout["coverage"] < coverage:
        reasons.append("HOLDOUT_COVERAGE_UNMET")
    if not holdout["accuracyWilson95"] or holdout["accuracyWilson95"][0] < 0.75:
        reasons.append("HOLDOUT_ACCURACY_WILSON_LOWER_BELOW_75")
    if not holdout["coverageWilson95"] or holdout["coverageWilson95"][0] < coverage:
        reasons.append("HOLDOUT_COVERAGE_WILSON_LOWER_UNMET")
    if block["status"] != "AVAILABLE":
        reasons.append("INSUFFICIENT_HOLDOUT_DAILY_BLOCKS")
    else:
        if block["accuracy"][0] < 0.75:
            reasons.append("HOLDOUT_DAILY_BLOCK_ACCURACY_LOWER_BELOW_75")
        if block["coverage"][0] < coverage:
            reasons.append("HOLDOUT_DAILY_BLOCK_COVERAGE_LOWER_UNMET")
    return {"status": "UNMET" if reasons else "MET", "reasons": reasons,
            "scope": "INDEPENDENT_HOLDOUT_ONLY", "longTermValidated": False,
            "forwardStatus": "FORWARD_VALIDATION_REQUIRED"}


def atomic_json(path, value):
    parent = os.path.dirname(os.path.abspath(path))
    fd, temporary = tempfile.mkstemp(prefix=".shadow35-", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, allow_nan=False)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def train_unlocked(payload):
    path = payload.get("eventsFile")
    model_dir = payload.get("modelDir")
    as_of = epoch_ms(payload.get("asOf"))
    requested_minimum = finite(payload.get("minRounds", MIN_ROUNDS))
    minimum = max(MIN_ROUNDS, int(requested_minimum or MIN_ROUNDS))
    accuracy = finite(payload.get("targetAccuracy", 0.8))
    coverage = finite(payload.get("targetCoverage", 0.5))
    if not isinstance(path, str) or not isinstance(model_dir, str) or as_of is None:
        return {"ok": False, "status": "INVALID_TRAIN_REQUEST", "productionEffect": PRODUCTION_EFFECT}
    if accuracy is None or coverage is None or accuracy < 0.8 or accuracy > 1 or coverage < 0.5 or coverage > 1:
        return {"ok": False, "status": "INVALID_TARGETS", "productionEffect": PRODUCTION_EFFECT}
    os.makedirs(model_dir, exist_ok=True)
    active_path = os.path.join(model_dir, "active-manifest.json")
    if os.path.exists(active_path):
        with open(active_path, encoding="utf-8") as stream:
            existing = json.load(stream)
        frozen = epoch_ms(existing.get("frozenUntilMs"))
        if frozen is not None and as_of < frozen:
            # Recover the same candidate if the process died after writing the
            # artifact but before the Node journal recorded its registration.
            return {"ok": True, **existing, "status": "FROZEN_CANDIDATE_EXISTS"}
    rounds, diagnostics = read_events(path, as_of)
    if diagnostics["officialSettledRounds"] < minimum:
        return {"ok": True, "status": "INSUFFICIENT_SAMPLES", "officialSettledRounds": diagnostics["officialSettledRounds"],
                "calendarRounds": len(rounds), "requiredRounds": minimum, "diagnostics": diagnostics, "productionEffect": PRODUCTION_EFFECT}
    groups = chronological_split(rounds)
    rows, labels, weights = flatten(groups["fit"])
    calibration_rows, calibration_labels, calibration_weights = flatten(groups["probabilityCalibration"])
    if len(rows) < 40 or len(calibration_rows) < 20 or len(set(labels)) < 2 or len(set(calibration_labels)) < 2:
        return {"ok": True, "status": "REJECTED_INSUFFICIENT_FOLD_FEATURES_OR_CLASSES",
                "folds": {name: fold_range(items) for name, items in groups.items()},
                "diagnostics": diagnostics, "productionEffect": PRODUCTION_EFFECT}
    joblib, np, Imputer, Logistic, Pipeline, Scaler = dependencies()
    classifier = Pipeline([("impute", Imputer(strategy="median", add_indicator=True)),
                           ("scale", Scaler()), ("logistic", Logistic(max_iter=800, C=0.3, random_state=20261010))])
    classifier.fit(np.asarray(rows, dtype=float), np.asarray(labels), logistic__sample_weight=np.asarray(weights))
    base = classifier.predict_proba(np.asarray(calibration_rows, dtype=float))[:, 1]
    logits = np.log(np.clip(base, 1e-6, 1 - 1e-6) / np.clip(1 - base, 1e-6, 1 - 1e-6))
    calibrator = Logistic(max_iter=400, C=1.0, random_state=20261010)
    calibrator.fit(logits.reshape(-1, 1), np.asarray(calibration_labels), sample_weight=np.asarray(calibration_weights))
    model = {"classifier": classifier, "probabilityCalibrator": calibrator}
    policy_probabilities = predict_rounds(model, groups["calibration"], np)
    policy = select_threshold(groups["calibration"], policy_probabilities, accuracy, coverage)
    threshold = policy["threshold"]
    calibration_metrics = replay(groups["calibration"], policy_probabilities, threshold)
    holdout_metrics = replay(groups["holdout"], predict_rounds(model, groups["holdout"], np), threshold)
    qualified = qualification(policy, holdout_metrics, accuracy, coverage)
    version = ENGINE_VERSION + "-" + str(as_of)
    policy_hash = hashlib.sha256(json.dumps({
        "modelVersion": version, "schemaFingerprint": SCHEMA_FINGERPRINT,
        "threshold": threshold, "policy": "FIRST_QUALIFIED_CHECKPOINT",
        "deadlineMs": DEADLINE_MS, "checkpointsMs": CHECKPOINTS_MS,
        "frozenUntilMs": as_of + FREEZE_MS,
    }, sort_keys=True).encode()).hexdigest()
    model_path = os.path.abspath(os.path.join(model_dir, version + ".joblib"))
    manifest_path = os.path.abspath(os.path.join(model_dir, version + ".manifest.json"))
    manifest = {"schemaVersion": SCHEMA_VERSION, "featureVersion": FEATURE_VERSION,
                "schemaFingerprint": SCHEMA_FINGERPRINT, "featureNames": list(FEATURE_NAMES),
                "engineVersion": ENGINE_VERSION, "modelVersion": version, "modelPath": model_path,
                "policyHash": policy_hash, "modelConfig": {"family": "sklearn_logistic", "C": 0.3, "randomSeed": 20261010},
                "manifestPath": manifest_path, "trainedAt": as_of, "trainingAsOfMs": as_of,
                "frozenUntilMs": as_of + FREEZE_MS, "trainEndRound": groups["train"][-1]["roundStartMs"],
                "officialSettledRounds": diagnostics["officialSettledRounds"], "calendarRounds": len(rounds), "minRounds": minimum, "threshold": threshold,
                "targetAccuracy": accuracy, "targetCoverage": coverage,
                "forwardTargetAccuracy": 0.75, "forwardTargetCoverage": 0.5,
                "checkpointsMs": list(CHECKPOINTS_MS), "deadlineMs": DEADLINE_MS,
                "folds": {name: fold_range(items) for name, items in groups.items()},
                "splitPolicy": "TIME_ORDERED_60_20_20_GROUPED_BY_ROUND",
                "purgePolicy": "FULL_5M_LABEL_HORIZON_AND_ACTUAL_LABEL_AVAILABILITY_BEFORE_NEXT_FOLD",
                "probabilityCalibration": "PLATT_INTERNAL_TRAIN_FOLD_WITH_ROUND_WEIGHTING",
                "calibration": {"policySelection": policy, "metrics": calibration_metrics},
                "holdout": holdout_metrics, "qualification": qualified["status"],
                "qualificationDetails": qualified, "trainingStatus": "QUALIFIED_HOLDOUT" if qualified["status"] == "MET" else "UNQUALIFIED_HOLDOUT",
                "forwardStatus": "FORWARD_VALIDATION_REQUIRED", "longTermValidated": False,
                "productionEffect": PRODUCTION_EFFECT, "diagnostics": diagnostics,
                "warnings": ["HISTORICAL_HOLDOUT_IS_NOT_A_LONG_TERM_GUARANTEE", "DO_NOT_SWITCH_PRODUCTION_AUTOMATICALLY"]}
    model["manifest"] = manifest
    descriptor, temporary = tempfile.mkstemp(prefix=".shadow35-model-", dir=model_dir)
    os.close(descriptor)
    try:
        joblib.dump(model, temporary)
        os.replace(temporary, model_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    with open(model_path, "rb") as artifact:
        manifest["modelSha256"] = hashlib.sha256(artifact.read()).hexdigest()
    atomic_json(manifest_path, manifest)
    atomic_json(active_path, manifest)
    return {"ok": True, "status": "CANDIDATE_REGISTERED", **manifest}


def train(payload):
    model_dir = payload.get("modelDir")
    if not isinstance(model_dir, str):
        return {"ok": False, "status": "INVALID_TRAIN_REQUEST", "productionEffect": PRODUCTION_EFFECT}
    import fcntl
    os.makedirs(model_dir, exist_ok=True)
    with open(os.path.join(model_dir, ".training.lock"), "a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"ok": True, "status": "TRAINING_ALREADY_RUNNING", "productionEffect": PRODUCTION_EFFECT}
        return train_unlocked(payload)


def predict(payload):
    path = payload.get("modelPath")
    if not isinstance(path, str):
        return {"ok": False, "status": "INVALID_MODEL_PATH", "productionEffect": PRODUCTION_EFFECT}
    snapshot = payload.get("snapshot")
    row, reason = snapshot_vector(snapshot)
    if row is None:
        return {"ok": False, "status": "INVALID_SNAPSHOT", "reason": reason,
                "productionEffect": PRODUCTION_EFFECT}
    joblib, np, _, _, _, _ = dependencies()
    manifest_path = path.removesuffix(".joblib") + ".manifest.json"
    with open(manifest_path, encoding="utf-8") as stream:
        expected_manifest = json.load(stream)
    if (snapshot["observedAt"] < expected_manifest["trainedAt"]
            or snapshot["roundStartMs"] <= expected_manifest["trainEndRound"]):
        return {"ok": False, "status": "SNAPSHOT_PREDATES_TRAINED_MODEL", "productionEffect": PRODUCTION_EFFECT}
    with open(path, "rb") as artifact:
        actual_hash = hashlib.sha256(artifact.read()).hexdigest()
    if actual_hash != expected_manifest.get("modelSha256"):
        return {"ok": False, "status": "MODEL_ARTIFACT_INTEGRITY_MISMATCH", "productionEffect": PRODUCTION_EFFECT}
    model = joblib.load(path)
    manifest = model["manifest"]
    if manifest.get("schemaFingerprint") != SCHEMA_FINGERPRINT:
        return {"ok": False, "status": "MODEL_SCHEMA_MISMATCH", "productionEffect": PRODUCTION_EFFECT}
    probability = float(calibrated_probabilities(model, [row], np)[0])
    if not math.isfinite(probability):
        return {"ok": False, "status": "NONFINITE_PROBABILITY", "productionEffect": PRODUCTION_EFFECT}
    return {"ok": True, "status": "SHADOW_PROBABILITY", "probability": probability,
            "modelVersion": manifest["modelVersion"], "threshold": manifest["threshold"],
            "qualification": manifest["qualification"], "frozenUntilMs": manifest["frozenUntilMs"],
            "policyHash": manifest["policyHash"],
            "forwardStatus": "FORWARD_VALIDATION_REQUIRED", "productionEffect": PRODUCTION_EFFECT}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("train", "predict"))
    args = parser.parse_args()
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("INPUT_MUST_BE_JSON_OBJECT")
        result = train(payload) if args.action == "train" else predict(payload)
    except Exception as exc:
        result = {"ok": False, "status": "ERROR", "error": type(exc).__name__ + ": " + str(exc),
                  "productionEffect": PRODUCTION_EFFECT}
    print("SHADOW35_RESULT=" + json.dumps(result, separators=(",", ":"), ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
